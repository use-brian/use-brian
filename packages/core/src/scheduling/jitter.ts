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
 * Steady-state behaviour is identical to `setInterval` — only the
 * phase changes.
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

export type JitteredIntervalHandle = {
  /** Internal — opaque. Treat as a token; do not introspect. */
  _initialTimeout: ReturnType<typeof setTimeout> | null
  _interval: ReturnType<typeof setInterval> | null
  _stopped: boolean
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
    void Promise.resolve()
      .then(() => fn())
      .catch(() => {
        /* per-tick errors are the worker's responsibility */
      })
    if (!handle._stopped) {
      handle._interval = setInterval(() => {
        void Promise.resolve()
          .then(() => fn())
          .catch(() => {})
      }, intervalMs)
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
