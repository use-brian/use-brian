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
  maxSensitivity,
  scopeEvidenceFromRows,
  scopeGrantContains,
  sourcesShareVisibility,
  type DerivedWriteEvidence,
  type Sensitivity,
  type TurnScope,
  type ScopeGrant,
  type AccessCeiling,
  type ResourceScope,
  type ScopeSource,
  type DepartmentReadGrant,
} from '@use-brian/core'
import {
  createDbContextScopeStore,
  type ContextScopeStore,
  type ContextTeam,
  type WorkspaceProject,
} from '../db/context-scope-store.js'
import { currentAgentAccess } from '../db/agent-access-context.js'
import { getWorkspaceRoleSystem, resolveOperationCeilingsSystem } from '../db/workspace-store.js'
import { query as systemQuery } from '../db/client.js'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from './department-resolver.js'

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

/**
 * Canonical envelope for newly persisted human/session input. A person's own
 * words belong to the thread's audience, not to whichever assistant answered
 * them: the assistant axis stays null so every assistant the owner addresses
 * in the thread (doc-dock switch, room @mention, a consult carrying the
 * message) may read it (scoped-context.md -> decision D2).
 */
export function sessionMessageInputScope(params: {
  scope: ResolvedTurnScope
  workspaceId: string | null | undefined
  userId: string
  sharedAudience?: boolean
}): ResourceScope | undefined {
  if (!params.workspaceId) return undefined
  return {
    workspaceId: params.workspaceId,
    userId: params.sharedAudience ? null : params.userId,
    assistantId: null,
    // Conversation text has no user-controlled sensitivity selector. Use the
    // resolved execution ceiling as a conservative server-owned floor.
    sensitivity: params.scope.access.clearance ?? 'internal',
    compartments: [...(params.scope.writeCompartments ?? [])],
    projectIds: [...(params.scope.writeProjectIds ?? [])],
  }
}

/**
 * How a turn's model output row is stamped. When everything the turn read sits
 * in one visibility partition, the output is a certified derivation, as before.
 * A primary assistant reads across partitions (memory-system.md -> "Primary
 * widens"), and such sources cannot certify one derived envelope. The output
 * then takes the session's own input envelope raised to the turn's label floor:
 * the transcript's existing audience, never wider, with every sensitivity,
 * compartment and Project requirement kept. Only the lineage edges are skipped.
 * A turn with no bound sources takes the same envelope.
 * See scoped-context.md -> "Departmental derivation evidence".
 */
export function turnOutputWrite(params: {
  producer: string
  accumulator: ContextScopeAccumulator
  envelope: ResourceScope | undefined
}): { derivation: DerivedWriteEvidence } | { scope: ResourceScope } {
  const sources = params.accumulator.evidence.sources ?? []
  if (!params.envelope || (sources.length > 0 && sourcesShareVisibility(sources))) {
    return { derivation: { producer: params.producer, sources } }
  }
  const envelope = params.envelope
  const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])].sort()
  return {
    scope: {
      ...envelope,
      sensitivity: maxSensitivity(envelope.sensitivity, params.accumulator.sensitivity),
      compartments: union(envelope.compartments, params.accumulator.compartments),
      projectIds: union(envelope.projectIds, params.accumulator.projectIds),
    },
  }
}

export type ResolveTurnScopeInput = {
  userId: string
  assistant: TurnScopeAssistant
  workspaceId?: string | null
  session?: TurnScopeBinding
  key?: TurnScopeBinding
  /** Trusted public-share/key lanes may intentionally publish assistant scope. */
  memberMode?: 'enforce' | 'assistant' | 'member' | 'external'
  /** The recipient envelope, not the storage session, owns shared-provider scope. */
  ignoreSessionBinding?: boolean
  systemRead?: boolean
}

export type ResolveTurnScopeDeps = {
  store?: ContextScopeStore
  resolveReadCeilings?: typeof resolveOperationCeilingsSystem
  resolveWorkspaceRole?: typeof getWorkspaceRoleSystem
  /** Permission model v2 snapshot reads, for a workspace whose flag is on. Defaults to the database. */
  departmentRead?: { query: <R>(sql: string, values: unknown[]) => Promise<{ rows: R[] }>; now?: () => Date }
}

function selectedBinding(input: ResolveTurnScopeInput): {
  groupId: string | null
  projectId: string | null
  historical: boolean
} {
  if (input.ignoreSessionBinding) {
    return { groupId: null, projectId: null, historical: false }
  }
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
  const memberMode = input.memberMode === 'assistant' || input.memberMode === 'external'
    ? input.memberMode
    : 'member'
  return pinAccessCeiling((await resolveScope({ ...input, memberMode }, strictDeps, scope => scope)).access)
}

async function resolveScope(
  input: ResolveTurnScopeInput,
  deps: ResolveTurnScopeDeps,
  applyProjection: (scope: ResolvedTurnScope) => ResolvedTurnScope,
): Promise<ResolvedTurnScope> {
  const workspaceId = input.workspaceId ?? input.assistant.workspaceId
  const resolveReadCeilings = deps.resolveReadCeilings ?? resolveOperationCeilingsSystem
  const externalPrincipal = input.memberMode === 'external'
  // External channel principals never inherit a workspace member's saved
  // Team/Project selection. Legacy sessions created before strict guest
  // authority may still carry those ids; treating them as a requested binding
  // bricks the public guest lane and, worse, makes session metadata look like a
  // grant. Their effective scope is always public General.
  const binding = externalPrincipal
    ? { groupId: null, projectId: null, historical: false }
    : selectedBinding(input)

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
    : externalPrincipal
      ? await (async () => {
          const role = await (deps.resolveWorkspaceRole ?? getWorkspaceRoleSystem)(
            input.userId,
            workspaceId,
            true,
          )
          if (role !== null) throw new Error('authority_unavailable')
          return {
            clearance: 'public' as const,
            compartments: [] as string[],
            mutationCompartments: [] as string[],
          }
        })()
      : input.memberMode === 'member'
        ? await resolveReadCeilings(
          input.userId,
          workspaceId,
          input.assistant.clearance,
          input.assistant.teamScopeMode === 'all' ? null : input.assistant.compartments,
          true,
        )
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
  let assistantProjectGrant: ScopeGrant = externalPrincipal ? [] : null
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
    assistantProjectGrant = externalPrincipal ? [] : principal.projectGrant
  } else if (input.assistant.projectScopeMode === 'assigned') {
    const principal = await store!.resolveAssistantPrincipalSystem(input.assistant.id, workspaceId)
    if (!principal) throw new ContextNotAvailableError('workspace', 'not_found')
    assistantProjectGrant = externalPrincipal ? [] : principal.projectGrant
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

  // Permission model v2: the membership read above also reports the
  // workspace's v2 flag. For a flagged workspace the read grant is computed
  // from edges and base clearance alone (resolveDepartmentGrant) and decides
  // every read; the legacy-shaped ceilings stay on `access` only as the
  // compatibility envelope persisted by workflow authority and authority
  // leases, until Phases 3-5 move those to the grant.
  const flagged = oldCeilings as { departmentReadV2?: boolean; departmentQuery?: <R>(sql: string, values: unknown[]) => Promise<{ rows: R[] }> }
  const departmentRead = flagged.departmentReadV2
    ? await resolveDepartmentGrant(input, workspaceId, binding.groupId, deps.departmentRead
      ?? { query: flagged.departmentQuery ?? systemQuery as <R>(sql: string, values: unknown[]) => Promise<{ rows: R[] }> })
    : undefined
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
      ...(departmentRead ? { departmentRead } : {}),
    },
    activeGroupId: activeTeam?.id ?? null,
    activeProjectId: activeProject?.id ?? null,
    effectiveCompartments,
    effectiveProjectIds,
    writeCompartments: externalPrincipal
      ? []
      : activeTeam
        ? [activeTeam.compartmentKey]
        : [...new Set(input.assistant.defaultCompartments ?? [])].sort(),
    writeProjectIds: externalPrincipal ? [] : activeProject ? [activeProject.id] : [],
    activeTeam,
    activeProject,
  })
}

/**
 * Permission model v2 read grant (workspace flag on): edges and base clearance
 * only, through the reference predicate. No role universe, read bundle, read
 * grant, manager, access or classification mode, Team scope mode or readiness
 * constant is an input. The bound department is ctx.department; an issued
 * anonymous surface acts as (issuer, A) capped at A's clearance (K3); an
 * external principal is anonymous.
 */
async function resolveDepartmentGrant(
  input: ResolveTurnScopeInput,
  workspaceId: string,
  contextDepartment: string | null,
  deps: NonNullable<ResolveTurnScopeDeps['departmentRead']>,
): Promise<DepartmentReadGrant> {
  const external = input.memberMode === 'external'
  // resolveScope already refused an assistant from another workspace, so an
  // id with no assistant row here is a member-only probe (access inspection
  // passes the member's own id): no assistant acts, identity in min().
  const acting = (await deps.query<{ id: string }>('SELECT id FROM assistants WHERE id = $1 AND workspace_id = $2',
    [input.assistant.id, workspaceId])).rows.length > 0
  const read = {
    workspaceId,
    userId: input.userId,
    assistantId: acting ? input.assistant.id : null,
    contextDepartment,
    credential: input.memberMode === 'assistant' ? { cap: input.assistant.clearance, binding: null } : null,
  }
  const loaded = await loadDepartmentSnapshot(deps.query, read)
  const principal = external ? { kind: 'anonymous' as const, id: 'anonymous' } : loaded.principal
  return resolveDepartmentReadGrant(loaded.snapshot, principal, read, deps.now?.() ?? new Date())
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
