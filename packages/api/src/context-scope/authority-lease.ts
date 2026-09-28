import { AsyncLocalStorage } from 'node:async_hooks'
import {
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
  const pinned = intersectAccessCeilings(starting, starting)
  let invalid = false
  let operationMayHaveExecuted = false
  const lease: AuthorityLease = {
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
>

/** Build the live lease used by web, public/API and messaging turns. */
export function createSessionAuthorityLease(input: {
  starting: AccessCeiling
  session: SessionAuthoritySnapshot
  /** Current caller; differs from the session starter in shared rooms. */
  userId?: string
  memberMode?: 'enforce' | 'assistant'
  systemRead?: boolean
  credentialCurrent?: () => Promise<boolean>
}): AuthorityLease {
  const expected = {
    id: input.session.id,
    assistantId: input.session.assistantId,
    userId: input.session.userId,
    authorityUserId: input.userId ?? input.session.userId,
    contextGroupId: input.session.contextGroupId,
    contextProjectId: input.session.contextProjectId,
    contextLockedAt: input.session.contextLockedAt?.toISOString() ?? null,
    workspaceId: input.starting.workspaceId,
  }
  return createAuthorityLease(input.starting, async () => {
    const [session, assistant, credentialCurrent] = await Promise.all([
      findSessionAuthorityById(expected.id),
      findAssistantById(expected.assistantId),
      input.credentialCurrent?.() ?? Promise.resolve(true),
    ])
    if (!session || !assistant || !credentialCurrent) return null
    if (
      session.assistantId !== expected.assistantId
      || session.userId !== expected.userId
      || session.contextGroupId !== expected.contextGroupId
      || session.contextProjectId !== expected.contextProjectId
      || (session.contextLockedAt?.toISOString() ?? null) !== expected.contextLockedAt
      || (assistant.workspaceId ?? '') !== expected.workspaceId
    ) return null
    return resolveLiveAccessCeilingSystem({
      userId: expected.authorityUserId,
      assistant,
      workspaceId: assistant.workspaceId,
      session,
      memberMode: input.memberMode,
      systemRead: input.systemRead,
    })
  })
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
