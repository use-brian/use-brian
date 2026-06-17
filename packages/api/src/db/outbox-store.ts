/**
 * `outbox-store.ts` — company-brain consistency layer.
 *
 * Data-access layer over `extraction_outbox` (migration 142). Implements
 * the two-phase write pattern from `docs/architecture/brain/consistency.md`:
 *
 *   Phase 1 — `enqueue()` inserts a job. Accepts an optional transaction
 *   client so the caller (Pipeline B) can write the source Episode and
 *   the outbox job atomically. `ON CONFLICT DO NOTHING` against the
 *   `(episode_id, derivation_kind, content_hash)` idempotency key — a
 *   re-enqueue with the same content is a no-op.
 *
 *   Phase 2 — `claimNext()` leases one due job via `FOR UPDATE SKIP
 *   LOCKED`, flips it to `processing` with a 5-minute lease. The caller
 *   runs the (long, transaction-free) LLM work, then calls `complete()`
 *   or `fail()`. `reclaimExpired()` returns crashed-mid-process jobs to
 *   the queue when their lease elapses.
 *
 * This module is the schema's store layer. The worker that drives the
 * drain loop ships with the Pipeline B wire-up — the outbox has no
 * producer until Pipeline B enqueues `extract` jobs.
 *
 * All access is system-level: `extraction_outbox` is worker-only state
 * (RLS `system_bypass` policy in migration 142), so the bare pool /
 * caller-supplied client is correct — no `queryWithRLS`.
 *
 * [COMP:brain/outbox-store]
 */

import type pg from 'pg'
import { getPool } from './client.js'

// ── Taxonomy (application-enforced — see migration 142 header) ───────

export type DerivationKind =
  | 'extract'
  | 'merge_cascade'
  | 'reembed'
  | 'kb_sync'
  | 're_extract'
  | 'skill_generate'
  | 'approved_write'

export type OutboxStatus = 'pending' | 'processing' | 'completed' | 'failed'

export type OutboxJob = {
  id: string
  workspaceId: string
  episodeId: string
  derivationKind: DerivationKind
  contentHash: string
  status: OutboxStatus
  attemptCount: number
  nextAttemptAt: Date
  lastError: string | null
  lockedBy: string | null
  lockedUntil: Date | null
  createdAt: Date
  completedAt: Date | null
}

export type EnqueueParams = {
  workspaceId: string
  episodeId: string
  derivationKind: DerivationKind
  contentHash: string
}

/** Minimal executor surface — both `pg.Pool` and `pg.PoolClient` satisfy it. */
type Queryable = Pick<pg.ClientBase, 'query'>

/** Lease window per consistency.md §"Lease semantics". */
const LEASE_TTL_MS = 5 * 60 * 1000

/** Permanent-failure threshold per consistency.md §"Failure handling". */
const MAX_ATTEMPTS = 5

const COLS = `
  id,
  workspace_id     AS "workspaceId",
  episode_id       AS "episodeId",
  derivation_kind  AS "derivationKind",
  content_hash     AS "contentHash",
  status,
  attempt_count    AS "attemptCount",
  next_attempt_at  AS "nextAttemptAt",
  last_error       AS "lastError",
  locked_by        AS "lockedBy",
  locked_until     AS "lockedUntil",
  created_at       AS "createdAt",
  completed_at     AS "completedAt"
`

function rowToJob(row: Record<string, unknown>): OutboxJob {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    episodeId: row.episodeId as string,
    derivationKind: row.derivationKind as DerivationKind,
    contentHash: row.contentHash as string,
    status: row.status as OutboxStatus,
    attemptCount: row.attemptCount as number,
    nextAttemptAt: row.nextAttemptAt as Date,
    lastError: (row.lastError as string | null) ?? null,
    lockedBy: (row.lockedBy as string | null) ?? null,
    lockedUntil: (row.lockedUntil as Date | null) ?? null,
    createdAt: row.createdAt as Date,
    completedAt: (row.completedAt as Date | null) ?? null,
  }
}

/**
 * Exponential backoff for retry scheduling: 2^attempt minutes, capped at
 * 1 hour. `attempt` is the count *after* the failed try.
 */
function backoffMs(attempt: number): number {
  const minutes = Math.min(2 ** attempt, 60)
  return minutes * 60 * 1000
}

export type OutboxStore = {
  /**
   * Phase 1 enqueue. Idempotent — a duplicate `(episode_id,
   * derivation_kind, content_hash)` is a no-op and returns `null`.
   * Pass `client` to enlist in the caller's transaction (the atomic
   * Episode-insert + outbox-enqueue of consistency.md §"Two-phase
   * write pattern"); omit it for a standalone insert.
   */
  enqueue(params: EnqueueParams, client?: Queryable): Promise<OutboxJob | null>

  /**
   * Phase 2 claim. Leases one due `pending` job (`next_attempt_at <=
   * now()`) via `FOR UPDATE SKIP LOCKED`, flips it to `processing` with
   * a `LEASE_TTL_MS` lease stamped `lockedBy`. Returns `null` when the
   * queue is empty.
   */
  claimNext(lockedBy: string): Promise<OutboxJob | null>

  /** Marks a processing job completed. */
  complete(id: string): Promise<void>

  /**
   * Records a failed attempt. Re-queues with exponential backoff until
   * `MAX_ATTEMPTS`, then transitions to permanent `failed`.
   */
  fail(id: string, error: string): Promise<OutboxJob | null>

  /**
   * Lease-expiry recovery — returns `processing` jobs whose
   * `locked_until` has elapsed back to `pending`. Returns the count
   * reclaimed. Called by the worker at the top of each tick.
   */
  reclaimExpired(): Promise<number>

  /** Observability — job counts grouped by status. */
  countByStatus(workspaceId?: string): Promise<Record<OutboxStatus, number>>
}

export function createOutboxStore(): OutboxStore {
  return {
    async enqueue(params, client) {
      const exec: Queryable = client ?? getPool()
      const result = await exec.query(
        `INSERT INTO extraction_outbox
           (workspace_id, episode_id, derivation_kind, content_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (episode_id, derivation_kind, content_hash) DO NOTHING
         RETURNING ${COLS}`,
        [params.workspaceId, params.episodeId, params.derivationKind, params.contentHash],
      )
      const row = result.rows[0]
      return row ? rowToJob(row as Record<string, unknown>) : null
    },

    async claimNext(lockedBy) {
      const dbClient = await getPool().connect()
      try {
        await dbClient.query('BEGIN')
        const claimed = await dbClient.query(
          `SELECT id
             FROM extraction_outbox
            WHERE status = 'pending'
              AND next_attempt_at <= now()
            ORDER BY next_attempt_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
        )
        const jobId = claimed.rows[0]?.id as string | undefined
        if (!jobId) {
          await dbClient.query('COMMIT')
          return null
        }
        const updated = await dbClient.query(
          `UPDATE extraction_outbox
              SET status       = 'processing',
                  locked_by    = $2,
                  locked_until = now() + ($3::int * INTERVAL '1 millisecond'),
                  attempt_count = attempt_count + 1
            WHERE id = $1
            RETURNING ${COLS}`,
          [jobId, lockedBy, LEASE_TTL_MS],
        )
        await dbClient.query('COMMIT')
        return rowToJob(updated.rows[0] as Record<string, unknown>)
      } catch (err) {
        await dbClient.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        dbClient.release()
      }
    },

    async complete(id) {
      await getPool().query(
        `UPDATE extraction_outbox
            SET status       = 'completed',
                completed_at = now(),
                locked_by    = NULL,
                locked_until = NULL,
                last_error   = NULL
          WHERE id = $1`,
        [id],
      )
    },

    async fail(id, error) {
      // Read attempt_count to decide retry-vs-permanent. The count was
      // already incremented by claimNext, so it reflects this attempt.
      const current = await getPool().query(
        `SELECT attempt_count AS "attemptCount" FROM extraction_outbox WHERE id = $1`,
        [id],
      )
      const attemptCount = current.rows[0]?.attemptCount as number | undefined
      if (attemptCount === undefined) return null

      const permanent = attemptCount >= MAX_ATTEMPTS
      const result = await getPool().query(
        permanent
          ? `UPDATE extraction_outbox
                SET status       = 'failed',
                    last_error   = $2,
                    locked_by    = NULL,
                    locked_until = NULL
              WHERE id = $1
              RETURNING ${COLS}`
          : `UPDATE extraction_outbox
                SET status          = 'pending',
                    last_error      = $2,
                    locked_by       = NULL,
                    locked_until    = NULL,
                    next_attempt_at = now() + ($3::int * INTERVAL '1 millisecond')
              WHERE id = $1
              RETURNING ${COLS}`,
        permanent
          ? [id, error.slice(0, 2000)]
          : [id, error.slice(0, 2000), backoffMs(attemptCount)],
      )
      const row = result.rows[0]
      return row ? rowToJob(row as Record<string, unknown>) : null
    },

    async reclaimExpired() {
      const result = await getPool().query(
        `UPDATE extraction_outbox
            SET status       = 'pending',
                locked_by    = NULL,
                locked_until = NULL
          WHERE status = 'processing'
            AND locked_until IS NOT NULL
            AND locked_until < now()`,
      )
      return result.rowCount ?? 0
    },

    async countByStatus(workspaceId) {
      const result = await getPool().query<{ status: OutboxStatus; n: string }>(
        workspaceId
          ? `SELECT status, COUNT(*)::text AS n
               FROM extraction_outbox
              WHERE workspace_id = $1
              GROUP BY status`
          : `SELECT status, COUNT(*)::text AS n
               FROM extraction_outbox
              GROUP BY status`,
        workspaceId ? [workspaceId] : [],
      )
      const counts: Record<OutboxStatus, number> = {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
      }
      for (const row of result.rows) {
        counts[row.status] = Number(row.n)
      }
      return counts
    },
  }
}
