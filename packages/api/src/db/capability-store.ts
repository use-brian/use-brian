import type {
  ActiveGrantRow,
  CapabilityGrant,
  CapabilityStore,
} from '@sidanclaw/core'
import { DuplicateGrantError } from '@sidanclaw/core'
import { query } from './client.js'

type GrantRow = {
  id: string
  assistantId: string
  capability: string
  grantedByUserId: string
  grantedAt: Date
  revokedAt: Date | null
  revokedByUserId: string | null
  reason: string | null
}

const GRANT_COLS = `
  id,
  assistant_id AS "assistantId",
  capability,
  granted_by_user_id AS "grantedByUserId",
  granted_at AS "grantedAt",
  revoked_at AS "revokedAt",
  revoked_by_user_id AS "revokedByUserId",
  reason
`

export function createDbCapabilityStore(): CapabilityStore {
  return {
    async listActive(assistantId) {
      const result = await query<{ capability: string }>(
        `SELECT capability FROM assistant_capabilities
         WHERE assistant_id = $1 AND revoked_at IS NULL`,
        [assistantId],
      )
      return result.rows.map((r) => r.capability)
    },

    async hasActive(assistantId) {
      const result = await query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM assistant_capabilities
           WHERE assistant_id = $1 AND revoked_at IS NULL
         ) AS exists`,
        [assistantId],
      )
      return result.rows[0]?.exists ?? false
    },

    async listAllActive() {
      const result = await query<GrantRow & { assistantName: string; ownerEmail: string | null }>(
        `SELECT ${GRANT_COLS},
                a.name AS "assistantName",
                u.email AS "ownerEmail"
         FROM assistant_capabilities ac
         JOIN assistants a ON a.id = ac.assistant_id
         LEFT JOIN users u ON u.id = a.owner_user_id
         WHERE ac.revoked_at IS NULL
         ORDER BY ac.granted_at DESC`,
      )
      return result.rows as ActiveGrantRow[]
    },

    async listHistoryForAssistant(assistantId) {
      const result = await query<GrantRow>(
        `SELECT ${GRANT_COLS} FROM assistant_capabilities
         WHERE assistant_id = $1
         ORDER BY granted_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async grant({ assistantId, capability, grantedByUserId, reason }) {
      try {
        const result = await query<GrantRow>(
          `INSERT INTO assistant_capabilities
             (assistant_id, capability, granted_by_user_id, reason)
           VALUES ($1, $2, $3, $4)
           RETURNING ${GRANT_COLS}`,
          [assistantId, capability, grantedByUserId, reason ?? null],
        )
        return result.rows[0]
      } catch (err) {
        // 23505 = unique_violation. Only one partial-unique index exists on
        // this table (uniq_active_capability) — any 23505 here means an
        // active grant for (assistantId, capability) already exists.
        if (isUniqueViolation(err)) {
          throw new DuplicateGrantError(assistantId, capability)
        }
        throw err
      }
    },

    async revoke({ grantId, revokedByUserId, reason }) {
      const result = await query<GrantRow>(
        `UPDATE assistant_capabilities
         SET revoked_at = now(),
             revoked_by_user_id = $2,
             reason = COALESCE($3, reason)
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING ${GRANT_COLS}`,
        [grantId, revokedByUserId, reason ?? null],
      )
      return result.rows[0] ?? null
    },
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === '23505'
}
