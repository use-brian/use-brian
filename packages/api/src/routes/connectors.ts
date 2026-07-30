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
 *   GET    /api/connectors/:provider/tools          — the connector's tool catalog
 *   GET    /api/connectors/:provider/config         — the connector's JSON config
 *   PATCH  /api/connectors/:provider/config         — merge into the JSON config
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
 * server-side secret via `~/.usebrian/connectors.config.json` (or `*_CLIENT_*`
 * env) for the callback's token exchange, and the public client id via
 * `NEXT_PUBLIC_*_CLIENT_ID` for app-web's client-side authorize redirect. GitHub
 * is PAT-only and needs neither.
 *
 * Custom MCP connectors (`POST/PATCH/DELETE /custom`, `POST /custom/:id/test`)
 * are mounted from the shared `customConnectorRoutes` factory in
 * `./custom-connectors.ts` — the same factory the closed edition mounts, so the
 * feature has one implementation across both editions.
 *
 * Out of scope for the open edition (handled by the closed route): Google Drive
 * authorized-files (`/gdrive/*`) and per-assistant tool policy (`/tools`).
 *
 * Component tag: [COMP:api/connectors-route].
 */

import { Router } from 'express'
import { constants as fsConstants, promises as fs } from 'node:fs'
import * as nodePath from 'node:path'
import { classifyTool, defaultPolicy } from '@use-brian/core'
import { OFFICIAL_CONNECTORS, OFFICIAL_CONNECTOR_TOOLS, type ConnectorEntry } from '@use-brian/shared'
import type { ConnectorStore, ConnectorCredentials } from '../db/connector-store.js'
import type { ConnectorInstanceStore, ConnectorInstance, ConnectorHealthStatus } from '../db/connector-instance-store.js'
import { buildConnectorAuthHeaders } from '../mcp/auth-headers.js'
import { customConnectorRoutes } from './custom-connectors.js'
import { validateGcsByoBinding } from '../files/gcs-byo-validate.js'
import type { GcsServiceAccountCredentials } from '../files/gcs-client.js'
import { validateS3ByoBinding } from '../files/s3-byo-validate.js'
import type { S3Credentials } from '../files/s3-client.js'
import { normalizeShopDomain, packShopifyTokens, packShopifyAppCredentials, unpackShopifyAppCredentials, getShopIdentity } from '../shopify/client.js'
import { resolveShopifyDomain, type ShopifyDomainResolution } from '../shopify/resolve-domain.js'
import { DESKTOP_OAUTH_EXCHANGERS, type DesktopOAuthExchangeResult } from '../connectors/desktop-oauth-exchange.js'
import { resolveMailboxPreset } from '../mailbox/presets.js'
import { verifyMailboxConnection } from '../mailbox/verify.js'
import { probeMailboxFolders } from '../mailbox/probe.js'
import { readMailboxSyncState, type MailboxBackfillScope, type MailboxSyncState } from '../mailbox/sync-worker.js'
import { getGlobalMailboxSyncDeps } from '../mailbox/sync-tool.js'
import { countEmailArchiveMessages } from '../db/email-archive-store.js'
import type { MailboxAccountSettings } from '../mailbox/types.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const OFFICIAL_BY_ID = new Map<string, ConnectorEntry>(OFFICIAL_CONNECTORS.map((c) => [c.id, c]))

// Channel infrastructure uses connector_instance for credentials/attribution,
// but these rows are managed in Studio -> Channels and expose no assistant
// tool catalog. Do not leak them into Studio -> Connectors as empty connectors.
const CHANNEL_INFRASTRUCTURE_PROVIDERS = new Set(['whatsapp'])

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
  /** Pipeline-C state; drives the stronger removal confirmation in Studio. */
  ingestionEnabled?: boolean
  custom?: boolean
  url?: string
  oauthRequired?: boolean
  category?: 'official' | 'community'
  connectedEmail?: string
  /**
   * Liveness (migration 294). 'auth_failed' means the credentials stopped
   * working (a 401/403 at call time) and the connector needs reconnecting even
   * though `connected` is still true. Drives the "Reconnect needed" UI state.
   */
  healthStatus?: ConnectorHealthStatus
}

type ConnectorRouteOptions = {
  connectorStore: ConnectorStore
  connectorInstanceStore: ConnectorInstanceStore
  /**
   * Enables the workspace-scoped bring-your-own GCS storage endpoints
   * (`/gcs/connect`, `/gcs/disconnect`). Omitted → those routes 404.
   */
  gcsByo?: {
    /** True iff the user is owner/admin of the workspace. */
    requireWorkspaceAdmin: (userId: string, workspaceId: string) => Promise<boolean>
    /** Validate-on-connect override (test seam). Defaults to the real probe. */
    validate?: typeof validateGcsByoBinding
  }
  /**
   * Enables the workspace-scoped bring-your-own S3 storage endpoints
   * (`/s3/connect`, `/s3/disconnect`). Omitted → those routes 404. Sibling of
   * `gcsByo`. See docs/plans/byo-s3-storage.md.
   */
  s3Byo?: {
    /** True iff the user is owner/admin of the workspace. */
    requireWorkspaceAdmin: (userId: string, workspaceId: string) => Promise<boolean>
    /** Validate-on-connect override (test seam). Defaults to the real probe. */
    validate?: typeof validateS3ByoBinding
  }
  /**
   * Test seams for the company-mailbox (`imap`) endpoints
   * (`/imap/resolve`, `/imap/connect`). The routes always mount — the
   * connector is outbound-only and edition-independent
   * (docs/architecture/integrations/mailbox-imap.md); defaults hit the network.
   */
  imapMailbox?: {
    verify?: typeof verifyMailboxConnection
    resolvePreset?: typeof resolveMailboxPreset
    probe?: typeof probeMailboxFolders
    countArchive?: typeof countEmailArchiveMessages
  }
  localStorage?: {
    requireWorkspaceAdmin: (userId: string, workspaceId: string) => Promise<boolean>
  }
  /**
   * Test seam for `/shopify/resolve-domain` (branded domain → myshopify host).
   * Defaults to the real SSRF-guarded probe. See `../shopify/resolve-domain.ts`.
   */
  shopifyResolveDomain?: typeof resolveShopifyDomain
  /**
   * Test seam for the verify-before-store probe on a pasted Shopify token
   * (`store-credentials`). Defaults to the real Admin API `shop { name
   * myshopifyDomain }` call. See docs/architecture/integrations/shopify.md
   * → "Auth model".
   */
  shopifyVerifyToken?: typeof getShopIdentity
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

/**
 * Persist resolved credentials onto a connector_instance — the shared store step
 * behind both `store-credentials` (credential handed in from the web callback)
 * and `exchange-and-store` (credential just minted from an OAuth code on the
 * desktop loopback path). One code path, three write intents:
 *   createNew    → mint a fresh instance (multi-account "add another")
 *   instanceId   → re-point an EXISTING instance's credential (re-auth)
 *   primary      → update the first matching instance or create it
 * Throws on infra failure (e.g. CHANNEL_CREDENTIAL_KEY unset) so the caller maps
 * it to 503; returns a discriminated 404 for a missing reconnect target.
 */
async function persistConnectorInstance(opts: {
  store: ConnectorInstanceStore
  userId: string
  provider: string
  fallbackLabel: string
  credentials: ConnectorCredentials
  email: string | null
  label: string | undefined
  configPatch: Record<string, unknown> | null
  createNew?: boolean
  instanceId?: string
}): Promise<{ ok: true; connectorInstanceId: string } | { ok: false; status: 404; error: string }> {
  const { store, userId, provider, fallbackLabel, credentials, email, label, configPatch } = opts

  if (opts.createNew) {
    const created = await store.createUserInstance({
      userId, provider, label: label ?? fallbackLabel, connectedEmail: email, connected: true, credentials,
      ...(configPatch ? { config: configPatch } : {}),
    })
    return { ok: true, connectorInstanceId: created.id }
  }

  if (opts.instanceId) {
    const updated = await store.update(userId, opts.instanceId, {
      connected: true, connectedEmail: email, credentials, ...(label ? { label } : {}),
    })
    if (!updated) return { ok: false, status: 404, error: 'Connector instance not found' }
    if (configPatch) await store.setConfig(userId, updated.id, configPatch)
    return { ok: true, connectorInstanceId: updated.id }
  }

  const existing = (await store.listByUser(userId, userId)).find((i) => i.provider === provider)
  if (existing) {
    const updated = await store.update(userId, existing.id, {
      connected: true, connectedEmail: email, credentials, ...(label ? { label } : {}),
    })
    if (configPatch) await store.setConfig(userId, existing.id, configPatch)
    return { ok: true, connectorInstanceId: updated?.id ?? existing.id }
  }

  const created = await store.createUserInstance({
    userId, provider, label: label ?? fallbackLabel, connectedEmail: email, connected: true, credentials,
    ...(configPatch ? { config: configPatch } : {}),
  })
  return { ok: true, connectorInstanceId: created.id }
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
    addable: entry.auth_type !== 'none' && !entry.single_instance,
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
    addable: entry ? entry.auth_type !== 'none' && !entry.single_instance : false,
    description: entry?.description,
    connected: inst.connected,
    ingestionEnabled: inst.ingestionEnabled,
    custom: inst.custom,
    url: inst.url ?? undefined,
    oauthRequired: entry?.oauth_required,
    category: entry ? entry.category : 'community',
    connectedEmail: inst.connectedEmail ?? undefined,
    healthStatus: inst.healthStatus,
  }
}

export function connectorRoutes(opts: ConnectorRouteOptions): Router {
  const { connectorStore, connectorInstanceStore } = opts
  const router = Router()

  // Custom MCP connector CRUD. Mounted FIRST so the literal `/custom` and
  // `/custom/:id` paths resolve before the `/:provider` catch-all routes below
  // (otherwise `/custom/:id` would be captured by `DELETE /:provider`).
  router.use(customConnectorRoutes({ connectorStore }))

  // ── Bring-your-own GCS storage (workspace-scoped) ──────────────
  //
  // Unlike the rest of this user-scoped router, the `gcs` connector binds at
  // the WORKSPACE level (storage must outlive any member) and validates the
  // supplied service-account key against the bucket before persisting.
  // See docs/plans/byo-google-storage.md.

  /** Parse the SA key (object or JSON string); null on malformed input. */
  function parseServiceAccountKey(raw: unknown): GcsServiceAccountCredentials | null {
    let obj: unknown = raw
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw) } catch { return null }
    }
    if (!obj || typeof obj !== 'object') return null
    if (typeof (obj as Record<string, unknown>).client_email !== 'string') return null
    return obj as GcsServiceAccountCredentials
  }

  router.post('/gcs/connect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const gcsByo = opts.gcsByo
    if (!gcsByo) { res.status(404).json({ error: 'GCS storage connector not available' }); return }

    const body = (req.body ?? {}) as { workspaceId?: string; serviceAccountKey?: unknown; bucket?: string; projectId?: string }
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    const bucket = typeof body.bucket === 'string' ? body.bucket.trim() : ''
    if (!UUID_RE.test(workspaceId)) { res.status(400).json({ error: 'Invalid workspaceId' }); return }
    if (!bucket) { res.status(400).json({ error: 'Missing bucket' }); return }

    if (!(await gcsByo.requireWorkspaceAdmin(userId, workspaceId))) {
      res.status(403).json({ error: 'Workspace owner or admin required' }); return
    }

    const key = parseServiceAccountKey(body.serviceAccountKey)
    if (!key) { res.status(400).json({ error: 'Invalid service account key JSON' }); return }
    const projectId =
      (typeof body.projectId === 'string' && body.projectId.trim()) ||
      (typeof key.project_id === 'string' ? key.project_id : undefined) ||
      undefined

    // Validate-on-connect: prove write/read/delete works before we trust it.
    const check = await (gcsByo.validate ?? validateGcsByoBinding)({ credentials: key, bucket, projectId })
    if (!check.ok) {
      res.status(400).json({ error: 'validation_failed', code: check.code, message: check.message }); return
    }

    const credentials: ConnectorCredentials = { type: 'gcs', serviceAccountKey: key, bucket, ...(projectId ? { projectId } : {}) }
    // `disconnectedAt: null` clears any prior soft-disconnect marker on reconnect.
    const config = { bucket, ...(projectId ? { projectId } : {}), disconnectedAt: null }

    try {
      const existing = await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 'gcs')
      if (existing) {
        await connectorInstanceStore.update(userId, existing.id, { connected: true, credentials })
        await connectorInstanceStore.setConfigSystem(existing.id, config)
        res.json({ ok: true, connectorInstanceId: existing.id }); return
      }
      const created = await connectorInstanceStore.createWorkspaceInstance({
        workspaceId,
        provider: 'gcs',
        label: 'Google Cloud Storage',
        connected: true,
        credentials,
        config,
        createdBy: userId,
      })
      res.json({ ok: true, connectorInstanceId: created.id })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('CHANNEL_CREDENTIAL_KEY')) {
        res.status(503).json({ error: 'Connector credential storage is not configured (CHANNEL_CREDENTIAL_KEY)' }); return
      }
      console.error('[connectors] gcs connect failed:', err)
      res.status(500).json({ error: 'Failed to connect GCS storage' })
    }
  })

  router.post('/gcs/disconnect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const gcsByo = opts.gcsByo
    if (!gcsByo) { res.status(404).json({ error: 'GCS storage connector not available' }); return }

    const body = (req.body ?? {}) as { workspaceId?: string }
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    if (!UUID_RE.test(workspaceId)) { res.status(400).json({ error: 'Invalid workspaceId' }); return }
    if (!(await gcsByo.requireWorkspaceAdmin(userId, workspaceId))) {
      res.status(403).json({ error: 'Workspace owner or admin required' }); return
    }

    try {
      const existing = await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 'gcs')
      if (!existing) { res.json({ ok: true }); return }
      // Disconnect = drop their key entirely (zero standing access). New writes
      // revert to the app default bucket and their BYO-bucket files go dormant
      // (unreadable without the key). We KEEP the workspace_files index rows so
      // a reconnect (re-supplying the key) revives them. `disconnectedAt` arms
      // the staleness sweep, which retracts the dormant rows if no reconnect
      // happens within the grace window. The bucket lives in `config` (non-
      // secret) so the sweep can target it after the key is gone.
      await connectorInstanceStore.update(userId, existing.id, { connected: false, credentials: { type: 'none' } })
      await connectorInstanceStore.setConfigSystem(existing.id, { disconnectedAt: new Date().toISOString() })
      res.json({ ok: true })
    } catch (err) {
      console.error('[connectors] gcs disconnect failed:', err)
      res.status(500).json({ error: 'Failed to disconnect GCS storage' })
    }
  })

  // ── Bring-your-own S3-compatible storage (workspace-scoped) ────
  //
  // Sibling of the `gcs` connector above: same workspace-level binding and
  // validate-on-connect flow, but authenticates with an access-key/secret-key
  // pair against any S3-compatible bucket (AWS S3, MinIO, R2, B2, …).
  // See docs/plans/byo-s3-storage.md.

  router.post('/s3/connect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const s3Byo = opts.s3Byo
    if (!s3Byo) { res.status(404).json({ error: 'S3 storage connector not available' }); return }

    const body = (req.body ?? {}) as {
      workspaceId?: string
      accessKeyId?: string
      secretAccessKey?: string
      bucket?: string
      region?: string
      endpoint?: string
      forcePathStyle?: boolean
    }
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    const bucket = typeof body.bucket === 'string' ? body.bucket.trim() : ''
    const accessKeyId = typeof body.accessKeyId === 'string' ? body.accessKeyId.trim() : ''
    const secretAccessKey = typeof body.secretAccessKey === 'string' ? body.secretAccessKey : ''
    const region = typeof body.region === 'string' && body.region.trim() ? body.region.trim() : undefined
    const endpoint = typeof body.endpoint === 'string' && body.endpoint.trim() ? body.endpoint.trim() : undefined
    const forcePathStyle = typeof body.forcePathStyle === 'boolean' ? body.forcePathStyle : undefined
    if (!UUID_RE.test(workspaceId)) { res.status(400).json({ error: 'Invalid workspaceId' }); return }
    if (!bucket) { res.status(400).json({ error: 'Missing bucket' }); return }
    if (!accessKeyId || !secretAccessKey) { res.status(400).json({ error: 'Missing access key or secret key' }); return }

    if (!(await s3Byo.requireWorkspaceAdmin(userId, workspaceId))) {
      res.status(403).json({ error: 'Workspace owner or admin required' }); return
    }

    const accessKey: S3Credentials = { accessKeyId, secretAccessKey }

    // Validate-on-connect: prove write/read/delete works before we trust it.
    const check = await (s3Byo.validate ?? validateS3ByoBinding)({ credentials: accessKey, bucket, region, endpoint, forcePathStyle })
    if (!check.ok) {
      res.status(400).json({ error: 'validation_failed', code: check.code, message: check.message }); return
    }

    const credentials: ConnectorCredentials = {
      type: 's3',
      accessKey,
      bucket,
      ...(region ? { region } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
    }
    // `disconnectedAt: null` clears any prior soft-disconnect marker on reconnect.
    // Only non-secret bits live in config (the sweep targets the bucket after the key is gone).
    const config = {
      bucket,
      ...(region ? { region } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
      disconnectedAt: null,
    }

    try {
      const existing = await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 's3')
      if (existing) {
        await connectorInstanceStore.update(userId, existing.id, { connected: true, credentials })
        await connectorInstanceStore.setConfigSystem(existing.id, config)
        res.json({ ok: true, connectorInstanceId: existing.id }); return
      }
      const created = await connectorInstanceStore.createWorkspaceInstance({
        workspaceId,
        provider: 's3',
        label: 'S3-Compatible Storage',
        connected: true,
        credentials,
        config,
        createdBy: userId,
      })
      res.json({ ok: true, connectorInstanceId: created.id })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('CHANNEL_CREDENTIAL_KEY')) {
        res.status(503).json({ error: 'Connector credential storage is not configured (CHANNEL_CREDENTIAL_KEY)' }); return
      }
      console.error('[connectors] s3 connect failed:', err)
      res.status(500).json({ error: 'Failed to connect S3 storage' })
    }
  })

  router.post('/s3/disconnect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const s3Byo = opts.s3Byo
    if (!s3Byo) { res.status(404).json({ error: 'S3 storage connector not available' }); return }

    const body = (req.body ?? {}) as { workspaceId?: string }
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    if (!UUID_RE.test(workspaceId)) { res.status(400).json({ error: 'Invalid workspaceId' }); return }
    if (!(await s3Byo.requireWorkspaceAdmin(userId, workspaceId))) {
      res.status(403).json({ error: 'Workspace owner or admin required' }); return
    }

    try {
      const existing = await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 's3')
      if (!existing) { res.json({ ok: true }); return }
      // Disconnect = drop their keys entirely (zero standing access). New writes
      // revert to the app default bucket and their BYO-bucket files go dormant
      // (unreadable without the keys). We KEEP the workspace_files index rows so
      // a reconnect (re-supplying the keys) revives them. `disconnectedAt` arms
      // the staleness sweep, which retracts the dormant rows if no reconnect
      // happens within the grace window. The bucket lives in `config` (non-
      // secret) so the sweep can target it after the keys are gone.
      await connectorInstanceStore.update(userId, existing.id, { connected: false, credentials: { type: 'none' } })
      await connectorInstanceStore.setConfigSystem(existing.id, { disconnectedAt: new Date().toISOString() })
      res.json({ ok: true })
    } catch (err) {
      console.error('[connectors] s3 disconnect failed:', err)
      res.status(500).json({ error: 'Failed to disconnect S3 storage' })
    }
  })

  // ── Local directory storage (workspace-scoped) ──────────────

  router.post('/local/connect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const localStorage = opts.localStorage
    if (!localStorage) { res.status(404).json({ error: 'Local storage connector not available' }); return }

    const body = (req.body ?? {}) as { workspaceId?: string; path?: string }
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    const dirPath = typeof body.path === 'string' ? body.path.trim() : ''
    if (!UUID_RE.test(workspaceId)) { res.status(400).json({ error: 'Invalid workspaceId' }); return }
    if (!dirPath) { res.status(400).json({ error: 'Missing path' }); return }

    if (!(await localStorage.requireWorkspaceAdmin(userId, workspaceId))) {
      res.status(403).json({ error: 'Workspace owner or admin required' }); return
    }

    const requestedPath = nodePath.resolve(dirPath)
    const resolvedPath = await fs.realpath(requestedPath).catch(() => null)
    if (!resolvedPath) {
      res.status(400).json({ error: 'Directory does not exist or is not writable' }); return
    }
    try {
      const stat = await fs.stat(resolvedPath)
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' }); return
      }
      await fs.access(resolvedPath, fsConstants.W_OK)
    } catch {
      res.status(400).json({ error: 'Directory does not exist or is not writable' }); return
    }

    const credentials: ConnectorCredentials = { type: 'local', path: resolvedPath }
    const config = { path: resolvedPath, disconnectedAt: null }

    try {
      const existing = await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 'local')
      if (existing) {
        await connectorInstanceStore.update(userId, existing.id, { connected: true, credentials })
        await connectorInstanceStore.setConfigSystem(existing.id, config)
        res.json({ ok: true, connectorInstanceId: existing.id }); return
      }
      const created = await connectorInstanceStore.createWorkspaceInstance({
        workspaceId,
        provider: 'local',
        label: 'Local Directory Storage',
        connected: true,
        credentials,
        config,
        createdBy: userId,
      })
      res.json({ ok: true, connectorInstanceId: created.id })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('CHANNEL_CREDENTIAL_KEY')) {
        res.status(503).json({ error: 'Connector credential storage is not configured (CHANNEL_CREDENTIAL_KEY)' }); return
      }
      console.error('[connectors] local connect failed:', err)
      res.status(500).json({ error: 'Failed to connect local storage' })
    }
  })

  router.post('/local/disconnect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const localStorage = opts.localStorage
    if (!localStorage) { res.status(404).json({ error: 'Local storage connector not available' }); return }

    const body = (req.body ?? {}) as { workspaceId?: string }
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    if (!UUID_RE.test(workspaceId)) { res.status(400).json({ error: 'Invalid workspaceId' }); return }
    if (!(await localStorage.requireWorkspaceAdmin(userId, workspaceId))) {
      res.status(403).json({ error: 'Workspace owner or admin required' }); return
    }

    try {
      const existing = await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 'local')
      if (!existing) { res.json({ ok: true }); return }
      await connectorInstanceStore.update(userId, existing.id, { connected: false, credentials: { type: 'none' } })
      await connectorInstanceStore.setConfigSystem(existing.id, { disconnectedAt: new Date().toISOString() })
      res.json({ ok: true })
    } catch (err) {
      console.error('[connectors] local disconnect failed:', err)
      res.status(500).json({ error: 'Failed to disconnect local storage' })
    }
  })

  // ── CLI connector (user-scoped, MCP stdio — OSS edition) ────────
  //
  // Connect a local binary that speaks MCP over stdin/stdout. The probe
  // is mandatory (binary is local, spawn is cheap). Multi-instance: each
  // connect creates a fresh instance keyed by label.
  // See docs/architecture/integrations/cli-connector.md.

  router.post('/cli/connect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const body = (req.body ?? {}) as {
      label?: string
      binaryPath?: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
      timeoutMs?: number
    }
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    const binaryPath = typeof body.binaryPath === 'string' ? body.binaryPath.trim() : ''
    if (!label) { res.status(400).json({ error: 'Missing label (connector name)' }); return }
    if (!binaryPath) { res.status(400).json({ error: 'Missing binaryPath' }); return }
    if (!nodePath.isAbsolute(binaryPath)) { res.status(400).json({ error: 'binaryPath must be absolute' }); return }

    const { isShellBinary, validateCliArgs, validateCliEnv, normalizeCliTimeout, discoverCliServer } = await import('../mcp/cli-transport.js')
    if (isShellBinary(binaryPath)) {
      res.status(400).json({ error: 'Shell binaries are not allowed. The CLI connector is for MCP servers.' }); return
    }

    const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === 'string') : []
    const argsError = validateCliArgs(args)
    if (argsError) { res.status(400).json({ error: argsError }); return }
    const envError = validateCliEnv(body.env)
    if (envError) { res.status(400).json({ error: envError }); return }
    let timeoutMs: number | undefined
    try { timeoutMs = normalizeCliTimeout(body.timeoutMs) }
    catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); return }
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined
    if (cwd && !nodePath.isAbsolute(cwd)) { res.status(400).json({ error: 'cwd must be absolute' }); return }

    try {
      const stat = await fs.stat(binaryPath)
      if (!stat.isFile()) { res.status(400).json({ error: 'binaryPath is not a regular file' }); return }
      await fs.access(binaryPath, fsConstants.X_OK)
    } catch {
      res.status(400).json({ error: 'Binary does not exist or is not executable' }); return
    }
    if (cwd) {
      try {
        const stat = await fs.stat(cwd)
        if (!stat.isDirectory()) { res.status(400).json({ error: 'cwd is not a directory' }); return }
      } catch { res.status(400).json({ error: 'cwd does not exist' }); return }
    }

    const env = body.env as Record<string, string> | undefined
    const serverParams = { binaryPath, args: args.length > 0 ? args : undefined, env, cwd, timeoutMs }
    try {
      const server = await Promise.race([
        discoverCliServer(serverParams, label),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('probe-timeout')), 10_000),
        ),
      ])

      const credentials: ConnectorCredentials = { type: 'cli', binaryPath, args: args.length > 0 ? args : undefined }
      const config: Record<string, unknown> = { binaryPath }
      if (env) config.env = env
      if (cwd) config.cwd = cwd
      if (timeoutMs) config.timeoutMs = timeoutMs

      const created = await connectorInstanceStore.createUserInstance({
        userId,
        provider: 'cli',
        label,
        connected: true,
        credentials,
        config,
      })

      res.json({
        ok: true,
        connectorInstanceId: created.id,
        toolCount: server.tools.length,
        tools: server.tools.map((t) => ({ name: t.name, description: t.description })),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'probe-timeout') {
        res.status(400).json({ error: 'Binary does not speak MCP stdio: connection timed out' }); return
      }
      if (msg.includes('CHANNEL_CREDENTIAL_KEY')) {
        res.status(503).json({ error: 'Connector credential storage is not configured (CHANNEL_CREDENTIAL_KEY)' }); return
      }
      res.status(400).json({ error: `Binary does not speak MCP stdio: ${msg.slice(0, 200)}` })
    }
  })

  router.get('/cli/:id', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const instance = await connectorInstanceStore.get(userId, req.params.id)
      if (!instance || instance.provider !== 'cli') {
        res.status(404).json({ error: 'CLI connector not found' }); return
      }
      const credentials = await connectorInstanceStore.getAuthCredentials(userId, instance.id)
      if (credentials?.type !== 'cli') {
        res.status(409).json({ error: 'CLI connector credentials are missing or invalid' }); return
      }
      const env = instance.config?.env
      res.json({
        connector: {
          id: instance.id,
          label: instance.label,
          binaryPath: credentials.binaryPath,
          args: credentials.args ?? [],
          cwd: typeof instance.config?.cwd === 'string' ? instance.config.cwd : '',
          timeoutMs: typeof instance.config?.timeoutMs === 'number' ? instance.config.timeoutMs : 30_000,
          envKeys: env && typeof env === 'object' && !Array.isArray(env) ? Object.keys(env) : [],
        },
      })
    } catch (err) {
      console.error('[connectors] CLI config read failed:', err)
      res.status(500).json({ error: 'Failed to load CLI connector' })
    }
  })

  router.patch('/cli/:id', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const instanceId = req.params.id
    const body = (req.body ?? {}) as {
      label?: string
      binaryPath?: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
      timeoutMs?: number
    }

    try {
      const instances = await connectorInstanceStore.listByUserSystem(userId)
      const existing = instances.find((i) => i.id === instanceId && i.provider === 'cli')
      if (!existing) { res.status(404).json({ error: 'CLI connector not found' }); return }

      const { isShellBinary, validateCliArgs, validateCliEnv, normalizeCliTimeout, discoverCliServer } = await import('../mcp/cli-transport.js')

      const storedCredentials = await connectorInstanceStore.getAuthCredentials(userId, instanceId)
      if (storedCredentials?.type !== 'cli') {
        res.status(409).json({ error: 'CLI connector credentials are missing or invalid' }); return
      }
      let binaryPath = storedCredentials.binaryPath
      let args = storedCredentials.args ?? []
      let label = existing.label
      const config: Record<string, unknown> = { ...existing.config }

      if (typeof body.label === 'string' && body.label.trim()) label = body.label.trim()
      if (typeof body.binaryPath === 'string' && body.binaryPath.trim()) {
        binaryPath = body.binaryPath.trim()
        if (!nodePath.isAbsolute(binaryPath)) { res.status(400).json({ error: 'binaryPath must be absolute' }); return }
        if (isShellBinary(binaryPath)) { res.status(400).json({ error: 'Shell binaries are not allowed' }); return }
        try {
          const stat = await fs.stat(binaryPath)
          if (!stat.isFile()) { res.status(400).json({ error: 'binaryPath is not a regular file' }); return }
          await fs.access(binaryPath, fsConstants.X_OK)
        } catch { res.status(400).json({ error: 'Binary does not exist or is not executable' }); return }
      }
      if (Array.isArray(body.args)) {
        args = body.args.filter((a): a is string => typeof a === 'string')
        const argsError = validateCliArgs(args)
        if (argsError) { res.status(400).json({ error: argsError }); return }
      }

      const envError = validateCliEnv(body.env)
      if (envError) { res.status(400).json({ error: envError }); return }
      if (body.env !== undefined) config.env = body.env
      if (body.cwd !== undefined) {
        const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
        if (cwd && !nodePath.isAbsolute(cwd)) { res.status(400).json({ error: 'cwd must be absolute' }); return }
        if (cwd) {
          try {
            const stat = await fs.stat(cwd)
            if (!stat.isDirectory()) { res.status(400).json({ error: 'cwd is not a directory' }); return }
          } catch { res.status(400).json({ error: 'cwd does not exist' }); return }
          config.cwd = cwd
        } else {
          delete config.cwd
        }
      }
      if (body.timeoutMs !== undefined) {
        try { config.timeoutMs = normalizeCliTimeout(body.timeoutMs) }
        catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); return }
      }

      config.binaryPath = binaryPath
      const launchChanged = body.binaryPath !== undefined || body.args !== undefined || body.env !== undefined || body.cwd !== undefined
      if (launchChanged) {
        const serverParams = {
          binaryPath,
          args: args.length > 0 ? args : undefined,
          env: config.env as Record<string, string> | undefined,
          cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
          timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
        }
        await Promise.race([
          discoverCliServer(serverParams, label),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Binary does not speak MCP stdio: connection timed out')), 10_000),
          ),
        ])
      }

      const credentials: ConnectorCredentials = { type: 'cli', binaryPath, args: args.length > 0 ? args : undefined }

      await connectorInstanceStore.update(userId, instanceId, { label, connected: true, credentials })
      await connectorInstanceStore.setConfigSystem(instanceId, config)

      res.json({ ok: true, connectorInstanceId: instanceId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('timed out') || msg.includes('MCP')) {
        res.status(400).json({ error: msg.slice(0, 200) }); return
      }
      console.error('[connectors] cli update failed:', err)
      res.status(500).json({ error: 'Failed to update CLI connector' })
    }
  })

  // ── Company mailbox (user-scoped `imap` connector) ─────────────
  //
  // Credential-entry connect with an MX-resolved preset (D1) and a LIVE
  // IMAP login + SMTP verify BEFORE anything is stored — green check or a
  // named error, never a stored-but-dead credential (plan §4). Multi-account
  // (D11 retired): a user connects several corporate mailboxes; connect keys on
  // the address, so the same email RECONNECTS (updates) and a new email ADDS.
  // The `/imap/*` status routes take an optional `instanceId` to target one
  // mailbox; omitted = the primary (first-connected). Generic
  // `/:provider/disconnect` and `DELETE /:provider` cover teardown.
  // See docs/architecture/integrations/mailbox-imap.md.

  /** MX → preset resolution for the connect dialog's on-blur detection. */
  router.post('/imap/resolve', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const email = typeof (req.body ?? {}).email === 'string' ? (req.body as { email: string }).email.trim() : ''
    if (!email.includes('@')) { res.status(400).json({ error: 'Invalid email' }); return }
    const resolvePreset = opts.imapMailbox?.resolvePreset ?? resolveMailboxPreset
    const preset = await resolvePreset(email)
    res.json({ preset })
  })

  router.post('/imap/connect', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const body = (req.body ?? {}) as {
      email?: string
      appPassword?: string
      imapHost?: string
      imapPort?: number
      smtpHost?: string
      smtpPort?: number
    }
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const appPassword = typeof body.appPassword === 'string' ? body.appPassword : ''
    if (!email.includes('@')) { res.status(400).json({ error: 'Invalid email' }); return }
    if (!appPassword) { res.status(400).json({ error: 'Missing app password' }); return }

    const validPort = (p: unknown): p is number => typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536
    let settings: MailboxAccountSettings
    if (typeof body.imapHost === 'string' && body.imapHost.trim() && validPort(body.imapPort) &&
        typeof body.smtpHost === 'string' && body.smtpHost.trim() && validPort(body.smtpPort)) {
      settings = {
        email, appPassword,
        imapHost: body.imapHost.trim(), imapPort: body.imapPort,
        smtpHost: body.smtpHost.trim(), smtpPort: body.smtpPort,
      }
    } else {
      const resolvePreset = opts.imapMailbox?.resolvePreset ?? resolveMailboxPreset
      const preset = await resolvePreset(email)
      if (!preset) {
        // Unrecognized MX and no explicit hosts — the dialog expands Advanced.
        res.status(400).json({ error: 'hosts_required' })
        return
      }
      settings = {
        email, appPassword,
        imapHost: preset.imapHost, imapPort: preset.imapPort,
        smtpHost: preset.smtpHost, smtpPort: preset.smtpPort,
      }
    }

    const verify = opts.imapMailbox?.verify ?? verifyMailboxConnection
    const check = await verify(settings)
    if (!check.ok) {
      res.status(400).json({ error: 'verification_failed', code: check.code, message: check.message })
      return
    }

    const credentials: ConnectorCredentials = { type: 'imap', ...settings }
    // Sync-on-connect: fire-and-forget a first sync so the archive goes live
    // within seconds instead of the next poll interval (mailbox-imap.md
    // §Phase 2 → "On-demand sync"). Never blocks the connect response; the
    // poller catches up if the seam is unarmed or the sync fails.
    const kickSync = (instanceId: string): void => {
      void getGlobalMailboxSyncDeps()?.syncInstanceById(instanceId).catch((err) => {
        console.warn('[connectors] imap sync-on-connect failed (poller will catch up):', err instanceof Error ? err.message : String(err))
      })
    }
    try {
      // Key on the address: the SAME mailbox reconnects (update, so a rotated
      // app password refreshes in place), a NEW address adds another instance
      // (multi-account, D11 retired). Preserves the user's label if renamed.
      const wantedEmail = email.trim().toLowerCase()
      const existing = (await connectorInstanceStore.listByUser(userId, userId))
        .find((i) => i.provider === 'imap' && (i.connectedEmail ?? '').trim().toLowerCase() === wantedEmail)
      if (existing) {
        const updated = await connectorInstanceStore.update(userId, existing.id, {
          connected: true,
          connectedEmail: email,
          credentials,
        })
        kickSync(updated?.id ?? existing.id)
        res.json({ ok: true, connectorInstanceId: updated?.id ?? existing.id })
        return
      }
      const created = await connectorInstanceStore.createUserInstance({
        userId,
        provider: 'imap',
        label: email,
        connectedEmail: email,
        connected: true,
        credentials,
      })
      kickSync(created.id)
      res.json({ ok: true, connectorInstanceId: created.id })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('CHANNEL_CREDENTIAL_KEY')) {
        res.status(503).json({ error: 'Connector credential storage is not configured (CHANNEL_CREDENTIAL_KEY)' })
        return
      }
      console.error('[connectors] imap connect failed:', err)
      res.status(500).json({ error: 'Failed to connect the mailbox' })
    }
  })

  /**
   * Resolve one of the caller's connected imap instances + decrypted settings.
   * `instanceId` targets a specific mailbox (ownership-checked via the
   * user-scoped list); omitted resolves the primary (first-connected). Returns
   * null when the caller has no such connected mailbox.
   */
  async function resolveImapInstance(userId: string, instanceId?: string): Promise<
    { instance: ConnectorInstance; settings: MailboxAccountSettings } | null
  > {
    const connected = (await connectorInstanceStore.listByUser(userId, userId))
      .filter((i) => i.provider === 'imap' && i.connected)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    const instance = instanceId
      ? connected.find((i) => i.id === instanceId)
      : connected[0]
    if (!instance) return null
    const creds = await connectorInstanceStore.getAuthCredentialsSystem(instance.id)
    if (!creds || creds.type !== 'imap') return null
    const { type: _t, ...settings } = creds
    return { instance, settings }
  }

  /** The optional `instanceId` targeting query/body param on the `/imap/*` status routes. */
  const readInstanceId = (v: unknown): string | undefined =>
    typeof v === 'string' && UUID_RE.test(v) ? v : undefined

  // Connected-card status: archive counts + sync/backfill cursor state. No
  // IMAP round-trip — safe to poll.
  router.get('/imap/sync-status', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const resolved = await resolveImapInstance(userId, readInstanceId(req.query.instanceId))
      if (!resolved) { res.status(404).json({ error: 'No connected mailbox' }); return }
      const state = readMailboxSyncState(resolved.instance.config)
      const countArchive = opts.imapMailbox?.countArchive ?? countEmailArchiveMessages
      const counts = await countArchive(resolved.instance.id)
      res.json({
        instanceId: resolved.instance.id,
        email: resolved.instance.connectedEmail ?? resolved.settings.email,
        archived: counts.total,
        byFolder: counts.byFolder,
        backfill: state.backfill ?? null,
        lastSyncAt: state.lastSyncAt ?? null,
        lastError: state.lastError ?? null,
        ingestionEnabled: resolved.instance.ingestionEnabled,
      })
    } catch (err) {
      console.error('[connectors] imap sync-status failed:', err)
      res.status(500).json({ error: 'Failed to read sync status' })
    }
  })

  // D9 pre-flight: cheap per-folder STATUS counts (~1s), never the expensive
  // work. The consent dialog quotes these before any backfill is armed.
  router.post('/imap/backfill/preflight', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const resolved = await resolveImapInstance(userId, readInstanceId((req.body ?? {}).instanceId))
      if (!resolved) { res.status(404).json({ error: 'No connected mailbox' }); return }
      const probe = opts.imapMailbox?.probe ?? probeMailboxFolders
      const result = await probe(resolved.settings)
      res.json(result)
    } catch (err) {
      console.error('[connectors] imap backfill preflight failed:', err)
      res.status(500).json({ error: 'Failed to probe the mailbox' })
    }
  })

  // Arm the archive backfill AFTER the user confirmed a scope (D9). The sync
  // worker walks it newest-first, checkpointed per folder; historical mail
  // never reaches the brain (D6). Re-arming resets the per-folder
  // checkpoints (idempotent inserts make a re-walk safe).
  router.post('/imap/backfill', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const scope = (req.body ?? {}).scope as MailboxBackfillScope | undefined
    if (scope !== '12m' && scope !== '2y' && scope !== 'all') {
      res.status(400).json({ error: 'Invalid scope (12m | 2y | all)' })
      return
    }
    try {
      const resolved = await resolveImapInstance(userId, readInstanceId((req.body ?? {}).instanceId))
      if (!resolved) { res.status(404).json({ error: 'No connected mailbox' }); return }
      const probe = opts.imapMailbox?.probe ?? probeMailboxFolders
      const probed = await probe(resolved.settings)
      const state = readMailboxSyncState(resolved.instance.config)
      const next: MailboxSyncState = {
        ...state,
        folders: Object.fromEntries(
          Object.entries(state.folders).map(([path, cursor]) => [
            path,
            { uidvalidity: cursor.uidvalidity, lastUid: cursor.lastUid },
          ]),
        ),
        backfill: {
          scope,
          requestedAt: new Date().toISOString(),
          status: 'running',
          // Upper bound shown as "Syncing N of M" — per-scope exact counts
          // would need per-folder date SEARCHes; the STATUS total is the
          // cheap honest ceiling.
          totalEstimate: probed.total,
        },
      }
      await connectorInstanceStore.setConfigSystem(resolved.instance.id, { mailboxSync: next })
      res.json({ ok: true, totalEstimate: probed.total })
    } catch (err) {
      console.error('[connectors] imap backfill arm failed:', err)
      res.status(500).json({ error: 'Failed to start the backfill' })
    }
  })

  /** Group the caller's instances by provider, each list oldest-first. */
  async function instancesByProvider(userId: string): Promise<Map<string, ConnectorInstance[]>> {
    const instances = await connectorInstanceStore.listForUser(userId)
    const byProvider = new Map<string, ConnectorInstance[]>()
    for (const inst of instances) {
      if (CHANNEL_INFRASTRUCTURE_PROVIDERS.has(inst.provider)) continue
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
          addable: entry.auth_type !== 'none' && !entry.single_instance,
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

  // ── GET /workspace/:workspaceId — workspace-scoped connectors + health ──
  //
  // Governance view (migration 294). The engine injects EVERY workspace-scoped
  // connector into this workspace's assistants via `listByWorkspaceSystem`
  // (membership-bypassing), while the personal connector list only shows a
  // member their own rows. This route closes that gap: it lets an owner/admin
  // see - and act on - every connector that is live-to-the-model in their
  // workspace, with its liveness (`healthStatus`), so a dead connector can
  // never be one no member can find. RLS-gated: only workspace members get
  // rows. See docs/architecture/integrations/connector-health.md.
  router.get('/workspace/:workspaceId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params
    if (!UUID_RE.test(workspaceId)) { res.status(400).json({ error: 'Invalid workspace id' }); return }
    try {
      const instances = await connectorInstanceStore.listByWorkspace(userId, workspaceId)
      const connectors = instances
        .filter((inst) => !CHANNEL_INFRASTRUCTURE_PROVIDERS.has(inst.provider))
        .map((inst) => ({
        connectorInstanceId: inst.id,
        provider: inst.provider,
        label: inst.label,
        connected: inst.connected,
        healthStatus: inst.healthStatus,
        lastError: inst.lastError,
        lastCheckedAt: inst.lastCheckedAt,
        }))
      res.json({ connectors })
    } catch (err) {
      console.error('[connectors] workspace connector list failed:', err)
      res.status(500).json({ error: 'Failed to list workspace connectors' })
    }
  })

  // ── GET /:provider/tools — the connector's tool catalog ──────
  // Built-in connectors expose a fixed tool set (OFFICIAL_CONNECTOR_TOOLS).
  // Custom MCP connectors (provider = a generated UUID, not in the registry)
  // are discovered LIVE — the same MCP handshake the `/custom/:id/test` probe
  // runs — so the Studio "Tools" tab shows the same tools the probe counted
  // instead of "No tools found". Policy is the registry/classification default;
  // the per-assistant L2 override store is out of scope for the open route.
  router.get('/:provider/tools', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const provider = req.params.provider

    // CLI catalogs are dynamic and instance-specific. The frontend addresses
    // them by connector_instance UUID so multiple local MCP servers do not
    // overwrite one shared `cli` tool catalog.
    if (UUID_RE.test(provider)) {
      try {
        const instance = await connectorInstanceStore.get(userId, provider)
        if (instance?.provider === 'cli' && instance.connected) {
          const credentials = await connectorInstanceStore.getAuthCredentials(userId, provider)
          if (credentials?.type !== 'cli') {
            res.status(409).json({ error: 'CLI connector credentials are missing or invalid' }); return
          }
          const { discoverCliServer } = await import('../mcp/cli-transport.js')
          const server = await discoverCliServer({
            binaryPath: credentials.binaryPath,
            args: credentials.args,
            env: instance.config?.env as Record<string, string> | undefined,
            cwd: typeof instance.config?.cwd === 'string' ? instance.config.cwd : undefined,
            timeoutMs: typeof instance.config?.timeoutMs === 'number' ? instance.config.timeoutMs : undefined,
          }, instance.label)
          res.json({
            serverName: server.name,
            tools: server.tools.map((t) => {
              const classification = classifyTool(t.name, t.description)
              return {
                name: t.name,
                description: t.description,
                classification,
                policy: defaultPolicy(classification),
              }
            }),
          })
          return
        }
      } catch (err) {
        console.error('[connectors] CLI tool discovery failed:', err)
        res.status(500).json({ error: 'Failed to discover CLI tools' }); return
      }
    }

    // Built-in: static registry catalog.
    const catalog = OFFICIAL_CONNECTOR_TOOLS[provider]
    if (catalog) {
      const entry = OFFICIAL_BY_ID.get(provider)
      res.json({
        serverName: entry?.name ?? provider,
        tools: catalog.map((t) => ({
          name: t.name,
          description: t.description,
          classification: t.classification,
          policy: t.defaultPolicy,
        })),
      })
      return
    }

    // Otherwise it may be a custom MCP connector — discover its tools live.
    try {
      const connector = (await connectorStore.list(userId)).find((c) => c.connectorId === provider)
      if (!connector || !connector.custom || !connector.url) {
        res.json({ serverName: connector?.name ?? provider, tools: [] })
        return
      }
      const { discoverMcpServer } = await import('../mcp/client.js')
      const authCreds = await connectorStore.getAuthCredentials(userId, provider)
      const server = await discoverMcpServer(connector.url, connector.name, buildConnectorAuthHeaders(authCreds))
      res.json({
        serverName: server.name,
        tools: server.tools.map((t) => {
          const classification = classifyTool(t.name, t.description)
          return {
            name: t.name,
            description: t.description,
            classification,
            policy: defaultPolicy(classification),
          }
        }),
      })
    } catch (err) {
      console.error('[connectors] custom tool discovery failed:', err)
      res.status(500).json({ error: 'Failed to discover tools' })
    }
  })

  // ── GET /:provider/config — the connector's JSON config ──────
  router.get('/:provider/config', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const config = await connectorStore.getConfig(userId, req.params.provider)
      res.json({ config })
    } catch (err) {
      console.error('[connectors] get config failed:', err)
      res.status(500).json({ error: 'Failed to load config' })
    }
  })

  // ── PATCH /:provider/config — merge into the JSON config ─────
  router.patch('/:provider/config', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const patch = (req.body ?? {}) as Record<string, unknown>
    try {
      await connectorStore.setConfig(userId, req.params.provider, patch)
      const config = await connectorStore.getConfig(userId, req.params.provider)
      res.json({ config })
    } catch (err) {
      console.error('[connectors] set config failed:', err)
      res.status(500).json({ error: 'Failed to save config' })
    }
  })

  // ── POST /shopify/resolve-domain — branded domain → myshopify host ──
  //
  // The OAuth authorize URL is per-shop and keyed on {handle}.myshopify.com,
  // which merchants rarely know (they only ever see their branded domain).
  // This resolves whatever they type — branded domain, myshopify domain, bare
  // handle, or pasted admin URL — to the canonical host by reading the /admin
  // redirect, SSRF-guarded. The connect dialog calls it on blur. Returns
  // { shopDomain, source: 'direct' | 'redirect' } or a typed error.
  // See docs/architecture/integrations/shopify.md → "Branded-domain resolution".
  router.post('/shopify/resolve-domain', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const input = typeof (req.body ?? {}).input === 'string' ? (req.body as { input: string }).input.trim() : ''
    if (!input) { res.status(400).json({ error: 'invalid_input' }); return }
    const resolve = opts.shopifyResolveDomain ?? resolveShopifyDomain
    let result: ShopifyDomainResolution
    try {
      result = await resolve(input)
    } catch (err) {
      console.error('[connectors] shopify resolve-domain failed:', err)
      res.status(502).json({ error: 'fetch_failed' }); return
    }
    if (!result.ok) {
      // Bad input / private host → 400; a valid host we simply couldn't map to
      // a shop (not-a-store, unreachable) → 422 so the form shows its fallback.
      const status = result.reason === 'invalid_input' || result.reason === 'blocked' ? 400 : 422
      res.status(status).json({ error: result.reason }); return
    }
    res.json({ shopDomain: result.shopDomain, source: result.source })
  })

  // ── Per-merchant Shopify app credentials ──────────────────────────
  //
  // A merchant's own custom-distribution app is capped at one store, so its
  // client id + secret belong to the connector INSTANCE, not to deployment
  // config. See docs/architecture/integrations/shopify.md → "Per-merchant app
  // credentials".

  /** Validate a caller-supplied app pair. Returns null when absent or unusable. */
  function readShopifyAppPair(
    input: { clientId?: string; clientSecret?: string } | undefined,
  ): { clientId: string; clientSecret: string } | null {
    const clientId = input?.clientId?.trim()
    const clientSecret = input?.clientSecret?.trim()
    if (!clientId || !clientSecret) return null
    // Size caps + no CR/LF: these values are interpolated into an authorize URL
    // and used as an HMAC key, so header/URL injection is the shape to block.
    if (clientId.length > 2048 || clientSecret.length > 8192) return null
    if (/[\r\n]/.test(clientId) || /[\r\n]/.test(clientSecret)) return null
    return { clientId, clientSecret }
  }

  /**
   * Re-read the pair already stored on an instance. Load-bearing for reconnects:
   * `store-credentials` rewrites the envelope wholesale, so a call that omits
   * `shopifyApp` would erase the credentials and break refresh + webhook
   * verification — the same whole-blob-rewrite hazard msgraph documents.
   */
  async function loadStoredShopifyAppPair(
    instanceId: string | undefined,
  ): Promise<{ clientId: string; clientSecret: string } | null> {
    if (!instanceId) return null
    try {
      const creds = await connectorInstanceStore.getCredentialsSystem(instanceId)
      const blob = creds?.client_secret
      return typeof blob === 'string' ? unpackShopifyAppCredentials(blob) : null
    } catch (err) {
      console.warn(`[connectors] could not read stored shopify app pair for ${instanceId}:`, err instanceof Error ? err.message : String(err))
      return null
    }
  }

  // POST /shopify/app-credentials — step 1 of the BYO connect: store the
  // merchant's app pair BEFORE the authorize redirect, when no token exists
  // yet. The instance stays `connected: false` until the callback lands a
  // token, so nothing claims a working connection in between.
  router.post('/shopify/app-credentials', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const body = (req.body ?? {}) as {
      shopDomain?: string
      clientId?: string
      clientSecret?: string
      instanceId?: string
    }
    const shopDomain = normalizeShopDomain(body.shopDomain ?? '')
    if (!shopDomain) {
      res.status(400).json({ error: 'invalid_shop_domain' }); return
    }
    const pair = readShopifyAppPair(body)
    if (!pair) {
      res.status(400).json({ error: 'invalid_app_credentials' }); return
    }
    if (body.instanceId !== undefined && !UUID_RE.test(body.instanceId)) {
      res.status(400).json({ error: 'Invalid instanceId' }); return
    }

    const credentials: ConnectorCredentials = {
      type: 'oauth',
      client_id: 'shopify_byo_pending',
      client_secret: packShopifyAppCredentials({
        shopDomain,
        clientId: pair.clientId,
        clientSecret: pair.clientSecret,
      }),
    }

    try {
      if (body.instanceId) {
        await connectorInstanceStore.update(userId, body.instanceId, { credentials, connected: false })
        res.json({ ok: true, connectorInstanceId: body.instanceId })
        return
      }
      const created = await connectorInstanceStore.createUserInstance({
        userId,
        provider: 'shopify',
        label: shopDomain,
        connectedEmail: shopDomain,
        credentials,
        // Not connected: there is no token yet. The webhook routing key is set
        // now so a delivery arriving mid-flow can still resolve this instance.
        connected: false,
        config: { shopDomain },
      })
      res.json({ ok: true, connectorInstanceId: created.id })
    } catch (err) {
      console.error('[connectors] shopify app-credentials failed:', err)
      res.status(500).json({ error: 'store_failed' })
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
      /**
       * Shopify's structured tuple (docs/architecture/integrations/shopify.md):
       * pasted static `shpat_` tokens and OAuth expiring tokens share one
       * envelope, discriminated by the presence of refreshToken + expiresAt.
       */
      shopifyTokens?: { accessToken?: string; refreshToken?: string; expiresAt?: string; shopDomain?: string }
      /**
       * The MERCHANT's own app pair, when this instance connected through their
       * custom-distribution app. Kept separate from `shopifyTokens` at the API
       * boundary because it answers a different question (which app minted this)
       * even though both land in one encrypted envelope.
       * docs/architecture/integrations/shopify.md → "Per-merchant app credentials".
       */
      shopifyApp?: { clientId?: string; clientSecret?: string }
      /**
       * Microsoft Graph's rotating tuple (docs/architecture/integrations/msgraph.md).
       * Graph replaces the refresh token on every use, so access + refresh +
       * expiry must persist together, plus the Entra tenant the grant is in.
       */
      msgraphTokens?: { accessToken?: string; refreshToken?: string; expiresAt?: string; tenantId?: string }
      email?: string
      label?: string
      instanceId?: string
      createNew?: boolean
    }
    if (body.instanceId !== undefined && !UUID_RE.test(body.instanceId)) {
      res.status(400).json({ error: 'Invalid instanceId' })
      return
    }

    let credentials: ConnectorCredentials
    let email = body.email ?? null
    let label = body.label?.trim() || undefined
    // Non-secret config stamped alongside the credentials (webhook → instance
    // routing resolves Shopify instances by config.shopDomain).
    let configPatch: Record<string, unknown> | null = null

    if (provider === 'shopify') {
      const t = body.shopifyTokens
      const shopDomain = normalizeShopDomain(t?.shopDomain ?? '')
      const accessToken = t?.accessToken?.trim()
      if (!accessToken || !shopDomain) {
        res.status(400).json({ error: 'Missing shopifyTokens.accessToken or a valid shopDomain (*.myshopify.com)' })
        return
      }
      const managed = typeof t?.refreshToken === 'string' && typeof t?.expiresAt === 'string'
      // Verify a PASTED token against the store before storing anything. This
      // is the only credential the Shopify connector has (the OAuth path is
      // not offered — shopify.md → "Auth model"), so an unverified paste means
      // a store that reads "Connected" and fails at the first tool call. The
      // imap `/imap/connect` verify-before-store precedent.
      //
      // Managed tuples skip it: they arrive from the OAuth callback, which
      // already proved the token by fetching shop identity, and re-probing
      // there would spend a request on a path this route does not own.
      let verifiedDomain: string | null = null
      if (!managed) {
        const verify = opts.shopifyVerifyToken ?? getShopIdentity
        try {
          const identity = await verify({ accessToken, shopDomain })
          verifiedDomain = normalizeShopDomain(identity.myshopifyDomain ?? '')
        } catch (err) {
          console.warn(`[connectors] shopify token verify failed for ${shopDomain}:`, err instanceof Error ? err.message : String(err))
          res.status(400).json({ error: 'invalid_token' })
          return
        }
      }
      // Shopify's own answer for the canonical host wins over what the user
      // typed — the same precedence the OAuth callback applies.
      const storedDomain = verifiedDomain ?? shopDomain
      // The merchant app pair, either supplied on this call (the OAuth callback
      // sends it alongside the token) or already stored from the app-credentials
      // step. Re-reading the stored pair matters: without it a reconnect that
      // omits `shopifyApp` would silently strip the credentials and break every
      // later refresh and webhook verification for that instance.
      const appPair = readShopifyAppPair(body.shopifyApp)
      if (body.shopifyApp && !appPair) {
        res.status(400).json({ error: 'Invalid shopifyApp credentials' })
        return
      }
      const carriedPair = appPair ?? (await loadStoredShopifyAppPair(body.instanceId))
      credentials = {
        type: 'oauth',
        // Discriminate on tuple SHAPE, never on the token prefix: Shopify's
        // EXPIRING offline tokens are also `shpat_`-prefixed, so a prefix test
        // labels every OAuth install `shopify_token`. Harmless while the
        // marker stays advisory (readers use isManagedShopifyTokens), but it
        // is a false provenance record and anything that later trusts it is
        // wrong. Same rule the parser uses.
        client_id: managed ? 'shopify_oauth' : 'shopify_token',
        client_secret: packShopifyTokens({
          accessToken,
          shopDomain: storedDomain,
          ...(managed ? { refreshToken: t?.refreshToken, expiresAt: t?.expiresAt } : {}),
          ...(carriedPair
            ? { appClientId: carriedPair.clientId, appClientSecret: carriedPair.clientSecret }
            : {}),
        }),
      }
      // The shop domain plays the connectedEmail role ("Connected:
      // mystore.myshopify.com") and is the default instance label (D3). A
      // verified domain overrides the caller's, so the displayed host can never
      // disagree with the config.shopDomain that webhook routing keys on.
      email = verifiedDomain ?? email ?? storedDomain
      label = label ?? storedDomain
      configPatch = { shopDomain: storedDomain }
    } else if (provider === 'msgraph') {
      const t = body.msgraphTokens
      if (
        typeof t?.accessToken !== 'string' ||
        typeof t?.refreshToken !== 'string' ||
        typeof t?.expiresAt !== 'string'
      ) {
        res.status(400).json({ error: 'Missing msgraphTokens (accessToken/refreshToken/expiresAt)' })
        return
      }
      // Fathom's rotating-tuple envelope plus the Entra tenant id. `client_id`
      // is the credential-type discriminator, not an OAuth client id.
      //
      // TWO-WRITER CONTRACT: `packMsGraphTokens` (src/msgraph/token.ts)
      // rewrites this blob in FULL on every refresh, so a field written here
      // and not handled there is erased at the first rotation rather than
      // ignored. Add to both in the same change. See
      // docs/architecture/integrations/msgraph.md §6 → "The rotation invariant".
      credentials = {
        type: 'oauth',
        client_id: 'msgraph_oauth',
        client_secret: JSON.stringify({
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          expiresAt: t.expiresAt,
          ...(typeof t.tenantId === 'string' ? { tenantId: t.tenantId } : {}),
        }),
      }
    } else {
      const secret = (body.refreshToken ?? body.pat ?? body.accessToken ?? body.token ?? '').trim()
      if (!secret) {
        res.status(400).json({ error: 'Missing credential (refreshToken/pat/accessToken/token)' })
        return
      }
      credentials = credentialsFor(secret)
    }

    try {
      const result = await persistConnectorInstance({
        store: connectorInstanceStore,
        userId,
        provider,
        fallbackLabel: entry.name,
        credentials,
        email,
        label,
        configPatch,
        createNew: body.createNew,
        instanceId: body.instanceId,
      })
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return }
      res.json({ ok: true, connectorInstanceId: result.connectorInstanceId })
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

  // ── POST /:provider/exchange-and-store — desktop OAuth: mint tokens from a code, then store ──
  //
  // The desktop shell can't complete the web callbacks' browser-cookie CSRF: consent
  // runs in the SYSTEM browser, a different cookie jar than the Electron renderer that
  // set the nonce, so `verifyConnectorState` always fails there (this was the bug —
  // docs/plans/desktop-connector-oauth-return.md). Instead the shell drives an RFC 8252
  // loopback flow (mirroring desktop sign-in), receives the OAuth `code`, and posts it
  // here with its OWN bearer. The exchange runs server-side (secrets never transit the
  // loopback URL), then stores via the same path as `store-credentials`. CSRF/cross-user
  // injection stays closed: the code only reaches the shell that minted the loopback
  // nonce, and the store is authorized by that acting user's token.
  router.post('/:provider/exchange-and-store', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const provider = req.params.provider
    const entry = credentialedConnector(provider)
    if (!entry) { res.status(400).json({ error: `Unsupported connector: ${provider}` }); return }

    const exchanger = DESKTOP_OAUTH_EXCHANGERS[provider]
    if (!exchanger) {
      res.status(400).json({ error: `Connector ${provider} does not support the desktop OAuth flow` })
      return
    }

    const body = (req.body ?? {}) as { code?: string; redirectUri?: string; instanceId?: string; createNew?: boolean }
    const code = body.code?.trim()
    const redirectUri = body.redirectUri?.trim()
    if (!code || !redirectUri) { res.status(400).json({ error: 'Missing code or redirectUri' }); return }
    if (body.instanceId !== undefined && !UUID_RE.test(body.instanceId)) {
      res.status(400).json({ error: 'Invalid instanceId' })
      return
    }

    let minted: DesktopOAuthExchangeResult
    try {
      minted = await exchanger({ code, redirectUri })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[connectors] exchange-and-store: ${provider} exchange failed:`, msg)
      // 503 = server misconfigured (no client secret); 502 = the provider or the
      // code rejected the exchange. Either way, nothing was stored.
      res.status(msg.includes('not configured') ? 503 : 502).json({ error: msg })
      return
    }

    try {
      const result = await persistConnectorInstance({
        store: connectorInstanceStore,
        userId,
        provider,
        fallbackLabel: entry.name,
        credentials: credentialsFor(minted.secret),
        email: minted.email,
        // A fresh account's default nickname (createNew only) — the connected
        // email (Google) or workspace name (Notion). Reconnect/primary keep theirs.
        label: body.createNew ? minted.defaultLabel : undefined,
        configPatch: null,
        createNew: body.createNew,
        instanceId: body.instanceId,
      })
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return }
      res.json({ ok: true, connectorInstanceId: result.connectorInstanceId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('CHANNEL_CREDENTIAL_KEY')) {
        res.status(503).json({ error: 'Connector credential storage is not configured (CHANNEL_CREDENTIAL_KEY)' })
        return
      }
      console.error('[connectors] exchange-and-store store failed:', err)
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
