/**
 * Built-in connector lifecycle routes — `/api/connectors`.
 *
 * The OSS-open half of the connector surface. The hosted edition mounts a
 * richer closed `/api/connectors` route (custom MCP CRUD, Google Drive
 * authorized-files, per-assistant tool policy); this open module implements the
 * built-in OAuth/PAT connector lifecycle that the open `apps/app-web` OAuth
 * callbacks and Studio → Connectors page drive:
 *
 *   GET    /api/connectors                          — the unified connector list
 *   GET    /api/connectors/directory                — the "browse to add" catalog
 *   POST   /api/connectors/directory/:id/add        — add an official connector
 *   POST   /api/connectors/:provider/store-credentials — persist an OAuth/PAT grant
 *   POST   /api/connectors/:provider/connect        — mark the primary instance connected
 *   POST   /api/connectors/instances/:id/connect    — mark a specific instance connected
 *   POST   /api/connectors/:provider/disconnect     — flip the primary instance offline
 *   PATCH  /api/connectors/instances/:id            — rename a connector instance
 *   DELETE /api/connectors/instances/:id            — delete a specific instance
 *   DELETE /api/connectors/:provider                — delete the primary instance
 *
 * THE LIST MUST INCLUDE NEVER-CONNECTED BUILT-IN PLACEHOLDERS. The Studio page
 * (`connector-groups.ts`) buckets every official connector with no instance into
 * the "available" group — that is the bare "Connect" affordance. A list of only
 * the user's existing `connector_instance` rows shows nothing on a fresh account
 * ("No connectors available"). So `GET /` merges `OFFICIAL_CONNECTORS` (the
 * drift-safe registry — never a hardcoded slug list, per CLAUDE.md) with the
 * caller's instances: a placeholder per unconnected official connector, plus a
 * row per real instance.
 *
 * Persistence goes through the RLS-gated `connectorInstanceStore` /
 * `connectorStore`, which encrypt the per-user OAuth refresh-token / PAT into
 * `connector_instance.credentials` under `CHANNEL_CREDENTIAL_KEY`. The injected
 * token is read back by `mcp/inject.ts` (`readRefreshToken` / `getPat` both read
 * `credentials.client_secret`), so every provider stores its secret as the
 * `client_secret` of an `oauth`-typed blob.
 *
 * Google / Notion / Fathom additionally need their OAuth *app* credentials: the
 * server-side secret via `~/.sidanclaw/connectors.config.json` (or `*_CLIENT_*`
 * env) for the callback's token exchange, and the public client id via
 * `NEXT_PUBLIC_*_CLIENT_ID` for app-web's client-side authorize redirect. GitHub
 * is PAT-only and needs neither.
 *
 * Out of scope for the open edition (handled by the closed route): custom MCP
 * connectors (`/custom`), Google Drive authorized-files (`/gdrive/*`), and
 * per-assistant tool policy (`/tools`).
 *
 * Component tag: [COMP:api/connectors-route].
 */

import { Router } from 'express'
import { OFFICIAL_CONNECTORS, type ConnectorEntry } from '@sidanclaw/shared'
import type { ConnectorStore, ConnectorCredentials } from '../db/connector-store.js'
import type { ConnectorInstanceStore, ConnectorInstance } from '../db/connector-instance-store.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const OFFICIAL_BY_ID = new Map<string, ConnectorEntry>(OFFICIAL_CONNECTORS.map((c) => [c.id, c]))

type ConnectorRowOut = {
  id: string
  connectorInstanceId?: string
  name: string
  label?: string
  isPrimary?: boolean
  addable?: boolean
  isPlaceholder?: boolean
  description?: string
  connected: boolean
  custom?: boolean
  url?: string
  oauthRequired?: boolean
  category?: 'official' | 'community'
  connectedEmail?: string
}

type ConnectorRouteOptions = {
  connectorStore: ConnectorStore
  connectorInstanceStore: ConnectorInstanceStore
}

/** Built-in connector that carries an external credential (excludes auth_type 'none'). */
function credentialedConnector(provider: string): ConnectorEntry | null {
  const entry = OFFICIAL_BY_ID.get(provider)
  if (!entry || entry.auth_type === 'none') return null
  return entry
}

/**
 * The credentials blob shape every built-in stores: the per-user secret (OAuth
 * refresh token for `oauth` providers, PAT for `api_key` providers) lands in
 * `client_secret`, which is what `mcp/inject.ts` reads back. `client_id` is
 * unused at injection time (Google's app client id comes from
 * `getConnectorConfig`), so it is left blank.
 */
function credentialsFor(secret: string): ConnectorCredentials {
  return { type: 'oauth', client_id: '', client_secret: secret }
}

/** A never-connected built-in: the bare "Connect" affordance in the list. */
function placeholderRow(entry: ConnectorEntry): ConnectorRowOut {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    connected: false,
    custom: false,
    isPlaceholder: true,
    isPrimary: true,
    addable: entry.auth_type !== 'none',
    oauthRequired: entry.oauth_required,
    category: entry.category,
  }
}

/** A real connector_instance row, projected to the page's connector shape. */
function instanceRow(inst: ConnectorInstance, isPrimary: boolean): ConnectorRowOut {
  const entry = OFFICIAL_BY_ID.get(inst.provider)
  return {
    id: inst.provider,
    connectorInstanceId: inst.id,
    name: entry?.name ?? inst.label,
    label: inst.label,
    isPrimary,
    addable: entry ? entry.auth_type !== 'none' : false,
    description: entry?.description,
    connected: inst.connected,
    custom: inst.custom,
    url: inst.url ?? undefined,
    oauthRequired: entry?.oauth_required,
    category: entry ? entry.category : 'community',
    connectedEmail: inst.connectedEmail ?? undefined,
  }
}

export function connectorRoutes(opts: ConnectorRouteOptions): Router {
  const { connectorStore, connectorInstanceStore } = opts
  const router = Router()

  /** Group the caller's instances by provider, each list oldest-first. */
  async function instancesByProvider(userId: string): Promise<Map<string, ConnectorInstance[]>> {
    const instances = await connectorInstanceStore.listForUser(userId)
    const byProvider = new Map<string, ConnectorInstance[]>()
    for (const inst of instances) {
      const list = byProvider.get(inst.provider) ?? []
      list.push(inst)
      byProvider.set(inst.provider, list)
    }
    for (const list of byProvider.values()) {
      list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    }
    return byProvider
  }

  // ── GET / — the unified connector list (placeholders + instances) ──
  router.get('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const byProvider = await instancesByProvider(userId)
      const rows: ConnectorRowOut[] = []

      // Every official connector: real instances if connected/added, else the
      // never-connected placeholder.
      for (const entry of OFFICIAL_CONNECTORS) {
        const insts = byProvider.get(entry.id)
        if (!insts || insts.length === 0) {
          rows.push(placeholderRow(entry))
        } else {
          insts.forEach((inst, i) => rows.push(instanceRow(inst, i === 0)))
        }
      }
      // Plus any non-official instances (custom MCP rows created elsewhere).
      for (const [provider, insts] of byProvider) {
        if (OFFICIAL_BY_ID.has(provider)) continue
        insts.forEach((inst, i) => rows.push(instanceRow(inst, i === 0)))
      }

      res.json({ connectors: rows })
    } catch (err) {
      console.error('[connectors] list failed:', err)
      res.status(500).json({ error: 'Failed to list connectors' })
    }
  })

  // ── GET /directory — the "browse to add" catalog ─────────────
  router.get('/directory', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const byProvider = await instancesByProvider(userId)
      const directory = OFFICIAL_CONNECTORS.map((entry) => {
        const insts = byProvider.get(entry.id) ?? []
        return {
          ...entry,
          added: insts.length > 0,
          connected: insts.some((i) => i.connected),
          addable: entry.auth_type !== 'none',
        }
      })
      res.json({ directory })
    } catch (err) {
      console.error('[connectors] directory failed:', err)
      res.status(500).json({ error: 'Failed to load directory' })
    }
  })

  // ── POST /directory/:id/add — add an official connector ──────
  // Idempotent: surfaces the connector in the user's list by ensuring an
  // instance row exists (disconnected until the user completes OAuth / PAT).
  // Official built-ins already render as placeholders, so this is a no-op
  // success when an instance is already present.
  router.post('/directory/:id/add', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const entry = OFFICIAL_BY_ID.get(req.params.id)
    if (!entry) { res.status(404).json({ error: `Unknown connector: ${req.params.id}` }); return }
    try {
      const existing = (await connectorInstanceStore.listByUser(userId, userId))
        .find((i) => i.provider === entry.id)
      if (existing) { res.json({ ok: true, connectorInstanceId: existing.id }); return }
      const created = await connectorInstanceStore.createUserInstance({
        userId,
        provider: entry.id,
        label: entry.name,
        connected: false,
      })
      res.json({ ok: true, connectorInstanceId: created.id })
    } catch (err) {
      console.error('[connectors] directory add failed:', err)
      res.status(500).json({ error: 'Failed to add connector' })
    }
  })

  // ── POST /:provider/store-credentials — persist an OAuth/PAT grant ──
  //
  // Request body (any one secret field, per the open OAuth callbacks +
  // Studio PAT form):
  //   refreshToken | pat | accessToken | token  — the per-user secret (required)
  //   email?    — the connected account email (stored on the instance)
  //   label?    — display nickname (defaults to the provider's display name)
  //   instanceId? — target an existing instance (re-auth / multi-account update)
  //   createNew?  — true: always create a NEW instance (multi-account "add another")
  router.post('/:provider/store-credentials', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const provider = req.params.provider
    const entry = credentialedConnector(provider)
    if (!entry) {
      res.status(400).json({ error: `Unsupported connector: ${provider}` })
      return
    }

    const body = (req.body ?? {}) as {
      refreshToken?: string
      pat?: string
      accessToken?: string
      token?: string
      email?: string
      label?: string
      instanceId?: string
      createNew?: boolean
    }
    const secret = (body.refreshToken ?? body.pat ?? body.accessToken ?? body.token ?? '').trim()
    if (!secret) {
      res.status(400).json({ error: 'Missing credential (refreshToken/pat/accessToken/token)' })
      return
    }
    if (body.instanceId !== undefined && !UUID_RE.test(body.instanceId)) {
      res.status(400).json({ error: 'Invalid instanceId' })
      return
    }

    const credentials = credentialsFor(secret)
    const email = body.email ?? null
    const label = body.label?.trim() || undefined

    try {
      // Multi-account "add another" — always a fresh instance.
      if (body.createNew) {
        const created = await connectorInstanceStore.createUserInstance({
          userId,
          provider,
          label: label ?? entry.name,
          connectedEmail: email,
          connected: true,
          credentials,
        })
        res.json({ ok: true, connectorInstanceId: created.id })
        return
      }

      // Re-auth / update a specific existing instance.
      if (body.instanceId) {
        const updated = await connectorInstanceStore.update(userId, body.instanceId, {
          connected: true,
          connectedEmail: email,
          credentials,
          ...(label ? { label } : {}),
        })
        if (!updated) { res.status(404).json({ error: 'Connector instance not found' }); return }
        res.json({ ok: true, connectorInstanceId: updated.id })
        return
      }

      // Primary (one-per-provider) path: update the first matching instance or
      // create it. Mirrors the legacy `connectorStore.upsert` semantic but also
      // records `connected_email`, which the shim drops.
      const existing = (await connectorInstanceStore.listByUser(userId, userId))
        .find((i) => i.provider === provider)
      if (existing) {
        const updated = await connectorInstanceStore.update(userId, existing.id, {
          connected: true,
          connectedEmail: email,
          credentials,
          ...(label ? { label } : {}),
        })
        res.json({ ok: true, connectorInstanceId: updated?.id ?? existing.id })
        return
      }

      const created = await connectorInstanceStore.createUserInstance({
        userId,
        provider,
        label: label ?? entry.name,
        connectedEmail: email,
        connected: true,
        credentials,
      })
      res.json({ ok: true, connectorInstanceId: created.id })
    } catch (err) {
      // The store throws when CHANNEL_CREDENTIAL_KEY is unset — surface it as a
      // 503 so the launcher-misconfiguration case is distinguishable from a bug.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('CHANNEL_CREDENTIAL_KEY')) {
        console.error('[connectors] store-credentials: encryption key not configured')
        res.status(503).json({ error: 'Connector credential storage is not configured (CHANNEL_CREDENTIAL_KEY)' })
        return
      }
      console.error('[connectors] store-credentials failed:', err)
      res.status(500).json({ error: 'Failed to store credentials' })
    }
  })

  // ── POST /instances/:id/connect — mark a specific instance connected ──
  router.post('/instances/:id/connect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { id } = req.params
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid instance id' }); return }
    try {
      const updated = await connectorInstanceStore.update(userId, id, { connected: true })
      if (!updated) { res.status(404).json({ error: 'Connector instance not found' }); return }
      res.json({ ok: true, connectorInstanceId: updated.id })
    } catch (err) {
      console.error('[connectors] instance connect failed:', err)
      res.status(500).json({ error: 'Failed to connect' })
    }
  })

  // ── POST /:provider/connect — mark the primary instance connected ──
  // For built-ins this is the non-OAuth/reconnect path; OAuth connectors go
  // through store-credentials after the client-side authorize redirect.
  router.post('/:provider/connect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const row = await connectorStore.setConnected(userId, req.params.provider, true)
      if (!row) { res.status(404).json({ error: 'Connector not found (connect it first)' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('[connectors] connect failed:', err)
      res.status(500).json({ error: 'Failed to connect' })
    }
  })

  // ── POST /:provider/disconnect — flip the primary instance offline ──
  router.post('/:provider/disconnect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const row = await connectorStore.setConnected(userId, req.params.provider, false)
      if (!row) { res.status(404).json({ error: 'Connector not found' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('[connectors] disconnect failed:', err)
      res.status(500).json({ error: 'Failed to disconnect' })
    }
  })

  // ── PATCH /instances/:id — rename a connector instance ───────
  router.patch('/instances/:id', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { id } = req.params
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid instance id' }); return }
    const label = ((req.body ?? {}) as { label?: string }).label?.trim()
    if (!label) { res.status(400).json({ error: 'label is required' }); return }
    try {
      const updated = await connectorInstanceStore.update(userId, id, { label })
      if (!updated) { res.status(404).json({ error: 'Connector instance not found' }); return }
      res.json({ ok: true, label: updated.label })
    } catch (err) {
      console.error('[connectors] rename failed:', err)
      res.status(500).json({ error: 'Failed to rename connector' })
    }
  })

  // ── DELETE /instances/:id — delete a specific instance ───────
  router.delete('/instances/:id', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { id } = req.params
    if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Invalid instance id' }); return }
    try {
      const deleted = await connectorInstanceStore.delete(userId, id)
      if (!deleted) { res.status(404).json({ error: 'Connector instance not found' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('[connectors] delete instance failed:', err)
      res.status(500).json({ error: 'Failed to delete connector' })
    }
  })

  // ── DELETE /:provider — delete the primary instance (legacy shim) ──
  router.delete('/:provider', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const deleted = await connectorStore.delete(userId, req.params.provider)
      if (!deleted) { res.status(404).json({ error: 'Connector not found' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('[connectors] delete failed:', err)
      res.status(500).json({ error: 'Failed to delete connector' })
    }
  })

  return router
}
