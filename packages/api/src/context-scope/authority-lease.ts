import { normalizeSessionVisibility, sessionAuthorityDestinationMatches } from '../session-kind.js'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  accessCeilingContains,
  intersectAccessCeilings,
  type AccessCeiling,
} from '@use-brian/agent-runtime/security/access-ceiling.js'
import { AuthoritySourceSchema } from '@use-brian/agent-runtime/security/authority-source.js'
import type { CurrentAuthorityBoundary } from '@use-brian/agent-runtime/tools/types.js'
import type { Session } from '../db/sessions.js'
import { operationCeilingsFromMembership } from '../db/workspace-store.js'
import { query } from '../db/client.js'
import type { PolicyEpoch } from './policy-epoch.js'
import { readSessionAuthorityFacts,decodeSessionAuthorityFacts,type SessionAuthorityFactsInput } from './session-authority-facts.js'
import { resolveLiveAccessCeilingSystem, type ResolveTurnScopeDeps } from './resolve-turn-scope.js'

/** A stale model context cannot be revived by granting access back later. */
export class AuthorityChangedError extends Error {
  readonly reason = 'authority_changed'
  readonly retrySafe = false
  constructor(readonly operationMayHaveExecuted = false) {
    super(operationMayHaveExecuted
      ? 'Access changed during the operation. Its outcome may be incomplete; check before retrying.'
      : 'Access changed. Start a new request with the current permissions.')
    this.name = 'AuthorityChangedError'
  }
}

export type AuthorityLease = CurrentAuthorityBoundary & {
  markOperationMayHaveExecuted(): void
}
const leases = new AsyncLocalStorage<readonly AuthorityLease[]>()

/** No TTL: each boundary observes live membership/grants, including timed expiry. */
export function createAuthorityLease(
  starting: AccessCeiling,
  resolveCurrent: () => Promise<AccessCeiling | null>,
  policyCurrent?: () => Promise<boolean>,
): AuthorityLease {
  return createAuthorityState(starting,resolveCurrent,policyCurrent).lease
}
function createAuthorityState(starting:AccessCeiling,resolveCurrent:()=>Promise<AccessCeiling|null>,policyCurrent?:()=>Promise<boolean>) {
  const invocationId = randomUUID()
  const pinned = intersectAccessCeilings(starting, starting)
  let invalid = false
  let operationMayHaveExecuted = false
  const assertValid=()=>{if(invalid)throw new AuthorityChangedError(operationMayHaveExecuted)}
  const verify=async(resolve:()=>Promise<AccessCeiling|null>)=>{
      if (invalid) throw new AuthorityChangedError(operationMayHaveExecuted)
      try {
        if (policyCurrent && !(await policyCurrent())) throw new AuthorityChangedError()
        const current = await resolve()
        if (!current || !accessCeilingContains(current, pinned)) invalid = true
        if (policyCurrent && !(await policyCurrent())) invalid = true
      } catch {
        // Failure to verify is not permission. Keep underlying diagnostics out
        // of the model response and never return content from stale context.
        invalid = true
      }
      // A concurrent validator may have invalidated this same lease while
      // this one awaited the database. Success cannot erase that decision.
      if (invalid) throw new AuthorityChangedError(operationMayHaveExecuted)
  }
  const lease: AuthorityLease = {
    snapshotSource: () => ({ version: 1, kind: 'invocation', invocationId }),
    markOperationMayHaveExecuted() { operationMayHaveExecuted = true },
    assertCurrent:()=>verify(resolveCurrent),
    async execute<T>(operation: () => Promise<T>): Promise<T> {
      await lease.assertCurrent()
      let result: T
      try {
        result = await operation()
      } catch (error) {
        try { await lease.assertCurrent() } catch { throw uncertainLeaseOperation(lease) }
        throw error
      }
      try { await lease.assertCurrent() } catch { throw uncertainLeaseOperation(lease) }
      return result
    },
  }
  return {lease,verify,assertValid}
}

type SessionReadOwner={assertCurrent:CurrentAuthorityBoundary['assertCurrent'];input:SessionAuthorityFactsInput;assertValid():void;verify(facts:unknown):Promise<void>}
const sessionReadOwners=new WeakMap<CurrentAuthorityBoundary,SessionReadOwner>()
const sessionTurnOwners=new WeakMap<CurrentAuthorityBoundary,Readonly<{token:string}>>()
/** Only the original kernel adoption binds this value. SQL still checks the
 * actual durable row and all principal/source facts at every record frame. */
export function bindSessionTurnAuthority(lease:CurrentAuthorityBoundary,turn:{sessionId:string;assistantId:string;token:string}):()=>void{
 const owner=sessionReadOwners.get(lease)
 if(!owner)return()=>{}
 if(owner.assertCurrent!==lease.assertCurrent||owner.input.sessionId!==turn.sessionId||owner.input.assistantId!==turn.assistantId
  ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turn.token)||sessionTurnOwners.has(lease))throw new AuthorityChangedError()
 owner.assertValid()
 const captured=Object.freeze({token:turn.token});sessionTurnOwners.set(lease,captured)
 return()=>{if(sessionTurnOwners.get(lease)===captured)sessionTurnOwners.delete(lease)}
}
/** The lease consumes facts from this exact source-acquisition statement. This
 * is an operation-owned read, never a receipt available to a later effect. */
export async function captureSessionAuthority<T>(lease:CurrentAuthorityBoundary,
 read:(input:SessionAuthorityFactsInput)=>Promise<{authority:unknown;value:T}|null>):Promise<{value:T}|null>{
 const owner=sessionReadOwners.get(lease)
 if(!owner||owner.assertCurrent!==lease.assertCurrent)return null
 owner.assertValid()
 const turn=sessionTurnOwners.get(lease)
 const captured=await read(structuredClone({...owner.input,...(turn?{turn}:{})}))
 if(owner.assertCurrent!==lease.assertCurrent||sessionTurnOwners.get(lease)!==turn)throw new AuthorityChangedError()
 if(!captured)return null
 await owner.verify(captured.authority)
 if(owner.assertCurrent!==lease.assertCurrent||sessionTurnOwners.get(lease)!==turn)throw new AuthorityChangedError()
 return{value:captured.value}
}
/** Opaque asynchronous work retains two fresh lease fences under one owner. */
export async function withCurrentReadAuthority<T>(authority:CurrentAuthorityBoundary|undefined,read:()=>Promise<T>):Promise<T>{
 await authority?.assertCurrent()
 const value=await read()
 await authority?.assertCurrent()
 return value
}

export type SessionAuthoritySnapshot = Pick<Session,
  'id' | 'assistantId' | 'userId' | 'contextGroupId' | 'contextProjectId' | 'contextLockedAt'
> & Partial<Pick<Session, 'visibility' | 'mode' | 'effectiveClearance' | 'contextCompartments' | 'channelType' | 'channelId' | 'appOrigin' | 'anchorKind' | 'anchorRef'>>

type SessionFacts = Awaited<ReturnType<typeof readSessionAuthorityFacts>>

/** Use one immutable binding comparison for startup and live owner checks. */
export function sessionReadBindingCurrent(expected: SessionAuthoritySnapshot, actual: NonNullable<SessionFacts['session']>,
  lock = expected.contextLockedAt?.toISOString() ?? null): boolean {
  return actual.id === expected.id && sessionAuthorityDestinationMatches(expected,actual)
    && (expected.mode === undefined || actual.mode === expected.mode)
    && actual.assistantId === expected.assistantId && actual.userId === expected.userId
    && actual.contextGroupId === expected.contextGroupId && actual.contextProjectId === expected.contextProjectId
    && contextLockCurrent(lock, actual.contextLockedAt?.toISOString() ?? null)
    && (expected.visibility === undefined || normalizeSessionVisibility(actual.visibility) === normalizeSessionVisibility(expected.visibility))
    && (expected.effectiveClearance === undefined || actual.effectiveClearance === expected.effectiveClearance)
    && (expected.contextCompartments == null
      || JSON.stringify([...(actual.contextCompartments ?? [])].sort()) === JSON.stringify([...expected.contextCompartments].sort()))
}

/** Only pass facts captured for this operation; none carries effect authority. */
export function sessionScopeDependencies(facts: SessionFacts): ResolveTurnScopeDeps {
  const {scopeFacts,member,department} = facts
  return {
    scopeFacts,
    resolveReadCeilings: async (_user, _workspace, clearance, compartments, requireMembership) =>
      operationCeilingsFromMembership(member, clearance, compartments, requireMembership),
    resolveWorkspaceRole: async () => member?.role ?? null,
    ...(department ? {departmentRead:{query:query as NonNullable<ResolveTurnScopeDeps['departmentRead']>['query'],facts:department}} : {}),
  }
}

/** Build the live lease used by web, public/API and messaging turns. */
export function createSessionAuthorityLease(input: {
  starting: AccessCeiling
  /** Only ordinary authenticated private web sessions qualify for cold source reconstruction. */
  durableSessionSource?: boolean
  session: SessionAuthoritySnapshot
  /**
   * The assistant actually running this turn. On a doc-dock switch or a room
   * @mention it differs from the session's bound assistant, and the starting
   * ceiling was resolved for IT - so the live re-check must be too. Absent,
   * the bound assistant runs the turn.
   */
  executingAssistantId?: string
  /** Current caller; differs from the session starter in shared rooms. */
  userId?: string
  memberMode?: 'enforce' | 'assistant' | 'member' | 'external'
  ignoreSessionBinding?: boolean
  systemRead?: boolean
  nativeSessionCredential?:{userId:string;sessionId:string;authVersion:number}
  credentialCurrent?: () => Promise<boolean>
  /** Re-resolve a recipient/surface ceiling at every authority boundary. */
  maximumAccessCurrent?: () => Promise<AccessCeiling | null>
  /** Construction-pinned native/application field and configuration metadata. */
  policy?: PolicyEpoch
}): AuthorityLease {
  const nativeCredential=input.nativeSessionCredential?Object.freeze(structuredClone(input.nativeSessionCredential)):undefined
  const sourceRead = { visibility: normalizeSessionVisibility(input.session.visibility), mode: input.session.mode,
    effectiveClearance: input.session.effectiveClearance,
    contextCompartments: input.session.contextCompartments ? [...input.session.contextCompartments] : undefined }
  const destination={channelType:input.session.channelType,channelId:input.session.channelId,appOrigin:input.session.appOrigin,anchorKind:input.session.anchorKind,anchorRef:input.session.anchorRef}
  const sessionBinding = {...input.session,contextCompartments:sourceRead.contextCompartments}
  const expected = {
    id: input.session.id,
    assistantId: input.session.assistantId,
    executingAssistantId: input.executingAssistantId ?? input.session.assistantId,
    userId: input.session.userId,
    authorityUserId: input.userId ?? input.session.userId,
    contextGroupId: input.session.contextGroupId,
    contextProjectId: input.session.contextProjectId,
    contextLockedAt: input.session.contextLockedAt?.toISOString() ?? null,
    workspaceId: input.starting.workspaceId,
  }
  const factsInput:SessionAuthorityFactsInput={sessionId:expected.id,assistantId:expected.executingAssistantId,
    workspaceId:expected.workspaceId,userId:expected.authorityUserId,credential:nativeCredential,
    includePolicy:!!input.policy,includeDepartments:input.memberMode!=='assistant'&&input.memberMode!=='external'}
  const resolveFacts=async(facts:SessionFacts)=>{
    const {session,assistant,credentialCurrent,policy}=facts
    if (!session || !assistant || !credentialCurrent || input.policy && !input.policy.matches(policy)) return null
    const currentLock = session.contextLockedAt?.toISOString() ?? null
    if (!sessionReadBindingCurrent(sessionBinding,session,expected.contextLockedAt)
      || (assistant.workspaceId ?? '') !== expected.workspaceId) return null
    // The first message takes the lock after the lease starts. Remember the
    // observed timestamp so a later lock rewrite in the same turn cannot pass
    // merely because the starting snapshot was null.
    if (expected.contextLockedAt === null && currentLock !== null) {
      expected.contextLockedAt = currentLock
    }
    const current = await resolveLiveAccessCeilingSystem({
      userId: expected.authorityUserId,
      assistant,
      workspaceId: assistant.workspaceId,
      session,
      memberMode: input.memberMode,
      ignoreSessionBinding: input.ignoreSessionBinding,
      systemRead: input.systemRead,
    }, sessionScopeDependencies(facts))
    const maximum = input.maximumAccessCurrent ? await input.maximumAccessCurrent() : current
    // Scope evaluation consumes the complete statement snapshot. Only an opaque
    // recipient callback opens an independent read interval requiring closure.
    if (input.maximumAccessCurrent && input.policy && !await input.policy.isCurrent()) return null
    return maximum ? intersectAccessCeilings(current, { ...maximum, userId: current.userId }) : null
  }
  const state=createAuthorityState(input.starting,async()=>{
    if(input.credentialCurrent&&!await input.credentialCurrent())return null
    return resolveFacts(await readSessionAuthorityFacts(factsInput))
  })
  const lease=state.lease
  if(!input.credentialCurrent&&!input.maximumAccessCurrent)sessionReadOwners.set(lease,{
    input:factsInput,assertCurrent:lease.assertCurrent,assertValid:state.assertValid,
    verify:raw=>state.verify(()=>resolveFacts(decodeSessionAuthorityFacts(factsInput,raw))),
  })
  const invocation = lease.snapshotSource!()
  lease.snapshotNativeSessionCredential = () => nativeCredential ? { ...nativeCredential } : null
  lease.snapshotSource = () => {
    if (!input.durableSessionSource || expected.contextLockedAt === null || input.credentialCurrent || input.maximumAccessCurrent
      ||nativeCredential&&nativeCredential.userId!==expected.authorityUserId) return { ...invocation }
    const snapshot = AuthoritySourceSchema.safeParse({ version: 1, kind: 'session', invocationId: invocation.invocationId, ...expected,
      contextLockedAt: expected.contextLockedAt, memberMode: input.memberMode ?? 'enforce',
      ignoreSessionBinding: input.ignoreSessionBinding ?? false, systemRead: input.systemRead ?? false,
      ...sourceRead,...(nativeCredential?{nativeCredential}:{}) })
    return snapshot.success ? snapshot.data : { ...invocation }
  }
  return lease
}

/**
 * A session that started unlocked is locked by its own first message (the
 * `session_messages_lock_context` trigger), mid-turn, with the same Team and
 * Project. That null → set step is the lock being taken, not access changing;
 * the context ids themselves are compared separately. Once pinned, the lock
 * timestamp must not move.
 */
function contextLockCurrent(expected: string | null, current: string | null): boolean {
  return expected === null || current === expected
}

export function runWithAuthorityLease<T>(lease: AuthorityLease, fn: () => T): T {
  return leases.run([...(leases.getStore() ?? []), lease], fn)
}

export async function assertCurrentAuthority(): Promise<void> {
  for (const lease of leases.getStore() ?? []) await lease.assertCurrent()
}

/** Protect both invocation and return; never replay an ambiguous operation. */
export async function executeWithCurrentAuthority<T>(fn: () => Promise<T>): Promise<T> {
  await assertCurrentAuthority()
  let result: T
  try {
    result = await fn()
  } catch (error) {
    try { await assertCurrentAuthority() } catch { throw uncertainOperation() }
    throw error
  }
  try { await assertCurrentAuthority() } catch { throw uncertainOperation() }
  return result
}

function uncertainOperation(): AuthorityChangedError {
  for (const lease of leases.getStore() ?? []) lease.markOperationMayHaveExecuted()
  return new AuthorityChangedError(true)
}

/** A domain transaction owns commit reconciliation and preserves the lease's
 * uncertain-outcome marker without acquiring another permission bracket. */
export function markAuthorityOperationUncertain(boundary:CurrentAuthorityBoundary):void{
 const lease=boundary as Partial<AuthorityLease>
 lease.markOperationMayHaveExecuted?.()
}

function uncertainLeaseOperation(lease: AuthorityLease): AuthorityChangedError {
  lease.markOperationMayHaveExecuted()
  return new AuthorityChangedError(true)
}

export function isAuthorityChangedError(error: unknown): error is AuthorityChangedError {
  return typeof error === 'object' && error !== null
    && (error as { reason?: unknown }).reason === 'authority_changed'
}
