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
import type { ConnectorAuthType } from '@sidanclaw/shared'

// ── Types ──────────────────────────────────────────────────────

export type ConnectorScope = 'user' | 'workspace'

// (renamed from 'team' in migration 110)
export type SensitivityTier = 'public' | 'internal' | 'confidential'

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
   * Non-secret discriminator for the encrypted credentials blob
   * (migration 261). Display/query metadata only — the runtime switches on
   * the decrypted blob's `type`, never this column.
   */
  credentialsType: ConnectorAuthType
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
  credentials_type AS "credentialsType",
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
      if (updates.credentials !== undefined) {
        const encrypted = encryptOrNull(updates.credentials, encryptionKey)
        sets.push(`credentials = $${idx}`); values.push(encrypted); idx++
        sets.push(`credentials_type = $${idx}`); values.push(credsTypeOf(updates.credentials)); idx++
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
      await query(
        `UPDATE connector_instance SET credentials = $2, credentials_type = $3 WHERE id = $1`,
        [id, encrypted, credsTypeOf(credentials)],
      )
    },
  }
}
