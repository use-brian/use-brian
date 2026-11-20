/**
 * Optional evidence lane: optional decoration yields to foreground admission.
 * [COMP:api/optional-evidence-lane]
 *
 * Session list titles are optional list decoration (session-messages.md,
 * "Auto-Titling"), but each one is admitted fresh through the complete
 * caller/audience validator inside a non-owner transaction that holds the
 * workspace row `FOR SHARE` (and, for Page-derived closures, Page authority
 * table locks). A title whose closure the native capture does not cover takes
 * the generic validator, which costs seconds. Unbounded, several of those
 * transactions overlap, so a `FOR NO KEY UPDATE` on the workspace row (turn
 * transition, session-create admission) never finds a gap and fails with
 * 57014, and the optional work holds every app-pool connection.
 *
 * This lane bounds that work without caching any authorization:
 *
 * - Marking. `runOptionalEvidence` marks an async call tree as optional. Outside
 *   it every function here is a no-op that sends no SQL, so foreground
 *   validation, publication and the fixed-workload statement counts are
 *   unchanged.
 * - One owner. At most one optional generic validation runs per installation
 *   (process). Another one waits for the slot, and while it waits it keeps
 *   checking the yield conditions below; it never waits past `waitMs`.
 * - Yield. At validator entry, while waiting and between its heavy phases, an
 *   optional validation defers when its request was aborted, when the
 *   installation backoff window is open, when the app pool has queued
 *   checkouts (someone needs the connection it holds), or when its own
 *   transaction is blocking another backend (`pg_blocking_pids`). A deferral
 *   throws `OptionalEvidenceDeferred` (code `55P03`, the existing optional-title
 *   timeout contract) so the caller withholds the optional bytes; the
 *   transaction rolls back and releases its locks.
 * - Backoff. A deferral opens an installation-wide window (1 s, doubling to
 *   30 s) during which optional generic validations defer at entry. A completed
 *   optional validation resets it.
 *
 * A deferral never admits or refuses a source; it withholds optional output.
 * Spec: docs/architecture/context-engine/scoped-context.md, "Optional evidence
 * yields to foreground admission".
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { PoolClient } from 'pg'
import { getAppPool } from '../db/client.js'

/** SQLSTATE-shaped code shared with the optional-title timeout contract. */
export const OPTIONAL_EVIDENCE_DEFERRED_CODE = '55P03'
export const OPTIONAL_EVIDENCE_BACKOFF_MIN_MS = 1_000
export const OPTIONAL_EVIDENCE_BACKOFF_MAX_MS = 30_000
export const OPTIONAL_EVIDENCE_WAIT_MS = 10_000
const POLL_MS = 100
const BLOCKING_POLL_MS = 500

export type OptionalEvidenceDeferral = 'aborted' | 'backoff' | 'pool_waiters' | 'blocking_foreground' | 'slot_wait'

/** Optional output is withheld; nothing was admitted or refused. */
export class OptionalEvidenceDeferred extends Error {
  readonly code = OPTIONAL_EVIDENCE_DEFERRED_CODE
  readonly reason = 'optional_evidence_deferred' as const
  readonly retrySafe = true as const
  constructor(readonly deferral: OptionalEvidenceDeferral) {
    super('Optional evidence deferred to foreground work.')
  }
}

type LaneContext = { readonly signal?: AbortSignal; readonly waitMs: number }
const lane = new AsyncLocalStorage<LaneContext>()

type Waiter = { wake: () => void }
const state = {
  active: 0,
  waiters: [] as Waiter[],
  backoffUntil: 0,
  backoffMs: 0,
  deferrals: 0,
  completed: 0,
}

/** Run `operation` as optional decoration. Nested calls keep the outer lane. */
export function runOptionalEvidence<T>(options: { signal?: AbortSignal; waitMs?: number }, operation: () => Promise<T>): Promise<T> {
  if (lane.getStore()) return operation()
  return lane.run({ signal: options.signal, waitMs: options.waitMs ?? OPTIONAL_EVIDENCE_WAIT_MS }, operation)
}

/** True only inside `runOptionalEvidence`. */
export function isOptionalEvidence(): boolean {
  return lane.getStore() !== undefined
}

function defer(deferral: OptionalEvidenceDeferral): never {
  state.deferrals++
  // Only foreground pressure opens the window; abort and slot contention are local.
  if (deferral === 'pool_waiters' || deferral === 'blocking_foreground') {
    state.backoffMs = Math.min(OPTIONAL_EVIDENCE_BACKOFF_MAX_MS, state.backoffMs ? state.backoffMs * 2 : OPTIONAL_EVIDENCE_BACKOFF_MIN_MS)
    state.backoffUntil = Date.now() + state.backoffMs
  }
  throw new OptionalEvidenceDeferred(deferral)
}

function poolHasWaiters(): boolean {
  try { return getAppPool().waitingCount > 0 } catch { return false }
}

async function blockingForeground(client: Pick<PoolClient, 'query'>): Promise<boolean> {
  const row = (await client.query<{ blocking: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM pg_locks waiting WHERE NOT waiting.granted
      AND pg_backend_pid()=ANY(pg_blocking_pids(waiting.pid))) AS blocking`)).rows[0]
  return row?.blocking === true
}

async function check(context: LaneContext, client: Pick<PoolClient, 'query'> | undefined, database: boolean): Promise<void> {
  if (context.signal?.aborted) defer('aborted')
  if (Date.now() < state.backoffUntil) defer('backoff')
  if (client && poolHasWaiters()) defer('pool_waiters')
  if (client && database && await blockingForeground(client)) defer('blocking_foreground')
}

/**
 * Yield point between heavy phases. No-op (no SQL) outside the lane. With a
 * client, it also checks whether this transaction blocks another backend.
 */
export async function yieldOptionalEvidence(client?: Pick<PoolClient, 'query'>): Promise<void> {
  const context = lane.getStore()
  if (!context) return
  await check(context, client, true)
}

/**
 * Enter the installation's single optional slot for a heavy validation and
 * return its release. Outside the lane it returns a no-op release without SQL.
 * Waiting keeps yielding: a waiter that holds a transaction defers as soon as
 * it blocks someone or the app pool queues a checkout.
 */
export async function enterOptionalEvidenceSlot(client?: Pick<PoolClient, 'query'>): Promise<(completed: boolean) => void> {
  const context = lane.getStore()
  if (!context) return () => {}
  await check(context, client, true)
  const deadline = Date.now() + context.waitMs
  let lastDatabaseCheck = Date.now()
  while (state.active > 0) {
    if (Date.now() >= deadline) defer('slot_wait')
    await new Promise<void>(resolve => {
      const waiter: Waiter = { wake: () => { clearTimeout(timer); resolve() } }
      const timer = setTimeout(() => { state.waiters = state.waiters.filter(w => w !== waiter); resolve() }, POLL_MS)
      state.waiters.push(waiter)
    })
    const database = Date.now() - lastDatabaseCheck >= BLOCKING_POLL_MS
    if (database) lastDatabaseCheck = Date.now()
    await check(context, client, database)
  }
  state.active++
  let released = false
  return (completed: boolean) => {
    if (released) return
    released = true
    state.active--
    if (completed) { state.completed++; state.backoffMs = 0; state.backoffUntil = 0 }
    state.waiters.shift()?.wake()
  }
}

/** Diagnostics and tests only; never an authorization input. */
export function optionalEvidenceState(): Readonly<{ active: number; waiting: number; backoffUntil: number; deferrals: number; completed: number }> {
  return { active: state.active, waiting: state.waiters.length, backoffUntil: state.backoffUntil, deferrals: state.deferrals, completed: state.completed }
}

/** Tests only. */
export function resetOptionalEvidenceStateForTests(): void {
  state.active = 0; state.waiters = []; state.backoffUntil = 0; state.backoffMs = 0; state.deferrals = 0; state.completed = 0
}
