/**
 * `file-ingest-jobs-store.ts` — the async file-ingest queue
 * (large-content-artifacts §Phase 2.2, migration 298).
 *
 * A large document / paste is filed synchronously into workspace_files, then the
 * boundary `enqueueFileIngestJob`s the parse/chunk/decompose work; the
 * file-ingest worker on `brian-api-workers` drains via
 * `claimNextFileIngestJob` (`FOR UPDATE SKIP LOCKED`), then
 * `markFileIngestJobDone` / `markFileIngestJobFailed` (with bounded retry).
 * Mirrors `recording-jobs-store.ts` (minus the recording blueprint).
 *
 * System-only: all access is via the owner pool (`query()`, RLS-open). The
 * boundary does its own membership check before enqueue; the worker has no user
 * context.
 *
 * [COMP:files/file-ingest-jobs-store]
 */

import { query } from './client.js'

export type FileIngestJobStatus = 'pending' | 'processing' | 'done' | 'failed'

export type FileIngestJob = {
  id: string
  fileId: string
  workspaceId: string
  actingUserId: string
  assistantId: string | null
  sourceLabel: string
  status: FileIngestJobStatus
  attempts: number
  lastError: string | null
}

/** A job is retried up to this many times (counting the first attempt) before it
 *  is parked in `failed`. */
export const FILE_INGEST_JOB_MAX_ATTEMPTS = 3

const RETURNING = `
  id,
  file_id        AS "fileId",
  workspace_id   AS "workspaceId",
  acting_user_id AS "actingUserId",
  assistant_id   AS "assistantId",
  source_label   AS "sourceLabel",
  status,
  attempts,
  last_error     AS "lastError"
`

/**
 * Enqueue a stored file for async parse/chunk/decompose. Idempotent: the partial
 * unique index on `file_id WHERE status IN ('pending','processing')` makes a
 * second enqueue while one is in-flight a no-op (`enqueued: false`).
 */
export async function enqueueFileIngestJob(input: {
  fileId: string
  workspaceId: string
  actingUserId: string
  assistantId?: string | null
  sourceLabel?: string
}): Promise<{ enqueued: boolean; jobId: string | null }> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO file_ingest_jobs (file_id, workspace_id, acting_user_id, assistant_id, source_label)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.fileId,
      input.workspaceId,
      input.actingUserId,
      input.assistantId ?? null,
      input.sourceLabel ?? 'upload',
    ],
  )
  return rows[0] ? { enqueued: true, jobId: rows[0].id } : { enqueued: false, jobId: null }
}

/**
 * Atomically claim the oldest pending job, flipping it to `processing` and
 * bumping `attempts`. `FOR UPDATE SKIP LOCKED` lets multiple worker instances
 * (or ticks) coexist without double-claiming. Returns null when the queue is
 * empty.
 */
export async function claimNextFileIngestJob(): Promise<FileIngestJob | null> {
  const { rows } = await query<FileIngestJob>(
    `UPDATE file_ingest_jobs
        SET status = 'processing', attempts = attempts + 1, locked_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM file_ingest_jobs
         WHERE status = 'pending'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING ${RETURNING}`,
  )
  return rows[0] ?? null
}

export async function markFileIngestJobDone(id: string): Promise<void> {
  await query(`UPDATE file_ingest_jobs SET status = 'done', updated_at = now() WHERE id = $1`, [id])
}

/**
 * Record a failure. Re-queues (`pending`) when there are attempts left, else
 * parks the job in `failed`. `attempts` was already incremented at claim time.
 */
export async function markFileIngestJobFailed(
  id: string,
  error: string,
): Promise<{ retrying: boolean }> {
  const { rows } = await query<{ attempts: number }>(
    `UPDATE file_ingest_jobs
        SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
            last_error = $3,
            locked_at = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING attempts`,
    [id, FILE_INGEST_JOB_MAX_ATTEMPTS, error.slice(0, 2000)],
  )
  const attempts = rows[0]?.attempts ?? FILE_INGEST_JOB_MAX_ATTEMPTS
  return { retrying: attempts < FILE_INGEST_JOB_MAX_ATTEMPTS }
}

/** Read a job's current status (for a status-poll surface / debugging). */
export async function getFileIngestJob(id: string): Promise<FileIngestJob | null> {
  const { rows } = await query<FileIngestJob>(
    `SELECT ${RETURNING} FROM file_ingest_jobs WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}

/**
 * Count a workspace's file-ingest jobs created at/after `sinceEpochMs` — the
 * rolling-window input for the channel-media-ingest quota (Phase 3.3, unioned
 * with `countRecentRecordingJobs`). Signature mirrors `countRecentRecordingJobs`.
 */
export async function countRecentFileIngestJobs(
  workspaceId: string,
  sinceEpochMs: number,
): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM file_ingest_jobs WHERE workspace_id = $1 AND created_at >= $2`,
    [workspaceId, new Date(sinceEpochMs).toISOString()],
  )
  return Number(rows[0]?.count ?? '0')
}
