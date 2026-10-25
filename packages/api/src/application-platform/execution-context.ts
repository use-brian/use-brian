/** App authentication enters the existing immutable context and sticky lease. [COMP:api/application-auth] */
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool, PoolClient } from 'pg'
import { createExecutionContext, intersectAccessCeilings, maxSensitivity, minSensitivity,
  type AccessCeiling, type ExecutionContext, type Sensitivity } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { findAssistantById } from '../db/users.js'
import { applyRLSGucs, rollbackAndRelease } from '../db/client.js'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import { createAuthorityLease, AuthorityChangedError } from '../context-scope/authority-lease.js'
import { pinPolicyEpoch } from '../context-scope/policy-epoch.js'
import { resolveLiveAccessCeilingSystem } from '../context-scope/resolve-turn-scope.js'
import { loadApplicationAuthority, type ApplicationAuthentication, type ApplicationAuthorityState } from './grant-authority.js'

const bindings = new WeakMap<ExecutionContext, { authentication: ApplicationAuthentication; state: ApplicationAuthorityState }>()
const transactionBindings = new WeakMap<PoolClient, ExecutionContext>()
// Shallow narrowing preserves this private token; JSON/clones cannot mint proof.
const applicationAccessToken = Symbol('application-access-context')
const applicationAccessExecutions = new WeakMap<object, ExecutionContext>()

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
export function currentApplicationReadTransaction(access:{workspaceId:string;userId:string;applicationBound?:true}) {
  const current=readTransactions.getStore()
  const token=(access as {[applicationAccessToken]?:object})[applicationAccessToken]
  if (access.applicationBound!==undefined || token!==undefined) {
    if (!current || access.applicationBound!==true || !token
      || applicationAccessExecutions.get(token)!==current.execution) {
      throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
    }
  }
  if(!current)return undefined
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
  const accessToken = Object.freeze({})
  const applicationAccess = { ...initial.ceiling, assistantId: initial.assistant.id,
    assistantKind: initial.assistant.kind, applicationBound: true as const, [applicationAccessToken]: accessToken }
  const execution = createExecutionContext({ identity: { kind: 'programmatic', credentialOwnerUserId: initial.state.issuerUserId,
    principal: { kind: 'application', credentialId: initial.state.credentialId, applicationId: initial.state.appId,
      actorUserId: initial.state.principal.userId, subjectKind: initial.state.principal.kind, serviceUserId: initial.state.serviceUserId } },
  ownership: { kind: 'workspace', workspaceId: initial.state.workspaceId },
  access: applicationAccess,
  writeDefaults: { compartments: [], projectIds: [] }, authority,
  lifecycle: { abortSignal: options.abortSignal ?? new AbortController().signal, sessionId: options.sessionId ?? randomUUID(),
    channelType: options.channelType ?? 'application', channelId: initial.state.appId, sessionPersisted: false },
  surface: initial.state.readOnly ? { readOnly: true } : {}, attribution: { credentialOwnerUserId: initial.state.issuerUserId } })
  for (const facts of [execution.identity, execution.ownership, execution.security.access, execution.security.ceiling,
    execution.security.writeDefaults, execution.security.provenance, execution.surface, execution.attribution]) freezeFacts(facts)
  Object.freeze(execution.security.authority)
  bindings.set(execution, { authentication: auth, state: initial.state })
  applicationAccessExecutions.set(accessToken, execution)
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

/** Run one admitted operation using the host-supplied non-owner pool. */
export async function runApplicationTransaction<T>(pool: Pool, execution: ExecutionContext, operation: (client: PoolClient, afterCommit: (effect: () => void) => void) => Promise<T>, effectful = false, commandLock?: string): Promise<T> {
  if (execution.ownership.kind !== 'workspace' || execution.ownership.workspaceId !== execution.security.access.workspaceId
    || execution.lifecycle.abortSignal.aborted) throw new ApplicationPlatformError('access_unavailable', 'The application is unavailable.')
  if (execution.identity.kind === 'programmatic' && execution.identity.principal.kind === 'application'
    && !getApplicationExecutionBinding(execution)) throw new ApplicationPlatformError('authentication_required', 'Application authentication is required.')
  await execution.security.authority.assertCurrent()
  return runWithAgentAccess(execution.security.access, async () => {
    const client = await pool.connect()
    const effects: Array<() => void> = []
    let commitStarted = false
    try {
      await client.query('BEGIN')
      const role = await client.query(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
        FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='entity_instances'::regclass WHERE r.rolname=current_user`)
      if (role.rows[0]?.bypass !== false) throw new ApplicationPlatformError('access_unavailable', 'A non-owner application role is required.')
      // A duplicate waits before holding the workspace/source locks needed by its winner.
      if (commandLock) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [commandLock])
        await execution.security.authority.assertCurrent()
        if (execution.lifecycle.abortSignal.aborted) throw new ApplicationPlatformError('access_unavailable', 'The operation was cancelled.')
      }
      await applyRLSGucs(client, execution.security.access.userId)
      const application = await applyApplicationRLSContext(client, execution)
      if (!application) {
        const member = await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',
          [execution.security.access.workspaceId, execution.security.access.userId])
        if (!member.rows[0]) throw new ApplicationPlatformError('access_unavailable', 'The application is unavailable.')
      }
      const value = await runWithApplicationReadTransaction(client,execution,()=>operation(client, effect => effects.push(effect)))
      await execution.security.authority.assertCurrent()
      if (execution.lifecycle.abortSignal.aborted) throw new ApplicationPlatformError('access_unavailable', 'The operation was cancelled.')
      commitStarted = true
      await client.query('COMMIT')
      releaseApplicationTransactionBinding(client)
      for (const effect of effects) {
        try { effect() } catch { console.warn('[application-platform] post-commit projection failed') }
      }
      return value
    } catch (error) {
      if (commitStarted && effectful) throw new ApplicationPlatformError('outcome_uncertain', 'Reconcile the saved operation before retrying.', 'uncertain')
      if (!(error instanceof ApplicationPlatformError)) {
        const code = (error as { code?: string })?.code
        if (code === '23505' || code === '40001' || code === '40P01') {
          throw new ApplicationPlatformError('record_version_conflict', 'The record or its declared uniqueness changed. Refresh before retrying.')
        }
        if (code === '22023' || code === '23514' || code === '22P02') {
          const refusal = new ApplicationPlatformError('invalid_value', 'The declared operation constraints were not satisfied.')
          Object.defineProperty(refusal, 'cause', { value: error })
          throw refusal
        }
        if (code === '42501') throw new ApplicationPlatformError('access_unavailable', 'The operation is unavailable.')
      }
      throw error
    } finally { releaseApplicationTransactionBinding(client); await rollbackAndRelease(client) }
  })
}
