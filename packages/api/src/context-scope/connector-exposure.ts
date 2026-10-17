/**
 * Live connector exposure gate. A connector's Team (department) and Project
 * labels name its AUDIENCE: who may see it and receive its tools. They are
 * not a claim that the provider's data is confined to that department.
 *
 * Empty arrays mean General: every principal in the workspace may use it.
 * A labelled connector is usable only by a turn whose mutation reach (the
 * department membership floor, never a temporary read grant) contains every
 * label. A clearance-only agent wrapper is not connector authority at all.
 *
 * [COMP:api/connector-context]
 */

import { intersectAccessCeilings, pinAccessCeiling, intersectScopeGrants, scopeGrantContains, type ScopeGrant, type DepartmentReadGrant } from '@use-brian/core'
import { currentAgentAccess } from '../db/agent-access-context.js'
import { query } from '../db/client.js'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from './department-resolver.js'
import { resolveTurnScopeSystem, type ResolvedTurnScope, type ResolveTurnScopeInput } from './resolve-turn-scope.js'

/** Connector audience membership cannot be widened by the legacy workspace read-universe switch. */
export async function resolveConnectorNativeTurnScopeSystem(input: ResolveTurnScopeInput,
  resolveScope: (input: ResolveTurnScopeInput) => Promise<ResolvedTurnScope> = resolveTurnScopeSystem): Promise<ResolvedTurnScope> {
  const scope = await resolveScope({ ...input, memberMode: 'member' })
  if (!scope.access.workspaceId) return scope
  const reader = { workspaceId: scope.access.workspaceId, userId: input.userId, assistantId: input.assistant.id,
    contextDepartment: scope.activeGroupId ?? null }
  const { snapshot, principal } = await loadDepartmentSnapshot(query as Parameters<typeof loadDepartmentSnapshot>[0], reader)
  if (principal.kind !== 'user') throw new Error('authority_unavailable')
  return { ...scope, access: { ...scope.access, departmentRead: resolveDepartmentReadGrant(snapshot, principal, reader, new Date()) } }
}

/** Keep every audience/credential restriction while imposing the actual initiator's native floor. */
export function narrowConnectorTurnScope(turn: ResolvedTurnScope, initiator: ResolvedTurnScope): ResolvedTurnScope {
  if (turn.access.assistantId !== initiator.access.assistantId) throw new Error('connector_actor_mismatch')
  const access = intersectAccessCeilings(pinAccessCeiling(turn.access), pinAccessCeiling(initiator.access))
  return { ...turn, access: { ...turn.access, ...access }, effectiveCompartments: access.compartments,
    effectiveProjectIds: access.projectIds,
    writeCompartments: turn.writeCompartments.filter(label => scopeGrantContains(access.mutationCompartments, [label])),
    writeProjectIds: turn.writeProjectIds.filter(id => scopeGrantContains(access.projectIds, [id])),
    activeTeam: turn.activeTeam && scopeGrantContains(access.mutationCompartments, [turn.activeTeam.compartmentKey]) ? turn.activeTeam : null,
    activeProject: turn.activeProject && scopeGrantContains(access.projectIds, [turn.activeProject.id]) ? turn.activeProject : null }
}

export type ConnectorContextBinding = {
  compartments: readonly string[]
  projectIds: readonly string[]
}

export type ConnectorTurnGrant = {
  effectiveCompartments: ScopeGrant
  effectiveProjectIds: ScopeGrant
  /** Present on the canonical TurnScope. Missing preserves legacy membership reach. */
  access?: { mutationCompartments?: ScopeGrant; departmentRead?: DepartmentReadGrant }
}

function axisAudienceAllowed(
  turnGrant: ScopeGrant,
  audience: readonly string[],
): boolean {
  if (turnGrant === null || audience.length === 0) return true
  return scopeGrantContains(turnGrant, audience)
}

export function connectorExposureAllowed(
  turn: ConnectorTurnGrant | null | undefined,
  binding: ConnectorContextBinding,
): boolean {
  const ambient = currentAgentAccess()
  // Only non-agent administrative callers may omit a trusted execution scope.
  if (!turn && !ambient) return true
  // A clearance-only agent wrapper is not authority to access live connectors.
  if (ambient && ambient.compartments === undefined) return false
  // V2 membership is an independent floor. Legacy owner/admin universe
  // reach must not turn a missing human or assistant department edge into access.
  const grants = [turn?.access?.departmentRead, ambient?.departmentRead].filter(
    (grant): grant is DepartmentReadGrant => grant !== undefined,
  )
  if (grants.length === 2 && (grants[0].workspaceId !== grants[1].workspaceId
    || grants[0].userId !== grants[1].userId)) return false
  for (const grant of grants) {
    if (!binding.compartments.every((label) => {
      if (!label.startsWith('team:')) return false
      const department = label.slice(5)
      return Object.hasOwn(grant.departments, department)
        && (grant.contextDepartment === null || grant.contextDepartment === department)
        && (grant.binding === null || grant.binding.includes(department))
    })) return false
  }
  const read = intersectScopeGrants(
    turn?.effectiveCompartments ?? null,
    ambient ? ambient.compartments ?? null : null,
  )
  const mutation = intersectScopeGrants(
    read,
    turn?.access?.mutationCompartments === undefined
      ? turn?.effectiveCompartments ?? null : turn.access.mutationCompartments,
    ambient ? ambient.mutationCompartments === undefined
      ? ambient.compartments ?? null : ambient.mutationCompartments : null,
  )
  const projects = intersectScopeGrants(
    turn?.effectiveProjectIds ?? null,
    ambient ? ambient.projectIds === undefined ? [] : ambient.projectIds : null,
  )
  return axisAudienceAllowed(mutation, binding.compartments)
    && axisAudienceAllowed(projects, binding.projectIds)
}
