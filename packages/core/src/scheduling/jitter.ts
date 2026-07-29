/**
 * Jittered `setInterval`: defers the first tick by a random fraction of
 * the interval so independent workers that boot at the same instant
 * (Cloud Run cold start) don't all fire on the same whole-second
 * boundary.
 *
 * Why this exists.  `apps/api/src/index.ts` boots ~19 background workers
 * sequentially at startup, and almost every one of them does
 * `setInterval(tick, INTERVAL_MS)` right after construction. Because
 * Node aligns timers to the event-loop tick they were registered on,
 * those workers end up firing within milliseconds of each other every
 * INTERVAL_MS window — a periodic spike of concurrent DB checkouts that
 * saturates the pg.Pool and triggers Postgres "remaining connection
 * slots are reserved" 500s on whatever HTTP request lands in the same
 * window. We saw this 2026-05-25: 8-10 in-flight user requests + 13
 * worker ticks aligned, all competing for 22 usable Cloud SQL slots.
 *
 * The fix is to spread the first tick over a full interval window.
 * Steady-state behaviour is otherwise identical to `setInterval` — only
 * the phase changes.
 *
 * Jitter only spreads the FIRST tick, though, so it says nothing about
 * steady state: once several loops run long enough to overlap, they
 * check out together again. Every tick is therefore also admitted
 * through the background lane (`background-lane.ts`), and a loop whose
 * previous tick has not settled skips its turn rather than stacking a
 * second one — see the `tick` closure below.
 *
 * Usage:
 *   const timer = startJitteredInterval(tick, 60_000)
 *   // ...
 *   stopJitteredInterval(timer)
 *
 * The handle is opaque; callers should treat it as the moral equivalent
 * of a `NodeJS.Timeout` (clear via `stopJitteredInterval`, ignore the
 * shape).
 *
 * Spec: `docs/architecture/platform/deployment.md` → "Worker tick jitter".
 */

import { runInBackgroundLane } from './background-lane.js'

export type JitteredIntervalHandle = {
  /** Internal — opaque. Treat as a token; do not introspect. */
  _initialTimeout: ReturnType<typeof setTimeout> | null
  _interval: ReturnType<typeof setInterval> | null
  _stopped: boolean
  /** True from the moment a tick asks for a lane slot until it settles. */
  _ticking: boolean
}

/**
 * Like `setInterval(fn, intervalMs)` but delays the first call by a
 * uniformly-random amount in `[0, intervalMs)`. After that first tick,
 * `fn` runs every `intervalMs` exactly as `setInterval` would.
 *
 * `intervalMs` must be > 0. A non-positive interval would collapse the
 * jitter range to 0 and produce identical alignment to the un-jittered
 * version, so it's likely a mistake — we throw instead of silently
 * eating the bug.
 */
export function startJitteredInterval(
  fn: () => void | Promise<void>,
  intervalMs: number,
): JitteredIntervalHandle {
  if (intervalMs <= 0) {
    throw new Error(
      `startJitteredInterval: intervalMs must be > 0 (got ${intervalMs})`,
    )
  }

  const handle: JitteredIntervalHandle = {
    _initialTimeout: null,
    _interval: null,
    _stopped: false,
    _ticking: false,
  }

  /**
   * One tick: admitted through the background lane, and skipped outright when
   * this loop's previous tick has not settled.
   *
   * The re-entry guard is what keeps the lane's queue bounded. Without it, a
   * loop whose tick outlives its interval enqueues a fresh waiter every period
   * and the backlog grows without limit — the failure mode the lane exists to
   * prevent, re-created one level up. With it, each loop contributes at most
   * one waiter, so the queue is bounded by the number of loops.
   */
  const tick = () => {
    if (handle._stopped || handle._ticking) return
    handle._ticking = true
    void runInBackgroundLane(async () => fn())
      .catch(() => {
        /* per-tick errors are the worker's responsibility */
      })
      .finally(() => {
        handle._ticking = false
      })
  }

  // Random offset in [0, intervalMs). The half-open upper bound matters:
  // if N workers each pick a uniform offset over the same interval, the
  // expected pairwise gap is intervalMs/(N+1), which is enough to keep
  // their checkout windows from completely overlapping under normal
  // tick durations (≪ intervalMs).
  const firstDelayMs = Math.floor(Math.random() * intervalMs)

  handle._initialTimeout = setTimeout(() => {
    handle._initialTimeout = null
    if (handle._stopped) return
    // Fire first tick, then enter the steady-state interval. If the
    // first tick throws synchronously we still want subsequent ticks
    // to run — that's how plain setInterval behaves, and the workers'
    // own try/catch should already swallow per-tick errors.
    tick()
    if (!handle._stopped) {
      handle._interval = setInterval(tick, intervalMs)
    }
  }, firstDelayMs)

  return handle
}

/** Idempotent — safe to call multiple times or before the first tick. */
export function stopJitteredInterval(handle: JitteredIntervalHandle): void {
  handle._stopped = true
  if (handle._initialTimeout) {
    clearTimeout(handle._initialTimeout)
    handle._initialTimeout = null
  }
  if (handle._interval) {
    clearInterval(handle._interval)
    handle._interval = null
  }
}
