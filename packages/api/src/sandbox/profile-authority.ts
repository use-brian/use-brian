/** Current browser identity authority. [COMP:sandbox/profiles] */
import { canRead, intersectDepartmentReadGrants, type BrowserProfile, type DepartmentReadGrant, type ToolContext } from '@use-brian/core'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from '../context-scope/department-resolver.js'
import { currentAgentAccess } from '../db/agent-access-context.js'
import { query } from '../db/client.js'
import { getWorkspaceMembershipWithReadScopeSystem } from '../db/workspace-store.js'

/** Caller must separately renew workspace membership. No administrative bypass. */
export function humanCanReadBrowserProfile(profile: BrowserProfile, userId: string, grant: DepartmentReadGrant | null | undefined): boolean {
  if (profile.scope === 'owner' && profile.ownerUserId !== userId) return false
  if (grant && (grant.userId !== userId || grant.workspaceId !== profile.workspaceId || grant.assistantId !== null)) return false
  if (!profile.departmentId) return !grant || profile.ownerUserId === userId
  if (!grant) return false
  const ceiling = grant.departments[profile.departmentId]
  return Boolean(ceiling && canRead(ceiling, profile.clearance)
    && (grant.contextDepartment === null || grant.contextDepartment === profile.departmentId)
    && (grant.binding === null || grant.binding.includes(profile.departmentId)))
}

export async function resolveHumanBrowserProfileDepartmentRead(userId: string, workspaceId: string): Promise<DepartmentReadGrant | null> {
  const member = await getWorkspaceMembershipWithReadScopeSystem(userId, workspaceId)
  if (!member) throw new Error('authority_unavailable')
  if (!member.departmentAccess) return null
  return resolveDepartmentReadGrant(member.departmentAccess.snapshot, member.departmentAccess.principal,
    { workspaceId, userId, assistantId: null }, new Date())
}

/** Preserve the caller's credential/context ceiling while renewing department edges. */
export async function resolveBrowserProfileDepartmentRead(context: ToolContext): Promise<DepartmentReadGrant | undefined> {
  const workspaceId = context.workspaceId
  if (!workspaceId) throw new Error('authority_unavailable')
  await context.executionContext?.security.authority.assertCurrent()
  const member = await getWorkspaceMembershipWithReadScopeSystem(context.userId, workspaceId)
  if (!member) throw new Error('authority_unavailable')
  const pins = [context.executionContext?.security.access.departmentRead, currentAgentAccess()?.departmentRead]
    .filter((grant): grant is DepartmentReadGrant => grant !== undefined)
  if (!member.departmentAccess) {
    if (pins.length) throw new Error('authority_unavailable')
    return undefined
  }
  if (!pins.length) throw new Error('authority_unavailable')
  for (const pin of pins) {
    if (pin.workspaceId !== workspaceId || pin.userId !== context.userId || pin.assistantId !== context.assistantId) {
      throw new Error('authority_unavailable')
    }
  }
  const input = { workspaceId, userId: context.userId, assistantId: context.assistantId }
  const { snapshot, principal } = await loadDepartmentSnapshot(
    <R>(sql: string, values: unknown[]) => query<R & Record<string, unknown>>(sql, values), input)
  let grant = resolveDepartmentReadGrant(snapshot, principal, input, new Date())
  for (const pin of pins) grant = intersectDepartmentReadGrants(grant, pin)
  return grant
}
