/**
 * Connector actions audit store — fronts `connector_actions` (migration 136,
 * WU-6.1). Every connector write (send_email, post_message, create_event,
 * …) materializes a row here so the system has end-to-end provenance.
 *
 * WU-6.6 surface (this WU): `create` (with `source_memory_id` backlink for
 * commitment-memory broadcasts) and `listBySourceMemory` (the broadcast
 * history query from `connector-actions.md:121-124`). Broader CRUD
 * (markExecuted, markFailed, retry pathways) is WU-6.3's territory.
 *
 * Specs:
 *  - docs/plans/company-brain/connector-actions.md (table schema + lifecycle)
 *  - docs/historical/decisions-log.md → "SV — Commitment-memory convention"
 *
 * Migration dependency: this store assumes `connector_actions` exists.
 * Until WU-6.1 ships migration 136, the integration tests skip; the type
 * surface still compiles and the store can be wired through interfaces.
 */

import type { Sensitivity } from '@use-brian/core'
import { query } from './client.js'

export type ConnectorActionStatus =
  | 'pending_confirmation'
  | 'allowed'
  | 'denied'
  | 'executed'
  | 'failed'

export type ConnectorAction = {
  id: string
  workspaceId: string
  episodeId: string
  connectorId: string
  actionKind: string
  payload: Record<string, unknown>
  initiatedByUserId: string
  initiatedByAssistantId: string
  retrievalSensitivityMax: Sensitivity
  audienceClearance: Sensitivity
  responseCeiling: Sensitivity
  status: ConnectorActionStatus
  confirmationAt: Date | null
  confirmationBy: string | null
  executedAt: Date | null
  externalId: string | null
  error: string | null
  sourceEpisodeIds: string[]
  /** Backlink to the commitment-memory this action broadcasts (SV 2026-05-14). */
  sourceMemoryId: string | null
  idempotencyKey: string | null
  createdAt: Date
}

export type CreateConnectorActionParams = {
  workspaceId: string
  episodeId: string
  connectorId: string
  actionKind: string
  payload: Record<string, unknown>
  initiatedByUserId: string
  initiatedByAssistantId: string
  retrievalSensitivityMax: Sensitivity
  audienceClearance: Sensitivity
  responseCeiling: Sensitivity
  status: ConnectorActionStatus
  sourceEpisodeIds?: string[]
  /** Set when the action broadcasts a commitment-memory. */
  sourceMemoryId?: string | null
  idempotencyKey?: string | null
}

const COLS = `
  id,
  workspace_id              AS "workspaceId",
  episode_id                AS "episodeId",
  connector_id              AS "connectorId",
  action_kind               AS "actionKind",
  payload,
  initiated_by_user_id      AS "initiatedByUserId",
  initiated_by_assistant_id AS "initiatedByAssistantId",
  retrieval_sensitivity_max AS "retrievalSensitivityMax",
  audience_clearance        AS "audienceClearance",
  response_ceiling          AS "responseCeiling",
  status,
  confirmation_at           AS "confirmationAt",
  confirmation_by           AS "confirmationBy",
  executed_at               AS "executedAt",
  external_id               AS "externalId",
  error,
  source_episode_ids        AS "sourceEpisodeIds",
  source_memory_id          AS "sourceMemoryId",
  idempotency_key           AS "idempotencyKey",
  created_at                AS "createdAt"
`

export type ConnectorActionStore = {
  /**
   * Insert a connector-action audit row. `sourceMemoryId` is the
   * commitment-memory backlink that powers the broadcast-history query;
   * pass it whenever the action surfaces a `commitment:<kind>` memory so
   * the lifecycle can correlate broadcasts with their source.
   *
   * Idempotency: callers may supply `idempotencyKey` (e.g.
   * sha256(connector_id|action_kind|normalized_payload)). On conflict the
   * existing row is returned — callers can detect a double-tap without a
   * separate read.
   */
  create(params: CreateConnectorActionParams): Promise<ConnectorAction>

  /**
   * Broadcast history for a commitment-memory.
   *
   *   SELECT * FROM connector_actions
   *   WHERE source_memory_id = $1
   *   ORDER BY created_at ASC;
   *
   * Rows without `source_memory_id` are excluded.
   */
  listBySourceMemory(memoryId: string): Promise<ConnectorAction[]>
}

export function createDbConnectorActionStore(): ConnectorActionStore {
  return {
    async create(params) {
      const sourceEpisodeIds = params.sourceEpisodeIds ?? []
      const sourceMemoryId = params.sourceMemoryId ?? null
      const idempotencyKey = params.idempotencyKey ?? null

      // ON CONFLICT (idempotency_key) DO NOTHING returns no rows; a
      // follow-up SELECT pulls the original. We guard against the NULL
      // case — only fire the SELECT when the caller supplied a key.
      const insert = await query<ConnectorAction>(
        `INSERT INTO connector_actions (
           workspace_id, episode_id, connector_id, action_kind, payload,
           initiated_by_user_id, initiated_by_assistant_id,
           retrieval_sensitivity_max, audience_clearance, response_ceiling,
           status, source_episode_ids, source_memory_id, idempotency_key
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${COLS}`,
        [
          params.workspaceId,
          params.episodeId,
          params.connectorId,
          params.actionKind,
          JSON.stringify(params.payload),
          params.initiatedByUserId,
          params.initiatedByAssistantId,
          params.retrievalSensitivityMax,
          params.audienceClearance,
          params.responseCeiling,
          params.status,
          sourceEpisodeIds,
          sourceMemoryId,
          idempotencyKey,
        ],
      )
      if (insert.rows[0]) return insert.rows[0]

      // ON CONFLICT hit. The caller must have supplied an idempotencyKey
      // (NULLs never conflict). Fetch the existing row.
      if (!idempotencyKey) {
        // Defensive: no key means no conflict was possible. Surface loudly
        // — this would indicate a CHECK or trigger silently swallowed the
        // insert.
        throw new Error('connector_actions insert returned no row without an idempotency key')
      }
      const existing = await query<ConnectorAction>(
        `SELECT ${COLS} FROM connector_actions WHERE idempotency_key = $1`,
        [idempotencyKey],
      )
      if (!existing.rows[0]) {
        throw new Error(`connector_actions insert conflicted but no row found for idempotency_key=${idempotencyKey}`)
      }
      return existing.rows[0]
    },

    async listBySourceMemory(memoryId) {
      const result = await query<ConnectorAction>(
        `SELECT ${COLS} FROM connector_actions
         WHERE source_memory_id = $1
         ORDER BY created_at ASC`,
        [memoryId],
      )
      return result.rows
    },
  }
}
