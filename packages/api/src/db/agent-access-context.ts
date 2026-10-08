import { AsyncLocalStorage } from 'node:async_hooks'
import { intersectDepartmentReadGrants,intersectScopeGrants,minSensitivity,type DepartmentReadGrant } from '@use-brian/core'

/**
 * Trusted execution ceiling propagated through awaits and nested tools.
 * Legacy clearance-only callers remain supported. A complete caller context
 * additionally pins workspace, actor and assistant visibility; nested wrappers
 * can narrow these grants but cannot replace the actor or widen an axis.
 * `applyRLSGucs` publishes the context transaction-locally for the app role,
 * while owner-pool resource queries use the same ceiling in their predicates.
 * Spec: docs/architecture/context-engine/scoped-context.md.
 */
const AGENT_CLEARANCES = ['public', 'internal', 'confidential'] as const
export type AgentClearance = (typeof AGENT_CLEARANCES)[number]

type AgentAccessContext = {
  workspaceId?: string
  userId?: string
  visibilityAssistantIds?: string[] | null
  /** Sticky: a nested execution can narrow to a shared audience, never widen back. */
  sharedAudience?: boolean
  clearance: AgentClearance
  /** undefined = legacy clearance-only wrap; linked Teams fail closed. */
  compartments?: string[] | null
  mutationCompartments?: string[] | null
  /** Project is not an ACL, but page/container reads must retain its boundary. */
  projectIds?: string[] | null
  /** Permission model v2 read authority for a workspace whose v2 flag is on. */
  departmentRead?: DepartmentReadGrant
}

const agentAccessStorage = new AsyncLocalStorage<AgentAccessContext>()

export function runWithAgentClearance<T>(clearance: string | null | undefined, fn: () => T): T {
  const validated = AGENT_CLEARANCES.find((c) => c === clearance)
  // Unknown/absent clearance runs WITHOUT the agent context rather than
  // guessing a tier — the membership model then applies (fail-closed).
  if (!validated) return fn()
  return runWithAgentAccess({clearance:validated,compartments:undefined},fn)
}

/** Carry both sensitivity and the resolved Team grant for assistant page access. */
export function runWithAgentAccess<T>(
  access: {
    workspaceId?: string
    userId?: string
    visibilityAssistantIds?: string[] | null
    sharedAudience?: boolean
    clearance: string | null | undefined
    compartments: string[] | null | undefined
    mutationCompartments?: string[] | null
    projectIds?: string[] | null | undefined
    departmentRead?: DepartmentReadGrant
  },
  fn: () => T,
): T {
  const clearance = AGENT_CLEARANCES.find((candidate) => candidate === access.clearance)
  if (!clearance) return fn()
  if(access.departmentRead && (
    access.workspaceId!==undefined && access.departmentRead.workspaceId!==access.workspaceId
    || access.userId!==undefined && access.departmentRead.userId!==access.userId
  ))throw new Error('access_actor_mismatch')
  const parent=agentAccessStorage.getStore()
  if(parent?.workspaceId!==undefined&&access.workspaceId!==undefined&&parent.workspaceId!==access.workspaceId
    ||parent?.userId!==undefined&&access.userId!==undefined&&parent.userId!==access.userId)throw new Error('access_actor_mismatch')
  const intersect=(a:string[]|null|undefined,b:string[]|null|undefined)=>
    a===undefined&&b===undefined?undefined:intersectScopeGrants(a??null,b??null)
  return agentAccessStorage.run({
    workspaceId:parent?.workspaceId??access.workspaceId,userId:parent?.userId??access.userId,
    clearance:parent?minSensitivity(parent.clearance,clearance):clearance,
    compartments:intersect(parent?.compartments,access.compartments),
    mutationCompartments:intersect(
      intersect(parent?.mutationCompartments,access.mutationCompartments===undefined?access.compartments:access.mutationCompartments),
      intersect(parent?.compartments,access.compartments)),
    projectIds:intersect(parent?.projectIds,access.projectIds),
    visibilityAssistantIds:intersect(parent?.visibilityAssistantIds,access.visibilityAssistantIds),
    ...(parent?.sharedAudience||access.sharedAudience?{sharedAudience:true}:{}),
    // Nested executions only narrow the v2 grant; one never replaces another.
    ...(parent?.departmentRead&&access.departmentRead?{departmentRead:intersectDepartmentReadGrants(parent.departmentRead,access.departmentRead)}
      :parent?.departmentRead??access.departmentRead?{departmentRead:(parent?.departmentRead??access.departmentRead)!}:{}),
  },fn)
}

/** A detached copy prevents accidental widening of a retained execution context. */
export function currentAgentAccess(): AgentAccessContext | undefined {
  const current=agentAccessStorage.getStore()
  return current?structuredClone(current):undefined
}

/** The active agent clearance, if this code runs inside an assistant execution wrap. */
export function currentAgentClearance(): AgentClearance | undefined {
  return agentAccessStorage.getStore()?.clearance
}

export function currentAgentCompartments(): string[] | null | undefined {
  return currentAgentAccess()?.compartments
}

export function currentAgentProjectIds(): string[] | null | undefined {
  return currentAgentAccess()?.projectIds
}

