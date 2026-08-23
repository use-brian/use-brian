/**
 * Brain MCP server — Streamable HTTP endpoint.
 *
 * `POST /api/brain/mcp` is an MCP server (initialize / tools/list /
 * tools/call) that external AI clients — Claude Code, Claude Desktop,
 * ChatGPT — connect to. It is API-key authed (`sk_brain_`), NOT JWT: the
 * endpoint is mounted WITHOUT `requireAuth`.
 *
 * Stateless transport: a fresh `McpServer` + transport is built per request,
 * with the tool surface scope-gated to the authenticating key. The MCP
 * protocol itself is handled by `@modelcontextprotocol/sdk` (the same SDK
 * the connector client already uses) — Use Brian is an MCP client elsewhere;
 * this makes it also an MCP server.
 *
 * Component tag: [COMP:api/brain-mcp].
 * Spec: docs/architecture/features/programmatic-access.md.
 */

import { Router } from 'express'
import { actionableInputSchema } from './actionable-input-schema.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Tool, Embedder } from '@use-brian/core'
import type { BrainKeyStore } from '../db/brain-keys-store.js'
import type { OAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import { authenticateBrainRequest } from './auth.js'
import type { AppStoreScope } from '@use-brian/brian-app'
import type { Sensitivity } from '@use-brian/core'
import type { BrainKeyScope } from '../db/brain-keys-store.js'
import {
  buildBrainTools,
  resolveAgentCapabilities,
  type BrainCrmTools,
  type BrainDocTools,
  type BrainFileTools,
  type BrainBrandTools,
  type BrainMemoryTools,
  type BrainRetrievalTools,
  type BrainTaskTools,
} from './tools.js'

type Options = {
  brainKeyStore: BrainKeyStore
  /**
   * Optional OAuth 2.1 authorization store. When set, the MCP endpoint also
   * accepts `oat_*` access tokens issued via /api/brain/oauth/token. When
   * unset, only the legacy `sk_brain_*` keys authenticate. See
   * programmatic-access.md → "OAuth 2.1 mode".
   */
  authorizationStore?: OAuthAuthorizationStore
  /**
   * Chat-side tool sets, reused as boot-time singletons so brain-key calls
   * emit the same analytics events and write the same entity-link edges as
   * chat-side calls. See programmatic-access.md → "Tool wiring".
   */
  memoryTools: BrainMemoryTools
  taskTools: BrainTaskTools
  crmTools: BrainCrmTools
  retrievalTools: BrainRetrievalTools
  /**
   * Workspace filesystem tools. Optional — only the deployments that
   * configure a blob client (GCS / local-disk) build the file tools, so a
   * files-less deploy passes `undefined` and the brain MCP omits the file
   * surface. `saveFileToBrain` (byte upload) is not part of this set.
   */
  fileTools?: BrainFileTools
  /** Brand primitive tools — `getBrand` (both scopes) + `saveBrandDraft` (write scope, draft-only). */
  brandTools?: BrainBrandTools
  /**
   * Doc-page tools (`readPage` / `editPage` / `deletePage`). Optional — only
   * deployments that build the doc stores pass it; a doc-less deploy omits the
   * page surface. `readPage` rides both key scopes, `editPage` / `deletePage`
   * require a `read_write` key. See `BrainDocTools`.
   */
  docTools?: BrainDocTools
  /**
   * Programmatic ingest entry to Pipeline B. When wired, the `ingestToBrain`
   * tool decomposes content into entities / edges / memories / tasks instead of
   * a flat memory write. Built at boot via `createBrainEpisodeIngestor`. When
   * unset (minimal deploy), `ingestToBrain` falls back to a direct `saveMemory`.
   * See programmatic-access.md → "Tool wiring".
   */
  ingest?: BrainEpisodeIngestor
  /**
   * The shared agent capability toolset (agent-facing capability surface) —
   * built at boot via `buildAgentToolset`. Optional: a deploy without it
   * keeps the data-plane-only brain MCP. Reads are exposed on both key
   * scopes; writes only on read_write keys whose bound primary assistant
   * holds the `configure` capability (`resolveAgentGate`).
   */
  agentTools?: { reads: Map<string, Tool>; writes: Map<string, Tool> }
  /**
   * Query embedder for the `searchRecording` tool's vector arm
   * (recording-to-brain). Optional — without it, recording retrieval degrades
   * to keyword (ILIKE) search. The same embedder that powers `retrievalTools`.
   */
  embedder?: Pick<Embedder, 'embed'>
  /**
   * Computer-use R2: the logic-block store behind `writeBrowserSkill` — the
   * OSS authoring skill's brain-sync tool. Optional; write-scope keys only.
   */
  browserSkills?: import('@use-brian/core').BrowserSkillStore
  /**
   * Resolve a custom Home app's commerce-store tools, bound to the workspace
   * primary assistant — the same binding the agent capability toolset uses.
   *
   * A resolver rather than a prebuilt map because the tools are per-workspace:
   * they carry that workspace's connector credentials and rotate tokens as a
   * side effect. Boot owns the connector plumbing; this module stays ignorant
   * of it. Returning `[]` (no store connected, no grant) is normal.
   */
  /**
   * Custom Home app bridge. Without this, `authenticateBrainRequest` skips
   * the bridge-token path entirely and every Home app gets a flat 401 — which
   * is exactly what happened between the feature shipping and this wiring:
   * the documented bridge sample could not work.
   *
   * `getApp` resolves the LIVE row so a revoked grant stops working on the
   * next call. `consumeBudget` charges the app's daily allowance, the same
   * way the KV endpoints do; a data call that costs nothing would leave the
   * only unbounded path in the bridge.
   */
  homeApps?: {
    secret: string
    getApp: (appId: string) => Promise<{
      id: string
      workspaceId: string
      status: string
      grantedScopes: { data: BrainKeyScope; store?: AppStoreScope } | null
      maxClearance: Sensitivity | null
    } | null>
    consumeBudget?: (appId: string) => Promise<{ allowed: boolean }>
  }
  storeTools?: (params: {
    workspaceId: string
    storeScope: AppStoreScope
    actingUserId?: string
  }) => Promise<Tool[]>
  /**
   * Hand a task to the workspace assistant on a Home app's behalf
   * (`scopes.agent: 'ask'`). The consult is capped at the app's own tool
   * ceiling by the caller, so it cannot reach past `scopes.store`.
   */
  agentTask?: (params: {
    workspaceId: string
    storeScope: AppStoreScope
    appId: string
    actingUserId?: string
    task: string
  }) => Promise<string>
}

export function brainMcpRoutes(opts: Options): Router {
  const router = Router()

  router.post('/', async (req, res) => {
    const auth = await authenticateBrainRequest(req, {
      brainKeyStore: opts.brainKeyStore,
      authorizationStore: opts.authorizationStore,
      homeApps: opts.homeApps,
    })
    if (!auth) {
      // Uniform 401 — a probe cannot tell a bad key from a revoked one. That
      // is a security property, not a reason to say nothing: the ONE message
      // covers every cause (so it leaks no more than the code does) while
      // still telling an honest client which header to send and where the
      // credential comes from.
      res.status(401).json({
        error: 'invalid_brain_key',
        message:
          'Authenticate with `Authorization: Bearer sk_brain_<keyId>_<secret>` (an API key) or ' +
          '`Bearer oat_<authorizationId>_<secret>` (an OAuth 2.1 access token from ' +
          '/api/brain/oauth/token). The credential is missing, malformed, revoked, or expired — ' +
          'these are deliberately indistinguishable, so check all four. An OAuth access token ' +
          'expires after 10 minutes: refresh it with `grant_type=refresh_token` rather than ' +
          'retrying. An API key is issued and rotated in Studio → Programmatic access. Retrying ' +
          'the same credential unchanged will fail identically.',
      })
      return
    }

    // One McpServer per request — stateless. The tool list is scope-gated:
    // a `read` key never sees `ingestToBrain` in `tools/list`, and the
    // agent write tools appear only when the bound primary assistant holds
    // the `configure` capability (resolved fresh per request so a revoked
    // grant takes effect immediately).
    const agentActiveCapabilities = opts.agentTools
      ? await resolveAgentCapabilities(auth.workspaceId)
      : new Set<string>()
    const agentWritesEnabled =
      opts.agentTools && auth.scope === 'read_write'
        ? agentActiveCapabilities.has('configure')
        : false
    // Every Home app bridge call spends one unit of its daily budget — this
    // is a data path, and leaving it free would make it the one unbounded
    // way into the workspace.
    if (auth.authKind === 'home_app' && opts.homeApps?.consumeBudget) {
      const budget = await opts.homeApps.consumeBudget(auth.keyId)
      if (!budget.allowed) {
        res.status(429).json({ error: 'This app has used its daily budget.' })
        return
      }
    }

    // Store tools reach a live merchant store, so they are resolved ONLY for a
    // Home app that was granted a tier. No other principal kind gets them:
    // an API key or OAuth token addresses the brain, and widening those to a
    // storefront is a decision nobody has made.
    let storeTools: Tool[] = []
    if (opts.storeTools && auth.authKind === 'home_app' && auth.storeScope !== 'none') {
      try {
        storeTools = await opts.storeTools({
          workspaceId: auth.workspaceId,
          storeScope: auth.storeScope,
          actingUserId: auth.actingUserId,
        })
      } catch (err) {
        // A connector that cannot be reached must not take the whole brain
        // surface down with it — the app's other tools still work, and the
        // missing store tools surface as "not available" rather than a 500.
        console.error('[brain-mcp] store tool resolution failed:', err)
      }
    }

    // An assistant turn costs model time, not one cheap query — so it is
    // exposed only on an explicit `agent` grant, and charged accordingly at
    // the call site rather than riding the flat per-call unit.
    const agentTask =
      opts.agentTask && auth.authKind === 'home_app' && auth.agentScope === 'ask'
        ? opts.agentTask
        : undefined

    const server = new McpServer({ name: 'use-brian-brain', version: '1.0.0' })
    for (const tool of buildBrainTools({
      workspaceId: auth.workspaceId,
      scope: auth.scope,
      keyId: auth.keyId,
      maxClearance: auth.maxClearance,
      memoryTools: opts.memoryTools,
      taskTools: opts.taskTools,
      crmTools: opts.crmTools,
      retrievalTools: opts.retrievalTools,
      fileTools: opts.fileTools,
      brandTools: opts.brandTools,
      docTools: opts.docTools,
      ingest: opts.ingest,
      agentTools: opts.agentTools,
      agentActiveCapabilities,
      agentWritesEnabled,
      embedder: opts.embedder,
      browserSkills: opts.browserSkills,
      storeTools,
      ...(agentTask
        ? {
            agentTask: (task: string) =>
              agentTask({
                workspaceId: auth.workspaceId,
                storeScope: auth.storeScope,
                appId: auth.keyId,
                actingUserId: auth.actingUserId,
                task,
              }),
          }
        : {}),
    })) {
      server.registerTool(
        tool.name,
        // A ZodObject whose failed parse renders compact `path: message` lines
        // (+ retry verdict) instead of the SDK default `ZodError.message` JSON
        // blob — see ./actionable-input-schema.ts.
        { description: tool.description, inputSchema: actionableInputSchema(tool.inputSchema, tool.name) },
        tool.handler,
      )
    }

    // Stateless transport — no session id issued or validated.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      console.error('[brain-mcp] request failed:', err)
      if (!res.headersSent) {
        res.status(500).json({
          error: 'brain_mcp_error',
          message:
            'The MCP transport failed while handling this request. Authentication and tool-surface ' +
            'construction had already succeeded, so the credential is fine and changing it will not ' +
            'help. The cause is server-side and may be transient: retry the same request once after ' +
            'a short wait, and if it persists report it rather than looping.',
        })
      }
    }
  })

  // The MCP Streamable HTTP spec lets a client open a GET SSE stream for
  // server-initiated messages. This tools-only server has none — a 405 tells
  // the client to proceed POST-only.
  router.get('/', (_req, res) => {
    res.status(405).json({ error: 'method_not_allowed' })
  })

  return router
}
