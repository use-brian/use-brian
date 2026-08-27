/**
 * Assistant MCP endpoint — `POST /api/v1/assistants/:assistantId/mcp`.
 *
 * The deterministic single-tool surface of the agent capability toolset
 * (docs/architecture/integrations/agent-capability-surface.md §7.2, locked §12.4):
 * an external agent points the same MCP client at this endpoint that it
 * points at the brain MCP, authed with the assistant's `sk_live_` key, and
 * calls capability tools directly — no chat turn.
 *
 * Authority: the endpoint is CEILINGED AT THE KEYED ASSISTANT (§2). The
 * per-request ToolContext carries the assistant's own clearance (read AND
 * write ceiling), compartments, kind, and active capability grants; Tier-2
 * writes appear in `tools/list` only when the keyed assistant holds the
 * `configure` capability. Approve-band writes stage `staged_write`
 * approvals exactly as on the brain MCP (`agent-surface/banding.ts`).
 *
 * Auth mirrors `public-api.ts`: parse `sk_live_<keyId>_<secret>`, look the
 * row up by id, verify the URL↔key binding (`key.assistant_id` must equal
 * the path param — a leaked key for assistant A must not be aimable at B),
 * check status, constant-time-compare the secret.
 *
 * Component tag: [COMP:api/assistant-mcp].
 */

import { randomUUID } from 'node:crypto'
import { actionableInputSchema } from '../brain-mcp/actionable-input-schema.js'
import { Router } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  SensitivityAccumulator,
  ContextScopeAccumulator,
  CONFIGURE_CAPABILITY,
  filterToolsByCapabilities,
  type CapabilityStore,
  type Tool,
  type ToolContext,
} from '@use-brian/core'
import { parseAuthToken, verifySecret, type ApiKeyStore } from '../db/api-key-store.js'
import { findAssistantById } from '../db/users.js'
import { query } from '../db/client.js'
import { bridgeCoreTool } from '../brain-mcp/tools.js'
import {
  ContextNotAvailableError,
  resolveTurnScopeSystem,
} from '../context-scope/resolve-turn-scope.js'

type Options = {
  apiKeyStore: ApiKeyStore
  capabilityStore: CapabilityStore
  /** The shared agent capability toolset (buildAgentToolset at boot). */
  agentTools: { reads: Map<string, Tool>; writes: Map<string, Tool> }
}

/** Workspace owner for team-owned assistants (owner_user_id NULL). */
async function resolveOwnerUserId(assistant: {
  ownerUserId: string | null
  workspaceId: string | null
}): Promise<string | null> {
  if (assistant.ownerUserId) return assistant.ownerUserId
  if (!assistant.workspaceId) return null
  const result = await query<{ ownerUserId: string }>(
    `SELECT owner_user_id AS "ownerUserId" FROM workspaces WHERE id = $1`,
    [assistant.workspaceId],
  )
  return result.rows[0]?.ownerUserId ?? null
}

/**
 * The uniform 401 body.
 *
 * The four ways this endpoint refuses a credential (no header, unparseable
 * token, unknown key row / key bound to a different assistant, wrong secret)
 * deliberately return the SAME code — a probe must not be able to tell them
 * apart. That is a security property, not a reason to stay silent: an honest
 * client is left with a bare `invalid_api_key` and no idea which header to
 * set. The message is therefore identical across all four (so it leaks
 * nothing) and says what a working request looks like and where the
 * credential comes from.
 */
const INVALID_KEY_MESSAGE =
  'Authenticate with `Authorization: Bearer sk_live_<keyId>_<secret>`, using a key minted for THIS ' +
  'assistant with scope `agent` (Studio → the assistant → API). The header is missing, malformed, ' +
  'names a key issued for a different assistant, or its secret does not match — these are ' +
  'deliberately indistinguishable, so check all four. Retrying the same credential will fail ' +
  'identically; mint or rotate a key instead.'

export function assistantMcpRoutes(opts: Options): Router {
  const router = Router()

  router.post<{ assistantId: string }>('/assistants/:assistantId/mcp', async (req, res) => {
    // ── Auth — same posture as the public API chat endpoint.
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'invalid_api_key', message: INVALID_KEY_MESSAGE })
      return
    }
    const parsed = parseAuthToken(header.slice('Bearer '.length))
    if (!parsed) {
      res.status(401).json({ error: 'invalid_api_key', message: INVALID_KEY_MESSAGE })
      return
    }
    const keyRow = await opts.apiKeyStore.getByIdSystem(parsed.keyId)
    if (!keyRow || keyRow.assistantId !== req.params.assistantId) {
      // URL↔key binding — uniform 401, not probeable.
      res.status(401).json({ error: 'invalid_api_key', message: INVALID_KEY_MESSAGE })
      return
    }
    if (keyRow.status !== 'active') {
      res.status(403).json({
        error: 'key_revoked',
        message:
          'This API key has been revoked, so it will never authenticate again. Revocation is ' +
          'permanent (the row is kept for audit; there is no un-revoke). Ask the workspace admin to ' +
          'mint a NEW key for this assistant with scope `agent` (Studio → the assistant → API) and ' +
          'replace the credential. Do not retry with this key.',
      })
      return
    }
    const ok = await verifySecret(parsed.secret, keyRow.keyHash)
    if (!ok) {
      res.status(401).json({ error: 'invalid_api_key', message: INVALID_KEY_MESSAGE })
      return
    }
    // Key-scope gate (migration 263), AFTER the secret compare so an id-only
    // prober never learns a key's scope: only 'agent'-purpose keys open the
    // MCP door. 'chat' keys — the original external story, and the backfill
    // for every key issued before scopes existed — stay /messages-only. The
    // slug is descriptive because the caller has proven possession; what the
    // key lacks is purpose, and the fix is minting an agent-scope key.
    if (keyRow.scope !== 'agent') {
      res.status(403).json({
        error: 'key_scope_chat_only',
        message:
          'This key authenticated correctly but was issued with scope `chat`, which reaches ' +
          '/api/v1/assistants/:id/messages only — the MCP surface requires scope `agent`. A key\'s ' +
          'scope is fixed at mint time and there is deliberately no endpoint to raise it, so the ' +
          'remedy is a NEW key: ask the workspace admin to mint one with scope `agent` (Studio → the ' +
          'assistant → API). Retrying with this key will fail identically.',
      })
      return
    }

    const assistant = await findAssistantById(req.params.assistantId)
    if (!assistant) {
      res.status(404).json({
        error: 'assistant_not_found',
        message:
          `The key is valid, but assistant ${req.params.assistantId} no longer exists — it was ` +
          'deleted after this key was issued (the key row outlives the assistant it was minted ' +
          'for). Nothing was served. Point the client at an assistant that exists and use a key ' +
          'minted for THAT assistant; retrying this URL will fail identically.',
      })
      return
    }
    const ownerUserId = await resolveOwnerUserId(assistant)
    if (!ownerUserId) {
      // NOT `assistant_not_found`: the assistant is right there. What is
      // missing is an acting principal — no owner, and no workspace (or a
      // workspace with no owner) to fall back to — so every tool call would
      // have nobody to run as. Conflating the two sent an integrator hunting
      // for a wrong id when the id was fine and the PROVISIONING was not.
      res.status(404).json({
        error: 'assistant_principal_unresolved',
        message:
          `Assistant ${assistant.id} exists and the key is valid, but it has no owner and is not ` +
          'attached to a workspace with one, so there is no principal for its tool calls to run ' +
          'as. The assistant id is NOT the problem — do not go looking for a different one. This ' +
          'is a provisioning gap: a workspace admin must attach the assistant to a workspace (or ' +
          'set an owner) in Studio. Retrying will fail identically until that is done.',
      })
      return
    }

    // ── Authority — the keyed assistant IS the ceiling (§2).
    const activeCapabilities = new Set(await opts.capabilityStore.listActive(assistant.id))
    const configureGranted = activeCapabilities.has(CONFIGURE_CAPABILITY)
    const clearance = assistant.clearance
    let turnScope
    try {
      turnScope = await resolveTurnScopeSystem({
        userId: ownerUserId,
        assistant,
        workspaceId: assistant.workspaceId,
        // Existing agent keys are explicitly company-wide on the active-context
        // axis; assistant Team/Project ceilings still apply.
        key: { contextGroupId: null, contextProjectId: null },
      })
    } catch (err) {
      if (!(err instanceof ContextNotAvailableError)) throw err
      res.status(409).json({
        error: err.code,
        message: err.message,
        axis: err.axis,
        reason: err.reason,
      })
      return
    }
    const sensitivity = new SensitivityAccumulator()
    sensitivity.note(clearance)
    const scopeAccumulator = new ContextScopeAccumulator({
      compartments: turnScope.writeCompartments,
      projectIds: turnScope.writeProjectIds,
    })
    const ctx: ToolContext = {
      userId: ownerUserId,
      assistantId: assistant.id,
      sessionId: randomUUID(),
      appId: assistant.id,
      channelType: 'assistant_mcp',
      channelId: keyRow.id,
      workspaceId: assistant.workspaceId,
      assistantKind: assistant.kind === 'primary' || assistant.kind === 'app' ? assistant.kind : 'standard',
      activeCapabilities,
      clearance: turnScope.access.clearance,
      assistantClearance: clearance,
      compartments: turnScope.effectiveCompartments,
      projectIds: turnScope.effectiveProjectIds,
      activeGroupId: turnScope.activeGroupId,
      activeProjectId: turnScope.activeProjectId,
      assistantCompartments: turnScope.effectiveCompartments,
      assistantDefaultCompartments: turnScope.writeCompartments,
      assistantProjectIds: turnScope.effectiveProjectIds,
      assistantDefaultProjectIds: turnScope.writeProjectIds,
      sensitivity,
      scopeAccumulator,
      abortSignal: new AbortController().signal,
    }
    const resolveCtx = async () => ctx

    // ── One stateless McpServer per request, same as the brain MCP.
    const server = new McpServer({ name: 'use-brian-assistant', version: '1.0.0' })
    const visibleReads = filterToolsByCapabilities(opts.agentTools.reads, activeCapabilities)
    const visibleWrites = filterToolsByCapabilities(opts.agentTools.writes, activeCapabilities)
    const tools = [
      ...[...visibleReads.values()].map((t) =>
        bridgeCoreTool(t, resolveCtx, assistant.workspaceId ?? ''),
      ),
      ...(configureGranted
        ? [...visibleWrites.values()].map((t) =>
            bridgeCoreTool(t, resolveCtx, assistant.workspaceId ?? ''),
          )
        : []),
    ]
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        // A ZodObject whose failed parse renders compact `path: message` lines
        // (+ retry verdict) instead of the SDK default `ZodError.message` JSON
        // blob — see ./actionable-input-schema.ts.
        { description: tool.description, inputSchema: actionableInputSchema(tool.inputSchema, tool.name) },
        tool.handler,
      )
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      console.error('[assistant-mcp] request failed:', err)
      if (!res.headersSent) {
        res.status(500).json({
          error: 'assistant_mcp_error',
          message:
            'The MCP transport failed while handling this request. Authentication and authority ' +
            'resolution had already succeeded, so the credential and the assistant id are fine and ' +
            'changing them will not help. The cause is server-side and may be transient: retry the ' +
            'same request once after a short wait, and if it persists report it rather than looping.',
        })
      }
    }
  })

  // MCP Streamable HTTP GET (server-initiated stream) — tools-only server.
  router.get('/assistants/:assistantId/mcp', (_req, res) => {
    res.status(405).json({
      error: 'method_not_allowed',
      message:
        'This MCP endpoint is POST-only. It serves tools/list and tools/call over Streamable HTTP ' +
        'and initiates nothing, so there is no GET SSE stream to open. Send the JSON-RPC body as a ' +
        'POST to the same URL; GET will never succeed here.',
    })
  })

  return router
}
