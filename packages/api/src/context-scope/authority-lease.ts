import { AsyncLocalStorage } from 'node:async_hooks'
import { accessCeilingContains, intersectAccessCeilings, type AccessCeiling } from '@use-brian/core'

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

type AuthorityLease = { assertCurrent(): Promise<void>; markOperationMayHaveExecuted(): void }
const leases = new AsyncLocalStorage<readonly AuthorityLease[]>()

/** No TTL: each boundary observes live membership/grants, including timed expiry. */
export function createAuthorityLease(
  starting: AccessCeiling,
  resolveCurrent: () => Promise<AccessCeiling | null>,
): AuthorityLease {
  const pinned = intersectAccessCeilings(starting, starting)
  let invalid = false
  let operationMayHaveExecuted = false
  return {
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
  }
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
