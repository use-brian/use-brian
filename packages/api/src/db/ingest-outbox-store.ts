/**
 * `ingest-outbox-store.ts` — the transactional outbox for external ingest
 * sinks (migration 364; docs/architecture/brain/ingest-external-sink.md).
 *
 * Implements the D8 transport decision: an ingestion event bound for an
 * external sink is NEVER POSTed inline. The producer writes the outbox row
 * in the SAME local transaction as its event capture (`enqueue` takes an
 * optional caller client — the `extraction_outbox` two-phase pattern), and
 * the relay worker (`external-sink-relay.ts`) drains rows to the sink under
 * `ub.ingest.append.v1` with idempotent retries.
 *
 * Failure taxonomy (X7):
 *   - `fail()`   — 429/5xx/network: capped exponential backoff, retried
 *                  INDEFINITELY. There is no attempt cap: the event stream
 *                  is irreplaceable (messaging-archive §5), so an endpoint
 *                  that is down for days must not lose rows. Contrast
 *                  `outbox-store.ts` (extraction retries have a cap because
 *                  the Episode persists and can be re-extracted).
 *   - `deadLetter()` — non-429 4xx (schema rejection): terminal `dead`
 *                  status, kept visible for admin triage — never a silent
 *                  drop.
 *
 * `claimDue` joins `ingest_external_sink.enabled`, so a disabled sink's
 * rows simply wait (and resume in order) rather than erroring.
 *
 * All access is system-level: `ingest_outbox` is worker-only state (RLS
 * `system_bypass`-only), so the bare pool / caller-supplied client is
 * correct — no `queryWithRLS`.
 *
 * [COMP:brain/ingest-outbox]
 */

import type pg from 'pg'
import { getPool } from './client.js'

export type IngestOutboxStatus = 'pending' | 'processing' | 'delivered' | 'dead'

export type IngestOutboxRow = {
  id: string
  sinkId: string
  connectorInstanceId: string
  workspaceId: string
  ownerUserId: string | null
  source: string
  /** Whole-batch idempotency key (X-UB-Idempotency-Key), stable across retries. */
  batchId: string
  messages: unknown[]
  /** Opaque producer cursor, echoed to the sink and back on ack. */
  sourceCursor: unknown
  status: IngestOutboxStatus
  attemptCount: number
  nextAttemptAt: Date
  lastError: string | null
  lockedBy: string | null
  lockedUntil: Date | null
  createdAt: Date
  deliveredAt: Date | null
}

export type EnqueueIngestOutboxParams = {
  sinkId: string
  connectorInstanceId: string
  workspaceId: string
  ownerUserId?: string | null
  source: string
  messages: unknown[]
  sourceCursor?: unknown
}

/** Minimal executor surface — both `pg.Pool` and `pg.PoolClient` satisfy it. */
type Queryable = Pick<pg.ClientBase, 'query'>

/** Lease window while a row is mid-POST (the extraction-outbox precedent). */
const LEASE_TTL_MS = 5 * 60 * 1000

/**
 * Retry backoff: 2^attempt × 15s, capped at 1 hour. Attempt 1 → 30s,
 * 2 → 1m, 3 → 2m … then flat hourly. Unbounded attempts by design (X7).
 */
function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 15_000, 60 * 60 * 1000)
}

const COLS = `
  id,
  sink_id               AS "sinkId",
  connector_instance_id AS "connectorInstanceId",
  workspace_id          AS "workspaceId",
  owner_user_id         AS "ownerUserId",
  source,
  batch_id              AS "batchId",
  messages,
  source_cursor         AS "sourceCursor",
  status,
  attempt_count         AS "attemptCount",
  next_attempt_at       AS "nextAttemptAt",
  last_error            AS "lastError",
  locked_by             AS "lockedBy",
  locked_until          AS "lockedUntil",
  created_at            AS "createdAt",
  delivered_at          AS "deliveredAt"
`

function rowToOutbox(row: Record<string, unknown>): IngestOutboxRow {
  return {
    id: row.id as string,
    sinkId: row.sinkId as string,
    connectorInstanceId: row.connectorInstanceId as string,
    workspaceId: row.workspaceId as string,
    ownerUserId: (row.ownerUserId as string | null) ?? null,
    source: row.source as string,
    batchId: row.batchId as string,
    messages: Array.isArray(row.messages) ? (row.messages as unknown[]) : [],
    sourceCursor: row.sourceCursor ?? null,
    status: row.status as IngestOutboxStatus,
    attemptCount: row.attemptCount as number,
    nextAttemptAt: row.nextAttemptAt as Date,
    lastError: (row.lastError as string | null) ?? null,
    lockedBy: (row.lockedBy as string | null) ?? null,
    lockedUntil: (row.lockedUntil as Date | null) ?? null,
    createdAt: row.createdAt as Date,
    deliveredAt: (row.deliveredAt as Date | null) ?? null,
  }
}

export type IngestOutboxStore = {
  /**
   * Producer-side enqueue. Pass `client` to enlist in the caller's
   * transaction — the D10 atomic record-plus-outbox commit; omit it for a
   * standalone insert.
   */
  enqueue(params: EnqueueIngestOutboxParams, client?: Queryable): Promise<IngestOutboxRow>

  /**
   * Relay-side claim. Leases up to `limit` due `pending` rows of ENABLED
   * sinks (`FOR UPDATE SKIP LOCKED`), flips them `processing` with a lease
   * stamped `lockedBy`, oldest-first.
   */
  claimDue(limit: number, lockedBy: string): Promise<IngestOutboxRow[]>

  /** Terminal success — the sink acked the batch. */
  markDelivered(id: string): Promise<void>

  /** Retryable failure (429/5xx/network): backoff re-queue, never terminal. */
  fail(id: string, error: string): Promise<IngestOutboxRow | null>

  /** Terminal failure (non-429 4xx): dead-letter, admin-visible (X7). */
  deadLetter(id: string, error: string): Promise<void>

  /** Lease-expiry recovery — crashed mid-POST rows return to `pending`. */
  reclaimExpired(): Promise<number>

  /** Admin triage read — dead-lettered rows, newest first. */
  listDead(opts?: { limit?: number }): Promise<IngestOutboxRow[]>

  /** Observability — row counts grouped by status. */
  countByStatus(): Promise<Record<IngestOutboxStatus, number>>
}

export function createIngestOutboxStore(): IngestOutboxStore {
  return {
    async enqueue(params, client) {
      const exec: Queryable = client ?? getPool()
      const result = await exec.query(
        `INSERT INTO ingest_outbox
           (sink_id, connector_instance_id, workspace_id, owner_user_id,
            source, messages, source_cursor)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
         RETURNING ${COLS}`,
        [
          params.sinkId,
          params.connectorInstanceId,
          params.workspaceId,
          params.ownerUserId ?? null,
          params.source,
          JSON.stringify(params.messages),
          params.sourceCursor === undefined ? null : JSON.stringify(params.sourceCursor),
        ],
      )
      return rowToOutbox(result.rows[0] as Record<string, unknown>)
    },

    async claimDue(limit, lockedBy) {
      const dbClient = await getPool().connect()
      try {
        await dbClient.query('BEGIN')
        const claimed = await dbClient.query(
          `SELECT o.id
             FROM ingest_outbox o
             JOIN ingest_external_sink s ON s.id = o.sink_id AND s.enabled = true
            WHERE o.status = 'pending'
              AND o.next_attempt_at <= now()
            ORDER BY o.next_attempt_at ASC
            LIMIT $1
            FOR UPDATE OF o SKIP LOCKED`,
          [limit],
        )
        const ids = claimed.rows.map((r) => (r as { id: string }).id)
        if (ids.length === 0) {
          await dbClient.query('COMMIT')
          return []
        }
        const updated = await dbClient.query(
          `UPDATE ingest_outbox
              SET status        = 'processing',
                  locked_by     = $2,
                  locked_until  = now() + ($3::int * INTERVAL '1 millisecond'),
                  attempt_count = attempt_count + 1
            WHERE id = ANY($1::uuid[])
            RETURNING ${COLS}`,
          [ids, lockedBy, LEASE_TTL_MS],
        )
        await dbClient.query('COMMIT')
        return updated.rows
          .map((r) => rowToOutbox(r as Record<string, unknown>))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      } catch (err) {
        await dbClient.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        dbClient.release()
      }
    },

    async markDelivered(id) {
      await getPool().query(
        `UPDATE ingest_outbox
            SET status       = 'delivered',
                delivered_at = now(),
                locked_by    = NULL,
                locked_until = NULL,
                last_error   = NULL
          WHERE id = $1`,
        [id],
      )
    },

    async fail(id, error) {
      // attempt_count was already incremented by claimDue, so it reflects
      // this attempt. No cap — retryable failures re-queue forever (X7).
      const result = await getPool().query(
        `UPDATE ingest_outbox
            SET status          = 'pending',
                last_error      = $2,
                locked_by       = NULL,
                locked_until    = NULL,
                next_attempt_at = now() + (LEAST(POWER(2, attempt_count) * 15000, 3600000)::int * INTERVAL '1 millisecond')
          WHERE id = $1
          RETURNING ${COLS}`,
        [id, error.slice(0, 2000)],
      )
      const row = result.rows[0]
      return row ? rowToOutbox(row as Record<string, unknown>) : null
    },

    async deadLetter(id, error) {
      await getPool().query(
        `UPDATE ingest_outbox
            SET status       = 'dead',
                last_error   = $2,
                locked_by    = NULL,
                locked_until = NULL
          WHERE id = $1`,
        [id, error.slice(0, 2000)],
      )
    },

    async reclaimExpired() {
      const result = await getPool().query(
        `UPDATE ingest_outbox
            SET status       = 'pending',
                locked_by    = NULL,
                locked_until = NULL
          WHERE status = 'processing'
            AND locked_until IS NOT NULL
            AND locked_until < now()`,
      )
      return result.rowCount ?? 0
    },

    async listDead(opts) {
      const result = await getPool().query(
        `SELECT ${COLS} FROM ingest_outbox
          WHERE status = 'dead'
          ORDER BY created_at DESC
          LIMIT $1`,
        [opts?.limit ?? 100],
      )
      return result.rows.map((r) => rowToOutbox(r as Record<string, unknown>))
    },

    async countByStatus() {
      const result = await getPool().query<{ status: IngestOutboxStatus; n: string }>(
        `SELECT status, COUNT(*)::text AS n FROM ingest_outbox GROUP BY status`,
      )
      const counts: Record<IngestOutboxStatus, number> = {
        pending: 0,
        processing: 0,
        delivered: 0,
        dead: 0,
      }
      for (const row of result.rows) {
        counts[row.status] = Number(row.n)
      }
      return counts
    },
  }
}
