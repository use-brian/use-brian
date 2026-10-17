/** Generic workspace-module lifecycle and transaction admission. [COMP:api/workspace-modules] */
import type { Pool, PoolClient } from 'pg'
import {
  WORKSPACE_MODULE_ACTIONS,
  WORKSPACE_MODULES,
  isWorkspaceModuleKey,
  workspaceModuleAdmits,
  workspaceModuleKeys,
  WorkspaceModuleError,
  type WorkspaceModule,
  type WorkspaceModuleActionInput,
  type WorkspaceModuleActionResult,
  type WorkspaceModuleBlockingWork,
  type WorkspaceModuleOperationClass,
  type WorkspaceModuleRegistry,
} from '@use-brian/shared'
import { applyRLSGucs, getAppPool, getPool } from './client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'

export { WorkspaceModuleError } from '@use-brian/shared'

export interface WorkspaceModuleLifecycleAdapter {
  readBlockingWork(client: PoolClient, workspaceId: string): Promise<WorkspaceModuleBlockingWork[]>
}

export type WorkspaceModuleLifecycleAdapters = Readonly<Record<string, WorkspaceModuleLifecycleAdapter | undefined>>
export interface WorkspaceModulesStoreOptions {
  registry?: WorkspaceModuleRegistry
  lifecycles?: WorkspaceModuleLifecycleAdapters
}

const SELECT = `workspace_id AS "workspaceId", module_key AS "moduleKey", state, version,
  enabled_at AS "enabledAt", disable_requested_at AS "disableRequestedAt",
  disabled_at AS "disabledAt", updated_at AS "updatedAt", updated_by_user_id AS "updatedByUserId"`

function requireModuleKey(value: string, registry: WorkspaceModuleRegistry): string {
  if (!isWorkspaceModuleKey(value, registry)) {
    throw new WorkspaceModuleError('invalid_input', 'A registered workspace module is required.', { moduleKey: value })
  }
  return value
}

function record(workspaceId: string, moduleKey: string, registry: WorkspaceModuleRegistry,
  row?: WorkspaceModule): WorkspaceModule {
  if (!row) return { workspaceId, moduleKey, state: registry[moduleKey].defaultState, version: 0,
    enabledAt: null, disableRequestedAt: null, disabledAt: null, updatedAt: null, updatedByUserId: null }
  return { ...row, enabledAt: instant(row.enabledAt), disableRequestedAt: instant(row.disableRequestedAt),
    disabledAt: instant(row.disabledAt), updatedAt: instant(row.updatedAt) }
}

function instant(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

async function blockingWork(adapter: WorkspaceModuleLifecycleAdapter | undefined, client: PoolClient,
  workspaceId: string): Promise<WorkspaceModuleBlockingWork[]> {
  const rows = adapter ? await adapter.readBlockingWork(client, workspaceId) : []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(row.key) || !Number.isSafeInteger(row.count) || row.count < 0
      || seen.has(row.key)) throw new Error('Workspace module lifecycle adapter returned invalid blocking work')
    seen.add(row.key)
  }
  return rows
}

/** Must be the first module lock in a vertical transaction and be held through commit. */
export async function lockWorkspaceModule(client: PoolClient, workspaceId: string, rawModuleKey: string,
  registry: WorkspaceModuleRegistry = WORKSPACE_MODULES, projection?: { kind: 'application' }): Promise<WorkspaceModule> {
  const moduleKey = requireModuleKey(rawModuleKey, registry)
  if (projection?.kind === 'application') {
    // This fixed metadata function independently checks the authenticated app
    // GUCs and holds the same canonical workspace/module locks. It grants no
    // membership, UPDATE policy, raw workspace row or business-data access.
    const result = await client.query<WorkspaceModule>(`SELECT ${SELECT} FROM application_lock_module($1,$2)`, [workspaceId, moduleKey])
    return record(workspaceId, moduleKey, registry, result.rows[0])
  }
  const result = await client.query<WorkspaceModule>(
    `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key=$2 FOR SHARE`,
    [workspaceId, moduleKey])
  if (!result.rows[0]) {
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [workspaceId])
    const retried = await client.query<WorkspaceModule>(
      `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key=$2 FOR SHARE`,
      [workspaceId, moduleKey])
    return record(workspaceId, moduleKey, registry, retried.rows[0])
  }
  return record(workspaceId, moduleKey, registry, result.rows[0])
}

export function requireWorkspaceModuleAdmission(module: WorkspaceModule,
  operation: WorkspaceModuleOperationClass, message?: string): void {
  if (workspaceModuleAdmits(module.state, operation)) return
  throw new WorkspaceModuleError(module.state === 'draining' ? 'module_draining' : 'module_disabled',
    message ?? 'New work is unavailable while this workspace module is not enabled.',
    { moduleKey: module.moduleKey, state: module.state, version: module.version })
}

async function memberTransaction<T>(pool: Pool, workspaceId: string, userId: string, admin: boolean,
  fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    const member = await client.query<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId, userId])
    if (!member.rows[0] || (admin && !['owner', 'admin'].includes(member.rows[0].role))) {
      throw new WorkspaceModuleError('not_authorized', admin ? 'An owner or admin member is required' : 'Workspace membership is required')
    }
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

export function createWorkspaceModulesStore(pool: Pool = getPool(), memberPool: Pool = getAppPool(),
  options: WorkspaceModulesStoreOptions = {}) {
  const registry: WorkspaceModuleRegistry = options.registry ?? WORKSPACE_MODULES
  const keys = workspaceModuleKeys(registry)
  const lifecycles = options.lifecycles ?? {}
  return {
    /** System/tool reads require the caller's already-resolved workspace authority. */
    async get(workspaceId: string, rawModuleKey: string): Promise<WorkspaceModule> {
      const moduleKey = requireModuleKey(rawModuleKey, registry)
      const result = await pool.query<WorkspaceModule>(
        `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key=$2`,
        [workspaceId, moduleKey])
      return record(workspaceId, moduleKey, registry, result.rows[0])
    },
    async listForMember(workspaceId: string, userId: string): Promise<WorkspaceModule[]> {
      return memberTransaction(memberPool, workspaceId, userId, false, async (client) => {
        const result = await client.query<WorkspaceModule>(
          `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key=ANY($2::text[])`,
          [workspaceId, keys])
        const rows = new Map(result.rows.map((row) => [row.moduleKey, row]))
        return keys.map((moduleKey) => record(workspaceId, moduleKey, registry, rows.get(moduleKey)))
      })
    },
    async act(workspaceId: string, userId: string, rawModuleKey: string,
      input: WorkspaceModuleActionInput): Promise<WorkspaceModuleActionResult> {
      const moduleKey = requireModuleKey(rawModuleKey, registry)
      if (!WORKSPACE_MODULE_ACTIONS.includes(input.action) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
        throw new WorkspaceModuleError('invalid_input', 'A known action and a nonnegative expectedVersion are required')
      }
      const result = await memberTransaction(memberPool, workspaceId, userId, true, async (client) => {
        let result = await client.query<WorkspaceModule>(
          `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key=$2 FOR UPDATE`,
          [workspaceId, moduleKey])
        let wasMissing = false
        if (!result.rows[0]) {
          const parent = await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
          if (!parent.rowCount) throw new WorkspaceModuleError('not_found', 'Workspace not found')
          result = await client.query<WorkspaceModule>(
            `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key=$2 FOR UPDATE`,
            [workspaceId, moduleKey])
          if (!result.rows[0]) {
            wasMissing = true
            const defaultState = registry[moduleKey].defaultState
            result = await client.query<WorkspaceModule>(
              `INSERT INTO workspace_modules (workspace_id,module_key,state,enabled_at,disabled_at)
               VALUES ($1,$2,$3,CASE WHEN $3='enabled' THEN now() END,CASE WHEN $3='disabled' THEN now() END)
               RETURNING ${SELECT}`,
              [workspaceId, moduleKey, defaultState])
          }
        }
        const current = record(workspaceId, moduleKey, registry, result.rows[0])
        const observedVersion = wasMissing ? 0 : current.version
        if (observedVersion !== input.expectedVersion) {
          throw new WorkspaceModuleError('stale_module_version', 'Module state changed; reload before trying again', { version: observedVersion })
        }
        const blockers = await blockingWork(lifecycles[moduleKey], client, workspaceId)
        const blocked = blockers.reduce((count, row) => count + row.count, 0)
        if (input.action === 'finish_disable' && blocked > 0) {
          throw new WorkspaceModuleError('module_drain_pending', 'Blocking work must finish before module shutdown.',
            { moduleKey, blockingWork: blockers })
        }
        const state = input.action === 'enable' ? 'enabled'
          : input.action === 'request_disable' && blocked > 0 ? 'draining' : 'disabled'
        if (state === current.state) return { module: current, changed: false, blockingWork: blockers }
        const changed = await client.query<WorkspaceModule>(
          `UPDATE workspace_modules SET state=$3,version=version+1,updated_at=now(),updated_by_user_id=$4,
             enabled_at=CASE WHEN $3='enabled' THEN now() ELSE enabled_at END,
             disable_requested_at=CASE WHEN $3='enabled' THEN NULL ELSE coalesce(disable_requested_at,now()) END,
             disabled_at=CASE WHEN $3='disabled' THEN now() ELSE NULL END
           WHERE workspace_id=$1 AND module_key=$2 RETURNING ${SELECT}`,
          [workspaceId, moduleKey, state, userId])
        const module = record(workspaceId, moduleKey, registry, changed.rows[0])
        await client.query(`INSERT INTO workspace_audit_log (workspace_id,actor_user_id,event_type,subject_id,details)
          VALUES ($1,$2,'workspace.module_changed',$1,$3)`, [workspaceId, userId,
          { moduleKey, action: input.action, from: current.state, to: state, version: module.version }])
        return { module, changed: true, blockingWork: blockers }
      })
      if (result.changed) notifyWorkspaceChange(workspaceId, 'workspace_config', 'update')
      return result
    },
  }
}
export type WorkspaceModulesStore = ReturnType<typeof createWorkspaceModulesStore>

/** Complete a requested drain for any registered module using its blocker adapter. */
export async function finishWorkspaceModuleDrain(workspaceId: string, rawModuleKey: string,
  lifecycle?: WorkspaceModuleLifecycleAdapter, pool: Pool = getPool(),
  registry: WorkspaceModuleRegistry = WORKSPACE_MODULES): Promise<boolean> {
  const moduleKey = requireModuleKey(rawModuleKey, registry)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = (await client.query<{ version: number }>(`SELECT version FROM workspace_modules
      WHERE workspace_id=$1 AND module_key=$2 AND state='draining' FOR UPDATE`, [workspaceId, moduleKey])).rows[0]
    if (!current || (await blockingWork(lifecycle, client, workspaceId)).some((row) => row.count > 0)) {
      await client.query('COMMIT'); return false
    }
    await client.query(`UPDATE workspace_modules SET state='disabled',version=version+1,disabled_at=clock_timestamp(),updated_at=clock_timestamp(),updated_by_user_id=NULL
      WHERE workspace_id=$1 AND module_key=$2`, [workspaceId, moduleKey])
    await client.query(`INSERT INTO workspace_audit_log(workspace_id,event_type,subject_id,details)
      VALUES($1,'workspace.module_changed',$1,$2::jsonb)`, [workspaceId, JSON.stringify({
        moduleKey, action: 'finish_disable', from: 'draining', to: 'disabled',
        version: current.version + 1, actorKind: 'system_job',
      })])
    await client.query('COMMIT'); return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); throw error
  } finally { client.release() }
}
