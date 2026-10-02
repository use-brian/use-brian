import { AsyncLocalStorage } from 'node:async_hooks'
// Consumer metadata reads reuse the claimant transaction (including max=1).
export const programmaticIntakeClient = new AsyncLocalStorage<{
  query<R extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>
}>()

/** Exact rows claimed by this worker transaction, not a caller-supplied sourceRef. */
export const programmaticIntakeClaims = new AsyncLocalStorage<ReadonlySet<string>>()
