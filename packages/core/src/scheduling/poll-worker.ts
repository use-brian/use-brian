/**
 * Poll worker: runs every 60s, executes due scheduled jobs.
 *
 * Dual-session architecture:
 * - Cron job runs in dedicated session (has history across runs)
 * - Results delivered to user's channel session
 */

import type { BatchStore, JobStore, PendingBatch, ScheduledJob } from './types.js'
import { computeNextRun } from './schedule.js'

export type JobExecutor = (job: ScheduledJob) => Promise<string>

/**
 * Path B durable chat resume handler (Q22 RESOLVED). Invoked by the poll
 * worker when a due job carries `state.triggerKind === 'session_resume'`,
 * which the approval resolution endpoint sets when the in-memory promise
 * registry has no entry for the approval (i.e. the chat process restarted
 * between suspension and approval response). The handler is responsible
 * for: looking up the suspended state in `session_resume_points`, the
 * resolved `pending_approvals` row, replaying the suspended tool with the
 * approved input (or synthesizing a rejection result), re-entering the
 * query loop with the resulting tool result message, and deleting the
 * resume point on success.
 *
 * Injection is optional: when `resumeHandler` is not provided, jobs whose
 * payload requests a session resume are logged and treated as failures
 * (no executor fallback — running them through the normal scheduled-job
 * executor would mis-fire as a fresh user channel turn). This keeps the
 * new branch additive and safe for environments that haven't wired the
 * chat-side dependencies yet.
 *
 * See docs/plans/company-brain/approvals.md → "Chat resume — Path B" and
 * migration 124 + packages/api/src/db/session-resume-store.ts.
 */
export type SessionResumeHandler = (job: ScheduledJob) => Promise<void>

/**
 * Fired when a recurring job is auto-disabled after
 * `maxConsecutiveFailures` consecutive executor throws. Best-effort —
 * the worker swallows callback errors so a notification/analytics failure
 * never blocks the disable. The API wiring uses this to emit a
 * `scheduled_job.auto_disabled` analytics event and (optionally) surface
 * the dead job to its owner. Absent = disable silently (still logged).
 */
type JobAutoDisabledHandler = (
  job: ScheduledJob,
  failureCount: number,
) => Promise<void> | void

/**
 * Default consecutive-failure ceiling. Ten gives transient provider 429s /
 * 5xxs and brief outages room to self-heal (one success resets the streak),
 * while bounding a permanently-broken config to ~10 fires instead of the
 * unbounded retry that let the moat workflow fail 162 times (2026-06).
 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10

export type PollWorkerOptions = {
  store: JobStore
  executor: JobExecutor
  /**
   * Optional dispatch for `state.triggerKind === 'session_resume'` jobs.
   * When absent, such jobs are marked failed (and disabled if one-time)
   * rather than handed to the standard executor. See `SessionResumeHandler`.
   */
  resumeHandler?: SessionResumeHandler
  /**
   * Auto-disable a recurring job after this many consecutive executor
   * failures (default `DEFAULT_MAX_CONSECUTIVE_FAILURES`). Pass `Infinity`
   * to restore the legacy retry-forever behavior. One-time jobs already
   * disable on their first fire and ignore this.
   */
  maxConsecutiveFailures?: number
  /** Optional hook fired once when a job is auto-disabled. */
  onJobAutoDisabled?: JobAutoDisabledHandler
  intervalMs?: number
}

/**
 * Returns true when the job is a Path B durable chat resume trigger.
 * Exported so the executor wiring layer can short-circuit log-and-skip
 * paths consistently when the resume handler is intentionally unwired
 * (e.g. tests that exercise only the standard executor).
 */
export function isSessionResumeJob(job: ScheduledJob): boolean {
  return job.state?.triggerKind === 'session_resume'
}

const DEFAULT_POLL_INTERVAL = 60_000 // 1 minute

/**
 * Clear a recurring job's failure streak after a success. No-op (and no
 * write) when there was no streak — the common case — so steady-state
 * success traffic adds zero extra writes. When a streak exists, re-read the
 * row so the `setState` blob-replace preserves any `activeNag` the executor
 * wrote during this fire.
 */
async function resetFailureStreak(store: JobStore, job: ScheduledJob): Promise<void> {
  if ((job.state.consecutiveFailures ?? 0) === 0) return
  const fresh = (await store.get(job.id)) ?? job
  const { consecutiveFailures: _drop, ...rest } = fresh.state
  await store.setState(job.id, rest)
}

/**
 * Increment a recurring job's failure streak and return the new count.
 * Re-reads the row first so a concurrent `activeNag` write from the failing
 * fire survives the blob-replace.
 */
async function bumpFailureStreak(store: JobStore, job: ScheduledJob): Promise<number> {
  const fresh = (await store.get(job.id)) ?? job
  const next = (fresh.state.consecutiveFailures ?? 0) + 1
  await store.setState(job.id, { ...fresh.state, consecutiveFailures: next })
  return next
}

export function createPollWorker(options: PollWorkerOptions) {
  const {
    store,
    executor,
    resumeHandler,
    maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
    onJobAutoDisabled,
    intervalMs = DEFAULT_POLL_INTERVAL,
  } = options
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function tick() {
    if (running) return // skip if previous tick still executing
    running = true

    try {
      const dueJobs = await store.getDueJobs()

      for (const job of dueJobs) {
        // Path B durable chat resume — dispatch to `resumeHandler` instead
        // of the standard executor. Resume jobs are always treated as
        // one-time: they disable on completion regardless of `schedule`
        // (the resolution endpoint enqueues with `schedule.type='once'`,
        // but defensive against malformed payloads). When the handler is
        // unwired we mark the job failed rather than fall through to the
        // standard executor, which would mis-fire as a fresh user-channel
        // turn carrying the resume sentinel as `instructions`.
        if (isSessionResumeJob(job)) {
          if (!resumeHandler) {
            await store.update(job.id, { enabled: false })
            await store.markFailed(job.id, new Date(0))
            console.error(
              `[scheduler] Session resume job ${job.id} skipped: no resumeHandler wired.`,
            )
            continue
          }
          try {
            await resumeHandler(job)
            await store.update(job.id, { enabled: false })
            await store.markCompleted(job.id, new Date(0))
            console.debug(`[scheduler] Session resume job ${job.id} completed and disabled.`)
          } catch (err) {
            await store.update(job.id, { enabled: false })
            await store.markFailed(job.id, new Date(0))
            console.error(`[scheduler] Session resume job ${job.id} failed:`, err)
          }
          continue
        }

        try {
          const result = await executor(job)
          if (job.schedule.type === 'once') {
            // One-time jobs: disable after execution, keep for history
            await store.update(job.id, { enabled: false })
            await store.markCompleted(job.id, new Date(0))
            console.debug(`[scheduler] One-time job ${job.id} completed and disabled.`)
          } else {
            // A success clears any failure streak so an intermittent error
            // never accumulates toward the auto-disable ceiling. Re-read the
            // row first: the executor may have written `state_json`
            // (`activeNag`) during this fire, and `setState` replaces the
            // whole blob — merging onto stale in-memory state would clobber
            // that write.
            await resetFailureStreak(store, job)
            const nextRunAt = computeNextRun(job.schedule, job.timezone)
            await store.markCompleted(job.id, nextRunAt)
            console.debug(`[scheduler] Job ${job.id} completed. Next run: ${nextRunAt.toISOString()}`)
          }
        } catch (err) {
          if (job.schedule.type === 'once') {
            await store.update(job.id, { enabled: false })
            await store.markFailed(job.id, new Date(0))
            console.error(`[scheduler] One-time job ${job.id} failed and disabled:`, err)
          } else {
            // Recurring failure: bump the consecutive-failure counter and,
            // once it reaches the ceiling, disable the job instead of
            // re-arming it forever (the moat-workflow runaway, 2026-06).
            const failures = await bumpFailureStreak(store, job)
            if (failures >= maxConsecutiveFailures) {
              await store.update(job.id, { enabled: false })
              if (onJobAutoDisabled) {
                try {
                  await onJobAutoDisabled(job, failures)
                } catch (cbErr) {
                  console.warn(`[scheduler] onJobAutoDisabled threw for ${job.id}:`, cbErr)
                }
              }
              await store.markFailed(job.id, new Date(0))
              console.error(
                `[scheduler] Job ${job.id} auto-disabled after ${failures} consecutive failures:`,
                err,
              )
            } else {
              const nextRunAt = computeNextRun(job.schedule, job.timezone)
              await store.markFailed(job.id, nextRunAt)
              console.error(
                `[scheduler] Job ${job.id} failed (${failures}/${maxConsecutiveFailures}):`,
                err,
              )
            }
          }
        }
      }
    } catch (err) {
      console.error('[scheduler] Poll error:', err)
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      console.log(`[scheduler] Poll worker started (interval: ${intervalMs}ms)`)
      timer = setInterval(tick, intervalMs)
      // Run immediately on start
      tick()
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
        console.log('[scheduler] Poll worker stopped')
      }
    },

    get isRunning() {
      return timer !== undefined
    },
  }
}

/**
 * Batch worker (company-brain WU-3.8): drains `pending_ingest_batches`
 * rows whose `fires_at` has elapsed and hands each one to `processBatch`.
 *
 * Mirrors the lifecycle of `createPollWorker`: same default 60s interval,
 * same `running` re-entry guard, same `start()`/`stop()`/`isRunning`
 * contract. Kept as a sibling factory (rather than folded into
 * `createPollWorker`) so the two queues stay independently startable
 * and the scheduled-jobs path is undisturbed.
 *
 * Failure semantics: a failed `processBatch` leaves `processed_at = NULL`,
 * so the row stays in the index and is retried on the next tick. The
 * spec (`docs/plans/company-brain/ingest.md` → "Engine components /
 * Batch worker") does not call for a retry budget yet — a wedged batch
 * surfaces as repeated 60s-cadence error logs.
 *
 * The downstream wiring (aggregator + Pipeline B) is composed by the
 * caller in `processBatch`. Until WU-3.6/WU-3.7 land, callers pass a
 * placeholder.
 */
export type BatchProcessor = (batch: PendingBatch) => Promise<void>

export type BatchWorkerOptions = {
  store: BatchStore
  processBatch: BatchProcessor
  intervalMs?: number
  /** Spec default of 100 rows per drain pass. */
  batchLimit?: number
}

export function createBatchWorker(options: BatchWorkerOptions) {
  const {
    store,
    processBatch,
    intervalMs = DEFAULT_POLL_INTERVAL,
    batchLimit = 100,
  } = options
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function tick() {
    if (running) return
    running = true

    try {
      await store.withClaimedBatches(batchLimit, async (batches, markProcessed) => {
        for (const batch of batches) {
          try {
            await processBatch(batch)
            await markProcessed(batch.id)
          } catch (err) {
            // Leave processed_at NULL → retried next tick. Log loudly so a
            // wedged batch is visible at 60s cadence.
            console.error(`[ingest-batch-worker] batch ${batch.id} failed:`, err)
          }
        }
      })
    } catch (err) {
      console.error('[ingest-batch-worker] poll error:', err)
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      console.log(`[ingest-batch-worker] started (interval: ${intervalMs}ms)`)
      timer = setInterval(tick, intervalMs)
      tick()
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
        console.log('[ingest-batch-worker] stopped')
      }
    },

    get isRunning() {
      return timer !== undefined
    },
  }
}
