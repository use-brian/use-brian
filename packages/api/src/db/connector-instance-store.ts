/**
 * Connector-instance store — multi-instance, user-XOR-team-scoped.
 *
 * Stage 1 of the team-connector promotion. Coexists with the legacy
 * `connector-store.ts` (mcp_connectors) during the dual-write window;
 * both stores can be active at once. `injectMcpTools` reads from this
 * one first, falling back to the legacy store on miss until Stage 6
 * drops the old table.
 *
 * See docs/architecture/integrations/mcp.md and
 * docs/architecture/platform/database-schema.md.
 * Component tag: [COMP:api/connector-instance-store].
 */

import { query, queryWithRLS } from './client.js'
import { encryptCredentials, decryptCredentials } from './credential-crypto.js'
import type { ChannelCredentials } from './channel-integrations.js'
import {
  normalizeStoredCredentials,
  credsTypeOf,
  type OAuthCredentials,
  type ConnectorCredentials,
} from './connector-store.js'
import type { ConnectorAuthType } from '@use-brian/shared'

// ── Types ──────────────────────────────────────────────────────

export type ConnectorScope = 'user' | 'workspace'

// (renamed from 'team' in migration 110)
export type SensitivityTier = 'public' | 'internal' | 'confidential'

/**
 * Connector liveness (migration 294). `connected` is user intent ("set up");
 * `healthStatus` is truth ("credentials work right now"). See
 * docs/architecture/integrations/connector-health.md.
 *   ok           worked on last use (default)
 *   auth_failed  a 401/403/invalid_grant at call time — needs reconnect
 *   unknown      reserved (never exercised)
 */
export type ConnectorHealthStatus = 'ok' | 'auth_failed' | 'unknown'

export type ConnectorInstance = {
  id: string
  scope: ConnectorScope
  userId: string | null
  workspaceId: string | null
  provider: string
  label: string
  connectedEmail: string | null
  url: string | null
  custom: boolean
  config: Record<string, unknown>
  sensitivity: SensitivityTier
  connected: boolean
  /** Pipeline C opt-in — flipped by the Studio ▸ Ingestion control plane (migration 145). */
  ingestionEnabled: boolean
  /**
   * Explicit ingest routing target (migration 311). When set, this instance's
   * episodes route to THIS workspace — the seam that lets a personal connector
   * exposed to a team workspace feed that workspace's brain. NULL → legacy
   * routing (workspace-scoped → workspace_id; user-scoped → owner's personal
   * workspace). Set on ingestion-enable from a workspace's Events page, cleared
   * on disable / exposure-revoke. See `resolveInstanceWorkspaceId`.
   */
  ingestWorkspaceId: string | null
  /**
   * Non-secret discriminator for the encrypted credentials blob
   * (migration 261). Display/query metadata only — the runtime switches on
   * the decrypted blob's `type`, never this column.
   */
  credentialsType: ConnectorAuthType
  /** Liveness — 'ok' | 'auth_failed' | 'unknown' (migration 294). Distinct from `connected`. */
  healthStatus: ConnectorHealthStatus
  /** Last auth-failure message captured at call time (migration 294). Null when healthy. */
  lastError: string | null
  /** When `healthStatus` last transitioned (migration 294). Null until first flip. */
  lastCheckedAt: Date | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export type CreateUserInstanceParams = {
  userId: string
  provider: string
  label: string
  connectedEmail?: string | null
  url?: string | null
  custom?: boolean
  credentials?: ConnectorCredentials | OAuthCredentials | null
  config?: Record<string, unknown>
  sensitivity?: SensitivityTier
  connected?: boolean
  createdBy?: string | null
}

export type CreateWorkspaceInstanceParams = {
  workspaceId: string
  provider: string
  label: string
  connectedEmail?: string | null
  url?: string | null
  custom?: boolean
  credentials?: ConnectorCredentials | OAuthCredentials | null
  config?: Record<string, unknown>
  sensitivity?: SensitivityTier
  connected?: boolean
  createdBy: string          // who authorized the connection (team admin)
}

export type UpdateInstanceParams = {
  label?: string
  connectedEmail?: string | null
  url?: string | null
  sensitivity?: SensitivityTier
  connected?: boolean
  ingestionEnabled?: boolean
  /** Ingest routing target (migration 311). `null` clears it (disable / revoke). */
  ingestWorkspaceId?: string | null
  credentials?: ConnectorCredentials | OAuthCredentials | null
}

export type ConnectorInstanceStore = {
  /** List instances the acting user can read: their own user-scoped + their teams' team-scoped. RLS-gated. */
  listForUser(actingUserId: string): Promise<ConnectorInstance[]>

  /** List a user's personal instances. RLS-gated. */
  listByUser(actingUserId: string, ownerUserId: string): Promise<ConnectorInstance[]>

  /** List a team's team-native instances. RLS-gated (caller must be a team member). */
  listByWorkspace(actingUserId: string, workspaceId: string): Promise<ConnectorInstance[]>

  /** Get by id. RLS-gated — returns null if not visible to the caller. */
  get(actingUserId: string, id: string): Promise<ConnectorInstance | null>

  createUserInstance(params: CreateUserInstanceParams): Promise<ConnectorInstance>
  createWorkspaceInstance(params: CreateWorkspaceInstanceParams): Promise<ConnectorInstance>

  update(actingUserId: string, id: string, updates: UpdateInstanceParams): Promise<ConnectorInstance | null>

  /**
   * Transfer a personal (`scope='user'`) instance to workspace ownership
   * (`scope='workspace'`, `user_id=NULL`). The credential blob, provider,
   * config, and `connected` flag ride along unchanged — the personal
   * credential *becomes* the team credential.
   *
   * Authorization is enforced by RLS + the explicit WHERE, not hand-rolled in
   * the route: the UPDATE's USING clause (ci_access) requires the OLD row be
   * the caller's own user-scoped instance; the WITH CHECK requires the NEW
   * row's workspace be one the caller belongs to. A non-owner or non-member
   * changes 0 rows → returns null (the route maps that to 403). Also clears
   * ingest routing (workspace-scoped instances route via `workspace_id`) and
   * deletes the instance's grants — a workspace-owned instance is visible by
   * scope and needs none, and the grant store forbids grants on it.
   *
   * See docs/plans/workspace-owned-connector-transfer.md §2A.
   */
  transferToWorkspace(
    actingUserId: string,
    id: string,
    workspaceId: string,
    sensitivity?: SensitivityTier,
  ): Promise<ConnectorInstance | null>

  /** Merge keys into the JSONB config. RLS-gated. */
  setConfig(actingUserId: string, id: string, config: Record<string, unknown>): Promise<void>

  delete(actingUserId: string, id: string): Promise<boolean>

  /** Decrypt credentials for the caller's own or team-visible instance. Returns null if absent. */
  getCredentials(actingUserId: string, id: string): Promise<OAuthCredentials | null>

  /**
   * Decrypt + normalize credentials for outbound MCP auth. Unlike
   * `getCredentials`, this does NOT filter on `connected = true` — the
   * connection probe must read credentials of a not-yet-connected row.
   * RLS-gated.
   */
  getAuthCredentials(actingUserId: string, id: string): Promise<ConnectorCredentials | null>

  // ── System-level (no RLS) — for workers and webhook handlers ──

  /** Get credentials for any instance. Used by KB sync, token refresh. */
  getCredentialsSystem(id: string): Promise<OAuthCredentials | null>

  /** System-level twin of `getAuthCredentials` — used at tool-injection time. */
  getAuthCredentialsSystem(id: string): Promise<ConnectorCredentials | null>

  /** Find a team's team-native instance by provider. Used by KB sync worker. */
  findByWorkspaceProviderSystem(workspaceId: string, provider: string): Promise<ConnectorInstance | null>

  /** Find a user's personal instance(s) by provider. Used by legacy-compat paths during the dual-read window. */
  findByUserProviderSystem(userId: string, provider: string): Promise<ConnectorInstance[]>

  /** List every team-native instance for a team. Used by the connector resolver at tool-injection time. */
  listByWorkspaceSystem(workspaceId: string): Promise<ConnectorInstance[]>

  /** List every user-scoped instance for a user. Used by the connector resolver at tool-injection time. */
  listByUserSystem(userId: string): Promise<ConnectorInstance[]>

  /** Every connected, ingestion-enabled instance of a provider — drives the Pipeline C pollers. System-level. */
  listIngestEnabledSystem(provider: string): Promise<ConnectorInstance[]>

  /** Every instance of a provider regardless of scope/connected. System-level. Drives the BYO storage staleness sweep. */
  listByProviderSystem(provider: string): Promise<ConnectorInstance[]>

  /** Merge keys into the JSONB config with no acting user — for system workers (ingest pollers). */
  setConfigSystem(id: string, config: Record<string, unknown>): Promise<void>

  /**
   * Re-encrypt and persist the credentials envelope with no acting user.
   * The Fathom ingest poller uses this to write back a rotated
   * refresh-token tuple (Fathom refresh tokens are one-time-use, so the
   * new tuple MUST be persisted before the next API call). RLS bypass is
   * correct here — a background worker holds no session user.
   */
  updateCredentialsSystem(id: string, credentials: ConnectorCredentials | OAuthCredentials): Promise<void>

  /**
   * Record connector liveness with no acting user (migration 294). Called at
   * tool-call time: `auth_failed` on a 401/403, `ok` on a subsequent success.
   * Writes only on an actual transition (idempotent — no write storm on the hot
   * success path); returns true when the status changed, which is the one-shot
   * signal downstream surfaces (owner notification) key on. RLS bypass is
   * correct — detection runs in engine/system context with no session user.
   * See docs/architecture/integrations/connector-health.md.
   */
  markHealth(id: string, status: ConnectorHealthStatus, error?: string | null): Promise<boolean>
}

// ── Column projections ─────────────────────────────────────────

const PUBLIC_COLS = `
  id, scope,
  user_id AS "userId",
  workspace_id AS "workspaceId",
  provider, label,
  connected_email AS "connectedEmail",
  url, custom, config, sensitivity, connected,
  ingestion_enabled AS "ingestionEnabled",
  ingest_workspace_id AS "ingestWorkspaceId",
  credentials_type AS "credentialsType",
  health_status AS "healthStatus",
  last_error AS "lastError",
  last_checked_at AS "lastCheckedAt",
  created_by AS "createdBy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
` as const

type PublicRow = ConnectorInstance

// ── Helpers ────────────────────────────────────────────────────

function requireKey(key: Buffer | null, context: string): Buffer {
  if (!key) {
    throw new Error(
      `Cannot ${context}: CHANNEL_CREDENTIAL_KEY is not configured`,
    )
  }
  return key
}

function decryptRow(row: { credentials: Buffer | null }, key: Buffer | null): OAuthCredentials | null {
  if (!row.credentials || !key) return null
  return decryptCredentials(row.credentials, key) as unknown as OAuthCredentials
}

function encryptOrNull(
  creds: ConnectorCredentials | OAuthCredentials | null | undefined,
  key: Buffer | null,
): Buffer | null {
  if (!creds) return null
  return encryptCredentials(creds as unknown as ChannelCredentials, requireKey(key, 'store connector credentials'))
}

// ── Store ──────────────────────────────────────────────────────

export function createConnectorInstanceStore(encryptionKey: Buffer | null): ConnectorInstanceStore {
  return {
    async listForUser(actingUserId) {
      // Scope explicitly in SQL: the caller's own user-scoped instances
      // plus workspace instances for workspaces they belong to. RLS is
      // defense-in-depth, NOT the filter — a privileged DB role bypasses
      // RLS, and a WHERE-less read would then leak every tenant's
      // connectors.
      const result = await queryWithRLS<PublicRow>(
        actingUserId,
        `SELECT ${PUBLIC_COLS} FROM connector_instance
         WHERE (scope = 'user' AND user_id = $1)
            OR (scope = 'workspace' AND workspace_id IN (
                  SELECT workspace_id FROM workspace_members WHERE user_id = $1))
         ORDER BY scope ASC, custom ASC, label ASC`,
        [actingUserId],
      )
      return result.rows
    },

    async listByUser(actingUserId, ownerUserId) {
      const result = await queryWithRLS<PublicRow>(
        actingUserId,
        `SELECT ${PUBLIC_COLS} FROM connector_instance
         WHERE scope = 'user' AND user_id = $1
         ORDER BY custom ASC, label ASC`,
        [ownerUserId],
      )
      return result.rows
    },

    async listByWorkspace(actingUserId, workspaceId) {
      const result = await queryWithRLS<PublicRow>(
        actingUserId,
        `SELECT ${PUBLIC_COLS} FROM connector_instance
         WHERE scope = 'workspace' AND workspace_id = $1
         ORDER BY custom ASC, label ASC`,
        [workspaceId],
      )
      return result.rows
    },

    async get(actingUserId, id) {
      const result = await queryWithRLS<PublicRow>(
        actingUserId,
        `SELECT ${PUBLIC_COLS} FROM connector_instance WHERE id = $1`,
        [id],
      )
      return result.rows[0] ?? null
    },

    async createUserInstance(params) {
      const encrypted = encryptOrNull(params.credentials, encryptionKey)
      const result = await queryWithRLS<PublicRow>(
        params.userId,
        `INSERT INTO connector_instance
           (scope, user_id, workspace_id, provider, label, connected_email, url,
            custom, credentials, credentials_type, config, sensitivity, connected, created_by)
         VALUES ('user', $1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${PUBLIC_COLS}`,
        [
          params.userId,
          params.provider,
          params.label,
          params.connectedEmail ?? null,
          params.url ?? null,
          params.custom ?? false,
          encrypted,
          credsTypeOf(encrypted ? params.credentials : null),
          JSON.stringify(params.config ?? {}),
          params.sensitivity ?? 'internal',
          params.connected ?? false,
          params.createdBy ?? params.userId,
        ],
      )
      return result.rows[0]
    },

    async createWorkspaceInstance(params) {
      const encrypted = encryptOrNull(params.credentials, encryptionKey)
      // RLS policy ci_team_member will reject if createdBy is not a member
      // of the team. That's the authorization gate — the route layer should
      // additionally check for admin/owner role before calling this.
      const result = await queryWithRLS<PublicRow>(
        params.createdBy,
        `INSERT INTO connector_instance
           (scope, user_id, workspace_id, provider, label, connected_email, url,
            custom, credentials, credentials_type, config, sensitivity, connected, created_by)
         VALUES ('workspace', NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${PUBLIC_COLS}`,
        [
          params.workspaceId,
          params.provider,
          params.label,
          params.connectedEmail ?? null,
          params.url ?? null,
          params.custom ?? false,
          encrypted,
          credsTypeOf(encrypted ? params.credentials : null),
          JSON.stringify(params.config ?? {}),
          params.sensitivity ?? 'internal',
          params.connected ?? false,
          params.createdBy,
        ],
      )
      return result.rows[0]
    },

    async update(actingUserId, id, updates) {
      const sets: string[] = []
      const values: unknown[] = []
      let idx = 1

      if (updates.label !== undefined) { sets.push(`label = $${idx}`); values.push(updates.label); idx++ }
      if (updates.connectedEmail !== undefined) { sets.push(`connected_email = $${idx}`); values.push(updates.connectedEmail); idx++ }
      if (updates.url !== undefined) { sets.push(`url = $${idx}`); values.push(updates.url); idx++ }
      if (updates.sensitivity !== undefined) { sets.push(`sensitivity = $${idx}`); values.push(updates.sensitivity); idx++ }
      if (updates.connected !== undefined) { sets.push(`connected = $${idx}`); values.push(updates.connected); idx++ }
      if (updates.ingestionEnabled !== undefined) { sets.push(`ingestion_enabled = $${idx}`); values.push(updates.ingestionEnabled); idx++ }
      if (updates.ingestWorkspaceId !== undefined) { sets.push(`ingest_workspace_id = $${idx}`); values.push(updates.ingestWorkspaceId); idx++ }
      if (updates.credentials !== undefined) {
        const encrypted = encryptOrNull(updates.credentials, encryptionKey)
        sets.push(`credentials = $${idx}`); values.push(encrypted); idx++
        sets.push(`credentials_type = $${idx}`); values.push(credsTypeOf(updates.credentials)); idx++
        // A fresh credential clears any prior auth-failure (reconnect recovery).
        sets.push(`health_status = 'ok'`)
        sets.push(`last_error = NULL`)
      }

      if (sets.length === 0) {
        const fetched = await queryWithRLS<PublicRow>(
          actingUserId,
          `SELECT ${PUBLIC_COLS} FROM connector_instance WHERE id = $1`,
          [id],
        )
        return fetched.rows[0] ?? null
      }

      values.push(id)
      const result = await queryWithRLS<PublicRow>(
        actingUserId,
        `UPDATE connector_instance SET ${sets.join(', ')}
         WHERE id = $${idx}
         RETURNING ${PUBLIC_COLS}`,
        values,
      )
      return result.rows[0] ?? null
    },

    async transferToWorkspace(actingUserId, id, workspaceId, sensitivity) {
      // Single RLS-gated UPDATE. The explicit `scope='user' AND user_id=$4`
      // mirrors the ci_access USING clause (defense-in-depth — RLS is not the
      // filter, see listForUser); the WITH CHECK on the resulting workspace row
      // rejects a non-member target. `COALESCE($3::text, sensitivity)` keeps the
      // existing tier when the caller passes none.
      const result = await queryWithRLS<PublicRow>(
        actingUserId,
        `UPDATE connector_instance
            SET scope = 'workspace',
                user_id = NULL,
                workspace_id = $2,
                ingest_workspace_id = NULL,
                sensitivity = COALESCE($3::text, sensitivity)
          WHERE id = $1 AND scope = 'user' AND user_id = $4
          RETURNING ${PUBLIC_COLS}`,
        [id, workspaceId, sensitivity ?? null, actingUserId],
      )
      const transferred = result.rows[0] ?? null
      if (!transferred) return null
      // Drop any exposures the personal instance carried. A workspace-owned
      // instance is visible by scope and needs no grant; the grant store also
      // forbids grants on scope='workspace' rows. The owner made every grant on
      // a personal instance, so cg_access permits this delete.
      await queryWithRLS(
        actingUserId,
        `DELETE FROM connector_grant WHERE connector_instance_id = $1`,
        [id],
      )
      return transferred
    },

    async setConfig(actingUserId, id, config) {
      await queryWithRLS(
        actingUserId,
        `UPDATE connector_instance
         SET config = COALESCE(config, '{}') || $2::jsonb
         WHERE id = $1`,
        [id, JSON.stringify(config)],
      )
    },

    async delete(actingUserId, id) {
      const result = await queryWithRLS(
        actingUserId,
        `DELETE FROM connector_instance WHERE id = $1`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    },

    async getCredentials(actingUserId, id) {
      const result = await queryWithRLS<{ credentials: Buffer | null }>(
        actingUserId,
        `SELECT credentials FROM connector_instance
         WHERE id = $1 AND connected = true`,
        [id],
      )
      const row = result.rows[0]
      if (!row) return null
      return decryptRow(row, encryptionKey)
    },

    async getCredentialsSystem(id) {
      const result = await query<{ credentials: Buffer | null }>(
        `SELECT credentials FROM connector_instance
         WHERE id = $1 AND connected = true`,
        [id],
      )
      const row = result.rows[0]
      if (!row) return null
      return decryptRow(row, encryptionKey)
    },

    async getAuthCredentials(actingUserId, id) {
      // No `connected = true` filter — see the interface doc.
      const result = await queryWithRLS<{ credentials: Buffer | null }>(
        actingUserId,
        `SELECT credentials FROM connector_instance WHERE id = $1`,
        [id],
      )
      const row = result.rows[0]
      if (!row?.credentials || !encryptionKey) return null
      return normalizeStoredCredentials(decryptCredentials(row.credentials, encryptionKey))
    },

    async getAuthCredentialsSystem(id) {
      const result = await query<{ credentials: Buffer | null }>(
        `SELECT credentials FROM connector_instance WHERE id = $1`,
        [id],
      )
      const row = result.rows[0]
      if (!row?.credentials || !encryptionKey) return null
      return normalizeStoredCredentials(decryptCredentials(row.credentials, encryptionKey))
    },

    async findByWorkspaceProviderSystem(workspaceId, provider) {
      const result = await query<PublicRow>(
        `SELECT ${PUBLIC_COLS} FROM connector_instance
         WHERE scope = 'workspace' AND workspace_id = $1 AND provider = $2
         ORDER BY created_at ASC
         LIMIT 1`,
        [workspaceId, provider],
      )
      return result.rows[0] ?? null
    },

    async findByUserProviderSystem(userId, provider) {
      const result = await query<PublicRow>(
        `SELECT ${PUBLIC_COLS} FROM connector_instance
         WHERE scope = 'user' AND user_id = $1 AND provider = $2
         ORDER BY created_at ASC`,
        [userId, provider],
      )
      return result.rows
    },

    async listByWorkspaceSystem(workspaceId) {
      // `connector_instance` now exists in OSS too (migration 280_oss_connectors),
      // so this no longer needs the edition stub. See connector-store.list.
      const result = await query<PublicRow>(
        `SELECT ${PUBLIC_COLS} FROM connector_instance
         WHERE scope = 'workspace' AND workspace_id = $1
         ORDER BY custom ASC, label ASC`,
        [workspaceId],
      )
      return result.rows
    },

    async listByUserSystem(userId) {
      const result = await query<PublicRow>(
        `SELECT ${PUBLIC_COLS} FROM connector_instance
         WHERE scope = 'user' AND user_id = $1
         ORDER BY custom ASC, label ASC`,
        [userId],
      )
      return result.rows
    },

    async listIngestEnabledSystem(provider) {
      const result = await query<PublicRow>(
        `SELECT ${PUBLIC_COLS} FROM connector_instance
         WHERE provider = $1 AND connected = true AND ingestion_enabled = true
         ORDER BY created_at ASC`,
        [provider],
      )
      return result.rows
    },

    async listByProviderSystem(provider) {
      const result = await query<PublicRow>(
        `SELECT ${PUBLIC_COLS} FROM connector_instance
         WHERE provider = $1
         ORDER BY created_at ASC`,
        [provider],
      )
      return result.rows
    },

    async setConfigSystem(id, config) {
      await query(
        `UPDATE connector_instance
         SET config = COALESCE(config, '{}') || $2::jsonb
         WHERE id = $1`,
        [id, JSON.stringify(config)],
      )
    },

    async updateCredentialsSystem(id, credentials) {
      const encrypted = encryptOrNull(credentials, encryptionKey)
      // A fresh credential clears any prior auth-failure (reconnect recovery).
      await query(
        `UPDATE connector_instance
         SET credentials = $2, credentials_type = $3, health_status = 'ok', last_error = NULL
         WHERE id = $1`,
        [id, encrypted, credsTypeOf(credentials)],
      )
    },

    async markHealth(id, status, error = null) {
      // `IS DISTINCT FROM` → write only on a real transition, so calling
      // markHealth('ok') on every successful call is a cheap no-op UPDATE.
      const result = await query(
        `UPDATE connector_instance
         SET health_status = $2, last_error = $3, last_checked_at = now()
         WHERE id = $1 AND health_status IS DISTINCT FROM $2`,
        [id, status, error],
      )
      return (result.rowCount ?? 0) > 0
    },
  }
}
