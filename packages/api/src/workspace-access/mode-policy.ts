import type { PoolClient } from 'pg'
import type { WorkspaceAccessModeState } from '@use-brian/shared'
import { getPool } from '../db/client.js'
import { WorkspaceAccessError } from './policy.js'
import { projectionLifetime } from './projection-lifetime.js'

/** Read-only mode projection. Missing policy is upgrade-compatible Departments,
 * not permission to admit new Simple resources; admission fails closed instead.
 */
export async function getWorkspaceAccessModeInTransaction(
  client: PoolClient, workspaceId: string, userId: string,
): Promise<WorkspaceAccessModeState> {
  const member = (await client.query<{ role: string }>(
    'SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId],
  )).rows[0]
  if (!member) throw new WorkspaceAccessError('not_found', 404)
  const canAdminister = member.role === 'owner' || member.role === 'admin'
  const policy = (await client.query<{
    mode: WorkspaceAccessModeState['mode']; setupState: WorkspaceAccessModeState['setupState']; policyRevision: string
    defaultDepartmentId: string | null; defaultDepartmentName: string | null
  }>(`SELECT p.access_mode AS mode,p.setup_state AS "setupState",p.revision::text AS "policyRevision",
    g.id AS "defaultDepartmentId",g.name AS "defaultDepartmentName"
    FROM workspace_access_policies p LEFT JOIN workspace_groups g ON g.id=p.default_department_id AND g.workspace_id=p.workspace_id
      AND g.status='active' AND (g.directory_visibility='workspace' OR $3::boolean
        OR EXISTS(SELECT 1 FROM workspace_group_members gm WHERE gm.group_id=g.id AND gm.user_id=$2))
    WHERE p.workspace_id=$1`, [workspaceId, userId, canAdminister])).rows[0]
  return {
    workspaceId, canAdminister, validForMs: await projectionLifetime(client, workspaceId, userId),
    mode: policy?.mode ?? 'departments', setupState: policy?.setupState ?? 'legacy', policyRevision: policy?.policyRevision ?? '1',
    defaultDepartmentId: policy?.defaultDepartmentId ?? null, defaultDepartmentName: policy?.defaultDepartmentName ?? null,
  }
}

export async function getWorkspaceAccessMode(workspaceId: string, userId: string): Promise<WorkspaceAccessModeState> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const result = await getWorkspaceAccessModeInTransaction(client, workspaceId, userId)
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
