/**
 * Assistant connector grants store — per-assistant capability grants
 * (#4 from `docs/architecture/integrations/connector-actions.md`).
 *
 * Fronts `assistant_connector_grants` (migration 178). The runtime
 * helper `packages/api/src/safety/assert-action-allowed.ts` gates every
 * connector write tool's execute callback on a matching grant; the
 * Studio UI surface (`apps/web/src/components/studio/assistant-detail.tsx`)
 * mutates via the REST route in `packages/api/src/routes/assistant-connector-grants.ts`.
 *
 * Default: no grant row → no writes allowed (action denied with no audit
 * row). Reads pass through `assistant_connector_settings` (mig 019) as
 * before — this table is write-only governance.
 *
 * [COMP:brain/assistant-connector-grants-store]
 */

import { query, queryWithRLS } from './client.js'

export type AssistantConnectorGrant = {
  id: string
  assistantId: string
  connectorId: string
  readAllowed: boolean
  allowedActions: string[]
  grantedByUserId: string
  grantedAt: Date
  updatedAt: Date
}

export type UpsertAssistantConnectorGrant = {
  assistantId: string
  connectorId: string
  readAllowed: boolean
  allowedActions: string[]
}

export type AssistantConnectorGrantsStore = {
  /**
   * Look up the grant for a single (assistant, connector). Returns
   * `null` when no row exists — the safe default (no writes allowed).
   * System-level read because the runtime check inside
   * `assertActionAllowed` happens during a tool execute callback where
   * the acting user is the message author, not the assistant owner,
   * and the audit decision must apply to all callers equally.
   */
  getForAssistantSystem(assistantId: string, connectorId: string): Promise<AssistantConnectorGrant | null>

  /** List every grant row for an assistant. Used by the Studio panel. */
  listForAssistant(userId: string, assistantId: string): Promise<AssistantConnectorGrant[]>

  /**
   * Upsert the grant row. Idempotent on (assistant_id, connector_id).
   * Always bumps `updated_at`.
   */
  upsert(userId: string, input: UpsertAssistantConnectorGrant): Promise<AssistantConnectorGrant>

  /** Delete the grant row. Idempotent — returns false when no row matched. */
  delete(userId: string, assistantId: string, connectorId: string): Promise<boolean>
}

const COLS = `
  id,
  assistant_id        AS "assistantId",
  connector_id        AS "connectorId",
  read_allowed        AS "readAllowed",
  allowed_actions     AS "allowedActions",
  granted_by_user_id  AS "grantedByUserId",
  granted_at          AS "grantedAt",
  updated_at          AS "updatedAt"
`

export function createDbAssistantConnectorGrantsStore(): AssistantConnectorGrantsStore {
  return {
    async getForAssistantSystem(assistantId, connectorId) {
      const result = await query<AssistantConnectorGrant>(
        `SELECT ${COLS} FROM assistant_connector_grants
         WHERE assistant_id = $1 AND connector_id = $2`,
        [assistantId, connectorId],
      )
      return result.rows[0] ?? null
    },

    async listForAssistant(userId, assistantId) {
      const result = await queryWithRLS<AssistantConnectorGrant>(
        userId,
        `SELECT ${COLS} FROM assistant_connector_grants
         WHERE assistant_id = $1
         ORDER BY connector_id`,
        [assistantId],
      )
      return result.rows
    },

    async upsert(userId, input) {
      const result = await queryWithRLS<AssistantConnectorGrant>(
        userId,
        `INSERT INTO assistant_connector_grants (
           assistant_id, connector_id, read_allowed, allowed_actions, granted_by_user_id
         )
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (assistant_id, connector_id) DO UPDATE
           SET read_allowed = EXCLUDED.read_allowed,
               allowed_actions = EXCLUDED.allowed_actions,
               granted_by_user_id = EXCLUDED.granted_by_user_id,
               updated_at = now()
         RETURNING ${COLS}`,
        [
          input.assistantId,
          input.connectorId,
          input.readAllowed,
          input.allowedActions,
          userId,
        ],
      )
      return result.rows[0]
    },

    async delete(userId, assistantId, connectorId) {
      const result = await queryWithRLS(
        userId,
        `DELETE FROM assistant_connector_grants
         WHERE assistant_id = $1 AND connector_id = $2`,
        [assistantId, connectorId],
      )
      return (result.rowCount ?? 0) > 0
    },
  }
}
