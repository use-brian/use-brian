/**
 * Trigger-orchestration layer for scheduled jobs.
 *
 * Post Phase-2 cutover (scheduling <-> workflow unification) every scheduled
 * job is workflow-backed. The 60s poll worker hands each due job here; this
 * thin runner owns the nag lifecycle — opening / rolling `activeNag` on the
 * parent row — then delegates execution to `runWorkflowFromJob`
 * (-> advanceWorkflowRun).
 *
 * Post nag-chain collapse (2026-05) the chain is implemented as a single
 * recurring parent row whose `next_run_at` advances by `nagIntervalMins`
 * while `activeNag` is open. No `once` follow-up rows are created per tick
 * — see docs/architecture/engine/scheduled-jobs.md → "Active-nag lifecycle"
 * for the runtime-only state model.
 *
 * The legacy single-assistant cron/delivery dual-session executor was
 * deleted at the cutover: delivery is now the workflow `assistant_call`
 * step's `deliver` field, and the persistent workflow session replaces the
 * per-job cron session. Deferred tool confirmations and proactive
 * compaction moved to the callee executor (packages/api/src/inter-assistant).
 *
 * See docs/architecture/engine/scheduled-jobs.md → "Unified execution model"
 * and the "The poll worker" section's executor description.
 * Component tag: [COMP:scheduling/trigger-orchestration].
 */

import type { ScheduledJob, JobExecutor, JobStore, AnalyticsLogger } from '@sidanclaw/core'
import { sanitize as sanitizeAnalytics } from '@sidanclaw/core'

export type JobExecutorOptions = {
  /** Trigger-row store — nag state, parent lookups. */
  jobStore: JobStore
  /** Optional analytics — `scheduled_job.*` lifecycle events. */
  analytics?: AnalyticsLogger
  /**
   * Delegate that advances the job's workflow. Required post-cutover —
   * every job carries a `workflow_id`. Handles both the scheduled-trigger
   * case (workflowId only -> fresh `workflow_runs` row) and the wait
   * wake-up case (workflowId + workflowStepRunId -> resume the paused run).
   */
  runWorkflowFromJob: (job: ScheduledJob) => Promise<string>
}

/**
 * Build a `JobExecutor` for the poll worker. The returned function never
 * delivers to a channel itself — it orchestrates nag state and hands the
 * job to the workflow path.
 */
export function createJobExecutor(options: JobExecutorOptions): JobExecutor {
  const { jobStore, analytics, runWorkflowFromJob } = options

  return async function executeJob(job: ScheduledJob): Promise<string> {
    const startedAt = Date.now()

    // ── Nag-loop state: open or roll the activeNag cycle ────────────
    //
    // For a job with `nagIntervalMins` (the parent of a nag chain) we keep
    // `state.activeNag` so the chat-route post-user-turn hook can clear it
    // on the user's `nagUntilKeyword` reply.
    //
    // Single-fire jobs (no `nagIntervalMins`) skip all of this.
    //
    // We previously gated the setState on `existingNag.cycleDate !==
    // todayCycleDate` — a "smart" skip when nothing changed. In prod (job
    // 43b08893 post-migration-159) the parent fired daily but `activeNag`
    // stayed pinned to yesterday's cycleDate, so the gate never flagged
    // yesterday's chain stale. Root cause of the skip is still under
    // investigation (the if-branch should have fired; it didn't).
    // Removing the guard makes the cycleDate roll an invariant of every
    // parent fire — one extra UPDATE per nag-parent per day, in exchange
    // for the entire class of "stale-state survives a fire" bugs going
    // away.
    //
    // Decision (2026-05 nag-chain collapse): when `nagIntervalMins != null`
    // we ALSO advance the parent's own `next_run_at` here to
    // `now + nagIntervalMins * 60_000`. This replaces the per-tick `once`
    // follow-up row pattern with a runtime-only state model: the same
    // recurring row re-fires every `nagIntervalMins` while the cycle is
    // open. The poll worker's `markCompleted` is taught to preserve the
    // override when `state.activeNag` is set (see job-store.markCompleted).
    // The chat-route nag-resolver clears the override + activeNag when the
    // user replies, returning the row to its normal schedule cadence.
    if (job.nagIntervalMins != null) {
      const todayCycleDate = formatCycleDate(new Date(), job.timezone)
      await jobStore.setState(job.id, {
        activeNag: {
          openedAt: new Date().toISOString(),
          cycleDate: todayCycleDate,
        },
      })

      // Re-fire at +nagIntervalMins (runtime-only "next nag" advancement).
      // We write this on the parent itself; `markCompleted` later detects
      // the open activeNag and preserves this value instead of overwriting
      // with `computeNextRun(schedule, timezone)`.
      const nagNextRunAt = new Date(Date.now() + job.nagIntervalMins * 60 * 1000)
      await jobStore.update(job.id, { nextRunAt: nagNextRunAt })
    }

    // ── Delegate execution to the workflow path ─────────────────────
    analytics?.logEvent({
      userId: job.userId,
      assistantId: job.assistantId,
      channelType: job.channelType,
      eventName: 'scheduled_job.started',
      metadata: {
        schedule_type: sanitizeAnalytics(job.schedule.type),
        mode: sanitizeAnalytics(job.mode),
      },
    })

    if (!job.workflowId) {
      // Post-cutover invariant: every scheduled_jobs row carries a
      // workflow_id (migration 159 + the rewritten cron tools). A row
      // without one is a hand-edited / pre-migration straggler — fail it
      // loudly rather than mis-firing a fresh user-channel turn.
      const msg = `Job ${job.id} has no workflow_id — post-cutover invariant violation`
      console.error(`[scheduler] ${msg}`)
      analytics?.logEvent({
        userId: job.userId,
        assistantId: job.assistantId,
        channelType: job.channelType,
        eventName: 'scheduled_job.failed',
        metadata: {
          error_message: sanitizeAnalytics('missing workflow_id'),
          duration_ms: Date.now() - startedAt,
        },
      })
      return msg
    }

    try {
      const outcome = await runWorkflowFromJob(job)
      analytics?.logEvent({
        userId: job.userId,
        assistantId: job.assistantId,
        channelType: job.channelType,
        eventName: 'scheduled_job.completed',
        metadata: { duration_ms: Date.now() - startedAt },
      })
      return outcome
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[scheduler] workflow advancement failed (job ${job.id}):`, err)
      analytics?.logEvent({
        userId: job.userId,
        assistantId: job.assistantId,
        channelType: job.channelType,
        eventName: 'scheduled_job.failed',
        metadata: {
          error_message: sanitizeAnalytics(errMsg.slice(0, 200)),
          duration_ms: Date.now() - startedAt,
        },
      })
      // Re-throw so the poll worker marks the job failed and computes the
      // next run (recurring) or disables it (one-time).
      throw err
    }
  }
}

/**
 * Format a cycle date as YYYY-MM-DD in the job's timezone. Used as the
 * `activeNag.cycleDate` key — the chat-route hook compares against this to
 * decide whether the user's "done" reply belongs to today's cycle.
 */
function formatCycleDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970'
  const month = parts.find((p) => p.type === 'month')?.value ?? '01'
  const day = parts.find((p) => p.type === 'day')?.value ?? '01'
  return `${year}-${month}-${day}`
}
