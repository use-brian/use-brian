/**
 * memory_recall_events — per-turn log linking memory recalls to the
 * assistant turn they informed (migration 167).
 *
 * The existing aggregate counters on `memories` (`recall_count`,
 * `last_recalled_at`, `query_hashes`, `recall_days`) tell us *how often*
 * a memory is reached for; this store tells us *which turn each recall
 * fed*. Pairing recalls with their assistant turn lets us JOIN to user
 * feedback (`analytics_events` rows with `event_name='feedback_negative'`
 * / `'feedback_positive'`, keyed on `metadata.messageId`) and surface
 * memories that consistently land in low-rated responses.
 *
 * Writes are system-level (recall logging shouldn't be RLS-gated — it
 * happens before the model emits, and we don't want the per-turn buffer
 * to fail because the connection lost its `app.current_user_id` GUC).
 * Reads are system-bypass too; the route layer enforces workspace
 * membership before issuing the JOIN.
 *
 * [COMP:api/memory-recall-events-store]
 *
 * See `docs/architecture/context-engine/memory-system.md` →
 * "Recall-outcome tagging".
 */

import { query } from './client.js'
import type { MemoryRecallSink } from '@use-brian/core'

export type MemoryRecallKind = 'index_inject' | 'tool_call' | 'consolidation'

/**
 * Store handle bundled into `chatRoutes` options. The shape matches the
 * core `MemoryRecallSink` interface (so it slots directly into a
 * `MemoryRecallBuffer`) plus the additional helpers the chat route
 * needs (`attachAssistantMessageId`, the JOIN reads). Constructed once
 * at boot via `createMemoryRecallEventsStore()`.
 */
export type MemoryRecallEventsStore = MemoryRecallSink & {
  recordRecall: typeof recordRecall
  attachAssistantMessageId: typeof attachAssistantMessageId
  listMemoriesByRecentOutcome: typeof listMemoriesByRecentOutcome
  listRecentRecallsForMemory: typeof listRecentRecallsForMemory
}

/** Build the store handle. Pure constructor — the DB pool is module-global. */
export function createMemoryRecallEventsStore(): MemoryRecallEventsStore {
  return {
    recordRecall,
    recordRecallBatch,
    attachAssistantMessageId,
    listMemoriesByRecentOutcome,
    listRecentRecallsForMemory,
  }
}

export type MemoryRecallEvent = {
  id: string
  memoryId: string
  sessionId: string
  assistantMessageId: string | null
  workspaceId: string
  userId: string
  recallKind: MemoryRecallKind
  createdAt: Date
}

const RECALL_SELECT = `
  id,
  memory_id            as "memoryId",
  session_id           as "sessionId",
  assistant_message_id as "assistantMessageId",
  workspace_id         as "workspaceId",
  user_id              as "userId",
  recall_kind          as "recallKind",
  created_at           as "createdAt"
`

export type RecordRecallParams = {
  memoryId: string
  sessionId: string
  workspaceId: string
  userId: string
  recallKind: MemoryRecallKind
  /**
   * Optional. Most recall sites don't have the assistant message id at
   * recall time (recall happens before the message commits). The chat
   * route's per-turn buffer fills this in via `attachAssistantMessageId`
   * once the message lands. A future callsite (e.g. a writer that already
   * has the message id) can pass it here to skip the two-phase dance.
   */
  assistantMessageId?: string | null
}

/**
 * Record a single recall event. Most callers use `recordRecallBatch`
 * instead — the per-turn buffer flushes a batch of memory IDs for the
 * same `(session_id, assistant_message_id, recall_kind)` triple.
 */
export async function recordRecall(
  params: RecordRecallParams,
): Promise<MemoryRecallEvent> {
  const result = await query<MemoryRecallEvent>(
    `INSERT INTO memory_recall_events (
       memory_id, session_id, assistant_message_id,
       workspace_id, user_id, recall_kind
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${RECALL_SELECT}`,
    [
      params.memoryId,
      params.sessionId,
      params.assistantMessageId ?? null,
      params.workspaceId,
      params.userId,
      params.recallKind,
    ],
  )
  return result.rows[0]
}

/**
 * Batch-insert recall events. The per-turn buffer typically flushes
 * 10-40 memory IDs at once (the per-turn memory index cap) — one
 * `INSERT … VALUES (…), (…), …` keeps the DB round-trip count at 1
 * regardless of batch size. Empty batches no-op.
 *
 * All rows in a single call must share `(sessionId, workspaceId, userId,
 * recallKind, assistantMessageId)`. The buffer maintains that invariant
 * by partitioning queued recalls by `recallKind`.
 */
export async function recordRecallBatch(params: {
  memoryIds: readonly string[]
  sessionId: string
  workspaceId: string
  userId: string
  recallKind: MemoryRecallKind
  assistantMessageId?: string | null
}): Promise<void> {
  if (params.memoryIds.length === 0) return

  // De-dupe inside a single batch — a memory can appear twice in a
  // turn's recall stream (once via index_inject, once via tool_call —
  // those are different batches), but two `index_inject` rows for the
  // same memory in the same turn are noise. Cheaper to filter in JS
  // than to add a partial unique index.
  const seen = new Set<string>()
  const uniq: string[] = []
  for (const id of params.memoryIds) {
    if (seen.has(id)) continue
    seen.add(id)
    uniq.push(id)
  }

  // Build `($1, $2, $3, $4, $5, $6), ($7, $2, $3, $4, $5, $6), …`. Each
  // row varies only in memory_id; everything else is shared.
  const valuesClauses: string[] = []
  const values: unknown[] = [
    params.sessionId,
    params.assistantMessageId ?? null,
    params.workspaceId,
    params.userId,
    params.recallKind,
  ]
  for (let i = 0; i < uniq.length; i++) {
    values.push(uniq[i])
    valuesClauses.push(`($${values.length}, $1, $2, $3, $4, $5)`)
  }

  await query(
    `INSERT INTO memory_recall_events (
       memory_id, session_id, assistant_message_id,
       workspace_id, user_id, recall_kind
     )
     VALUES ${valuesClauses.join(', ')}`,
    values,
  )
}

/**
 * Attach an `assistant_message_id` to every recall row for a session
 * that doesn't yet have one. Called by the chat route once the assistant
 * message commits — the per-turn buffer's recall rows were inserted
 * before the message id existed.
 *
 * Scoped to `(session_id, assistant_message_id IS NULL)` so a later
 * turn's recalls aren't accidentally re-stamped: each turn's recalls
 * land in the table, then immediately get stamped before the next turn
 * begins.
 *
 * Returns the count of rows updated — useful for instrumentation and
 * the JOIN test ("did the flush land?").
 */
export async function attachAssistantMessageId(
  sessionId: string,
  assistantMessageId: string,
): Promise<number> {
  const result = await query(
    `UPDATE memory_recall_events
        SET assistant_message_id = $2
      WHERE session_id = $1
        AND assistant_message_id IS NULL`,
    [sessionId, assistantMessageId],
  )
  return result.rowCount ?? 0
}

/**
 * One row per memory recalled in the time window, with aggregate counts
 * of downstream positive / negative feedback. Backs the bad-outcome
 * surface in the staged-memory review UI (`GET /api/memories?
 * include=bad_outcome`).
 *
 * The JOIN walks:
 *
 *   memory_recall_events  (memory_id, assistant_message_id)
 *     ↘
 *      analytics_events  (metadata->>'messageId' = mre.assistant_message_id,
 *                         event_name IN ('feedback_positive','feedback_negative'))
 *
 * `negativeCount` counts distinct `(assistant_message_id)` pairs where
 * feedback was negative — a thumb-down on a single turn that recalled 5
 * memories contributes 1 to each memory, not 5.
 *
 * `correctionCount` counts feedback rows where the user wrote follow-up
 * details (the feedback route stores them in `metadata.details`). A
 * pure thumb-down without details still counts to `negativeCount`; only
 * those with substantive details bump `correctionCount`.
 *
 * `windowDays` is the lookback in days. Filtering by `mre.created_at`
 * lets the partial index `idx_memory_recall_events_workspace_created`
 * drive the scan.
 *
 * System-level — caller enforces workspace membership.
 */
export type MemoryWithOutcomeScore = {
  memoryId: string
  recallCount: number
  positiveCount: number
  negativeCount: number
  correctionCount: number
}

export async function listMemoriesByRecentOutcome(params: {
  workspaceId: string
  windowDays: number
  /**
   * `'negative'` filters to memories with at least one negative-feedback
   * recall event. `'positive'` filters to positive. `'any'` returns
   * every recalled memory in the window regardless of feedback presence.
   */
  sentimentFilter?: 'negative' | 'positive' | 'any'
  /**
   * Only return memories whose `negativeCount + correctionCount` meets
   * this floor. The default (2) matches the "consistently led to bad
   * responses" threshold described in the task spec — a single bad turn
   * is noise; two is a pattern.
   */
  minBadCount?: number
}): Promise<MemoryWithOutcomeScore[]> {
  const filter = params.sentimentFilter ?? 'any'
  const minBadCount = params.minBadCount ?? 0

  // The `correctionCount` heuristic: a feedback row counts as a
  // "correction" when `metadata.details` is a non-empty string AND its
  // trimmed length is at least 10 chars — same threshold the feedback
  // route uses to decide whether to ALSO save a memory (see
  // `routes/feedback.ts:55`). Keeping the thresholds aligned means the
  // review surface's "consistently led to bad responses" badge tracks
  // the same signal that already drives memory creation.
  const result = await query<{
    memoryId: string
    recallCount: string
    positiveCount: string
    negativeCount: string
    correctionCount: string
  }>(
    `WITH recalls_in_window AS (
       SELECT mre.memory_id, mre.assistant_message_id
         FROM memory_recall_events mre
        WHERE mre.workspace_id = $1
          AND mre.created_at >= now() - ($2 || ' days')::interval
          AND mre.assistant_message_id IS NOT NULL
     ),
     turn_feedback AS (
       SELECT ae.metadata->>'messageId' AS message_id,
              ae.event_name,
              ae.metadata->>'details'  AS details
         FROM analytics_events ae
        WHERE ae.event_name IN ('feedback_positive', 'feedback_negative')
          AND ae.created_at >= now() - ($2 || ' days')::interval
     )
     SELECT r.memory_id AS "memoryId",
            count(*)::text AS "recallCount",
            count(*) FILTER (WHERE tf.event_name = 'feedback_positive')::text
              AS "positiveCount",
            count(*) FILTER (WHERE tf.event_name = 'feedback_negative')::text
              AS "negativeCount",
            count(*) FILTER (
              WHERE tf.event_name = 'feedback_negative'
                AND tf.details IS NOT NULL
                AND length(trim(tf.details)) >= 10
            )::text AS "correctionCount"
       FROM recalls_in_window r
       LEFT JOIN turn_feedback tf
              ON tf.message_id = r.assistant_message_id::text
      GROUP BY r.memory_id
      HAVING (
        CASE
          WHEN $3::text = 'negative' THEN count(*) FILTER (WHERE tf.event_name = 'feedback_negative') > 0
          WHEN $3::text = 'positive' THEN count(*) FILTER (WHERE tf.event_name = 'feedback_positive') > 0
          ELSE true
        END
      )
        AND (
          count(*) FILTER (WHERE tf.event_name = 'feedback_negative')
          + count(*) FILTER (
              WHERE tf.event_name = 'feedback_negative'
                AND tf.details IS NOT NULL
                AND length(trim(tf.details)) >= 10
            )
        ) >= $4`,
    [params.workspaceId, params.windowDays, filter, minBadCount],
  )

  return result.rows.map((r) => ({
    memoryId: r.memoryId,
    recallCount: Number(r.recallCount),
    positiveCount: Number(r.positiveCount),
    negativeCount: Number(r.negativeCount),
    correctionCount: Number(r.correctionCount),
  }))
}

/**
 * Per-memory recall history — every recall event for a single memory
 * with the assistant message id and any feedback signal for that turn.
 * Drives the per-memory detail panel in the review UI.
 *
 * Returns rows ordered newest-first, capped at `limit` (default 50). A
 * higher cap is intentionally not exposed — the review panel doesn't
 * scroll past the recent window, and unbounded reads make the
 * indexed-DESC scan worse than a worker batch read.
 */
export type RecallEventWithFeedback = {
  id: string
  memoryId: string
  sessionId: string
  assistantMessageId: string | null
  recallKind: MemoryRecallKind
  createdAt: Date
  /** 'positive', 'negative', or null when no feedback was recorded. */
  feedbackKind: 'positive' | 'negative' | null
  feedbackDetails: string | null
}

export async function listRecentRecallsForMemory(
  memoryId: string,
  limit = 50,
): Promise<RecallEventWithFeedback[]> {
  const result = await query<{
    id: string
    memoryId: string
    sessionId: string
    assistantMessageId: string | null
    recallKind: MemoryRecallKind
    createdAt: Date
    feedbackKind: 'positive' | 'negative' | null
    feedbackDetails: string | null
  }>(
    `SELECT mre.id,
            mre.memory_id            AS "memoryId",
            mre.session_id           AS "sessionId",
            mre.assistant_message_id AS "assistantMessageId",
            mre.recall_kind          AS "recallKind",
            mre.created_at           AS "createdAt",
            CASE
              WHEN ae.event_name = 'feedback_positive' THEN 'positive'
              WHEN ae.event_name = 'feedback_negative' THEN 'negative'
              ELSE NULL
            END AS "feedbackKind",
            ae.metadata->>'details' AS "feedbackDetails"
       FROM memory_recall_events mre
       LEFT JOIN LATERAL (
         SELECT event_name, metadata
           FROM analytics_events
          WHERE metadata->>'messageId' = mre.assistant_message_id::text
            AND event_name IN ('feedback_positive', 'feedback_negative')
          ORDER BY created_at DESC
          LIMIT 1
       ) ae ON true
      WHERE mre.memory_id = $1
      ORDER BY mre.created_at DESC
      LIMIT $2`,
    [memoryId, limit],
  )
  return result.rows
}
