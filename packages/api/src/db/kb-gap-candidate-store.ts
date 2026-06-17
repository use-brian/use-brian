/**
 * KB gap candidate store — weekly REM-aggregated retrieval-miss patterns.
 *
 * Backs `docs/architecture/context-engine/memory-consolidation.md` §CL-9 user-in-the-loop
 * drafting. The weekly aggregator clusters `retrieval_miss` rows by
 * embedding similarity and emits one candidate per cluster (≥ N
 * occurrences across ≥ 2 distinct sessions). The workspace owner sees
 * each open candidate as a notification — they Draft (which opens a
 * pre-filled KB editor) or Dismiss (suppressed N days). The system
 * never auto-writes KB rows; only the user can fill the answer.
 *
 * Workspace-scoped via RLS (mig 171).
 *
 * [COMP:api/kb-gap-candidate-store]
 */

import { query, queryWithRLS } from './client.js'

export type KbGapCandidateRow = {
  id: string
  workspaceId: string
  patternSummary: string
  evidenceMissIds: string[]
  occurrences: number
  distinctSessions: number
  dismissedAt: Date | null
  dismissedByUserId: string | null
  draftedAt: Date | null
  draftedByUserId: string | null
  createdAt: Date
}

export type KbGapCandidateInput = {
  workspaceId: string
  patternSummary: string
  evidenceMissIds: string[]
  occurrences: number
  distinctSessions: number
}

export type KbGapCandidateStore = {
  /** Insert a new candidate. System-level — written by the REM aggregator. */
  create(input: KbGapCandidateInput): Promise<KbGapCandidateRow>

  /** Open candidates for a workspace: not dismissed, not drafted. */
  listOpen(
    workspaceId: string,
    opts?: { actingUserId?: string },
  ): Promise<KbGapCandidateRow[]>

  /** User dismisses a candidate (suppress for N days). */
  dismiss(actingUserId: string, id: string): Promise<boolean>

  /** User opened the KB editor to draft an entry. */
  markDrafted(actingUserId: string, id: string): Promise<boolean>
}

const COLS_PUBLIC = `
  id,
  workspace_id          AS "workspaceId",
  pattern_summary       AS "patternSummary",
  evidence_miss_ids     AS "evidenceMissIds",
  occurrences,
  distinct_sessions     AS "distinctSessions",
  dismissed_at          AS "dismissedAt",
  dismissed_by_user_id  AS "dismissedByUserId",
  drafted_at            AS "draftedAt",
  drafted_by_user_id    AS "draftedByUserId",
  created_at            AS "createdAt"
`

export function createDbKbGapCandidateStore(): KbGapCandidateStore {
  return {
    async create(input) {
      const r = await query<KbGapCandidateRow>(
        `INSERT INTO kb_gap_candidate
           (workspace_id, pattern_summary, evidence_miss_ids, occurrences, distinct_sessions)
         VALUES ($1, $2, $3::uuid[], $4, $5)
         RETURNING ${COLS_PUBLIC}`,
        [
          input.workspaceId,
          input.patternSummary,
          input.evidenceMissIds,
          input.occurrences,
          input.distinctSessions,
        ],
      )
      return r.rows[0]
    },

    async listOpen(workspaceId, opts) {
      const sql = `
        SELECT ${COLS_PUBLIC}
        FROM kb_gap_candidate
        WHERE workspace_id = $1 AND dismissed_at IS NULL AND drafted_at IS NULL
        ORDER BY created_at DESC
      `
      if (opts?.actingUserId) {
        const r = await queryWithRLS<KbGapCandidateRow>(opts.actingUserId, sql, [workspaceId])
        return r.rows
      }
      const r = await query<KbGapCandidateRow>(sql, [workspaceId])
      return r.rows
    },

    async dismiss(actingUserId, id) {
      const r = await queryWithRLS(
        actingUserId,
        `UPDATE kb_gap_candidate
         SET dismissed_at = now(), dismissed_by_user_id = $1
         WHERE id = $2 AND dismissed_at IS NULL`,
        [actingUserId, id],
      )
      return (r.rowCount ?? 0) > 0
    },

    async markDrafted(actingUserId, id) {
      const r = await queryWithRLS(
        actingUserId,
        `UPDATE kb_gap_candidate
         SET drafted_at = now(), drafted_by_user_id = $1
         WHERE id = $2 AND drafted_at IS NULL`,
        [actingUserId, id],
      )
      return (r.rowCount ?? 0) > 0
    },
  }
}
