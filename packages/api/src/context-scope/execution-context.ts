/** Trusted API construction for the core execution-context contract. */

import {
  createExecutionContext,
  intersectAccessCeilings,
  pinAccessCeiling,
  type AccessCeiling,
  type CreateExecutionContextInput,
  type CurrentAuthorityBoundary,
  type ExecutionContext,
  type ResolvedExecutionAccess,
  type ScopeEvidence,
} from '@use-brian/core'
import {
  createAuthorityLease,
  createSessionAuthorityLease,
  type SessionAuthoritySnapshot,
} from './authority-lease.js'
import {
  resolveLiveAccessCeilingSystem,
  resolveTurnScopeSystem,
  type ResolveTurnScopeDeps,
  type ResolveTurnScopeInput,
  type ResolvedTurnScope,
} from './resolve-turn-scope.js'

export type ResolveExecutionContextInput = ResolveTurnScopeInput & {
  identity: CreateExecutionContextInput['identity']
  ownership: CreateExecutionContextInput['ownership']
  lifecycle: CreateExecutionContextInput['lifecycle']
  surface?: CreateExecutionContextInput['surface']
  attribution?: CreateExecutionContextInput['attribution']
  provenance?: ScopeEvidence
  /** Required for attended/public session runs; absent for request-scoped MCP/system jobs. */
  sessionAuthority?: SessionAuthoritySnapshot
  credentialCurrent?: () => Promise<boolean>
}

export type ResolvedExecutionContext = {
  executionContext: ExecutionContext
  turnScope: ResolvedTurnScope
}

export type ResolveExecutionContextDeps = ResolveTurnScopeDeps & {
  resolveScope?: typeof resolveTurnScopeSystem
  resolveLive?: typeof resolveLiveAccessCeilingSystem
  createSessionLease?: (
    input: Parameters<typeof createSessionAuthorityLease>[0],
  ) => CurrentAuthorityBoundary
  createLease?: (
    starting: AccessCeiling,
    resolveCurrent: () => Promise<AccessCeiling | null>,
  ) => CurrentAuthorityBoundary
}

function boundedStartingCeiling(
  access: ResolvedExecutionAccess,
  identity: ResolveExecutionContextInput['identity'],
): AccessCeiling {
  const own = pinAccessCeiling(access)
  return identity.kind === 'delegated'
    ? intersectAccessCeilings(own, identity.parentCeiling)
    : own
}

/** Resolve current trusted scope and attach the existing sticky live lease. */
export async function resolveExecutionContextSystem(
  input: ResolveExecutionContextInput,
  deps: ResolveExecutionContextDeps = {},
): Promise<ResolvedExecutionContext> {
  const resolveScope = deps.resolveScope ?? resolveTurnScopeSystem
  const resolveLive = deps.resolveLive ?? resolveLiveAccessCeilingSystem
  const scopeDeps: ResolveTurnScopeDeps = {
    store: deps.store,
    resolveReadCeilings: deps.resolveReadCeilings,
    resolveWorkspaceRole: deps.resolveWorkspaceRole,
  }
  const turnScope = await resolveScope(input, scopeDeps)
  const access: ResolvedExecutionAccess = {
    ...turnScope.access,
    workspaceId: turnScope.access.workspaceId,
    userId: turnScope.access.userId,
    assistantId: turnScope.access.assistantId,
    assistantKind: turnScope.access.assistantKind,
    clearance: turnScope.access.clearance!,
    compartments: turnScope.access.compartments === undefined
      ? (() => { throw new Error('execution_context_missing:compartments') })()
      : turnScope.access.compartments,
    mutationCompartments: turnScope.access.mutationCompartments === undefined
      ? (() => { throw new Error('execution_context_missing:mutation_compartments') })()
      : turnScope.access.mutationCompartments,
    projectIds: turnScope.access.projectIds === undefined
      ? (() => { throw new Error('execution_context_missing:project_ids') })()
      : turnScope.access.projectIds,
    visibilityAssistantIds: turnScope.access.visibilityAssistantIds === undefined
      ? (turnScope.access.assistantKind === 'primary' ? null : [turnScope.access.assistantId])
      : turnScope.access.visibilityAssistantIds,
    systemRead: input.surface?.systemRead,
    clientSelfMemory: input.surface?.clientSelfMemory,
  }
  const starting = boundedStartingCeiling(access, input.identity)
  const authority = input.sessionAuthority
    ? (deps.createSessionLease ?? createSessionAuthorityLease)({
        starting,
        session: input.sessionAuthority,
        userId: input.userId,
        memberMode: input.memberMode,
        systemRead: input.surface?.systemRead,
        credentialCurrent: input.credentialCurrent,
      })
    : (deps.createLease ?? createAuthorityLease)(starting, async () => {
        if (input.credentialCurrent && !(await input.credentialCurrent())) return null
        const current = await resolveLive(input, scopeDeps)
        return input.identity.kind === 'delegated'
          ? intersectAccessCeilings(current, input.identity.parentCeiling)
          : current
      })

  return {
    turnScope,
    executionContext: createExecutionContext({
      identity: input.identity,
      ownership: input.ownership,
      access,
      writeDefaults: {
        compartments: turnScope.writeCompartments,
        projectIds: turnScope.writeProjectIds,
      },
      provenance: input.provenance,
      authority,
      lifecycle: input.lifecycle,
      surface: input.surface,
      attribution: input.attribution,
    }),
  }
}
