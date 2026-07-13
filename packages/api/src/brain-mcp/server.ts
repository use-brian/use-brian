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
 * the connector client already uses) — sidanclaw is an MCP client elsewhere;
 * this makes it also an MCP server.
 *
 * Component tag: [COMP:api/brain-mcp].
 * Spec: docs/architecture/features/programmatic-access.md.
 */

import { Router } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Tool, Embedder } from '@sidanclaw/core'
import type { BrainKeyStore } from '../db/brain-keys-store.js'
import type { OAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import { authenticateBrainRequest } from './auth.js'
import {
  buildBrainTools,
  resolveAgentGate,
  type BrainCrmTools,
  type BrainDocTools,
  type BrainFileTools,
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
  browserSkills?: import('@sidanclaw/core').BrowserSkillStore
}

export function brainMcpRoutes(opts: Options): Router {
  const router = Router()

  router.post('/', async (req, res) => {
    const auth = await authenticateBrainRequest(req, {
      brainKeyStore: opts.brainKeyStore,
      authorizationStore: opts.authorizationStore,
    })
    if (!auth) {
      // Uniform 401 — a probe cannot tell a bad key from a revoked one.
      res.status(401).json({ error: 'invalid_brain_key' })
      return
    }

    // One McpServer per request — stateless. The tool list is scope-gated:
    // a `read` key never sees `ingestToBrain` in `tools/list`, and the
    // agent write tools appear only when the bound primary assistant holds
    // the `configure` capability (resolved fresh per request so a revoked
    // grant takes effect immediately).
    const agentWritesEnabled =
      opts.agentTools && auth.scope === 'read_write'
        ? await resolveAgentGate(auth.workspaceId)
        : false
    const server = new McpServer({ name: 'sidanclaw-brain', version: '1.0.0' })
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
      docTools: opts.docTools,
      ingest: opts.ingest,
      agentTools: opts.agentTools,
      agentWritesEnabled,
      embedder: opts.embedder,
      browserSkills: opts.browserSkills,
    })) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
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
        res.status(500).json({ error: 'brain_mcp_error' })
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
