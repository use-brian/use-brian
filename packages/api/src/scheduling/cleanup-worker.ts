/**
 * Scheduled-jobs cleanup worker.
 *
 * Post nag-chain collapse (2026-05) `scheduled_jobs` is the control
 * plane for actively-firing schedules — not a history table. One-shot
 * trigger rows now delete on completion (`markCompleted`'s reap path)
 * and disabled rows are GC'd nightly here. The audit trail of what
 * those rows used to do lives in `workflow_runs` + `analytics_events`;
 * a disabled trigger row carries no information past the disable.
 *
 * Mirrors `views-prune-worker` in shape: single SQL statement, daily
 * tick, re-entry guard, never throws past the catch.
 *
 * Component tag: [COMP:scheduling/cleanup-worker].
 * Doc: docs/architecture/engine/scheduled-jobs.md → "Control plane vs
 * history plane".
 */

import type { JobStore } from '@sidanclaw/core'

/** Default tick cadence. Daily — rows have a 30-day TTL after disable. */
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Disabled rows older than this are reaped on each tick. */
export const DISABLED_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type CleanupWorkerDeps = {
  /** Trigger-row store. Production wires `createDbJobStore()`. */
  jobStore: JobStore
  /** Test-only error hook. Defaults to `console.error`. */
  onError?: (err: unknown) => void
}

export type CleanupWorkerOptions = CleanupWorkerDeps & {
  /** Tick cadence. Default `DEFAULT_INTERVAL_MS` (24h). */
  intervalMs?: number
  /** If true, runs an immediate tick on `start()`. Production: yes; tests: false. */
  runImmediately?: boolean
}

export function createCleanupWorker(options: CleanupWorkerOptions) {
  const jobStore = options.jobStore
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const runImmediately = options.runImmediately ?? true
  const onError = options.onError ?? ((err) => console.error('[cleanup-worker] tick failed:', err))

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const cutoff = new Date(Date.now() - DISABLED_TTL_MS)
      const purged = await jobStore.purgeDisabledOlderThan(cutoff)
      console.log(`[cleanup-worker] purged ${purged} disabled scheduled_jobs rows`)
    } catch (err) {
      // A single tick failure must not crash the host process.
      onError(err)
    } finally {
      running = false
    }
  }

  return {
    /** Run one tick immediately. Exposed for tests and operator triggers. */
    tick,
    start() {
      if (timer) return
      console.log(`[cleanup-worker] worker started (interval: ${intervalMs}ms)`)
      timer = setInterval(() => { void tick() }, intervalMs)
      if (runImmediately) void tick()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
        console.log('[cleanup-worker] worker stopped')
      }
    },
    get isRunning() {
      return timer !== undefined
    },
  }
}
