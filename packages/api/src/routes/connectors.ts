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
import { normalizeShopDomain, packShopifyTokens } from '../shopify/client.js'
import { resolveMailboxPreset } from '../mailbox/presets.js'
import { verifyMailboxConnection } from '../mailbox/verify.js'
import { probeMailboxFolders } from '../mailbox/probe.js'
import { readMailboxSyncState, type MailboxBackfillScope, type MailboxSyncState } from '../mailbox/sync-worker.js'
import { countEmailArchiveMessages } from '../db/email-archive-store.js'
import type { MailboxAccountSettings } from '../mailbox/types.js'

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

  // ── Company mailbox (user-scoped `imap` connector) ─────────────
  //
  // Credential-entry connect with an MX-resolved preset (D1) and a LIVE
  // IMAP login + SMTP verify BEFORE anything is stored — green check or a
  // named error, never a stored-but-dead credential (plan §4). One mailbox
  // per user (D11; `single_instance` in the registry). Generic
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
    try {
      const existing = (await connectorInstanceStore.listByUser(userId, userId))
        .find((i) => i.provider === 'imap')
      if (existing) {
        const updated = await connectorInstanceStore.update(userId, existing.id, {
          connected: true,
          connectedEmail: email,
          credentials,
          label: email,
        })
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

  /** Resolve the caller's imap instance + decrypted settings, or null. */
  async function resolveImapInstance(userId: string): Promise<
    { instance: ConnectorInstance; settings: MailboxAccountSettings } | null
  > {
    const instance = (await connectorInstanceStore.listByUser(userId, userId))
      .find((i) => i.provider === 'imap' && i.connected)
    if (!instance) return null
    const creds = await connectorInstanceStore.getAuthCredentialsSystem(instance.id)
    if (!creds || creds.type !== 'imap') return null
    const { type: _t, ...settings } = creds
    return { instance, settings }
  }

  // Connected-card status: archive counts + sync/backfill cursor state. No
  // IMAP round-trip — safe to poll.
  router.get('/imap/sync-status', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const resolved = await resolveImapInstance(userId)
      if (!resolved) { res.status(404).json({ error: 'No connected mailbox' }); return }
      const state = readMailboxSyncState(resolved.instance.config)
      const countArchive = opts.imapMailbox?.countArchive ?? countEmailArchiveMessages
      const counts = await countArchive(resolved.instance.id)
      res.json({
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
      const resolved = await resolveImapInstance(userId)
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
      const resolved = await resolveImapInstance(userId)
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
      const connectors = instances.map((inst) => ({
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
      credentials = {
        type: 'oauth',
        client_id: accessToken.startsWith('shpat_') ? 'shopify_token' : 'shopify_oauth',
        client_secret: packShopifyTokens({
          accessToken,
          shopDomain,
          ...(managed ? { refreshToken: t?.refreshToken, expiresAt: t?.expiresAt } : {}),
        }),
      }
      // The shop domain plays the connectedEmail role ("Connected:
      // mystore.myshopify.com") and is the default instance label (D3).
      email = email ?? shopDomain
      label = label ?? shopDomain
      configPatch = { shopDomain }
    } else {
      const secret = (body.refreshToken ?? body.pat ?? body.accessToken ?? body.token ?? '').trim()
      if (!secret) {
        res.status(400).json({ error: 'Missing credential (refreshToken/pat/accessToken/token)' })
        return
      }
      credentials = credentialsFor(secret)
    }

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
          ...(configPatch ? { config: configPatch } : {}),
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
        if (configPatch) await connectorInstanceStore.setConfig(userId, updated.id, configPatch)
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
        if (configPatch) await connectorInstanceStore.setConfig(userId, existing.id, configPatch)
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
        ...(configPatch ? { config: configPatch } : {}),
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
