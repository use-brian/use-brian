import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  AuthoritySourceSchema,
  accessCeilingContains,
  intersectAccessCeilings,
  type AccessCeiling,
  type CurrentAuthorityBoundary,
} from '@use-brian/core'
import { findSessionAuthorityById, type Session } from '../db/sessions.js'
import { findAssistantById } from '../db/users.js'
import { resolveLiveAccessCeilingSystem } from './resolve-turn-scope.js'

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
): AuthorityLease {
  const invocationId = randomUUID()
  const pinned = intersectAccessCeilings(starting, starting)
  let invalid = false
  let operationMayHaveExecuted = false
  const lease: AuthorityLease = {
    snapshotSource: () => ({ version: 1, kind: 'invocation', invocationId }),
    markOperationMayHaveExecuted() { operationMayHaveExecuted = true },
    async assertCurrent() {
      if (invalid) throw new AuthorityChangedError(operationMayHaveExecuted)
      try {
        const current = await resolveCurrent()
        if (!current || !accessCeilingContains(current, pinned)) invalid = true
      } catch {
        // Failure to verify is not permission. Keep underlying diagnostics out
        // of the model response and never return content from stale context.
        invalid = true
      }
      // A concurrent validator may have invalidated this same lease while
      // this one awaited the database. Success cannot erase that decision.
      if (invalid) throw new AuthorityChangedError(operationMayHaveExecuted)
    },
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
  return lease
}

export type SessionAuthoritySnapshot = Pick<Session,
  'id' | 'assistantId' | 'userId' | 'contextGroupId' | 'contextProjectId' | 'contextLockedAt'
> & Partial<Pick<Session, 'visibility' | 'mode' | 'effectiveClearance' | 'contextCompartments'>>

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
  credentialCurrent?: () => Promise<boolean>
  /** Re-resolve a recipient/surface ceiling at every authority boundary. */
  maximumAccessCurrent?: () => Promise<AccessCeiling | null>
}): AuthorityLease {
  const sourceRead = { visibility: input.session.visibility, mode: input.session.mode,
    effectiveClearance: input.session.effectiveClearance,
    contextCompartments: input.session.contextCompartments ? [...input.session.contextCompartments] : undefined }
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
  const lease = createAuthorityLease(input.starting, async () => {
    const [session, assistant, credentialCurrent] = await Promise.all([
      findSessionAuthorityById(expected.id),
      findAssistantById(expected.executingAssistantId),
      input.credentialCurrent?.() ?? Promise.resolve(true),
    ])
    if (!session || !assistant || !credentialCurrent) return null
    const currentLock = session.contextLockedAt?.toISOString() ?? null
    if (
      session.assistantId !== expected.assistantId
      || session.userId !== expected.userId
      || session.contextGroupId !== expected.contextGroupId
      || session.contextProjectId !== expected.contextProjectId
      || !contextLockCurrent(expected.contextLockedAt, currentLock)
      || (assistant.workspaceId ?? '') !== expected.workspaceId
    ) return null
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
    })
    if (!input.maximumAccessCurrent) return current
    const maximum = await input.maximumAccessCurrent()
    return maximum
      ? intersectAccessCeilings(current, { ...maximum, userId: current.userId })
      : null
  })
  const invocation = lease.snapshotSource!()
  lease.snapshotSource = () => {
    if (!input.durableSessionSource || expected.contextLockedAt === null || input.credentialCurrent || input.maximumAccessCurrent) return { ...invocation }
    const snapshot = AuthoritySourceSchema.safeParse({ version: 1, kind: 'session', invocationId: invocation.invocationId, ...expected,
      contextLockedAt: expected.contextLockedAt, memberMode: input.memberMode ?? 'enforce',
      ignoreSessionBinding: input.ignoreSessionBinding ?? false, systemRead: input.systemRead ?? false,
      ...sourceRead })
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

function uncertainLeaseOperation(lease: AuthorityLease): AuthorityChangedError {
  lease.markOperationMayHaveExecuted()
  return new AuthorityChangedError(true)
}

export function isAuthorityChangedError(error: unknown): error is AuthorityChangedError {
  return typeof error === 'object' && error !== null
    && (error as { reason?: unknown }).reason === 'authority_changed'
}
