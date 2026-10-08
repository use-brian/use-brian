import { withFileTransactionAdmission } from '../workspace-access/file-transaction-admission.js'
import { resolveBrowserTaskExecutionAuthority } from '../sandbox/task-execution-authority.js'
import { browserTaskPublicationSnapshot } from '@use-brian/core'
/**
 * DB-backed sandbox task store and spend accumulator.
 *
 * [COMP:sandbox/lifecycle]
 */
import { BrowserProfileAuthoritySchema, parseAuthoringAuthority, AuthoritySourceSchema } from '@use-brian/core'
import { parseBrowserInputScope, mergeBrowserInputScope } from '@use-brian/core'
import type { SandboxTaskRecord, SandboxTaskStatus, SandboxTaskStore } from '@use-brian/core'
import { query, getPool, rollbackAndRelease } from './client.js'

type Row = {
  task_id: string
  sandbox_id: string
  user_id: string
  workspace_id: string
  session_id: string
  status: SandboxTaskStatus
  profile_id: string | null
  source_authority: unknown
  input_scope: unknown
  execution_authority: unknown
  profile_authority: unknown
  injected_site: string | null
  browser_started_at: Date | null
  authorized_budget_usd: string
  created_at: Date
  last_activity_at: Date
}

function toRecord(row: Row): SandboxTaskRecord {
  const executionAuthority = row.execution_authority == null ? null : parseAuthoringAuthority(row.execution_authority)
  if (row.execution_authority != null && !executionAuthority) throw Object.assign(new Error('Task authority unavailable'), { code: 'profile_authority_denied' })
  const parsedSource = row.source_authority == null ? null : AuthoritySourceSchema.safeParse(row.source_authority)
  if (parsedSource && (!parsedSource.success || !executionAuthority)) throw Object.assign(new Error('Task source authority unavailable'), { code: 'profile_authority_denied' })
  return {
    inputScope: row.input_scope == null ? null : parseBrowserInputScope(row.input_scope, row.workspace_id),
    sourceAuthority: parsedSource?.data ?? null,
    executionAuthority,
    taskId: row.task_id,
    sandboxId: row.sandbox_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    status: row.status,
    profileId: row.profile_id,
    profileAuthority: BrowserProfileAuthoritySchema.safeParse(row.profile_authority).data ?? null,
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
    async withPublication(expected, operation) {
      const snapshot = browserTaskPublicationSnapshot(expected)
      return withFileTransactionAdmission(async (client, actor, input) => {
        if (actor !== snapshot.userId || input.workspaceId !== snapshot.workspaceId) throw new Error('scope_operation_denied')
        await client.query('SELECT admit_browser_task_publication($1,$2,$3,$4::jsonb)',
          [snapshot.workspaceId, snapshot.sessionId, snapshot.taskId, JSON.stringify(snapshot)])
        if (snapshot.sourceAuthority?.kind === 'workflow') {
          if (snapshot.sourceAuthority.runId !== snapshot.sessionId) throw new Error('scope_operation_denied')
          const authority = await resolveBrowserTaskExecutionAuthority(snapshot, undefined, client)
          await authority.assertCurrent()
          return async fileId => {
            await client.query('SELECT capture_workflow_file_temporal_boundary($1,$2,$3)',
              [snapshot.workspaceId, snapshot.sessionId, fileId])
            await authority.assertCurrent()
          }
        }
      }, operation)
    },
    async noteInputScope(taskId, input) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const row = (await client.query<Row>("SELECT * FROM sandbox_tasks WHERE task_id=$1 AND status IN ('running','paused') FOR UPDATE", [taskId])).rows[0]
        if (!row) throw Object.assign(new Error('Task unavailable'), { code: 'profile_authority_denied' })
        const current = row.input_scope == null ? null : parseBrowserInputScope(row.input_scope, row.workspace_id)
        const merged = mergeBrowserInputScope(current, input, row.workspace_id)
        await client.query('UPDATE sandbox_tasks SET input_scope=$2::jsonb WHERE task_id=$1', [taskId, merged])
        await client.query('COMMIT')
        return merged
      } finally { await rollbackAndRelease(client) }
    },
    async getActiveBySession(sessionId) {
      const res = await query<Row>(
        `SELECT * FROM sandbox_tasks
          WHERE session_id = $1 AND status IN ('running', 'paused')
          ORDER BY created_at DESC, task_id DESC LIMIT 1`,
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
      const executionAuthority = record.executionAuthority ? parseAuthoringAuthority(record.executionAuthority) : null
      if (record.executionAuthority && (!executionAuthority || executionAuthority.ceiling.userId !== record.userId
        || executionAuthority.ceiling.workspaceId !== record.workspaceId)) throw Object.assign(new Error('Task authority unavailable'), { code: 'profile_authority_denied' })
      if (record.sourceAuthority && !executionAuthority) throw Object.assign(new Error('Task source authority unavailable'), { code: 'profile_authority_denied' })
      await query(
        `INSERT INTO sandbox_tasks
           (task_id, sandbox_id, user_id, workspace_id, session_id, status,
            profile_id, injected_site, browser_started_at, authorized_budget_usd,
            created_at, last_activity_at, profile_authority, execution_authority, source_authority, input_scope)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 to_timestamp($9::double precision / 1000.0),
                 $10, to_timestamp($11 / 1000.0), to_timestamp($12 / 1000.0), $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb)`,
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
          record.profileAuthority ? BrowserProfileAuthoritySchema.parse(record.profileAuthority) : null,
          executionAuthority,
          record.sourceAuthority ? AuthoritySourceSchema.parse(record.sourceAuthority) : null,
          record.inputScope ? parseBrowserInputScope(record.inputScope, record.workspaceId) : null,
        ],
      )
    },

    async update(taskId, patch) {
      if (patch.inputScope !== undefined) throw Object.assign(new Error('Task input protection requires monotonic admission'), { code: 'profile_authority_denied' })
      const sets: string[] = []
      const params: unknown[] = [taskId]
      const push = (sql: string, value: unknown) => {
        params.push(value)
        sets.push(`${sql} = $${params.length}`)
      }
      const executionAuthority = patch.executionAuthority === undefined ? undefined : parseAuthoringAuthority(patch.executionAuthority)
      if (executionAuthority === null) throw Object.assign(new Error('Task authority unavailable'), { code: 'profile_authority_denied' })
      if (patch.sourceAuthority !== undefined && !executionAuthority) throw Object.assign(new Error('Task source authority unavailable'), { code: 'profile_authority_denied' })
      if (executionAuthority) {
        push('execution_authority', executionAuthority)
        push('source_authority', patch.sourceAuthority ? AuthoritySourceSchema.parse(patch.sourceAuthority) : null)
      }
      if (patch.status !== undefined) push('status', patch.status)
      if (patch.profileId !== undefined) push('profile_id', patch.profileId)
      if (patch.profileAuthority) {
        const floor = BrowserProfileAuthoritySchema.parse(patch.profileAuthority)
        if (patch.profileId !== floor.id) throw Object.assign(new Error('Profile authority unavailable'), { code: 'profile_authority_denied' })
        push('profile_authority', floor)
      } else if (patch.profileAuthority !== undefined) {
        throw Object.assign(new Error('Profile authority unavailable'), { code: 'profile_authority_denied' })
      }
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
      const binding = patch.profileAuthority
      if (binding) params.push(binding.workspaceId)
      let guard = binding ? ` AND profile_id IS NULL AND profile_authority IS NULL AND workspace_id=$${params.length} AND status IN ('running','paused')` : ''
      if (!binding && patch.profileId !== undefined) {
        params.push(patch.profileId)
        guard = ` AND profile_id IS NOT DISTINCT FROM $${params.length}::uuid`
      }
      if (executionAuthority) {
        params.push(executionAuthority.ceiling.userId, executionAuthority.ceiling.workspaceId)
        guard += ` AND execution_authority IS NULL AND source_authority IS NULL AND browser_started_at IS NULL AND user_id=$${params.length-1} AND workspace_id=$${params.length} AND status IN ('running','paused')`
      }
      const result = await query(`UPDATE sandbox_tasks SET ${sets.join(', ')} WHERE task_id = $1${guard}`, params)
      if ((binding || executionAuthority || patch.profileId !== undefined) && result.rowCount !== 1) throw Object.assign(new Error('Profile authority unavailable'), { code: 'profile_authority_denied' })
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
