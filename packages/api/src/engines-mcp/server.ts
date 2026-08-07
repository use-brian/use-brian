/**
 * AI Engines MCP — the route.
 *
 * `POST /api/engines/mcp`: a stateless MCP server (one McpServer per request,
 * same transport pattern as `brain-mcp/server.ts`) exposing the engine
 * observation tools. Auth is a single shared bearer secret
 * (`ENGINES_MCP_SECRET`), timing-safe-compared, uniform 401 — the endpoint is
 * registered in a workspace as a CUSTOM MCP connector and governed there
 * (per-assistant grants, per-tool policy). No DB, no session auth, no
 * workspace state.
 *
 * Mounted env-gated in `boot.ts`: no secret or no engine credential → the
 * route does not exist. Spec: docs/architecture/integrations/engines-mcp.md.
 * [COMP:api/engines-mcp]
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createEngineTools, type EnginesEnv } from './tools.js'

/** Constant-time bearer check (hash both sides so length never leaks). */
export function authorizeEnginesRequest(
  authorizationHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret) return false
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader ?? '')
  if (!match) return false
  const a = createHash('sha256').update(match[1]).digest()
  const b = createHash('sha256').update(secret).digest()
  return timingSafeEqual(a, b)
}

export function enginesMcpRoutes(env: EnginesEnv = process.env as EnginesEnv): Router {
  const router = Router()
  const secret = env.ENGINES_MCP_SECRET ?? ''
  // Tools are built once per boot — env is process-lifetime config, and the
  // daily call counter must be shared across requests to mean anything.
  const tools = createEngineTools(env)

  router.post('/', async (req, res) => {
    if (!authorizeEnginesRequest(req.headers.authorization, secret)) {
      res.status(401).json({ error: 'invalid_engines_secret' })
      return
    }

    const server = new McpServer({ name: 'use-brian-engines', version: '1.0.0' })
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
      console.error('[engines-mcp] request failed:', err)
      if (!res.headersSent) {
        res.status(500).json({ error: 'engines_mcp_error' })
      }
    }
  })

  // Streamable HTTP allows a GET SSE stream for server-initiated messages;
  // this tools-only server has none — 405 tells the client to stay POST-only.
  router.get('/', (_req, res) => {
    res.status(405).json({ error: 'method_not_allowed' })
  })

  return router
}

/** Boot gate: mount only when the secret AND at least one engine credential exist. */
export function enginesMcpEnabled(env: EnginesEnv = process.env as EnginesEnv): boolean {
  return Boolean(
    env.ENGINES_MCP_SECRET &&
      (env.ENGINES_OPENAI_API_KEY ||
        env.ENGINES_GEMINI_API_KEY ||
        env.ENGINES_PERPLEXITY_API_KEY ||
        env.ENGINES_ANTHROPIC_API_KEY ||
        env.ENGINES_GSC_KEY_FILE ||
        env.ENGINES_GSC_KEY_JSON),
  )
}
