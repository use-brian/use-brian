/**
 * `ingest-sink-store.ts` — external-sink config for the ingest pipeline.
 *
 * Data-access layer over `ingest_external_sink` (migration 364). A sink
 * attaches to a `connector_instance` (the same attachment point as
 * `ingest_rules`) and names the external endpoint that receives the
 * instance's normalized events under `ub.ingest.append.v1` — see
 * docs/architecture/brain/ingest-external-sink.md.
 *
 * Secrets are AES-256-GCM blobs (`credential-crypto.ts`) under the
 * CHANNEL_CREDENTIAL_KEY master key — never inline plaintext (X6). The
 * decrypted secret is exposed only through `getSecretSystem` for the relay
 * worker's outbound auth; sink DTOs carry a `hasSecret` boolean instead.
 *
 * `recordAck` is the X3 barrier: `last_ack_cursor` moves ONLY when the relay
 * received a 200 whose accounting proved durable storage and that carried an
 * `ack_cursor`. Nothing else may write that column.
 *
 * All access is system-level (owner pool): `ingest_external_sink` is
 * worker/control-plane state (RLS `system_bypass`-only, the
 * pending_ingest_batches posture); routes do their own RLS-gated
 * connector_instance access check before calling in.
 *
 * [COMP:api/ingest-sink-store]
 */

import { getPool } from './client.js'
import { decryptCredentials, encryptCredentials } from './credential-crypto.js'

export type IngestSinkAuthKind = 'bearer' | 'hmac'
export type IngestSinkMode = 'all' | 'rule_filtered'

export type IngestExternalSink = {
  id: string
  connectorInstanceId: string
  workspaceId: string
  endpointUrl: string
  authKind: IngestSinkAuthKind
  mode: IngestSinkMode
  enabled: boolean
  hasSecret: boolean
  /** Opaque — last cursor the sink durably acked (X3). */
  lastAckCursor: unknown
  lastDeliveredAt: Date | null
  createdAt: Date
}

export type CreateIngestSinkParams = {
  connectorInstanceId: string
  workspaceId: string
  endpointUrl: string
  authKind: IngestSinkAuthKind
  secret: string
  mode?: IngestSinkMode
  enabled?: boolean
}

export type UpdateIngestSinkPatch = {
  endpointUrl?: string
  authKind?: IngestSinkAuthKind
  secret?: string
  mode?: IngestSinkMode
  enabled?: boolean
}

type SecretBlob = { secret: string }

const COLS = `
  id,
  connector_instance_id AS "connectorInstanceId",
  workspace_id          AS "workspaceId",
  endpoint_url          AS "endpointUrl",
  auth_kind             AS "authKind",
  mode,
  enabled,
  (secret_ciphertext IS NOT NULL) AS "hasSecret",
  last_ack_cursor       AS "lastAckCursor",
  last_delivered_at     AS "lastDeliveredAt",
  created_at            AS "createdAt"
`

function rowToSink(row: Record<string, unknown>): IngestExternalSink {
  return {
    id: row.id as string,
    connectorInstanceId: row.connectorInstanceId as string,
    workspaceId: row.workspaceId as string,
    endpointUrl: row.endpointUrl as string,
    authKind: row.authKind as IngestSinkAuthKind,
    mode: row.mode as IngestSinkMode,
    enabled: row.enabled as boolean,
    hasSecret: row.hasSecret as boolean,
    lastAckCursor: row.lastAckCursor ?? null,
    lastDeliveredAt: (row.lastDeliveredAt as Date | null) ?? null,
    createdAt: row.createdAt as Date,
  }
}

export type IngestSinkStore = {
  create(params: CreateIngestSinkParams): Promise<IngestExternalSink>
  get(id: string): Promise<IngestExternalSink | null>
  listByInstance(connectorInstanceId: string): Promise<IngestExternalSink[]>
  /** The fan-out read — only sinks that should receive events right now. */
  listEnabledByInstance(connectorInstanceId: string): Promise<IngestExternalSink[]>
  update(id: string, patch: UpdateIngestSinkPatch): Promise<IngestExternalSink | null>
  remove(id: string): Promise<boolean>
  /** Decrypted outbound-auth secret — relay-only. Null when none stored. */
  getSecretSystem(id: string): Promise<string | null>
  /**
   * Advance the sink cursor after an acked delivery (X3). `ackCursor` is
   * stored opaquely; `last_delivered_at` stamps alongside it.
   */
  recordAck(id: string, ackCursor: unknown): Promise<void>
}

export function createIngestSinkStore(encryptionKey: Buffer | null): IngestSinkStore {
  function encryptSecret(secret: string): Buffer {
    if (!encryptionKey) {
      throw new Error(
        'ingest-sink-store: CHANNEL_CREDENTIAL_KEY is required to store sink secrets — refusing to store plaintext',
      )
    }
    return encryptCredentials<SecretBlob>({ secret }, encryptionKey)
  }

  return {
    async create(params) {
      const result = await getPool().query(
        `INSERT INTO ingest_external_sink
           (connector_instance_id, workspace_id, endpoint_url, auth_kind,
            secret_ciphertext, mode, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLS}`,
        [
          params.connectorInstanceId,
          params.workspaceId,
          params.endpointUrl,
          params.authKind,
          encryptSecret(params.secret),
          params.mode ?? 'all',
          params.enabled ?? true,
        ],
      )
      return rowToSink(result.rows[0] as Record<string, unknown>)
    },

    async get(id) {
      const result = await getPool().query(
        `SELECT ${COLS} FROM ingest_external_sink WHERE id = $1`,
        [id],
      )
      const row = result.rows[0]
      return row ? rowToSink(row as Record<string, unknown>) : null
    },

    async listByInstance(connectorInstanceId) {
      const result = await getPool().query(
        `SELECT ${COLS} FROM ingest_external_sink
          WHERE connector_instance_id = $1
          ORDER BY created_at ASC`,
        [connectorInstanceId],
      )
      return result.rows.map((r) => rowToSink(r as Record<string, unknown>))
    },

    async listEnabledByInstance(connectorInstanceId) {
      const result = await getPool().query(
        `SELECT ${COLS} FROM ingest_external_sink
          WHERE connector_instance_id = $1 AND enabled = true
          ORDER BY created_at ASC`,
        [connectorInstanceId],
      )
      return result.rows.map((r) => rowToSink(r as Record<string, unknown>))
    },

    async update(id, patch) {
      const sets: string[] = []
      const values: unknown[] = [id]
      const push = (fragment: string, value: unknown) => {
        values.push(value)
        sets.push(`${fragment} = $${values.length}`)
      }
      if (patch.endpointUrl !== undefined) push('endpoint_url', patch.endpointUrl)
      if (patch.authKind !== undefined) push('auth_kind', patch.authKind)
      if (patch.secret !== undefined) push('secret_ciphertext', encryptSecret(patch.secret))
      if (patch.mode !== undefined) push('mode', patch.mode)
      if (patch.enabled !== undefined) push('enabled', patch.enabled)
      if (sets.length === 0) return this.get(id)
      const result = await getPool().query(
        `UPDATE ingest_external_sink SET ${sets.join(', ')}
          WHERE id = $1
          RETURNING ${COLS}`,
        values,
      )
      const row = result.rows[0]
      return row ? rowToSink(row as Record<string, unknown>) : null
    },

    async remove(id) {
      const result = await getPool().query(
        `DELETE FROM ingest_external_sink WHERE id = $1`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    },

    async getSecretSystem(id) {
      const result = await getPool().query(
        `SELECT secret_ciphertext AS "secretCiphertext"
           FROM ingest_external_sink WHERE id = $1`,
        [id],
      )
      const blob = result.rows[0]?.secretCiphertext as Buffer | null | undefined
      if (!blob) return null
      if (!encryptionKey) {
        throw new Error(
          'ingest-sink-store: CHANNEL_CREDENTIAL_KEY is required to read sink secrets',
        )
      }
      return decryptCredentials<SecretBlob>(blob, encryptionKey).secret
    },

    async recordAck(id, ackCursor) {
      await getPool().query(
        `UPDATE ingest_external_sink
            SET last_ack_cursor   = $2::jsonb,
                last_delivered_at = now()
          WHERE id = $1`,
        [id, ackCursor === undefined ? null : JSON.stringify(ackCursor)],
      )
    },
  }
}
