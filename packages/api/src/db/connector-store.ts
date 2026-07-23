/**
 * MCP connector store — compatibility shim over `connector_instance`.
 *
 * Stage 6 of the team-connector promotion: `mcp_connectors` has been
 * dropped; this store now reads and writes `connector_instance` rows
 * with `scope='user'`. The `ConnectorStore` interface is unchanged so
 * every legacy caller (routes, injectMcpTools, google-oauth callback,
 * sync-credentials) continues to work without modification.
 *
 * Translation between the legacy shape and the instance shape:
 *
 *   Legacy                           Instance
 *   ──────                           ────────
 *   connectorId (PK part)         →  provider
 *   name                          →  label
 *   UNIQUE(user_id, connector_id) →  (dropped — multi-instance allowed in
 *                                     the new table; this shim preserves
 *                                     the legacy one-per-(user, provider)
 *                                     semantic by always targeting the
 *                                     first matching row on upsert /
 *                                     setConnected / getCredentials /
 *                                     setConfig / delete)
 *
 * Team-native instances (`scope='team'`) and member-exposure grants are
 * handled by `connector-instance-store.ts` and `connector-grant-store.ts`
 * directly — this shim only serves the legacy (userId, provider) access
 * pattern.
 *
 * See docs/architecture/integrations/mcp.md.
 */

import { query, queryWithRLS } from './client.js'
import {
  encryptCredentials,
  decryptCredentials,
} from './credential-crypto.js'
import type { ChannelCredentials } from './channel-integrations.js'
import type { ConnectorAuthType } from '@use-brian/shared'

// ── Types ──────────────────────────────────────────────────────

export type OAuthCredentials = {
  client_id: string
  client_secret: string
}

/**
 * Discriminated union for the encrypted `connector_instance.credentials`
 * blob. Legacy rows store a bare `{ client_id, client_secret }` (no `type`)
 * — `normalizeStoredCredentials` stamps those as `oauth` at read time so
 * existing connectors behave exactly as before (no outbound header).
 * The non-secret discriminator is mirrored to the queryable
 * `credentials_type` column; the runtime always switches on the decrypted
 * blob's `type`, never the column.
 */
/**
 * A customer GCS service-account key, kept opaque on purpose: only
 * `client_email` is named (for display); the signing secret rides along in
 * the rest of the object and is never destructured or logged. The whole
 * object is handed straight to the GCS client.
 */
export type GcsCredentialKey = {
  client_email: string
  project_id?: string
  [k: string]: unknown
}

/**
 * A customer S3 access-key pair, kept together as one object (the sibling of
 * `GcsCredentialKey`). Only `accessKeyId` is meaningfully identifying;
 * `secretAccessKey` is the signing secret and is never logged. The whole
 * object is handed straight to the S3 client and never destructured elsewhere.
 */
export type S3AccessKey = {
  accessKeyId: string
  secretAccessKey: string
  [k: string]: unknown
}

/**
 * A user's corporate-mailbox credential (the `imap` connector): the mailbox
 * address, the app-specific "client security password", and the resolved
 * IMAP/SMTP endpoints. The password is the secret; hosts/ports ride along so
 * the runtime never re-resolves MX. See
 * docs/architecture/integrations/mailbox-imap.md.
 */
export type ImapMailboxCredentials = {
  email: string
  appPassword: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
}

export type ConnectorCredentials =
  | { type: 'oauth'; client_id: string; client_secret: string }
  | { type: 'bearer'; token: string }
  | { type: 'custom_header'; header: string; value: string }
  | ({ type: 'imap' } & ImapMailboxCredentials)
  | { type: 'gcs'; serviceAccountKey: GcsCredentialKey; bucket: string; projectId?: string }
  | {
      type: 's3'
      accessKey: S3AccessKey
      bucket: string
      region?: string
      /** Custom endpoint URL for non-AWS S3-compatible stores (MinIO, R2, B2). Omit for AWS. */
      endpoint?: string
      /** Path-style addressing (bucket in the URL path). Defaults on for custom endpoints. */
      forcePathStyle?: boolean
    }
  | { type: 'local'; path: string }
  | { type: 'none' }

/** Normalize a decrypted credentials blob into the typed union. */
export function normalizeStoredCredentials(raw: unknown): ConnectorCredentials | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const t = obj.type as string | undefined
  switch (t) {
    case 'bearer':
      return typeof obj.token === 'string' ? { type: 'bearer', token: obj.token } : null
    case 'custom_header':
      return typeof obj.header === 'string' && typeof obj.value === 'string'
        ? { type: 'custom_header', header: obj.header, value: obj.value }
        : null
    case 'gcs': {
      const key = obj.serviceAccountKey
      const bucket = obj.bucket
      if (
        key && typeof key === 'object' &&
        typeof (key as Record<string, unknown>).client_email === 'string' &&
        typeof bucket === 'string'
      ) {
        return {
          type: 'gcs',
          serviceAccountKey: key as GcsCredentialKey,
          bucket,
          ...(typeof obj.projectId === 'string' ? { projectId: obj.projectId } : {}),
        }
      }
      return null
    }
    case 'imap': {
      if (
        typeof obj.email === 'string' &&
        typeof obj.appPassword === 'string' &&
        typeof obj.imapHost === 'string' &&
        typeof obj.imapPort === 'number' &&
        typeof obj.smtpHost === 'string' &&
        typeof obj.smtpPort === 'number'
      ) {
        return {
          type: 'imap',
          email: obj.email,
          appPassword: obj.appPassword,
          imapHost: obj.imapHost,
          imapPort: obj.imapPort,
          smtpHost: obj.smtpHost,
          smtpPort: obj.smtpPort,
        }
      }
      return null
    }
    case 's3': {
      const key = obj.accessKey
      const bucket = obj.bucket
      if (
        key && typeof key === 'object' &&
        typeof (key as Record<string, unknown>).accessKeyId === 'string' &&
        typeof (key as Record<string, unknown>).secretAccessKey === 'string' &&
        typeof bucket === 'string'
      ) {
        return {
          type: 's3',
          accessKey: key as S3AccessKey,
          bucket,
          ...(typeof obj.region === 'string' ? { region: obj.region } : {}),
          ...(typeof obj.endpoint === 'string' ? { endpoint: obj.endpoint } : {}),
          ...(typeof obj.forcePathStyle === 'boolean' ? { forcePathStyle: obj.forcePathStyle } : {}),
        }
      }
      return null
    }
    case 'none':
      return { type: 'none' }
    case 'local':
      return typeof obj.path === 'string' ? { type: 'local', path: obj.path } : null
    case 'oauth':
    case undefined:
      // Legacy blobs predate the discriminator — every stored pair is OAuth-shaped.
      return typeof obj.client_id === 'string' && typeof obj.client_secret === 'string'
        ? { type: 'oauth', client_id: obj.client_id, client_secret: obj.client_secret }
        : null
    default:
      return null
  }
}

/** The `credentials_type` column value for a credentials write. */
export function credsTypeOf(
  creds: ConnectorCredentials | OAuthCredentials | null | undefined,
): ConnectorAuthType {
  if (!creds) return 'none'
  return 'type' in creds ? creds.type : 'oauth'
}

export type McpConnector = {
  id: string
  userId: string
  connectorId: string
  name: string
  url: string | null
  custom: boolean
  connected: boolean
  credentialsType: ConnectorAuthType
  /**
   * Non-secret, client-writable JSON config (gdrive authorized files, gcal
   * config, the `custom_header` name mirror, and `preflightHeaders` — see
   * `docs/architecture/engine/tool-hooks.md`). Never holds credentials.
   */
  config?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export type ConnectorStore = {
  list(userId: string): Promise<McpConnector[]>

  upsert(
    userId: string,
    params: {
      connectorId: string
      name: string
      url?: string
      custom?: boolean
      connected?: boolean
      credentials?: ConnectorCredentials | OAuthCredentials
      /**
       * Null out the stored credentials (and reset `credentials_type` to
       * 'none'). Needed because the UPDATE branch keeps credentials via
       * COALESCE when none are provided — switching a connector to
       * auth-type 'none' must clear, not keep.
       */
      clearCredentials?: boolean
    },
  ): Promise<McpConnector>

  setConnected(userId: string, connectorId: string, connected: boolean): Promise<McpConnector | null>

  getCredentials(userId: string, connectorId: string): Promise<OAuthCredentials | null>

  /** System-level credential access (no RLS) for worker context. */
  getCredentialsSystem(userId: string, connectorId: string): Promise<OAuthCredentials | null>

  /**
   * Decrypt + normalize credentials for outbound MCP auth. Unlike
   * `getCredentials`, this does NOT filter on `connected = true` — the
   * connection probe must read credentials of a not-yet-connected row.
   * RLS-gated.
   */
  getAuthCredentials(userId: string, connectorId: string): Promise<ConnectorCredentials | null>

  /** Get the JSONB config for a connector. Returns {} if no config set. */
  getConfig(userId: string, connectorId: string): Promise<Record<string, unknown>>

  /** Merge config keys into the connector's JSONB config. */
  setConfig(userId: string, connectorId: string, config: Record<string, unknown>): Promise<void>

  delete(userId: string, connectorId: string): Promise<boolean>
}

// ── Store ──────────────────────────────────────────────────────

// connector_instance columns projected as the legacy McpConnector shape.
// `label` is aliased back to `name`, `provider` back to `connectorId`.
const PUBLIC_COLS = `
  id,
  user_id AS "userId",
  provider AS "connectorId",
  label AS name,
  url, custom, connected,
  credentials_type AS "credentialsType",
  config,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
` as const

type ConnectorRow = McpConnector

export function createDbConnectorStore(encryptionKey: Buffer | null): ConnectorStore {
  return {
    async list(userId) {
      // `connector_instance` exists in every edition: the hosted overlay-v1
      // baseline creates it, and migration 280_oss_connectors creates it for the
      // OSS open schema. (It was previously OSS-stubbed to `[]` because the table
      // was absent there.)
      const result = await queryWithRLS<ConnectorRow>(
        userId,
        `SELECT ${PUBLIC_COLS} FROM connector_instance
         WHERE scope = 'user' AND user_id = $1
         ORDER BY custom ASC, label ASC`,
        [userId],
      )
      return result.rows
    },

    async upsert(userId, params) {
      if (params.credentials && !encryptionKey) {
        throw new Error('Cannot store connector credentials: CHANNEL_CREDENTIAL_KEY is not configured')
      }

      const encrypted =
        params.credentials && encryptionKey
          ? encryptCredentials(params.credentials as unknown as ChannelCredentials, encryptionKey)
          : null

      // The legacy contract is "one row per (user_id, connector_id)".
      // connector_instance has no such UNIQUE, so we preserve the
      // semantic by finding the first matching row and updating it;
      // on miss we INSERT a new user-scoped row.
      const existing = await queryWithRLS<{ id: string }>(
        userId,
        `SELECT id FROM connector_instance
         WHERE scope = 'user' AND user_id = $1 AND provider = $2
         ORDER BY created_at ASC
         LIMIT 1`,
        [userId, params.connectorId],
      )

      const clear = params.clearCredentials === true

      if (existing.rows[0]) {
        // Credentials three-way: clear → NULL + 'none'; new blob → replace
        // both; neither → keep both (legacy COALESCE semantics).
        const result = await queryWithRLS<ConnectorRow>(
          userId,
          `UPDATE connector_instance
             SET label       = $2,
                 url         = $3,
                 connected   = COALESCE($4, connected),
                 credentials = CASE WHEN $6 THEN NULL ELSE COALESCE($5, credentials) END,
                 credentials_type = CASE
                   WHEN $6 THEN 'none'
                   WHEN $5::bytea IS NOT NULL THEN $7
                   ELSE credentials_type
                 END
           WHERE id = $1
           RETURNING ${PUBLIC_COLS}`,
          [
            existing.rows[0].id,
            params.name,
            params.url ?? null,
            params.connected ?? null,
            encrypted,
            clear,
            credsTypeOf(params.credentials),
          ],
        )
        return result.rows[0]
      }

      const result = await queryWithRLS<ConnectorRow>(
        userId,
        `INSERT INTO connector_instance
           (scope, user_id, provider, label, url, custom, credentials, credentials_type, connected, created_by)
         VALUES ('user', $1, $2, $3, $4, $5, $6, $7, COALESCE($8, false), $1)
         RETURNING ${PUBLIC_COLS}`,
        [
          userId,
          params.connectorId,
          params.name,
          params.url ?? null,
          params.custom ?? false,
          encrypted,
          credsTypeOf(encrypted ? params.credentials : null),
          params.connected ?? null,
        ],
      )
      return result.rows[0]
    },

    async setConnected(userId, connectorId, connected) {
      // Target the first matching instance for legacy (user, connectorId) semantics.
      const result = await queryWithRLS<ConnectorRow>(
        userId,
        `UPDATE connector_instance
           SET connected = $3
         WHERE id = (
           SELECT id FROM connector_instance
           WHERE scope = 'user' AND user_id = $1 AND provider = $2
           ORDER BY created_at ASC
           LIMIT 1
         )
         RETURNING ${PUBLIC_COLS}`,
        [userId, connectorId, connected],
      )
      return result.rows[0] ?? null
    },

    async getCredentials(userId, connectorId) {
      const result = await queryWithRLS<{ credentials: Buffer | null }>(
        userId,
        `SELECT credentials FROM connector_instance
         WHERE scope = 'user' AND user_id = $1 AND provider = $2 AND connected = true
         ORDER BY created_at ASC
         LIMIT 1`,
        [userId, connectorId],
      )
      const row = result.rows[0]
      if (!row?.credentials || !encryptionKey) return null
      return decryptCredentials(row.credentials, encryptionKey) as unknown as OAuthCredentials
    },

    async getCredentialsSystem(userId, connectorId) {
      const result = await query<{ credentials: Buffer | null }>(
        `SELECT credentials FROM connector_instance
         WHERE scope = 'user' AND user_id = $1 AND provider = $2 AND connected = true
         ORDER BY created_at ASC
         LIMIT 1`,
        [userId, connectorId],
      )
      const row = result.rows[0]
      if (!row?.credentials || !encryptionKey) return null
      return decryptCredentials(row.credentials, encryptionKey) as unknown as OAuthCredentials
    },

    async getAuthCredentials(userId, connectorId) {
      // No `connected = true` filter — the connection probe reads the
      // credentials of a row that is not connected yet.
      const result = await queryWithRLS<{ credentials: Buffer | null }>(
        userId,
        `SELECT credentials FROM connector_instance
         WHERE scope = 'user' AND user_id = $1 AND provider = $2
         ORDER BY created_at ASC
         LIMIT 1`,
        [userId, connectorId],
      )
      const row = result.rows[0]
      if (!row?.credentials || !encryptionKey) return null
      return normalizeStoredCredentials(decryptCredentials(row.credentials, encryptionKey))
    },

    async getConfig(userId, connectorId) {
      const result = await queryWithRLS<{ config: Record<string, unknown> }>(
        userId,
        `SELECT COALESCE(config, '{}') AS config FROM connector_instance
         WHERE scope = 'user' AND user_id = $1 AND provider = $2
         ORDER BY created_at ASC
         LIMIT 1`,
        [userId, connectorId],
      )
      return result.rows[0]?.config ?? {}
    },

    async setConfig(userId, connectorId, config) {
      await queryWithRLS(
        userId,
        `UPDATE connector_instance
           SET config = COALESCE(config, '{}') || $3::jsonb
         WHERE id = (
           SELECT id FROM connector_instance
           WHERE scope = 'user' AND user_id = $1 AND provider = $2
           ORDER BY created_at ASC
           LIMIT 1
         )`,
        [userId, connectorId, JSON.stringify(config)],
      )
    },

    async delete(userId, connectorId) {
      const result = await queryWithRLS(
        userId,
        `DELETE FROM connector_instance
         WHERE id = (
           SELECT id FROM connector_instance
           WHERE scope = 'user' AND user_id = $1 AND provider = $2
           ORDER BY created_at ASC
           LIMIT 1
         )`,
        [userId, connectorId],
      )
      return (result.rowCount ?? 0) > 0
    },
  }
}
