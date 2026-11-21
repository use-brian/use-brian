/** Native actor floor shared by discovery, gateway/direct invocation and return. [COMP:api/connector-context] */
import { createHash } from 'node:crypto'
import { pinAccessCeiling, type AccessCeiling } from '@use-brian/agent-runtime/security/access-ceiling.js'
import { findAssistantById } from '../db/users.js'
import { currentAgentAccess } from '../db/agent-access-context.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { connectorExposureAllowed, resolveConnectorNativeTurnScopeSystem, type ConnectorContextBinding } from '../context-scope/connector-exposure.js'
import { resolveTurnScopeMetadataSystem, withinExecutingCaller, type ResolvedTurnScope } from '../context-scope/resolve-turn-scope.js'
import { AuthorityChangedError, createAuthorityLease } from '../context-scope/authority-lease.js'

export type ConnectorRuntimeActorFacts = {
  workspaceId: string
  assistantId: string
  /** Actual authenticated host actor; absent never falls back to the credential owner. */
  initiatingUserId?: string
  /** An independently supplied host identity, when emitted. Conflicts refuse. */
  identityUserId?: string
}
/** `scope` is the actor's native floor without any executing caller's ambient projection. */
type NativeActorState = { scope: ResolvedTurnScope | null }
type ConnectorNativeActorReader = (facts: Readonly<ConnectorRuntimeActorFacts> & { initiatingUserId: string }) => Promise<NativeActorState | null>

async function readNativeActorSystem(facts: Readonly<ConnectorRuntimeActorFacts> & { initiatingUserId: string }): Promise<NativeActorState | null> {
  const parent = currentAgentAccess()
  // Metadata ignores inherited label narrowing, never inherited identity.
  if (parent && (parent.workspaceId !== undefined && parent.workspaceId !== facts.workspaceId
    || parent.userId !== undefined && parent.userId !== facts.initiatingUserId)) throw new AuthorityChangedError()
  const assistant = await findAssistantById(facts.assistantId)
  if (!assistant || assistant.workspaceId !== facts.workspaceId) return null
  const role = await getWorkspaceRoleSystem(facts.initiatingUserId, facts.workspaceId, true)
  if (role === null) return { scope: null }
  // Metadata resolution: the same facts whether the check runs at admission or
  // inside a narrower tool projection (a shared room's audience).
  return { scope: await resolveConnectorNativeTurnScopeSystem({ workspaceId: facts.workspaceId, userId: facts.initiatingUserId, assistant },
    resolveTurnScopeMetadataSystem) }
}

/** The reader port is host composition, never connector config/model data. Acceptance uses the canonical reader. */
export async function createConnectorRuntimeAuthority(rawFacts: ConnectorRuntimeActorFacts, read: ConnectorNativeActorReader = readNativeActorSystem) {
  const facts = Object.freeze({ ...rawFacts })
  const hasActor = Boolean(facts.initiatingUserId)
  const conflicting = Boolean(facts.identityUserId && facts.identityUserId !== facts.initiatingUserId)
  const validBinding = (binding: ConnectorContextBinding) => Array.isArray(binding.compartments) && Array.isArray(binding.projectIds)
    && [...binding.compartments,...binding.projectIds].every(value => typeof value === 'string' && value.length > 0)
  const isGeneral = (binding: ConnectorContextBinding) => validBinding(binding) && binding.compartments.length === 0 && binding.projectIds.length === 0
  const generalOnly = () => ({
    cacheKey: createHash('sha256').update(JSON.stringify([facts.workspaceId,facts.assistantId,facts.initiatingUserId ?? null,'general-only'])).digest('hex'),
    allows: (binding: ConnectorContextBinding) => !conflicting && isGeneral(binding),
    assertCurrent: async () => { if (conflicting) throw new AuthorityChangedError() },
    execute: async <T>(operation: () => Promise<T>): Promise<T> => {
      if (conflicting) throw new AuthorityChangedError()
      return operation()
    },
  })
  // Compatibility administration can inspect General metadata without an execution.
  // Missing actual actor facts can never discover or invoke a labelled connector.
  if (!hasActor || conflicting) return generalOnly()
  const actorFacts = { ...facts, initiatingUserId: facts.initiatingUserId! }
  const initial = await read(actorFacts)
  if (!initial) throw new AuthorityChangedError()
  const general: AccessCeiling = { workspaceId: facts.workspaceId, userId: actorFacts.initiatingUserId,
    clearance: 'public', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [facts.assistantId] }
  const ceiling = (state: NativeActorState) => {
    if (!state.scope) return general
    if (state.scope.access.workspaceId !== facts.workspaceId || state.scope.access.userId !== actorFacts.initiatingUserId
      || state.scope.access.assistantId !== facts.assistantId) throw new AuthorityChangedError()
    return pinAccessCeiling(state.scope.access)
  }
  // The lease pins and renews the same native floor under the same (no) ambient
  // projection, so a narrower call-site audience is never read as revocation.
  const pinned = ceiling(initial), lease = createAuthorityLease(pinned, async () => {
    const current = await read(actorFacts)
    return current ? ceiling(current) : null
  })
  // Exposure keeps the admission-time caller projection (the ambient this
  // authority was created under), as before; the native grant stays the floor's.
  const projected = initial.scope ? withinExecutingCaller(initial.scope) : null
  const native = initial.scope?.access.departmentRead
  const scope = projected ? structuredClone({ ...projected, access: { ...projected.access, ...(native ? { departmentRead: native } : {}) } }) : null
  return {
    cacheKey: createHash('sha256').update(JSON.stringify([facts.workspaceId,actorFacts.initiatingUserId,facts.assistantId,
      scope ? pinAccessCeiling(scope.access) : pinned])).digest('hex'),
    allows: (binding: ConnectorContextBinding) => validBinding(binding) && (scope
      ? connectorExposureAllowed(scope, binding) : isGeneral(binding)),
    assertCurrent: () => lease.assertCurrent(),
    execute: <T>(operation: () => Promise<T>) => lease.execute(operation),
  }
}
