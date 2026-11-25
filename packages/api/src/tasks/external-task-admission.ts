/** Reports inherit their source Task's current canonical read authority. Lane
 * membership/RLS alone cannot admit a task's fields, lineage or audience. */
import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import { ApplicationPlatformError } from '@use-brian/shared'
import { resolveDepartmentReadGrant } from '../context-scope/department-resolver.js'
import { readLegacyCanonicalTask } from '../db/task-reader.js'
import { getWorkspaceMembershipWithReadScopeSystem } from '../db/workspace-store.js'

export async function admittedExternalTaskId(userId: string, workspaceId: string, taskId: string,
  executionAccess?: AccessContext | null): Promise<string | null> {
  // An absent execution authority on a tool call is not an authenticated REST read.
  if (executionAccess === null) return null
  let access = executionAccess
  if (!access) {
    const member = await getWorkspaceMembershipWithReadScopeSystem(userId, workspaceId)
    if (!member) return null
    const department = member.departmentAccess
    access = { workspaceId, userId, assistantId: '', assistantKind: 'primary',
      clearance: member.clearance, compartments: member.compartments, projectIds: member.projectIds,
      ...(department ? { departmentRead: resolveDepartmentReadGrant(department.snapshot, department.principal,
        { workspaceId, userId, assistantId: null }, new Date()) } : {}) }
  }
  if (access.workspaceId !== workspaceId || access.userId !== userId || access.systemRead) return null
  try {
    const task = await readLegacyCanonicalTask(access, taskId, undefined, true)
    return task?.workspaceId === workspaceId ? task.id : null
  } catch (error) {
    if (error instanceof ApplicationPlatformError && error.code === 'access_unavailable') return null
    throw error
  }
}
