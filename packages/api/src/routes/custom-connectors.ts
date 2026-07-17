/**
 * Custom MCP connector CRUD — the `/custom` slice of `/api/connectors`.
 *
 * This is the OPEN home of the custom-connector feature. It used to live only
 * in the closed `@use-brian/api-platform` connectors route; it now lives here so
 * BOTH editions share one implementation. The open `connectorRoutes` mounts it,
 * and the closed route imports and mounts the SAME factory instead of carrying a
 * duplicate (the import boundary allows closed→open, never open→closed).
 *
 * It depends only on open primitives — the `ConnectorStore` (custom rows live in
 * the same `connector_instance` table the rest of the connector surface reads,
 * so a row written here shows up in `GET /api/connectors` with no extra wiring),
 * `buildConnectorAuthHeaders` / `isValidHeaderName` from `mcp/auth-headers`, and
 * `discoverMcpServer` from `mcp/client` for the connection probe.
 *
 *   POST   /custom          — add a custom MCP connector
 *   PATCH  /custom/:id      — update one (keep-secret PATCH contract)
 *   POST   /custom/:id/test — probe (MCP initialize + tools/list), set `connected`
 *   DELETE /custom/:id      — remove one
 *
 * Mounted behind requireAuth by both editions — no guest access. Secrets are
 * validated at this boundary (size caps + no CR/LF, the header-injection vector)
 * and never echoed back in any response.
 *
 * See docs/architecture/integrations/mcp.md → "Custom connector auth".
 * Component tag: [COMP:api/custom-connectors-route].
 */

import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { CONNECTOR_AUTH_TYPES } from '@use-brian/shared'
import type { ConnectorStore, ConnectorCredentials } from '../db/connector-store.js'
import { buildConnectorAuthHeaders, isValidHeaderName } from '../mcp/auth-headers.js'

const noCrLf = (v: string) => !/[\r\n]/.test(v)

const customConnectorBody = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
  authType: z.enum(CONNECTOR_AUTH_TYPES).optional(),
  oauthClientId: z.string().max(2048).refine(noCrLf).optional(),
  oauthClientSecret: z.string().max(8192).refine(noCrLf).optional(),
  bearerToken: z.string().max(8192).refine(noCrLf).optional(),
  headerName: z.string().max(128).optional(),
  headerValue: z.string().max(8192).refine(noCrLf).optional(),
})

type CustomConnectorBody = z.infer<typeof customConnectorBody>

type ResolvedCustomAuth =
  | { ok: true; credentials?: ConnectorCredentials; clearCredentials?: boolean; authHeaderName?: string | null }
  | { ok: false; error: string }

/**
 * Map a validated POST/PATCH /custom body to the credentials write.
 *
 * `stored` carries the existing row's state for the PATCH keep-secret rule:
 * same auth type (and, for custom_header, an unchanged header name) with
 * blank secret fields keeps the stored credentials untouched; changing the
 * type or the header name requires re-entering the secret. `stored` is null
 * in add mode, where every non-none type requires its secret.
 * `authType` omitted entirely preserves the legacy contract: both OAuth
 * fields set the pair, anything else leaves credentials untouched.
 */
function resolveCustomAuth(
  body: CustomConnectorBody,
  stored: { credentialsType: string; authHeaderName?: string } | null,
): ResolvedCustomAuth {
  const { authType } = body
  const oauthPair =
    body.oauthClientId && body.oauthClientSecret
      ? { type: 'oauth' as const, client_id: body.oauthClientId, client_secret: body.oauthClientSecret }
      : undefined

  if (authType === undefined) {
    return { ok: true, credentials: oauthPair }
  }

  switch (authType) {
    case 'none':
      return { ok: true, clearCredentials: true, authHeaderName: null }
    case 'oauth':
      if (oauthPair) return { ok: true, credentials: oauthPair }
      // A half-filled pair is an error, not a silent keep — otherwise a
      // caller rotating just the client_id would have it silently dropped
      // while the old secret is retained. Matches the client-side rule in
      // apps/app-web/src/lib/connector-auth-form.ts.
      if (body.oauthClientId || body.oauthClientSecret) {
        return { ok: false, error: 'Both OAuth Client ID and Client Secret are required' }
      }
      break
    case 'bearer':
      if (body.bearerToken) return { ok: true, credentials: { type: 'bearer', token: body.bearerToken } }
      break
    case 'custom_header':
      if (body.headerName !== undefined && !isValidHeaderName(body.headerName)) {
        return { ok: false, error: 'Header name must contain only HTTP token characters' }
      }
      if (body.headerName && body.headerValue) {
        return {
          ok: true,
          credentials: { type: 'custom_header', header: body.headerName, value: body.headerValue },
          authHeaderName: body.headerName,
        }
      }
      break
  }

  // Secret fields absent — keep the stored credentials when nothing
  // material changed; otherwise the caller must (re-)enter the secret.
  if (stored && stored.credentialsType === authType) {
    const headerUnchanged =
      authType !== 'custom_header' || !body.headerName || body.headerName === stored.authHeaderName
    if (headerUnchanged) return { ok: true }
  }
  return {
    ok: false,
    error: stored
      ? 'Re-enter the secret when changing the auth type or header name'
      : 'Secret required for the selected auth type',
  }
}

/**
 * A safe, body-free message for a failed connection probe. Surfaces the
 * HTTP status code when the failure carries one (StreamableHTTPError.code),
 * the timeout category, or a generic "could not reach" — never the upstream
 * response body the MCP SDK embeds in its error message.
 */
function probeErrorMessage(err: unknown, timeoutMarker: string): string {
  if (err instanceof Error && err.message === timeoutMarker) return 'Connection timed out'
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'number') return `Server returned HTTP ${code}`
  return 'Could not reach the MCP server'
}

type CustomConnectorRouteOptions = {
  connectorStore: ConnectorStore
}

/**
 * Build the `/custom` sub-router. Both editions mount it on `/api/connectors`
 * (`router.use(customConnectorRoutes({ connectorStore }))`), so it must be
 * mounted BEFORE any `/:param` catch-all route or `/custom/:id` would be
 * swallowed by `/:id`.
 */
export function customConnectorRoutes({ connectorStore }: CustomConnectorRouteOptions): Router {
  const router = Router()

  // ── POST /custom — add custom connector ──────────────────────
  router.post('/custom', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const parsed = customConnectorBody.safeParse(req.body ?? {})
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request body' }); return }
    const body = parsed.data

    const name = body.name?.trim()
    const url = body.url?.trim()
    if (!name || !url) {
      res.status(400).json({ error: 'Name and URL are required' })
      return
    }

    const auth = resolveCustomAuth(body, null)
    if (!auth.ok) { res.status(400).json({ error: auth.error }); return }

    try {
      const connectorId = randomUUID()
      const row = await connectorStore.upsert(userId, {
        connectorId,
        name,
        url,
        custom: true,
        connected: false,
        credentials: auth.credentials,
      })
      // Mirror the (non-secret) header name into config so the edit form
      // can display it without ever decrypting the credentials blob.
      if (typeof auth.authHeaderName === 'string') {
        await connectorStore.setConfig(userId, connectorId, { authHeaderName: auth.authHeaderName })
      }
      res.json({ id: row.connectorId, connector: row })
    } catch (err) {
      console.error('[connectors] add custom failed:', err)
      res.status(500).json({ error: 'Failed to add connector' })
    }
  })

  // ── PATCH /custom/:id — update custom connector ───────────────
  router.patch('/custom/:id', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const parsed = customConnectorBody.safeParse(req.body ?? {})
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request body' }); return }
    const body = parsed.data

    const name = body.name?.trim()
    const url = body.url?.trim()
    if (!name || !url) {
      res.status(400).json({ error: 'Name and URL are required' })
      return
    }

    try {
      // Stored state for the keep-secret rule. A PATCH on a missing id
      // keeps the legacy upsert-create behavior and is treated as add mode.
      let stored: { credentialsType: string; authHeaderName?: string } | null = null
      const rows = await connectorStore.list(userId)
      const existing = rows.find((r) => r.connectorId === req.params.id)
      // Only custom connectors are editable here. Without this guard the
      // `authType: 'none'` → clearCredentials path could null a built-in's
      // stored OAuth refresh token (upsert matches any (user, provider) row
      // regardless of `custom`), leaving it connected-but-broken.
      if (existing && !existing.custom) {
        res.status(400).json({ error: 'Only custom connectors can be edited here' })
        return
      }
      if (existing) {
        const config = await connectorStore.getConfig(userId, req.params.id)
        stored = {
          credentialsType: existing.credentialsType,
          authHeaderName: typeof config.authHeaderName === 'string' ? config.authHeaderName : undefined,
        }
      }

      const auth = resolveCustomAuth(body, stored)
      if (!auth.ok) { res.status(400).json({ error: auth.error }); return }

      const row = await connectorStore.upsert(userId, {
        connectorId: req.params.id,
        name,
        url,
        custom: true,
        credentials: auth.credentials,
        clearCredentials: auth.clearCredentials,
      })
      if (auth.authHeaderName !== undefined) {
        await connectorStore.setConfig(userId, row.connectorId, { authHeaderName: auth.authHeaderName })
      }
      res.json({ id: row.connectorId, connector: row })
    } catch (err) {
      console.error('[connectors] update custom failed:', err)
      res.status(500).json({ error: 'Failed to update connector' })
    }
  })

  // ── POST /custom/:id/test — connection probe ──────────────────
  //
  // Runs a real MCP initialize + tools/list against the connector's URL
  // with its configured auth, and sets `connected` from the outcome —
  // unlike the blind /:id/connect flip. Always responds 200 when the
  // probe ran; the result is data ({ ok, toolCount | error }). The
  // credential read deliberately skips the `connected = true` filter
  // (getAuthCredentials) so a never-connected connector can be probed.
  router.post('/custom/:id/test', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const connectorId = req.params.id
    try {
      const connectors = await connectorStore.list(userId)
      const connector = connectors.find((c) => c.connectorId === connectorId)
      if (!connector) { res.status(404).json({ error: 'Connector not found' }); return }
      if (!connector.custom || !connector.url) {
        res.status(400).json({ error: 'Only custom connectors with a URL can be tested' })
        return
      }

      const creds = await connectorStore.getAuthCredentials(userId, connectorId)
      const headers = buildConnectorAuthHeaders(creds)
      const { discoverMcpServer } = await import('../mcp/client.js')

      const PROBE_TIMEOUT = 10_000
      const TIMEOUT_MARKER = 'Use Brian:probe-timeout'
      try {
        const server = await Promise.race([
          discoverMcpServer(connector.url, connector.name, headers),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(TIMEOUT_MARKER)), PROBE_TIMEOUT),
          ),
        ])
        await connectorStore.setConnected(userId, connectorId, true)
        res.json({ ok: true, toolCount: server.tools.length, connected: true })
      } catch (probeErr) {
        await connectorStore.setConnected(userId, connectorId, false)
        // Categorize WITHOUT reflecting the upstream response body. The MCP
        // SDK's StreamableHTTPError embeds `await response.text()` in its
        // message; echoing that to the caller would turn this probe into a
        // credentialed read primitive (point url at a metadata/internal
        // endpoint, set a custom header, read the body back). Surface only
        // the HTTP status code or a generic category.
        res.json({ ok: false, error: probeErrorMessage(probeErr, TIMEOUT_MARKER), connected: false })
      }
    } catch (err) {
      console.error('[connectors] connection probe failed:', err)
      res.status(500).json({ error: 'Failed to test connector' })
    }
  })

  // ── DELETE /custom/:id — remove custom connector ─────────────
  router.delete('/custom/:id', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      const deleted = await connectorStore.delete(userId, req.params.id)
      if (!deleted) { res.status(404).json({ error: 'Connector not found' }); return }
      res.status(204).end()
    } catch (err) {
      console.error('[connectors] delete failed:', err)
      res.status(500).json({ error: 'Failed to delete connector' })
    }
  })

  return router
}
