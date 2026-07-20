/**
 * Post-user-turn nag-resolution hook.
 *
 * Bridges the user-facing session and the cron session for jobs with
 * `nagIntervalMins` configured. The cron executor opens
 * `state_json.activeNag` at fire time AND advances `next_run_at` by
 * `nagIntervalMins` (post nag-chain collapse, the parent re-fires itself
 * runtime-only — no per-tick `once` rows). This helper closes the cycle
 * when the user's reply matches the job's `nagUntilKeyword`: it clears
 * `activeNag` and also rewinds the parent's `next_run_at` back to the
 * normal schedule cadence via `computeNextRun(schedule, timezone)`.
 *
 * Without the rewind, the parent's `next_run_at` would still be the most
 * recent `now + nagIntervalMins * 60_000` set by the executor and the
 * parent would re-fire on that interval forever — even after resolution.
 *
 * Called from each chat route's post-user-turn seam (right after the
 * user message has been persisted and before the model is invoked).
 *
 * See docs/architecture/engine/scheduled-jobs.md → "Active-nag lifecycle".
 *
 * Component tag: [COMP:api/scheduling-nag-resolver].
 */

import type { JobStore, ScheduledJob } from '@use-brian/core'
import { computeNextRun } from '@use-brian/core'

export type NagResolutionResult = {
  /** Number of activeNag rows cleared by this call. */
  resolved: number
  /** IDs of the jobs whose nag was cleared. */
  jobIds: string[]
}

/**
 * Detect "done" (or whatever each active job has set as `nagUntilKeyword`)
 * in the user's message. For every match, clear the job's `activeNag`
 * state and rewind the parent's `next_run_at` back to the normal schedule
 * cadence (post nag-chain collapse — see the file header).
 *
 * Returns the count and ids resolved so callers can log analytics.
 */
export async function detectAndResolveNags(params: {
  userId: string
  userMessage: string
  jobStore: JobStore
}): Promise<NagResolutionResult> {
  const { userId, userMessage, jobStore } = params

  // Cheap early exit — most user messages don't match any nag keyword.
  // The partial index keeps `listActiveNagsForUser` near-zero cost when
  // there are no active nags, but we still avoid the round trip when the
  // message obviously has no resolution intent.
  const trimmed = userMessage.trim()
  if (trimmed.length === 0) {
    return { resolved: 0, jobIds: [] }
  }

  const activeJobs = await jobStore.listActiveNagsForUser(userId)
  if (activeJobs.length === 0) {
    return { resolved: 0, jobIds: [] }
  }

  const lower = trimmed.toLowerCase()
  const resolved: ScheduledJob[] = []

  for (const job of activeJobs) {
    if (!job.nagUntilKeyword) continue
    if (lower.includes(job.nagUntilKeyword.toLowerCase())) {
      resolved.push(job)
    }
  }

  if (resolved.length === 0) {
    return { resolved: 0, jobIds: [] }
  }

  for (const job of resolved) {
    // Clear activeNag.
    await jobStore.setState(job.id, {})

    // Rewind the parent's `next_run_at` to the normal schedule. Without
    // this, the executor's most recent `now + nagIntervalMins * 60_000`
    // override stays on the row and the parent re-fires on that interval
    // forever (re-opening activeNag and looping). The same-day `once`
    // follow-up row cancel UPDATE we used to issue here is gone with the
    // collapsed-chain model — there are no follow-up rows to cancel.
    const nextRunAt = computeNextRun(job.schedule, job.timezone)
    await jobStore.update(job.id, { nextRunAt })
  }

  return {
    resolved: resolved.length,
    jobIds: resolved.map((j) => j.id),
  }
}
