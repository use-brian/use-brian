/**
 * Session-state memory tier.
 *
 * Per-session, upsert-in-place records of "what's currently open or recently
 * resolved" within a session. Distinct from long-term `memories`
 * (cross-session, append + consolidate) and `episodic_memories` (topic-keyed,
 * compaction-boundary materialized, classifier-gated retrieval).
 *
 * Injected unconditionally into every turn's Layer-1 prompt as
 * `# Open commitments`, so the model never has to re-derive current
 * commitment status from linear session history.
 *
 * Written by two paths, matching how long-term memory writes are structured:
 *   - `tool`       — explicit `trackCommitment` / `resolveCommitment` calls
 *   - `diff-pass`  — post-turn LLM safety net (analogous to pre-compaction
 *                    LLM extraction for long-term memory)
 *   - `scheduler`  — reserved for future scheduled-job-driven writes
 *
 * See `docs/architecture/context-engine/session-state.md`.
 */

export type SessionStateStatus = 'open' | 'resolved' | 'cancelled'

export type SessionStateSource = 'tool' | 'diff-pass' | 'scheduler'

export type SessionStateRecord = {
  id: string
  sessionId: string
  userId: string
  assistantId: string
  key: string
  status: SessionStateStatus
  summary: string
  detail: string | null
  source: SessionStateSource
  createdAt: Date
  updatedAt: Date
  resolvedAt: Date | null
}

export type SessionStateStore = {
  /**
   * Insert a new commitment or update an existing one for `(sessionId, key)`.
   * On update, `status` is set back to `'open'` (reopens a resolved/cancelled
   * row when the model re-acknowledges it) and `summary`/`detail` are
   * overwritten. Callers should not rely on this for idempotency — they
   * should dedupe against `listOpenBySession` first.
   */
  upsert(params: {
    sessionId: string
    userId: string
    assistantId: string
    key: string
    summary: string
    detail?: string | null
    source: SessionStateSource
  }): Promise<SessionStateRecord>

  /**
   * Flip the row identified by `(sessionId, key)` to `'resolved'` with
   * `resolved_at = now()`. Returns the updated row, or `null` if no row
   * with that key exists (informational no-op — callers surface this to
   * the model as "no open commitment with key X").
   */
  resolve(params: {
    sessionId: string
    key: string
    source: SessionStateSource
  }): Promise<SessionStateRecord | null>

  /**
   * Fetch all open rows for a session, newest `updated_at` first. Used by
   * the retrieval formatter (every turn) and by the diff pass (for dedup).
   */
  listOpenBySession(sessionId: string): Promise<SessionStateRecord[]>

  /**
   * Fetch all rows for a session (any status), newest `updated_at` first.
   * Used by the retrieval formatter when budget allows including recently-
   * resolved rows; capped by `limit` (default 50).
   */
  listRecentBySession(
    sessionId: string,
    limit?: number,
  ): Promise<SessionStateRecord[]>

  /**
   * Hard-delete resolved/cancelled rows in a session whose `resolved_at` is
   * older than `olderThan`. Called by the housekeeping pass piggy-backed on
   * proactive compaction. Returns the number of rows deleted.
   */
  purgeResolvedOlderThan(
    sessionId: string,
    olderThan: Date,
  ): Promise<number>
}
