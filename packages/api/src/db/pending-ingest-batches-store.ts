import type { BatchStore, PendingBatch } from '@use-brian/core'
import { getPool } from './client.js'

/**
 * Postgres-backed `BatchStore` for the company-brain ingest batch worker
 * (WU-3.8). Drains rows from `pending_ingest_batches` (migration 131)
 * inside a single transaction so the SELECT FOR UPDATE SKIP LOCKED locks
 * are released by per-row UPDATEs to `processed_at`.
 *
 * See docs/plans/company-brain/ingest.md → "Engine components / Batch
 * worker" for the spec query shape.
 */

type BatchRow = {
  id: string
  workspace_id: string
  rule_id: string
  assistant_id: string | null
  partition_key: string
  source: string
  fires_at: Date
  events: unknown[]
  created_at: Date
  episode_sensitivity: 'public' | 'internal' | 'confidential' | null
  compartments: string[]
  project_ids: string[]
}

function rowToBatch(row: BatchRow): PendingBatch {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ruleId: row.rule_id,
    assistantId: row.assistant_id,
    partitionKey: row.partition_key,
    source: row.source,
    firesAt: row.fires_at,
    events: Array.isArray(row.events) ? row.events : [],
    createdAt: row.created_at,
    episodeSensitivity: row.episode_sensitivity,
    compartments: row.compartments ?? [],
    projectIds: row.project_ids ?? [],
  }
}

export function createDbBatchStore(): BatchStore {
  return {
    async withClaimedBatches(limit, handler) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const result = await client.query<BatchRow>(
          `SELECT id, workspace_id, rule_id, assistant_id, partition_key,
                  source, fires_at, events,
                  created_at, episode_sensitivity, compartments, project_ids
             FROM pending_ingest_batches
             WHERE fires_at < now() AND processed_at IS NULL
               AND source <> 'programmatic'
             FOR UPDATE SKIP LOCKED
             LIMIT $1`,
          [limit],
        )
        const batches = result.rows.map(rowToBatch)
        const markProcessed = async (id: string) => {
          await client.query(
            `UPDATE pending_ingest_batches SET processed_at = now() WHERE id = $1`,
            [id],
          )
        }
        const handlerResult = await handler(batches, markProcessed)
        await client.query('COMMIT')
        return handlerResult
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  }
}

/** Dedicated claimant so the generic connector processor never drains a
 * programmatic batch with its per-event fallback path. */
export function createDbProgrammaticBatchStore(
  pool: TransactionalPool = getPool(),
): BatchStore {
  return {
    async withClaimedBatches(limit, handler) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await client.query<BatchRow>(
          `SELECT id, workspace_id, rule_id, assistant_id, partition_key,
                  source, fires_at, events,
                  created_at, episode_sensitivity, compartments, project_ids
             FROM pending_ingest_batches
            WHERE fires_at < now() AND processed_at IS NULL
              AND source = 'programmatic'
            FOR UPDATE SKIP LOCKED
            LIMIT $1`,
          [limit],
        )
        const batches = result.rows.map(rowToBatch)
        const markProcessed = async (id: string) => {
          await client.query(
            `UPDATE pending_ingest_batches SET processed_at = now() WHERE id = $1`,
            [id],
          )
          await client.query(
            `UPDATE programmatic_capture_receipts
                SET status = 'completed', error = NULL, updated_at = now()
              WHERE batch_id = $1 AND status = 'queued'`,
            [id],
          )
        }
        const handlerResult = await handler(batches, markProcessed)
        await client.query('COMMIT')
        return handlerResult
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  }
}

/**
 * Size-based early-flush bound (ingest-pipeline.md → "Batch flush — cron
 * backstop + size trigger"). When an `appendBatchEvent` push takes a batch's
 * accumulated text past this many tokens, the batch's `fires_at` is pulled
 * forward to `now()` so the next ~60s worker tick drains it instead of waiting
 * for the cron firing. Coupled with `CONTENT_CHAR_LIMIT` in pipeline-b.ts (cap
 * ≥ flush bound in tokens) so a bounded window extracts without truncation.
 */
export const EARLY_FLUSH_TOKENS = 32_000

/** Token estimate at ~4 chars/token — the cheap proxy used for the bound. */
const APPROX_CHARS_PER_TOKEN = 4

/** Char-count threshold for the early flush (≈128 KB at 32k tokens). */
export const EARLY_FLUSH_CHARS = EARLY_FLUSH_TOKENS * APPROX_CHARS_PER_TOKEN

/** Minimal pool surface used here — injectable so the flush logic is unit-testable. */
type QueryablePool = {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>
}

export type ProgrammaticCapturePrincipalKind = 'api_key' | 'oauth_token' | 'home_app'
export type ProgrammaticCaptureReceiptStatus =
  | 'processing'
  | 'queued'
  | 'completed'
  | 'dropped'
  | 'failed'

export type QueuedProgrammaticCaptureEvent = {
  eventId: string
  content: string
  occurredAt: string
  receivedAt: string
  role: string
  sessionId?: string
  subjectId?: string
  sourceLabel?: string
  metadata: Record<string, string | number | boolean | null>
  principalKind: ProgrammaticCapturePrincipalKind
  principalId: string
  actingUserId?: string
}

export type ProgrammaticReceiptResult = {
  duplicate: boolean
  status: ProgrammaticCaptureReceiptStatus
  batchId: string | null
  firesAt: Date | null
}

type TransactionalPool = QueryablePool & {
  connect(): Promise<{
    query<R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: R[] }>
    release(): void
  }>
}

export async function getProgrammaticReceipt(
  principalKind: ProgrammaticCapturePrincipalKind,
  principalId: string,
  eventId: string,
  pool: QueryablePool = getPool(),
): Promise<ProgrammaticReceiptResult> {
  const result = await pool.query<{
    status: ProgrammaticCaptureReceiptStatus
    batchId: string | null
    firesAt: Date | null
  }>(
    `SELECT r.status, r.batch_id AS "batchId", b.fires_at AS "firesAt"
       FROM programmatic_capture_receipts r
       LEFT JOIN pending_ingest_batches b ON b.id = r.batch_id
      WHERE r.principal_kind = $1 AND r.principal_id = $2 AND r.event_id = $3
      LIMIT 1`,
    [principalKind, principalId, eventId],
  )
  const row = result.rows[0]
  if (!row) throw new Error('programmatic capture receipt disappeared')
  return { duplicate: true, status: row.status, batchId: row.batchId, firesAt: row.firesAt }
}

/** Persist a deterministic drop receipt so client retries remain idempotent. */
export async function recordDroppedProgrammaticEvent(input: {
  workspaceId: string
  principalKind: ProgrammaticCapturePrincipalKind
  principalId: string
  eventId: string
  ruleId: string | null
}, pool: QueryablePool = getPool()): Promise<ProgrammaticReceiptResult> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO programmatic_capture_receipts
       (workspace_id, principal_kind, principal_id, event_id, rule_id, status)
     VALUES ($1, $2, $3, $4, $5, 'dropped')
     ON CONFLICT (principal_kind, principal_id, event_id) DO NOTHING
     RETURNING id`,
    [input.workspaceId, input.principalKind, input.principalId, input.eventId, input.ruleId],
  )
  if (result.rows[0]) {
    return { duplicate: false, status: 'dropped', batchId: null, firesAt: null }
  }
  return getProgrammaticReceipt(input.principalKind, input.principalId, input.eventId, pool)
}

/** Reserve an idempotency receipt before a realtime extraction call. Failed
 * receipts may be retried; every other existing status is treated as a replay. */
export async function reserveRealtimeProgrammaticEvent(input: {
  workspaceId: string
  principalKind: ProgrammaticCapturePrincipalKind
  principalId: string
  eventId: string
  ruleId: string
}, pool: QueryablePool = getPool()): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO programmatic_capture_receipts
       (workspace_id, principal_kind, principal_id, event_id, rule_id, status)
     VALUES ($1, $2, $3, $4, $5, 'processing')
     ON CONFLICT (principal_kind, principal_id, event_id) DO UPDATE
       SET status = 'processing', error = NULL, rule_id = EXCLUDED.rule_id, updated_at = now()
       WHERE programmatic_capture_receipts.status = 'failed'
     RETURNING id`,
    [input.workspaceId, input.principalKind, input.principalId, input.eventId, input.ruleId],
  )
  return result.rows.length > 0
}

export async function finishRealtimeProgrammaticEvent(input: {
  principalKind: ProgrammaticCapturePrincipalKind
  principalId: string
  eventId: string
  status: 'completed' | 'failed'
  error?: string
}, pool: QueryablePool = getPool()): Promise<void> {
  await pool.query(
    `UPDATE programmatic_capture_receipts
        SET status = $4, error = $5, updated_at = now()
      WHERE principal_kind = $1 AND principal_id = $2 AND event_id = $3
        AND status = 'processing'`,
    [input.principalKind, input.principalId, input.eventId, input.status, input.error ?? null],
  )
}

/**
 * Atomically deduplicate one routed event and append it to its pooled batch.
 * The partial unique index from migration 492 makes concurrent producers safe;
 * the receipt update and append commit together, so a retry can never observe
 * a queued receipt without its event.
 */
export async function appendProgrammaticBatchEvent(input: {
  workspaceId: string
  assistantId: string
  ruleId: string
  partitionKey: string
  firesAt: Date
  event: QueuedProgrammaticCaptureEvent
  episodeSensitivity: 'public' | 'internal' | 'confidential'
  compartments: string[]
  projectIds: string[]
}, pool: TransactionalPool = getPool()): Promise<ProgrammaticReceiptResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const receipt = await client.query<{ id: string }>(
      `INSERT INTO programmatic_capture_receipts
         (workspace_id, principal_kind, principal_id, event_id, rule_id, status)
       VALUES ($1, $2, $3, $4, $5, 'processing')
       ON CONFLICT (principal_kind, principal_id, event_id) DO NOTHING
       RETURNING id`,
      [
        input.workspaceId,
        input.event.principalKind,
        input.event.principalId,
        input.event.eventId,
        input.ruleId,
      ],
    )
    if (!receipt.rows[0]) {
      await client.query('COMMIT')
      return getProgrammaticReceipt(
        input.event.principalKind,
        input.event.principalId,
        input.event.eventId,
        pool,
      )
    }

    const eventJson = JSON.stringify([input.event])
    const batch = await client.query<{ id: string; firesAt: Date; chars: number | string }>(
      `INSERT INTO pending_ingest_batches
         (workspace_id, rule_id, assistant_id, partition_key, source, fires_at,
          events, episode_sensitivity, compartments, project_ids)
       VALUES ($1, $2, $3, $4, 'programmatic', $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (rule_id, assistant_id, partition_key, fires_at)
         WHERE source = 'programmatic' AND processed_at IS NULL
       DO UPDATE SET
         events = pending_ingest_batches.events || EXCLUDED.events,
         episode_sensitivity = CASE
           WHEN pending_ingest_batches.episode_sensitivity = 'public'
             OR EXCLUDED.episode_sensitivity = 'public' THEN 'public'
           WHEN pending_ingest_batches.episode_sensitivity = 'internal'
             OR EXCLUDED.episode_sensitivity = 'internal' THEN 'internal'
           ELSE 'confidential'
         END,
         compartments = ARRAY(
           SELECT DISTINCT unnest(pending_ingest_batches.compartments || EXCLUDED.compartments)
           ORDER BY 1
         ),
         project_ids = ARRAY(
           SELECT DISTINCT unnest(pending_ingest_batches.project_ids || EXCLUDED.project_ids)
           ORDER BY 1
         )
       RETURNING id, fires_at AS "firesAt", length(events::text) AS chars`,
      [
        input.workspaceId,
        input.ruleId,
        input.assistantId,
        input.partitionKey,
        input.firesAt,
        eventJson,
        input.episodeSensitivity,
        input.compartments,
        input.projectIds,
      ],
    )
    const row = batch.rows[0]!
    let actualFiresAt = row.firesAt
    if (Number(row.chars) >= EARLY_FLUSH_CHARS) {
      const flushed = await client.query<{ firesAt: Date }>(
        `UPDATE pending_ingest_batches SET fires_at = now()
          WHERE id = $1 AND fires_at > now()
          RETURNING fires_at AS "firesAt"`,
        [row.id],
      )
      actualFiresAt = flushed.rows[0]?.firesAt ?? actualFiresAt
    }
    await client.query(
      `UPDATE programmatic_capture_receipts
          SET status = 'queued', batch_id = $2, updated_at = now()
        WHERE id = $1`,
      [receipt.rows[0].id, row.id],
    )
    await client.query('COMMIT')
    return { duplicate: false, status: 'queued', batchId: row.id, firesAt: actualFiresAt }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Producer-side append for the ingest poller. Finds the unprocessed
 * batch row for `(rule_id, fires_at)` and pushes `event` onto its
 * `events` JSONB array; creates the row if none exists. Migration 131
 * deliberately omits a `(rule_id, fires_at)` UNIQUE — the find-or-create
 * is application-layer, safe because the poll producers are single-
 * instance (same assumption as the drain worker).
 *
 * Size early flush: each append returns the row's accumulated text length
 * (`length(events::text)` — the cheap char proxy for the token estimate); when
 * it crosses `EARLY_FLUSH_CHARS` a future `fires_at` is pulled back to `now()`
 * so the busy window drains on the next tick. The pull only moves a future
 * `fires_at` earlier (`WHERE fires_at > now()`) — a cron time already due, or a
 * row already early-flushed, is left untouched. The cron firing stays the time
 * backstop for low-traffic windows that never reach the bound.
 *
 * System-level — `pending_ingest_batches` RLS is `system_bypass` only.
 */
export async function appendBatchEvent(
  input: {
    workspaceId: string
    ruleId: string
    source: string
    firesAt: Date
    event: unknown
    /**
     * Per-rule Episode sensitivity override (migration 183). Threaded
     * through from the routing decision so the batch worker can stamp the
     * digest Episode at the right tier without joining back to the rule.
     * NULL = inherit source default.
     */
    episodeSensitivity?: 'public' | 'internal' | 'confidential' | null
    compartments?: string[]
    projectIds?: string[]
  },
  pool: QueryablePool = getPool(),
): Promise<void> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM pending_ingest_batches
       WHERE rule_id = $1 AND fires_at = $2 AND processed_at IS NULL
       LIMIT 1`,
    [input.ruleId, input.firesAt],
  )
  const eventJson = JSON.stringify([input.event])
  let batchId: string
  let accumulatedChars: number
  if (existing.rows[0]) {
    const updated = await pool.query<{ id: string; chars: number | string }>(
      `UPDATE pending_ingest_batches SET
         events = events || $2::jsonb,
         compartments = ARRAY(
           SELECT DISTINCT unnest(compartments || $3::text[]) ORDER BY 1
         ),
         project_ids = ARRAY(
           SELECT DISTINCT unnest(project_ids || $4::uuid[]) ORDER BY 1
         )
         WHERE id = $1
         RETURNING id, length(events::text) AS chars`,
      [existing.rows[0].id, eventJson, input.compartments ?? [], input.projectIds ?? []],
    )
    batchId = updated.rows[0]!.id
    accumulatedChars = Number(updated.rows[0]!.chars)
  } else {
    const inserted = await pool.query<{ id: string; chars: number | string }>(
      `INSERT INTO pending_ingest_batches
         (workspace_id, rule_id, source, fires_at, events, episode_sensitivity,
          compartments, project_ids)
       VALUES (
         $1, $2, $3, $4, $5::jsonb, $6,
         COALESCE($7::text[],
           (SELECT r.compartments FROM ingest_rules r WHERE r.id = $2),
           ARRAY[]::text[]),
         COALESCE($8::uuid[],
           (SELECT r.project_ids FROM ingest_rules r WHERE r.id = $2),
           ARRAY[]::uuid[])
       )
       RETURNING id, length(events::text) AS chars`,
      [
        input.workspaceId,
        input.ruleId,
        input.source,
        input.firesAt,
        eventJson,
        input.episodeSensitivity ?? null,
        input.compartments,
        input.projectIds,
      ],
    )
    batchId = inserted.rows[0]!.id
    accumulatedChars = Number(inserted.rows[0]!.chars)
  }

  if (accumulatedChars >= EARLY_FLUSH_CHARS) {
    await pool.query(
      `UPDATE pending_ingest_batches SET fires_at = now()
         WHERE id = $1 AND fires_at > now()`,
      [batchId],
    )
  }
}
