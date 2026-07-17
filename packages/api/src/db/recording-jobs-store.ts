/**
 * `recording-jobs-store.ts` — the async recording-process queue
 * (channel-media-ingest Phase 2, migration 288).
 *
 * Recording transcription runs OFF the inline HTTP request: the `/process` route
 * (and, later, the channel media-ingest paths) `enqueueRecordingJob`, and the
 * recording-process worker on `sidanclaw-api-workers` drains via
 * `claimNextRecordingJob` (`FOR UPDATE SKIP LOCKED`), then `markRecordingJobDone`
 * / `markRecordingJobFailed` (with bounded retry).
 *
 * System-only: all access is via the owner pool (`query()`, RLS-open). The route
 * does its own membership check before enqueue; the worker has no user context.
 *
 * [COMP:recordings/recording-jobs-store]
 */

import { query } from './client.js'

export type RecordingJobStatus = 'pending' | 'processing' | 'done' | 'failed'

export type RecordingJob = {
  id: string
  recordingId: string
  workspaceId: string
  actingUserId: string
  blueprintSlug: string | null
  status: RecordingJobStatus
  attempts: number
  lastError: string | null
}

/** A job is retried up to this many times (counting the first attempt) before it
 *  is parked in `failed`. */
export const RECORDING_JOB_MAX_ATTEMPTS = 3

const RETURNING = `
  id,
  recording_id   AS "recordingId",
  workspace_id   AS "workspaceId",
  acting_user_id AS "actingUserId",
  blueprint_slug AS "blueprintSlug",
  status,
  attempts,
  last_error     AS "lastError"
`

/**
 * Enqueue a recording for async processing. Idempotent: the partial unique index
 * on `recording_id WHERE status IN ('pending','processing')` makes a second
 * enqueue while one is in-flight a no-op (`enqueued: false`).
 */
export async function enqueueRecordingJob(input: {
  recordingId: string
  workspaceId: string
  actingUserId: string
  blueprintSlug?: string | null
}): Promise<{ enqueued: boolean; jobId: string | null }> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO recording_jobs (recording_id, workspace_id, acting_user_id, blueprint_slug)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [input.recordingId, input.workspaceId, input.actingUserId, input.blueprintSlug ?? null],
  )
  return rows[0] ? { enqueued: true, jobId: rows[0].id } : { enqueued: false, jobId: null }
}

/**
 * Atomically claim the oldest pending job, flipping it to `processing` and
 * bumping `attempts`. `FOR UPDATE SKIP LOCKED` lets multiple worker instances
 * (or ticks) coexist without double-claiming. Returns null when the queue is
 * empty.
 */
export async function claimNextRecordingJob(): Promise<RecordingJob | null> {
  const { rows } = await query<RecordingJob>(
    `UPDATE recording_jobs
        SET status = 'processing', attempts = attempts + 1, locked_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM recording_jobs
         WHERE status = 'pending'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING ${RETURNING}`,
  )
  return rows[0] ?? null
}

export async function markRecordingJobDone(id: string): Promise<void> {
  await query(`UPDATE recording_jobs SET status = 'done', updated_at = now() WHERE id = $1`, [id])
}

/**
 * Record a failure. Re-queues (`pending`) when there are attempts left, else
 * parks the job in `failed`. `attempts` was already incremented at claim time.
 */
export async function markRecordingJobFailed(
  id: string,
  error: string,
): Promise<{ retrying: boolean }> {
  const { rows } = await query<{ attempts: number }>(
    `UPDATE recording_jobs
        SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
            last_error = $3,
            locked_at = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING attempts`,
    [id, RECORDING_JOB_MAX_ATTEMPTS, error.slice(0, 2000)],
  )
  const attempts = rows[0]?.attempts ?? RECORDING_JOB_MAX_ATTEMPTS
  return { retrying: attempts < RECORDING_JOB_MAX_ATTEMPTS }
}

/**
 * True when a processing run already COMPLETED for this recording — the
 * re-process confirmation gate (an already-processed recording never silently
 * re-runs; see transcription.md §"Re-processing"). Pending/processing jobs
 * don't count: those are guarded by the active-job unique index instead.
 */
export async function hasCompletedRecordingJob(recordingId: string): Promise<boolean> {
  const { rows } = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM recording_jobs WHERE recording_id = $1 AND status = 'done' LIMIT 1`,
    [recordingId],
  )
  return rows.length > 0
}

/** Read a job's current status (for the `/process` status-poll endpoint). */
export async function getRecordingJob(id: string): Promise<RecordingJob | null> {
  const { rows } = await query<RecordingJob>(
    `SELECT ${RETURNING} FROM recording_jobs WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}

/**
 * Count a workspace's recording jobs created at/after `sinceEpochMs` — the
 * rolling-window input for the channel-media-ingest quota (Phase 6).
 */
export async function countRecentRecordingJobs(workspaceId: string, sinceEpochMs: number): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM recording_jobs WHERE workspace_id = $1 AND created_at >= $2`,
    [workspaceId, new Date(sinceEpochMs).toISOString()],
  )
  return Number(rows[0]?.count ?? '0')
}
