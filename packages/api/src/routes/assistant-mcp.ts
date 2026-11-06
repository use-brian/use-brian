import { authenticateWorkspaceOAuthToken, getAuthenticatedBrainCredentialCurrent } from '../brain-mcp/auth.js'
import type { OAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import { readWorkspaceMcpConsent, workspaceMcpMaximum } from '../workspace-mcp/consent.js'
import type { WorkspaceMcpProfile } from '../workspace-mcp/profile.js'
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
import { Router } from 'express'
import { serveStatelessMcp } from '../brain-mcp/stateless.js'
import {
  SensitivityAccumulator,
  ContextScopeAccumulator,
  CONFIGURE_CAPABILITY,
  executionToolContext,
  type CapabilityStore,
  type Tool,
  type ToolContext,
} from '@use-brian/core'
import { parseAuthToken, verifySecret, type ApiKeyStore } from '../db/api-key-store.js'
import { findAssistantById } from '../db/users.js'
import { query } from '../db/client.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { resolveExecutionContextSystem } from '../context-scope/execution-context.js'
import { buildWorkspaceMcpCatalog } from '../workspace-mcp/catalog.js'
import { workspaceDiscoveryNames } from '../workspace-mcp/discovery.js'
import {
  ContextNotAvailableError,
} from '../context-scope/resolve-turn-scope.js'

type Options = {
  workspaceProfile?: WorkspaceMcpProfile
  authorizationStoreFor?: (assistantId: string) => OAuthAuthorizationStore
  apiUrl?: string
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
    if (opts.apiUrl && /^[0-9a-f-]{36}$/i.test(req.params.assistantId)) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${opts.apiUrl.replace(/\/$/,'')}/.well-known/oauth-protected-resource/api/v1/assistants/${req.params.assistantId}/mcp"`)
    }
    // ── Auth — same posture as the public API chat endpoint.
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'invalid_api_key', message: INVALID_KEY_MESSAGE })
      return
    }
    if (header.slice(7).startsWith('oat_')) {
      if (!opts.authorizationStoreFor || !opts.workspaceProfile || !/^[0-9a-f-]{36}$/i.test(req.params.assistantId)) {
        res.status(401).json({ error: 'invalid_api_key' }); return
      }
      const auth = await authenticateWorkspaceOAuthToken(header.slice(7), opts.authorizationStoreFor(req.params.assistantId), req.params.assistantId)
      const consent = auth?.workspaceMcpConsent
      const assistant = auth ? await findAssistantById(req.params.assistantId) : null
      const current = auth ? getAuthenticatedBrainCredentialCurrent(auth) : undefined
      if (!auth || !consent || !assistant || assistant.workspaceId !== auth.workspaceId || !auth.actingUserId || !current
        || !await getWorkspaceRoleSystem(auth.actingUserId,auth.workspaceId)) {
        res.status(401).json({ error: 'invalid_api_key' }); return
      }
      const ownerUserId = await resolveOwnerUserId(assistant)
      if (!ownerUserId) { res.status(401).json({ error: 'invalid_api_key' }); return }
      try {
        const { executionContext, turnScope } = await resolveExecutionContextSystem({
          userId: auth.actingUserId, assistant, workspaceId: auth.workspaceId, key: consent, sharedAudience: true,
          maximumAccess: workspaceMcpMaximum(consent,auth.workspaceId,auth.actingUserId), credentialCurrent: current,
          identity: { kind: 'programmatic', principal: { kind: 'oauth_token',credentialId: auth.keyId,actorUserId: auth.actingUserId },credentialOwnerUserId: ownerUserId },
          ownership: { kind: 'workspace',workspaceId: auth.workspaceId },
          lifecycle: { abortSignal: new AbortController().signal,sessionId: randomUUID(),sessionPersisted: false,channelType: 'assistant_mcp',channelId: auth.keyId },
          attribution: { credentialOwnerUserId: ownerUserId,billingUserId: ownerUserId },
        })
        const base: ToolContext = { ...executionToolContext(executionContext,{ appId: assistant.id }),
          activeCapabilities: new Set(await opts.capabilityStore.listActive(assistant.id)),activeGroupId: turnScope.activeGroupId,activeProjectId: turnScope.activeProjectId,
          scopeAccumulator: new ContextScopeAccumulator({ compartments: turnScope.writeCompartments,projectIds: turnScope.writeProjectIds }) }
        const tools = await buildWorkspaceMcpCatalog(async () => {
          const context = await opts.workspaceProfile!.prepareContext(base,consent,req.body?.params?._meta?.['usebrian.ai/context-id'])
          return { context,executeOperation: opts.workspaceProfile!.executeOperation,tools: await opts.workspaceProfile!.toolsFor(context,consent),operationNames: new Set(consent.operationNames),readOnly: auth.scope==='read' }
        })
        await serveStatelessMcp(req,res,tools,'use-brian-assistant',workspaceDiscoveryNames)
      } catch (error) {
        console.error('[assistant-mcp] OAuth request failed:',error)
        if (!res.headersSent) res.status(500).json({ error: 'assistant_mcp_error',retrySafe: false })
      }
      return
    }
    const parsed = parseAuthToken(header.slice('Bearer '.length))
    if (!parsed) {
      res.status(401).json({ error: 'invalid_api_key', message: INVALID_KEY_MESSAGE })
      return
    }
    const storedKey = await opts.apiKeyStore.getByIdSystem(parsed.keyId)
    const keyRow = storedKey ? structuredClone(storedKey) : null
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

    let workspaceConsent
    try { workspaceConsent = readWorkspaceMcpConsent(keyRow.workspaceMcpConsent) } catch {
      res.status(401).json({ error: 'invalid_api_key', message: INVALID_KEY_MESSAGE }); return
    }
    if (workspaceConsent && workspaceConsent.assistantId !== keyRow.assistantId) {
      res.status(401).json({ error: 'invalid_api_key', message: INVALID_KEY_MESSAGE }); return
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

    // The issuer is the delegating principal. An owner fallback is allowed only
    // for an old key with no issuer; a removed issuer never inherits ownership.
    const issuerUserId = keyRow.issuerUserId ?? keyRow.createdBy
    const actingUserId = issuerUserId ?? ownerUserId
    const credentialCurrent = async () => {
      const current = await opts.apiKeyStore.getByIdSystem(keyRow.id)
      if (!current || current.status !== 'active' || current.keyHash !== keyRow.keyHash
        || current.assistantId !== keyRow.assistantId || current.scope !== keyRow.scope
        || current.createdBy !== keyRow.createdBy || current.issuerUserId !== keyRow.issuerUserId
        || current.audience !== keyRow.audience
        || current.anonymousContext !== keyRow.anonymousContext || current.toolPolicy !== keyRow.toolPolicy
        || JSON.stringify(current.workspaceMcpConsent ?? null) !== JSON.stringify(keyRow.workspaceMcpConsent ?? null)
        || workspaceConsent && Date.parse(workspaceConsent.expiresAt) <= Date.now()) return false
      return !issuerUserId || !assistant.workspaceId
        || await getWorkspaceRoleSystem(actingUserId, assistant.workspaceId) !== null
    }
    if (!await credentialCurrent()) {
      res.status(401).json({ error: 'invalid_api_key', message: INVALID_KEY_MESSAGE })
      return
    }
    const activeCapabilities = new Set(await opts.capabilityStore.listActive(assistant.id))
    let resolved
    try {
      resolved = await resolveExecutionContextSystem({
        userId: actingUserId, assistant, workspaceId: assistant.workspaceId,
        key: workspaceConsent ?? { contextGroupId: null, contextProjectId: null },
        ...(workspaceConsent && assistant.workspaceId ? { sharedAudience: true,
          maximumAccess: workspaceMcpMaximum(workspaceConsent, assistant.workspaceId, actingUserId) } : {}),
        credentialCurrent,
        identity: {
          kind: 'programmatic',
          principal: { kind: 'assistant_key', credentialId: keyRow.id, actorUserId: actingUserId },
          credentialOwnerUserId: ownerUserId,
        },
        ownership: assistant.workspaceId
          ? { kind: 'workspace', workspaceId: assistant.workspaceId }
          : { kind: 'personal', ownerUserId },
        lifecycle: {
          abortSignal: new AbortController().signal,
          sessionId: randomUUID(), sessionPersisted: false,
          channelType: 'assistant_mcp', channelId: keyRow.id,
        },
        attribution: { credentialOwnerUserId: ownerUserId, billingUserId: ownerUserId },
      })
    } catch (err) {
      if (!(err instanceof ContextNotAvailableError)) throw err
      res.status(409).json({ error: err.code, message: err.message, axis: err.axis, reason: err.reason })
      return
    }
    const { executionContext, turnScope } = resolved
    const sensitivity = new SensitivityAccumulator()
    sensitivity.note(turnScope.access.clearance)
    const ctx: ToolContext = {
      ...executionToolContext(executionContext, { appId: assistant.id }),
      activeCapabilities,
      activeGroupId: turnScope.activeGroupId,
      activeProjectId: turnScope.activeProjectId,
      sensitivity,
      scopeAccumulator: new ContextScopeAccumulator({
        compartments: turnScope.writeCompartments, projectIds: turnScope.writeProjectIds,
      }),
    }
    // Preserve the old credential envelope, but use the native execution gate.
    // New workspace grants can supply a broader finite operationNames set to
    // the same adapter without changing what an already-issued key can do.
    try {
      const guardedTools = await buildWorkspaceMcpCatalog(async () => {
        ctx.activeCapabilities = new Set(await opts.capabilityStore.listActive(assistant.id))
        if (workspaceConsent) {
          if (!opts.workspaceProfile) throw new Error('workspace_mcp_profile_unavailable')
          const context = await opts.workspaceProfile.prepareContext(ctx, workspaceConsent, req.body?.params?._meta?.['usebrian.ai/context-id'])
          return { context, executeOperation: opts.workspaceProfile.executeOperation, tools: await opts.workspaceProfile.toolsFor(context, workspaceConsent),
            operationNames: new Set(workspaceConsent.operationNames), readOnly: false }
        }
        const tools = new Map(opts.agentTools.reads)
        if (ctx.activeCapabilities.has(CONFIGURE_CAPABILITY)) {
          for (const [name, tool] of opts.agentTools.writes) tools.set(name, tool)
        }
        return { context: ctx, tools, operationNames: new Set(tools.keys()), readOnly: false }
      })
      await serveStatelessMcp(req, res, guardedTools, 'use-brian-assistant', workspaceConsent ? workspaceDiscoveryNames : undefined)
    } catch (err) {
      console.error('[assistant-mcp] request failed:', err)
      if (!res.headersSent) {
        res.status(500).json({
          error: 'assistant_mcp_error',
          retrySafe: false,
          message: 'The MCP request could not be completed. Check the operation outcome before retrying a write; a missing response does not mean no effect occurred.',
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
