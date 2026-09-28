/**
 * The single trusted Team/Project resolver for every model execution path.
 * It converts authenticated transport/session/key state into one immutable
 * TurnScope before prompt assembly or tool injection.
 *
 * [COMP:api/context-scope-resolver]
 */

import {
  boundScopeSource,
  canonicalScopeGrant,
  pinAccessCeiling,intersectAccessCeilings,
  ContextScopeAccumulator,
  intersectScopeGrants,
  scopeEvidenceFromRows,
  scopeGrantContains,
  type Sensitivity,
  type TurnScope,
  type ScopeGrant,
  type AccessCeiling,
  type ResourceScope,
  type ScopeSource,
} from '@use-brian/core'
import {
  createDbContextScopeStore,
  type ContextScopeStore,
  type ContextTeam,
  type WorkspaceProject,
} from '../db/context-scope-store.js'
import { currentAgentAccess } from '../db/agent-access-context.js'
import { resolveOperationCeilingsSystem } from '../db/workspace-store.js'

export type TurnScopeAssistant = {
  id: string
  workspaceId: string | null
  kind: 'primary' | 'standard' | 'app'
  clearance: Sensitivity
  compartments: ScopeGrant
  defaultCompartments?: string[] | null
  teamScopeMode?: 'legacy' | 'all' | 'assigned'
  defaultWorkspaceGroupId?: string | null
  projectScopeMode?: 'all' | 'assigned'
  defaultProjectId?: string | null
}

export type TurnScopeBinding = {
  contextGroupId?: string | null
  contextProjectId?: string | null
  /** A locked session may continue reading an archived historical context. */
  contextLockedAt?: Date | string | null
}

export type ResolvedTurnScope = TurnScope & {
  activeTeam: Pick<ContextTeam, 'id' | 'name' | 'key' | 'compartmentKey' | 'status'> | null
  activeProject: Pick<WorkspaceProject, 'id' | 'name' | 'status'> | null
}

export class ContextNotAvailableError extends Error {
  readonly code = 'context_not_available'

  constructor(
    readonly axis: 'workspace' | 'team' | 'project',
    readonly reason:
      | 'not_a_member'
      | 'not_found'
      | 'archived'
      | 'outside_grant',
  ) {
    super(`Requested ${axis} context is not available (${reason}).`)
    this.name = 'ContextNotAvailableError'
  }
}

/** Canonical envelope for newly persisted human/session input. */
export function sessionMessageInputScope(params: {
  scope: ResolvedTurnScope
  workspaceId: string | null | undefined
  userId: string
  assistantId: string
  sharedAudience?: boolean
}): ResourceScope | undefined {
  if (!params.workspaceId) return undefined
  return {
    workspaceId: params.workspaceId,
    userId: params.sharedAudience ? null : params.userId,
    assistantId: params.assistantId,
    // Conversation text has no user-controlled sensitivity selector. Use the
    // resolved execution ceiling as a conservative server-owned floor.
    sensitivity: params.scope.access.clearance ?? 'internal',
    compartments: [...(params.scope.writeCompartments ?? [])],
    projectIds: [...(params.scope.writeProjectIds ?? [])],
  }
}

export type ResolveTurnScopeInput = {
  userId: string
  assistant: TurnScopeAssistant
  workspaceId?: string | null
  session?: TurnScopeBinding
  key?: TurnScopeBinding
  /** Trusted public-share/key lanes may intentionally publish assistant scope. */
  memberMode?: 'enforce' | 'assistant'
  systemRead?: boolean
}

export type ResolveTurnScopeDeps = {
  store?: ContextScopeStore
  resolveReadCeilings?: typeof resolveOperationCeilingsSystem
}

function selectedBinding(input: ResolveTurnScopeInput): {
  groupId: string | null
  projectId: string | null
  historical: boolean
} {
  // Presence matters: an existing legacy session/key with explicit NULL is
  // company-wide and must not begin inheriting a newly configured assistant
  // default after the fact.
  if (input.session !== undefined) {
    return {
      groupId: input.session.contextGroupId ?? null,
      projectId: input.session.contextProjectId ?? null,
      historical: input.session.contextLockedAt != null,
    }
  }
  if (input.key !== undefined) {
    return {
      groupId: input.key.contextGroupId ?? null,
      projectId: input.key.contextProjectId ?? null,
      historical: false,
    }
  }
  return {
    groupId: input.assistant.defaultWorkspaceGroupId ?? null,
    projectId: input.assistant.defaultProjectId ?? null,
    historical: false,
  }
}

function requireActiveOrHistorical(
  axis: 'team' | 'project',
  status: 'active' | 'archived',
  historical: boolean,
): void {
  if (status === 'archived' && !historical) {
    throw new ContextNotAvailableError(axis, 'archived')
  }
}

/** A nested execution may narrow the caller projection but cannot replace it. */
function withinExecutingCaller(scope:ResolvedTurnScope):ResolvedTurnScope {
  const parent=currentAgentAccess()
  if(!parent)return scope
  const own=pinAccessCeiling(scope.access)
  const bounded=intersectAccessCeilings(own,{
    ...own,
    workspaceId:parent.workspaceId??own.workspaceId,userId:parent.userId??own.userId,
    clearance:parent.clearance,
    compartments:parent.compartments===undefined?own.compartments:parent.compartments,
    mutationCompartments:parent.mutationCompartments===undefined?own.mutationCompartments:parent.mutationCompartments,
    projectIds:parent.projectIds===undefined?own.projectIds:parent.projectIds,
    visibilityAssistantIds:parent.visibilityAssistantIds===undefined?own.visibilityAssistantIds:parent.visibilityAssistantIds,
  })
  return {...scope,access:{...scope.access,...bounded},effectiveCompartments:bounded.compartments,effectiveProjectIds:bounded.projectIds}
}

/**
 * Resolve a turn once. No caller may broaden, reinterpret, or recompute the
 * returned grants; downstream code receives `scope.access` and the same write
 * defaults/accumulator.
 */
export async function resolveTurnScopeSystem(
  input: ResolveTurnScopeInput,
  deps: ResolveTurnScopeDeps = {},
): Promise<ResolvedTurnScope> {
  return resolveScope(input, deps, withinExecutingCaller)
}

/** Authority metadata only: lease renewal must not mistake inherited narrowing for revocation. */
export async function resolveLiveAccessCeilingSystem(
  input: ResolveTurnScopeInput,
  deps: ResolveTurnScopeDeps = {},
): Promise<AccessCeiling> {
  const strictDeps: ResolveTurnScopeDeps = {
    ...deps,
    resolveReadCeilings: deps.resolveReadCeilings ?? ((userId, workspaceId, clearance, compartments) =>
      resolveOperationCeilingsSystem(userId, workspaceId, clearance, compartments, true)),
  }
  return pinAccessCeiling((await resolveScope(input, strictDeps, scope => scope)).access)
}

async function resolveScope(
  input: ResolveTurnScopeInput,
  deps: ResolveTurnScopeDeps,
  applyProjection: (scope: ResolvedTurnScope) => ResolvedTurnScope,
): Promise<ResolvedTurnScope> {
  const workspaceId = input.workspaceId ?? input.assistant.workspaceId
  const binding = selectedBinding(input)
  const resolveReadCeilings = deps.resolveReadCeilings ?? resolveOperationCeilingsSystem

  if (!workspaceId) {
    return applyProjection({
      access: {
        workspaceId: '',
        userId: input.userId,
        assistantId: input.assistant.id,
        assistantKind: input.assistant.kind,
        clearance: input.assistant.clearance,
        compartments: input.assistant.compartments,
        mutationCompartments: input.assistant.compartments,
        projectIds: null,
        systemRead: input.systemRead,
      },
      activeGroupId: null,
      activeProjectId: null,
      effectiveCompartments: input.assistant.compartments,
      effectiveProjectIds: null,
      writeCompartments: [...new Set(input.assistant.defaultCompartments ?? [])].sort(),
      writeProjectIds: [],
      activeTeam: null,
      activeProject: null,
    })
  }

  if (input.assistant.workspaceId !== workspaceId) {
    throw new ContextNotAvailableError('workspace', 'not_found')
  }

  const oldCeilings = input.memberMode === 'assistant'
    ? {
        clearance: input.assistant.clearance,
        mutationCompartments: input.assistant.teamScopeMode === 'all' ? null : input.assistant.compartments,
        compartments: input.assistant.teamScopeMode === 'all'
          ? null as ScopeGrant
          : input.assistant.compartments,
      }
    : await resolveReadCeilings(
        input.userId,
        workspaceId,
        input.assistant.clearance,
        input.assistant.teamScopeMode === 'all' ? null : input.assistant.compartments,
      )

  // The legacy fused resolver returns the empty grant for non-members. That is
  // a valid external-client projection, so the typed membership refusal is
  // reserved for assigned-Team resolution where membership is authority.
  if (oldCeilings.mutationCompartments === undefined) throw new Error('authority_unavailable')
  let effectiveCompartments = canonicalScopeGrant(oldCeilings.compartments)
  let mutationCompartments = intersectScopeGrants(effectiveCompartments,
    canonicalScopeGrant(oldCeilings.mutationCompartments))
  let assistantProjectGrant: ScopeGrant = null
  const needsStore =
    input.assistant.teamScopeMode === 'assigned'
    || input.assistant.projectScopeMode === 'assigned'
    || binding.groupId !== null
    || binding.projectId !== null
  const store = needsStore ? (deps.store ?? createDbContextScopeStore()) : deps.store

  if (input.assistant.teamScopeMode === 'assigned') {
    const principal = await store!.resolveAssistantPrincipalSystem(input.assistant.id, workspaceId)
    if (!principal) throw new ContextNotAvailableError('workspace', 'not_found')
    effectiveCompartments = intersectScopeGrants(effectiveCompartments, principal.teamGrant)
    mutationCompartments = intersectScopeGrants(mutationCompartments, principal.teamGrant)
    assistantProjectGrant = principal.projectGrant
  } else if (input.assistant.projectScopeMode === 'assigned') {
    const principal = await store!.resolveAssistantPrincipalSystem(input.assistant.id, workspaceId)
    if (!principal) throw new ContextNotAvailableError('workspace', 'not_found')
    assistantProjectGrant = principal.projectGrant
  }

  let activeTeam: ResolvedTurnScope['activeTeam'] = null
  if (binding.groupId) {
    const team = await store!.getTeamSystem(workspaceId, binding.groupId)
    if (!team) throw new ContextNotAvailableError('team', 'not_found')
    requireActiveOrHistorical('team', team.status, binding.historical)
    if (!scopeGrantContains(effectiveCompartments, [team.compartmentKey])) {
      throw new ContextNotAvailableError('team', 'outside_grant')
    }
    effectiveCompartments = intersectScopeGrants(effectiveCompartments, team.readBundle)
    mutationCompartments = intersectScopeGrants(mutationCompartments, team.readBundle)
    activeTeam = {
      id: team.id,
      name: team.name,
      key: team.key,
      compartmentKey: team.compartmentKey,
      status: team.status,
    }
  }

  let activeProject: ResolvedTurnScope['activeProject'] = null
  let effectiveProjectIds = canonicalScopeGrant(assistantProjectGrant)
  if (binding.projectId) {
    const project = await store!.getProjectSystem(workspaceId, binding.projectId)
    if (!project) throw new ContextNotAvailableError('project', 'not_found')
    requireActiveOrHistorical('project', project.status, binding.historical)
    if (!scopeGrantContains(assistantProjectGrant, [project.id])) {
      throw new ContextNotAvailableError('project', 'outside_grant')
    }
    effectiveProjectIds = intersectScopeGrants(assistantProjectGrant, [project.id])
    activeProject = { id: project.id, name: project.name, status: project.status }
  }

  return applyProjection({
    access: {
      workspaceId,
      userId: input.userId,
      assistantId: input.assistant.id,
      assistantKind: input.assistant.kind,
      clearance: oldCeilings.clearance,
      compartments: effectiveCompartments,
      mutationCompartments,
      projectIds: effectiveProjectIds,
      systemRead: input.systemRead,
    },
    activeGroupId: activeTeam?.id ?? null,
    activeProjectId: activeProject?.id ?? null,
    effectiveCompartments,
    effectiveProjectIds,
    writeCompartments: activeTeam
      ? [activeTeam.compartmentKey]
      : [...new Set(input.assistant.defaultCompartments ?? [])].sort(),
    writeProjectIds: activeProject ? [activeProject.id] : [],
    activeTeam,
    activeProject,
  })
}

/** Trusted prompt fact; empty for a legacy company-wide turn. */
export function formatActiveWorkspaceContext(scope: ResolvedTurnScope): string {
  if (!scope.activeTeam && !scope.activeProject) return ''
  const lines = ['# Active workspace context']
  if (scope.activeTeam) {
    lines.push(`Team: ${scope.activeTeam.name} (required scope: ${scope.activeTeam.key})`)
  }
  if (scope.activeProject) lines.push(`Project: ${scope.activeProject.name}`)
  lines.push('Boundary: Only Workspace General plus rows within these scopes are available.')
  return lines.join('\n')
}

/**
 * Note automatic (non-tool) context after its access-filtered rows have been
 * selected for the prompt. Callers pass exactly the surfaced rows, never the
 * pre-filter candidate pool.
 */
export function noteAutomaticScopeEvidence(
  accumulator: ContextScopeAccumulator,
  rows: readonly unknown[],
): void {
  // These rows come directly from access-filtered readers. Never recurse into
  // arbitrary content looking for canonical IDs or accept model citations.
  const sources = rows.flatMap(row => {
    if (!row || typeof row !== 'object' || boundScopeSource(row)) return []
    const source = (row as { scopeSource?: ScopeSource }).scopeSource
    return source ? [source] : []
  })
  accumulator.note({ ...scopeEvidenceFromRows(rows), ...(sources.length ? { sources } : {}) })
}
