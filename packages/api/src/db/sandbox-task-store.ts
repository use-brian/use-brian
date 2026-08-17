/**
 * DB-backed sandbox task store and spend accumulator.
 *
 * [COMP:sandbox/lifecycle]
 */
import type { SandboxTaskRecord, SandboxTaskStatus, SandboxTaskStore } from '@use-brian/core'
import { query } from './client.js'

type Row = {
  task_id: string
  sandbox_id: string
  user_id: string
  workspace_id: string
  session_id: string
  status: SandboxTaskStatus
  profile_id: string | null
  injected_site: string | null
  browser_started_at: Date | null
  authorized_budget_usd: string
  created_at: Date
  last_activity_at: Date
}

function toRecord(row: Row): SandboxTaskRecord {
  return {
    taskId: row.task_id,
    sandboxId: row.sandbox_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    status: row.status,
    profileId: row.profile_id,
    injectedSite: row.injected_site,
    browserStartedAt: row.browser_started_at?.getTime() ?? null,
    authorizedBudgetUsd: Number(row.authorized_budget_usd),
    createdAt: row.created_at.getTime(),
    lastActivityAt: row.last_activity_at.getTime(),
  }
}

export type DbSandboxTaskStore = SandboxTaskStore & {
  addSpend(taskId: string, usd: number): Promise<{ spentUsd: number; authorizedBudgetUsd: number }>
}

export function createSandboxTaskStore(): DbSandboxTaskStore {
  return {
    async getActiveBySession(sessionId) {
      const res = await query<Row>(
        `SELECT * FROM sandbox_tasks
          WHERE session_id = $1 AND status IN ('running', 'paused')
          ORDER BY created_at DESC LIMIT 1`,
        [sessionId],
      )
      return res.rows[0] ? toRecord(res.rows[0]) : null
    },

    async listActiveByWorkspace(workspaceId) {
      const res = await query<Row>(
        `SELECT * FROM sandbox_tasks
          WHERE workspace_id = $1
            AND status IN ('running', 'paused')
            AND browser_started_at IS NOT NULL
          ORDER BY created_at DESC`,
        [workspaceId],
      )
      return res.rows.map(toRecord)
    },

    async create(record) {
      await query(
        `INSERT INTO sandbox_tasks
           (task_id, sandbox_id, user_id, workspace_id, session_id, status,
            profile_id, injected_site, browser_started_at, authorized_budget_usd,
            created_at, last_activity_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 to_timestamp($9::double precision / 1000.0),
                 $10, to_timestamp($11 / 1000.0), to_timestamp($12 / 1000.0))`,
        [
          record.taskId,
          record.sandboxId,
          record.userId,
          record.workspaceId,
          record.sessionId,
          record.status,
          record.profileId,
          record.injectedSite,
          record.browserStartedAt,
          record.authorizedBudgetUsd,
          record.createdAt,
          record.lastActivityAt,
        ],
      )
    },

    async update(taskId, patch) {
      const sets: string[] = []
      const params: unknown[] = [taskId]
      const push = (sql: string, value: unknown) => {
        params.push(value)
        sets.push(`${sql} = $${params.length}`)
      }
      if (patch.status !== undefined) push('status', patch.status)
      if (patch.profileId !== undefined) push('profile_id', patch.profileId)
      if (patch.injectedSite !== undefined) push('injected_site', patch.injectedSite)
      if (patch.browserStartedAt !== undefined) {
        params.push(patch.browserStartedAt)
        sets.push(`browser_started_at = to_timestamp($${params.length}::double precision / 1000.0)`)
      }
      if (patch.authorizedBudgetUsd !== undefined) push('authorized_budget_usd', patch.authorizedBudgetUsd)
      if (patch.lastActivityAt !== undefined) {
        params.push(patch.lastActivityAt)
        sets.push(`last_activity_at = to_timestamp($${params.length} / 1000.0)`)
      }
      if (sets.length === 0) return
      await query(`UPDATE sandbox_tasks SET ${sets.join(', ')} WHERE task_id = $1`, params)
    },

    async listStale(cutoffMs) {
      const res = await query<Row>(
        `SELECT * FROM sandbox_tasks
          WHERE status IN ('running', 'paused') AND last_activity_at < to_timestamp($1 / 1000.0)`,
        [cutoffMs],
      )
      return res.rows.map(toRecord)
    },

    async addSpend(taskId, usd) {
      const res = await query<{ spent_usd: string; authorized_budget_usd: string }>(
        `UPDATE sandbox_tasks SET spent_usd = spent_usd + $2
          WHERE task_id = $1
          RETURNING spent_usd, authorized_budget_usd`,
        [taskId, usd],
      )
      const row = res.rows[0]
      return {
        spentUsd: row ? Number(row.spent_usd) : 0,
        authorizedBudgetUsd: row ? Number(row.authorized_budget_usd) : 0,
      }
    },
  }
}
