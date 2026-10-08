/**
 * DB-backed standing grants for browser skills.
 *
 * [COMP:sandbox/approval-grants]
 */
import type { BrowserSkillGrant, BrowserSkillGrantStore } from '@use-brian/core'
import type { PoolClient } from 'pg'
import { query } from './client.js'
import { createBrowserProfileStore, withBrowserProfileOwnerMutation } from './browser-profile-store.js'

type Row = {
  source_approval_id: string | null
  skill_version: number | null
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
    skillVersion: row.skill_version ?? null,
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

/** Recheck original review authority and current identity before reading or spending a grant. */
async function withAdmittedGrant<T>(row: Row, operation: (client: PoolClient) => Promise<T>): Promise<T | null> {
  if (!row.source_approval_id || !row.skill_version) return null
  const profile = await createBrowserProfileStore().get(row.profile_id)
  if (!profile || profile.workspaceId !== row.workspace_id || profile.ownerUserId !== row.granted_by) return null
  try {
    return await withBrowserProfileOwnerMutation(profile.id, profile, async client => {
      const denied = () => Object.assign(new Error('Grant authority unavailable'), { code: 'profile_authority_denied' })
      const source = await client.query('SELECT id FROM pending_approvals WHERE id=$1 FOR SHARE', [row.source_approval_id])
      if (!source.rowCount) throw denied()
      // Lazy import avoids eager initialization of the mutually dependent persistence modules.
      const { createPendingApprovalsStore, lockBrowserApprovalSource } = await import('./pending-approvals-store.js')
      const approval = await createPendingApprovalsStore().getById(row.granted_by, row.source_approval_id!)
      if (!approval || approval.status !== 'approved' || approval.kind !== 'browser_skill_send'
        || approval.workspaceId !== row.workspace_id || approval.approverUserId !== row.granted_by
        || approval.respondedBy !== row.granted_by || approval.approvalPayload.profileId !== row.profile_id
        || approval.approvalPayload.skillId !== row.skill_id || approval.approvalPayload.skillVersion !== row.skill_version) throw denied()
      const assertSourceFresh = await lockBrowserApprovalSource(client, row.granted_by, approval)
      const skill = await client.query("SELECT version FROM browser_skills WHERE id=$1 AND workspace_id=$2 AND status='active' FOR SHARE", [row.skill_id,row.workspace_id])
      if (skill.rows[0]?.version !== row.skill_version) throw denied()
      const current = await client.query(`SELECT id FROM browser_skill_grants WHERE id=$1 AND status='active'
        AND workspace_id=$2 AND profile_id=$3 AND granted_by=$4 AND skill_id=$5 AND skill_version=$6
        AND source_approval_id=$7 AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR UPDATE`,
        [row.id,row.workspace_id,row.profile_id,row.granted_by,row.skill_id,row.skill_version,row.source_approval_id])
      if (!current.rowCount) throw denied()
      const result = await operation(client)
      await assertSourceFresh()
      return result
    })
  } catch (error) {
    if ((error as {code?:string}).code === 'profile_authority_denied') return null
    throw error
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
      return res.rows[0] ? withAdmittedGrant(res.rows[0], async () => toGrant(res.rows[0])) : null
    },

    async recordUse(id, params) {
      const existing = await query<Row>('SELECT * FROM browser_skill_grants WHERE id=$1', [id])
      const refused = { withinBudget: false, withinRate: false }
      if (!existing.rows[0]) return refused
      return await withAdmittedGrant(existing.rows[0], async client => {
        const res = await client.query<{
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
           WHERE id = $1 AND status='active' AND (expires_at IS NULL OR expires_at>clock_timestamp())
           RETURNING spent_usd, budget_usd, rate_per_hour, window_use_count`,
          [id, params?.costUsd ?? 0],
        )
        const row = res.rows[0]
        if (!row) return { withinBudget: false, withinRate: false }
        return {
          withinBudget: row.budget_usd === null || Number(row.spent_usd) <= Number(row.budget_usd),
          withinRate: row.rate_per_hour === null || row.window_use_count <= row.rate_per_hour,
        }
      }) ?? refused
    },

    async void(id, reason) {
      await query(
        `UPDATE browser_skill_grants SET status = 'voided', void_reason = $2
          WHERE id = $1 AND status = 'active'`,
        [id, reason.slice(0, 500)],
      )
    },

    async create(params) {
      const denied = () => Object.assign(new Error('Profile authority unavailable'), { code: 'profile_authority_denied' })
      const profile = await createBrowserProfileStore().get(params.profileId)
      if (!profile || profile.workspaceId !== params.workspaceId || profile.ownerUserId !== params.grantedBy) throw denied()
      return withBrowserProfileOwnerMutation(profile.id, profile, async client => {
        return createBrowserSkillGrantInTransaction(client, params)
      })
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

    async revoke(id, expectedProfile) {
      if (expectedProfile) {
        await withBrowserProfileOwnerMutation(expectedProfile.id, expectedProfile, async client => {
          await client.query(`UPDATE browser_skill_grants SET status='revoked'
            WHERE id=$1 AND profile_id=$2 AND workspace_id=$3 AND status='active'`,
          [id, expectedProfile.id, expectedProfile.workspaceId])
        })
      } else await query(`UPDATE browser_skill_grants SET status = 'revoked' WHERE id = $1 AND status = 'active'`, [id])
    },
  }
}

/** Caller must hold the profile owner-mutation transaction through commit. */
export async function createBrowserSkillGrantInTransaction(
  client: PoolClient, params: Parameters<BrowserSkillGrantStore['create']>[0], sourceApprovalId?: string,
): Promise<BrowserSkillGrant> {
  const denied = () => Object.assign(new Error('Profile authority unavailable'), { code: 'profile_authority_denied' })
  const skill = await client.query("SELECT id, version FROM browser_skills WHERE id=$1 AND workspace_id=$2 AND status='active' FOR SHARE",
    [params.skillId, params.workspaceId])
  if (!skill.rowCount || (params.skillVersion !== undefined && params.skillVersion !== skill.rows[0].version)) throw denied()
  await client.query(
    `UPDATE browser_skill_grants SET status = 'revoked'
      WHERE workspace_id = $1 AND skill_id = $2 AND profile_id = $3 AND status = 'active'`,
    [params.workspaceId, params.skillId, params.profileId],
  )
  const res = await client.query<Row>(
    `INSERT INTO browser_skill_grants
       (workspace_id, skill_id, profile_id, granted_by, budget_usd, rate_per_hour, expires_at, skill_version, source_approval_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      params.workspaceId,
      params.skillId,
      params.profileId,
      params.grantedBy,
      params.budgetUsd ?? null,
      params.ratePerHour ?? null,
      params.expiresAt ?? null,
      skill.rows[0].version,
      sourceApprovalId ?? null,
    ],
  )
  return toGrant(res.rows[0])
}
