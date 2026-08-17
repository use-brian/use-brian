/**
 * DB-backed standing grants for browser skills.
 *
 * [COMP:sandbox/approval-grants]
 */
import type { BrowserSkillGrant, BrowserSkillGrantStore } from '@use-brian/core'
import { query } from './client.js'

type Row = {
  id: string
  workspace_id: string
  skill_id: string
  profile_id: string
  granted_by: string
  budget_usd: string | null
  rate_per_hour: number | null
  spent_usd: string
  window_started_at: Date | null
  window_use_count: number
  expires_at: Date | null
  status: 'active' | 'revoked' | 'voided'
  created_at: Date
  last_used_at: Date | null
}

function toGrant(row: Row): BrowserSkillGrant {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    skillId: row.skill_id,
    profileId: row.profile_id,
    grantedBy: row.granted_by,
    budgetUsd: row.budget_usd === null ? null : Number(row.budget_usd),
    ratePerHour: row.rate_per_hour,
    spentUsd: Number(row.spent_usd),
    expiresAt: row.expires_at?.toISOString() ?? null,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  }
}

export function createBrowserSkillGrantStore(): BrowserSkillGrantStore {
  return {
    async findActive({ workspaceId, skillId, profileId }) {
      const res = await query<Row>(
        `SELECT * FROM browser_skill_grants
          WHERE workspace_id = $1 AND skill_id = $2 AND profile_id = $3
            AND status = 'active'
            AND (expires_at IS NULL OR expires_at > now())`,
        [workspaceId, skillId, profileId],
      )
      return res.rows[0] ? toGrant(res.rows[0]) : null
    },

    async recordUse(id, params) {
      const res = await query<{
        spent_usd: string
        budget_usd: string | null
        rate_per_hour: number | null
        window_use_count: number
      }>(
        `UPDATE browser_skill_grants SET
           window_started_at = CASE
             WHEN window_started_at IS NULL OR window_started_at < now() - interval '1 hour'
             THEN now() ELSE window_started_at END,
           window_use_count = CASE
             WHEN window_started_at IS NULL OR window_started_at < now() - interval '1 hour'
             THEN 1 ELSE window_use_count + 1 END,
           spent_usd = spent_usd + $2,
           last_used_at = now()
         WHERE id = $1
         RETURNING spent_usd, budget_usd, rate_per_hour, window_use_count`,
        [id, params?.costUsd ?? 0],
      )
      const row = res.rows[0]
      if (!row) return { withinBudget: false, withinRate: false }
      return {
        withinBudget: row.budget_usd === null || Number(row.spent_usd) <= Number(row.budget_usd),
        withinRate: row.rate_per_hour === null || row.window_use_count <= row.rate_per_hour,
      }
    },

    async void(id, reason) {
      await query(
        `UPDATE browser_skill_grants SET status = 'voided', void_reason = $2
          WHERE id = $1 AND status = 'active'`,
        [id, reason.slice(0, 500)],
      )
    },

    async create(params) {
      await query(
        `UPDATE browser_skill_grants SET status = 'revoked'
          WHERE workspace_id = $1 AND skill_id = $2 AND profile_id = $3 AND status = 'active'`,
        [params.workspaceId, params.skillId, params.profileId],
      )
      const res = await query<Row>(
        `INSERT INTO browser_skill_grants
           (workspace_id, skill_id, profile_id, granted_by, budget_usd, rate_per_hour, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          params.workspaceId,
          params.skillId,
          params.profileId,
          params.grantedBy,
          params.budgetUsd ?? null,
          params.ratePerHour ?? null,
          params.expiresAt ?? null,
        ],
      )
      return toGrant(res.rows[0])
    },

    async list({ workspaceId, profileId }) {
      const res = profileId
        ? await query<Row>(
            `SELECT * FROM browser_skill_grants
              WHERE workspace_id = $1 AND profile_id = $2 ORDER BY created_at DESC`,
            [workspaceId, profileId],
          )
        : await query<Row>(
            `SELECT * FROM browser_skill_grants WHERE workspace_id = $1 ORDER BY created_at DESC`,
            [workspaceId],
          )
      return res.rows.map(toGrant)
    },

    async revoke(id) {
      await query(`UPDATE browser_skill_grants SET status = 'revoked' WHERE id = $1 AND status = 'active'`, [id])
    },
  }
}
