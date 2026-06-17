/**
 * Assistant MCP endpoint — `POST /api/v1/assistants/:assistantId/mcp`.
 *
 * The deterministic single-tool surface of the agent capability toolset
 * (docs/plans/agent-facing-capability-surface.md §7.2, locked §12.4):
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
import { Router } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  SensitivityAccumulator,
  CONFIGURE_CAPABILITY,
  type CapabilityStore,
  type Tool,
  type ToolContext,
} from '@sidanclaw/core'
import { parseAuthToken, verifySecret, type ApiKeyStore } from '../db/api-key-store.js'
import { findAssistantById } from '../db/users.js'
import { query } from '../db/client.js'
import { bridgeCoreTool } from '../brain-mcp/tools.js'

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

export function assistantMcpRoutes(opts: Options): Router {
  const router = Router()

  router.post<{ assistantId: string }>('/assistants/:assistantId/mcp', async (req, res) => {
    // ── Auth — same posture as the public API chat endpoint.
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'invalid_api_key' })
      return
    }
    const parsed = parseAuthToken(header.slice('Bearer '.length))
    if (!parsed) {
      res.status(401).json({ error: 'invalid_api_key' })
      return
    }
    const keyRow = await opts.apiKeyStore.getByIdSystem(parsed.keyId)
    if (!keyRow || keyRow.assistantId !== req.params.assistantId) {
      // URL↔key binding — uniform 401, not probeable.
      res.status(401).json({ error: 'invalid_api_key' })
      return
    }
    if (keyRow.status !== 'active') {
      res.status(403).json({ error: 'key_revoked' })
      return
    }
    const ok = await verifySecret(parsed.secret, keyRow.keyHash)
    if (!ok) {
      res.status(401).json({ error: 'invalid_api_key' })
      return
    }
    // Key-scope gate (migration 263), AFTER the secret compare so an id-only
    // prober never learns a key's scope: only 'agent'-purpose keys open the
    // MCP door. 'chat' keys — the original external story, and the backfill
    // for every key issued before scopes existed — stay /messages-only. The
    // slug is descriptive because the caller has proven possession; what the
    // key lacks is purpose, and the fix is minting an agent-scope key.
    if (keyRow.scope !== 'agent') {
      res.status(403).json({ error: 'key_scope_chat_only' })
      return
    }

    const assistant = await findAssistantById(req.params.assistantId)
    if (!assistant) {
      res.status(404).json({ error: 'assistant_not_found' })
      return
    }
    const ownerUserId = await resolveOwnerUserId(assistant)
    if (!ownerUserId) {
      res.status(404).json({ error: 'assistant_not_found' })
      return
    }

    // ── Authority — the keyed assistant IS the ceiling (§2).
    const activeCapabilities = new Set(await opts.capabilityStore.listActive(assistant.id))
    const configureGranted = activeCapabilities.has(CONFIGURE_CAPABILITY)
    const clearance = assistant.clearance
    const sensitivity = new SensitivityAccumulator()
    sensitivity.note(clearance)
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
      clearance,
      assistantClearance: clearance,
      compartments: assistant.compartments ?? null,
      assistantCompartments: assistant.compartments ?? null,
      assistantDefaultCompartments: assistant.defaultCompartments ?? [],
      sensitivity,
      abortSignal: new AbortController().signal,
    }
    const resolveCtx = async () => ctx

    // ── One stateless McpServer per request, same as the brain MCP.
    const server = new McpServer({ name: 'sidanclaw-assistant', version: '1.0.0' })
    const tools = [
      ...[...opts.agentTools.reads.values()].map((t) =>
        bridgeCoreTool(t, resolveCtx, assistant.workspaceId ?? ''),
      ),
      ...(configureGranted
        ? [...opts.agentTools.writes.values()].map((t) =>
            bridgeCoreTool(t, resolveCtx, assistant.workspaceId ?? ''),
          )
        : []),
    ]
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
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
        res.status(500).json({ error: 'assistant_mcp_error' })
      }
    }
  })

  // MCP Streamable HTTP GET (server-initiated stream) — tools-only server.
  router.get('/assistants/:assistantId/mcp', (_req, res) => {
    res.status(405).json({ error: 'method_not_allowed' })
  })

  return router
}
