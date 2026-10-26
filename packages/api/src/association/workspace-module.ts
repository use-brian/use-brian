/** Association adapter for the generic workspace-module lifecycle. [COMP:crm/association-lifecycle] */
import type { Pool, PoolClient } from 'pg'
import type { WorkspaceModule, WorkspaceModuleBlockingWork } from '@use-brian/shared'
import { getAppPool, getPool } from '../db/client.js'
import {
  createWorkspaceModulesStore,
  lockWorkspaceModule,
  requireWorkspaceModuleAdmission,
  type WorkspaceModuleLifecycleAdapter,
} from '../db/workspace-modules-store.js'

export const ASSOCIATION_MODULE_KEY = 'association' as const
export const ASSOCIATION_PENDING_ORDERS_BLOCKER = 'pending_orders'

export const associationModuleLifecycle: WorkspaceModuleLifecycleAdapter = {
  async readBlockingWork(client, workspaceId) {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM association_orders WHERE workspace_id=$1 AND status='pending'`,
      [workspaceId])
    return [{ key: ASSOCIATION_PENDING_ORDERS_BLOCKER, count: result.rows[0].count }]
  },
}

export function createAssociationWorkspaceModulesStore(pool: Pool = getPool(), memberPool: Pool = getAppPool()) {
  const store = createWorkspaceModulesStore(pool, memberPool, { lifecycles: { association: associationModuleLifecycle } })
  return {
    ...store,
    async act(...args: Parameters<typeof store.act>) {
      const result = await store.act(...args)
      return args[2] === ASSOCIATION_MODULE_KEY
        ? { ...result, pendingOrders: associationPendingOrders(result.blockingWork) }
        : result
    },
  }
}

export function lockAssociationModule(client: PoolClient, workspaceId: string): Promise<WorkspaceModule> {
  return lockWorkspaceModule(client, workspaceId, ASSOCIATION_MODULE_KEY)
}

export function requireAssociationAdmission(module: WorkspaceModule): void {
  requireWorkspaceModuleAdmission(module, 'new_work',
    'New Association commerce is unavailable. An owner or admin can review the module state.')
}

export function associationPendingOrders(blockingWork: WorkspaceModuleBlockingWork[]): number {
  return blockingWork.find((row) => row.key === ASSOCIATION_PENDING_ORDERS_BLOCKER)?.count ?? 0
}

export async function finishAssociationDrain(workspaceId: string, pool: Pool = getPool()): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query<{ finished: boolean }>('SELECT association_finish_module_drain($1) AS finished', [workspaceId])
    await client.query('COMMIT')
    return result.rows[0].finished
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}
