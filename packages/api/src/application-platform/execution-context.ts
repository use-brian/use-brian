/** App authentication enters the existing immutable context and sticky lease. [COMP:api/application-auth] */
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { PoolClient } from 'pg'
import { createExecutionContext, intersectAccessCeilings, maxSensitivity, minSensitivity,
  type AccessCeiling, type ExecutionContext, type Sensitivity } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { findAssistantById } from '../db/users.js'
import { createAuthorityLease, AuthorityChangedError } from '../context-scope/authority-lease.js'
import { pinPolicyEpoch } from '../context-scope/policy-epoch.js'
import { resolveLiveAccessCeilingSystem } from '../context-scope/resolve-turn-scope.js'
import { loadApplicationAuthority, type ApplicationAuthentication, type ApplicationAuthorityState } from './grant-authority.js'

const bindings = new WeakMap<ExecutionContext, { authentication: ApplicationAuthentication; state: ApplicationAuthorityState }>()
const transactionBindings = new WeakMap<PoolClient, ExecutionContext>()
/** Canonical writers receive proof only for the exact host-bound transaction. */
export function getApplicationTransactionBinding(client: PoolClient) {
  const execution = transactionBindings.get(client)
  return execution ? Object.freeze({ workspaceId: execution.security.access.workspaceId,
    actorUserId: execution.security.access.userId, assistantId: execution.assistant.id }) : undefined
}
export function releaseApplicationTransactionBinding(client: PoolClient) {
  transactionBindings.delete(client)
}
const readTransactions=new AsyncLocalStorage<{client:PoolClient;execution:ExecutionContext;lease:{active:boolean}}>()
/** Legacy native reads must retain the genuine application's exact SQL ceiling. */
export function runWithApplicationReadTransaction<T>(client:PoolClient,execution:ExecutionContext,operation:()=>Promise<T>):Promise<T> {
  const app=getApplicationExecutionBinding(execution),bound=getApplicationTransactionBinding(client)
  if(!app) {
    if(readTransactions.getStore())throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
    return operation()
  }
  if(transactionBindings.get(client)!==execution||!bound||bound.workspaceId!==execution.security.access.workspaceId||bound.actorUserId!==execution.security.access.userId) {
    throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
  }
  const lease={active:true}
  return readTransactions.run(Object.freeze({client,execution,lease}),async()=>{
    try{return await operation()}finally{lease.active=false}
  })
}
/** A retained asynchronous callback cannot reuse a released host transaction. */
export function currentApplicationReadTransaction(access:{workspaceId:string;userId:string}) {
  const current=readTransactions.getStore();if(!current)return undefined
  const workspaceId=access.workspaceId,userId=access.userId
  const assertLive=()=>{
    const bound=getApplicationTransactionBinding(current.client)
    if(readTransactions.getStore()!==current||!current.lease.active||transactionBindings.get(current.client)!==current.execution
      ||!bound||bound.workspaceId!==workspaceId||bound.actorUserId!==userId) {
      throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
    }
  }
  assertLive()
  return Object.freeze({client:current.client,execution:current.execution,assertLive})
}
const intersect = (left: string[], right: string[]) => left.filter(value => right.includes(value))
function freezeFacts(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return
  for (const nested of Object.values(value)) freezeFacts(nested)
  Object.freeze(value)
}
function releaseCeiling(state: ApplicationAuthorityState): AccessCeiling {
  const now = Date.now()
  let compartments: string[] | undefined, projects: string[] | undefined, clearance: Sensitivity = 'confidential'
  for (const alternatives of state.layers) {
    const paths = alternatives.flatMap(path => {
      const grants = [...path.current, ...path.maximum.grants]
      if (grants.some(grant => grant.status !== 'active' || Date.parse(grant.startsAt) > now
        || grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now)) return []
      return [{ clearance: minSensitivity(...grants.map(grant => grant.clearance)),
        compartments: grants.reduce((keys, grant) => intersect(keys, grant.compartments), grants[0].compartments),
        projects: grants.reduce((keys, grant) => intersect(keys, grant.projectIds), grants[0].projectIds) }]
    })
    if (!paths.length) throw new ApplicationPlatformError('grant_revoked', 'Application access is unavailable.')
    const labels = [...new Set(paths.flatMap(path => path.compartments))]
    const ids = [...new Set(paths.flatMap(path => path.projects))]
    compartments = compartments ? intersect(compartments, labels) : labels
    projects = projects ? intersect(projects, ids) : ids
    clearance = minSensitivity(clearance, maxSensitivity(...paths.map(path => path.clearance)))
  }
  return { workspaceId: state.workspaceId, userId: state.principal.userId, clearance,
    compartments: compartments ?? [], mutationCompartments: compartments ?? [], projectIds: projects ?? [], visibilityAssistantIds: [state.assistantId] }
}

export async function resolveApplicationExecutionContext(authentication: ApplicationAuthentication,
  options: { abortSignal?: AbortSignal; sessionId?: string; channelType?: string } = {}): Promise<ExecutionContext> {
  // Keep the authenticated objects themselves: cloning their public metadata must lose proof.
  const auth = Object.freeze({ credential: authentication.credential, user: authentication.user, home: authentication.home })
  // Bootstrap identity is metadata only. Resolve all trusted grants/ceilings again
  // inside the epoch bracket so an intervening change cannot be attached to it.
  const identity = await loadApplicationAuthority(auth)
  const policyCurrent = await pinPolicyEpoch({ workspaceId: identity.workspaceId,
    principalId: identity.principal.userId, assistantId: identity.assistantId })
  async function resolve() {
    const state = await loadApplicationAuthority(auth)
    const assistant = await findAssistantById(state.assistantId)
    if (!assistant || assistant.workspaceId !== state.workspaceId) throw new ApplicationPlatformError('grant_revoked', 'Application access is unavailable.')
    let ceiling = releaseCeiling(state)
    ceiling = { ...ceiling, clearance: minSensitivity(ceiling.clearance, assistant.clearance, state.clearanceCap ?? 'confidential') }
    if (state.nativeMember) {
      ceiling = intersectAccessCeilings(ceiling, await resolveLiveAccessCeilingSystem({ userId: state.principal.userId, workspaceId: state.workspaceId, assistant, memberMode: 'member' }))
    }
    const signature = createHash('sha256').update(JSON.stringify({ fingerprint: state.fingerprint, ceiling, assistant })).digest('hex')
    return { state, assistant, ceiling, signature }
  }
  const initial = await resolve()
  if (initial.state.workspaceId !== identity.workspaceId || initial.state.principal.userId !== identity.principal.userId
    || initial.state.assistantId !== identity.assistantId || !(await policyCurrent())) throw new AuthorityChangedError()
  const authority = createAuthorityLease(initial.ceiling, async () => {
    const current = await resolve()
    return current.signature === initial.signature ? current.ceiling : null
  }, policyCurrent)
  const execution = createExecutionContext({ identity: { kind: 'programmatic', credentialOwnerUserId: initial.state.issuerUserId,
    principal: { kind: 'application', credentialId: initial.state.credentialId, applicationId: initial.state.appId,
      actorUserId: initial.state.principal.userId, subjectKind: initial.state.principal.kind, serviceUserId: initial.state.serviceUserId } },
  ownership: { kind: 'workspace', workspaceId: initial.state.workspaceId },
  access: { ...initial.ceiling, assistantId: initial.assistant.id, assistantKind: initial.assistant.kind },
  writeDefaults: { compartments: [], projectIds: [] }, authority,
  lifecycle: { abortSignal: options.abortSignal ?? new AbortController().signal, sessionId: options.sessionId ?? randomUUID(),
    channelType: options.channelType ?? 'application', channelId: initial.state.appId, sessionPersisted: false },
  surface: initial.state.readOnly ? { readOnly: true } : {}, attribution: { credentialOwnerUserId: initial.state.issuerUserId } })
  for (const facts of [execution.identity, execution.ownership, execution.security.access, execution.security.ceiling,
    execution.security.writeDefaults, execution.security.provenance, execution.surface, execution.attribution]) freezeFacts(facts)
  Object.freeze(execution.security.authority)
  bindings.set(execution, { authentication: auth, state: initial.state })
  return execution
}

/** No public descriptor or model args can attach a verified binding to a context. */
export function getApplicationExecutionBinding(execution: ExecutionContext) {
  const binding = bindings.get(execution)
  return binding ? { state: structuredClone(binding.state) } : undefined
}

export async function applyApplicationRLSContext(client: PoolClient, execution: ExecutionContext): Promise<boolean> {
  transactionBindings.delete(client)
  const binding = bindings.get(execution)
  if (!binding) return false
  await execution.security.authority.assertCurrent()
  await client.query(`SELECT set_config('app.application_id',$1,true),set_config('app.application_credential_id',$2,true),
    set_config('app.application_oauth_id',$3,true),set_config('app.application_assistant_id',$4,true),
    set_config('app.v2_assistant_id',$4,true),set_config('app.v2_cap',$5,true),set_config('app.application_home_binding_id',$6,true)`,
  [binding.state.appId, binding.authentication.credential?.credentialId ?? '', binding.authentication.user?.authorizationId ?? '',
    execution.assistant.id, execution.security.access.clearance, binding.authentication.home?.bindingId ?? ''])
  const result = await client.query<{ admitted: boolean }>('SELECT application_lock_workspace($1) AS admitted', [binding.state.workspaceId])
  if (result.rows[0]?.admitted !== true) throw new ApplicationPlatformError('grant_revoked', 'Application access is unavailable.')
  transactionBindings.set(client, execution)
  return true
}
