/**
 * Retrieval-miss store — per-session inline log of query reformulations
 * that returned meaningfully different results.
 *
 * Backs `docs/architecture/context-engine/memory-consolidation.md` §CL-9 within-session
 * detection. The inline detector embeds each query, compares to prior
 * queries in the same session, and inserts a row when
 * `cosine ≥ 0.85 AND top-K overlap < 50 %`. The 5-misses-per-session cap
 * is enforced in the application via `countForSession`.
 *
 * Workspace-scoped via RLS (mig 171).
 *
 * [COMP:api/retrieval-miss-store]
 */

import { query, queryWithRLS } from './client.js'

export type RetrievalMissRow = {
  id: string
  sessionId: string
  workspaceId: string
  userId: string
  priorQueryHash: string
  newQueryHash: string
  priorQueryText: string
  newQueryText: string
  topKOverlap: number
  cosineSimilarity: number
  at: Date
}

export type RecordRetrievalMissInput = {
  sessionId: string
  workspaceId: string
  userId: string
  priorQueryText: string
  newQueryText: string
  priorQueryHash: string
  newQueryHash: string
  topKOverlap: number
  cosineSimilarity: number
}

export type RetrievalMissStore = {
  /** Insert a single miss row. System-level — fires from the chat hot path. */
  record(input: RecordRetrievalMissInput): Promise<RetrievalMissRow>

  /**
   * Count of miss rows already recorded for a session. The inline
   * detector reads this to enforce the per-session cap (default 5).
   */
  countForSession(sessionId: string): Promise<number>

  /**
   * Workspace-wide read for the weekly REM aggregator. Filters by an
   * inclusive `since` and an exclusive `until` so consecutive weekly
   * runs don't double-count.
   */
  listForAggregation(workspaceId: string, since: Date, until: Date): Promise<RetrievalMissRow[]>
}

const COLS_PUBLIC = `
  id,
  session_id        AS "sessionId",
  workspace_id      AS "workspaceId",
  user_id           AS "userId",
  prior_query_hash  AS "priorQueryHash",
  new_query_hash    AS "newQueryHash",
  prior_query_text  AS "priorQueryText",
  new_query_text    AS "newQueryText",
  top_k_overlap     AS "topKOverlap",
  cosine_similarity AS "cosineSimilarity",
  at
`

export function createDbRetrievalMissStore(): RetrievalMissStore {
  return {
    async record(input) {
      const r = await query<RetrievalMissRow>(
        `INSERT INTO retrieval_miss (
           session_id, workspace_id, user_id,
           prior_query_hash, new_query_hash,
           prior_query_text, new_query_text,
           top_k_overlap, cosine_similarity
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING ${COLS_PUBLIC}`,
        [
          input.sessionId,
          input.workspaceId,
          input.userId,
          input.priorQueryHash,
          input.newQueryHash,
          input.priorQueryText,
          input.newQueryText,
          input.topKOverlap,
          input.cosineSimilarity,
        ],
      )
      return r.rows[0]
    },

    async countForSession(sessionId) {
      const r = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM retrieval_miss WHERE session_id = $1`,
        [sessionId],
      )
      return Number(r.rows[0]?.count ?? 0)
    },

    async listForAggregation(workspaceId, since, until) {
      const r = await query<RetrievalMissRow>(
        `SELECT ${COLS_PUBLIC}
         FROM retrieval_miss
         WHERE workspace_id = $1 AND at >= $2 AND at < $3
         ORDER BY at ASC`,
        [workspaceId, since, until],
      )
      return r.rows
    },
  }
}

// Exported for callers that want to read misses with RLS context (e.g. the
// per-session miss listing surface in the workspace dashboard).
export async function listMissesForSession(
  actingUserId: string,
  sessionId: string,
): Promise<RetrievalMissRow[]> {
  const r = await queryWithRLS<RetrievalMissRow>(
    actingUserId,
    `SELECT ${COLS_PUBLIC}
     FROM retrieval_miss
     WHERE session_id = $1
     ORDER BY at ASC`,
    [sessionId],
  )
  return r.rows
}
