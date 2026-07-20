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
  source: string
  fires_at: Date
  events: unknown[]
  created_at: Date
  episode_sensitivity: 'public' | 'internal' | 'confidential' | null
}

function rowToBatch(row: BatchRow): PendingBatch {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ruleId: row.rule_id,
    source: row.source,
    firesAt: row.fires_at,
    events: Array.isArray(row.events) ? row.events : [],
    createdAt: row.created_at,
    episodeSensitivity: row.episode_sensitivity,
  }
}

export function createDbBatchStore(): BatchStore {
  return {
    async withClaimedBatches(limit, handler) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const result = await client.query<BatchRow>(
          `SELECT id, workspace_id, rule_id, source, fires_at, events,
                  created_at, episode_sensitivity
             FROM pending_ingest_batches
             WHERE fires_at < now() AND processed_at IS NULL
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
      `UPDATE pending_ingest_batches SET events = events || $2::jsonb
         WHERE id = $1
         RETURNING id, length(events::text) AS chars`,
      [existing.rows[0].id, eventJson],
    )
    batchId = updated.rows[0]!.id
    accumulatedChars = Number(updated.rows[0]!.chars)
  } else {
    const inserted = await pool.query<{ id: string; chars: number | string }>(
      `INSERT INTO pending_ingest_batches
         (workspace_id, rule_id, source, fires_at, events, episode_sensitivity)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id, length(events::text) AS chars`,
      [
        input.workspaceId,
        input.ruleId,
        input.source,
        input.firesAt,
        eventJson,
        input.episodeSensitivity ?? null,
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
