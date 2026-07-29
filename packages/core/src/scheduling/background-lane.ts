/**
 * Background-lane admission semaphore.
 *
 * The workers service runs ~19 tick loops in one process against a pool capped
 * at `PG_POOL_MAX` connections. Jitter (see `jitter.ts`) spreads their *first*
 * tick, but says nothing about steady state: once several loops are slow enough
 * to overlap, they all check out at once and the pool's queue is the only thing
 * between them and the fleet's slot budget.
 *
 * This bounds how many background ticks may be *in flight* at all. B3 of
 * docs/plans/corpus-substrate-hardening.md §4, the companion to lowering the
 * workers pool cap from 3 to 2: give the background lane less, not more.
 *
 * **Queuing here is the point.** Overflow inside the lane waits; overflow at
 * the Postgres server is rejected and surfaces as user-facing 500s. Background
 * work has nobody waiting on it, so trading its latency for the fleet's
 * error budget is the whole trade. Nothing is dropped — a waiter runs as soon
 * as a slot frees.
 *
 * **Not re-entrant.** A task already running in the lane must not call
 * `runInBackgroundLane` again: with `limit` small, a nested acquire waits on a
 * slot its own caller is holding. The lane is applied at the outermost tick
 * drivers only (`startJitteredInterval`, the poll/batch worker, the embedding
 * worker) precisely so no such nesting exists.
 *
 * Spec: docs/architecture/platform/deployment.md → "Background lane admission".
 */

/**
 * Concurrent background ticks allowed. Matches the workers service's per-pool
 * cap (`PG_POOL_MAX=2`): the point is that the loops cannot collectively demand
 * more connections than the pool can serve without queueing at the server.
 */
export const DEFAULT_BACKGROUND_LANE_CONCURRENCY = 2

export function resolveBackgroundLaneConcurrency(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim()
  if (!/^\d+$/.test(trimmed)) return DEFAULT_BACKGROUND_LANE_CONCURRENCY
  const n = Number(trimmed)
  // 0 would wedge every background loop forever, which is a far worse failure
  // than an unbounded lane. Treat it as "unset".
  return n > 0 ? n : DEFAULT_BACKGROUND_LANE_CONCURRENCY
}

let limit = resolveBackgroundLaneConcurrency(process.env.BACKGROUND_LANE_CONCURRENCY)
let inFlight = 0
const waiters: Array<() => void> = []

/** Observability + tests. `queued` is the number of ticks waiting for a slot. */
export function backgroundLaneStats(): { limit: number; inFlight: number; queued: number } {
  return { limit, inFlight, queued: waiters.length }
}

/**
 * Test seam. Resets the lane and optionally re-sizes it — the module reads its
 * limit from the environment once at import, which a test cannot restage.
 */
export function configureBackgroundLane(next?: { limit?: number }): void {
  if (next?.limit !== undefined && next.limit > 0) limit = next.limit
  inFlight = 0
  waiters.length = 0
}

/**
 * Free a slot — by HANDING it to the next waiter rather than decrementing and
 * letting it re-acquire. The decrement-then-wake shape has a real hole: the
 * woken waiter resumes on a later microtask, so a caller arriving in between
 * sees the freed slot, takes it, and the lane runs `limit + 1` tasks.
 */
function release(): void {
  const next = waiters.shift()
  if (next) {
    next()
    return
  }
  inFlight -= 1
}

/**
 * Run `fn` once a lane slot is free. FIFO, so a loop that waited longest goes
 * first and no loop can starve behind a busier one.
 */
export async function runInBackgroundLane<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= limit) {
    // The slot is transferred by `release`, so `inFlight` is already ours.
    await new Promise<void>((resolve) => waiters.push(resolve))
  } else {
    inFlight += 1
  }
  try {
    return await fn()
  } finally {
    release()
  }
}
