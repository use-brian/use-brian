/**
 * Short-term / episodic memory tier.
 *
 * Topic-keyed, session-scoped summaries produced by topic-structured
 * compaction. Sits between raw session messages and the long-term
 * `memories` table. Retrieved when the per-turn topic classifier detects
 * `resume` or `cross-topic` so the model has prior-topic history even
 * after compaction has cleared it from the live context.
 *
 * See docs/architecture/context-engine/compaction.md.
 */

export type EpisodicMessageSpan = {
  fromSequence: number
  toSequence: number
  turnCount: number
  fromMsgId?: string
  toMsgId?: string
}

export type EpisodicMemoryRecord = {
  id: string
  userId: string
  assistantId: string
  sessionId: string
  topicLabel: string
  summary: string
  messageSpan: EpisodicMessageSpan
  entityRefs: unknown[] | null
  createdAt: Date
  lastAccessedAt: Date
  accessCount: number
  /**
   * Number of subsequent compactions this row has survived without being
   * evicted (access_count==0) or promoted. Starts at 0, bumped each time
   * compaction's housekeeping pass keeps the row. At the promotion
   * threshold it graduates to `memories` as a `context`-type row with
   * source='episodic-graduation' and the episodic row is deleted.
   * See docs/context-engine/compaction.md → "Episodic lifecycle".
   */
  survivalCount: number
}

export type EpisodicStore = {
  /**
   * Persist an episodic-memory row. Called by proactive compaction when
   * the multi-topic profile emits a per-topic section.
   */
  create(params: {
    userId: string
    assistantId: string
    sessionId: string
    topicLabel: string
    summary: string
    messageSpan: EpisodicMessageSpan
    entityRefs?: unknown[]
  }): Promise<EpisodicMemoryRecord>

  /**
   * Fetch the most-recent N rows for a (session, topic) pair.
   * Side-effect: bumps last_accessed_at + access_count on returned rows.
   * Returns newest first.
   */
  fetchByTopic(params: {
    sessionId: string
    topicLabel: string
    limit?: number
  }): Promise<EpisodicMemoryRecord[]>

  /**
   * Fetch all rows for a session (audit / admin).
   */
  fetchBySession(params: {
    sessionId: string
    limit?: number
  }): Promise<EpisodicMemoryRecord[]>

  /**
   * Enumerate distinct topic labels in a session, newest first.
   * Used as input to the topic classifier's `knownTopicsThisSession`.
   */
  listTopicsBySession(params: {
    sessionId: string
    limit?: number
  }): Promise<string[]>

  /**
   * Fetch every episodic row for a session without bumping access
   * counters. Used by the compaction housekeeping pass to decide which
   * rows to evict, promote, or keep.
   */
  listBySession(sessionId: string): Promise<EpisodicMemoryRecord[]>

  /**
   * Hard-delete an episodic row by id. Called by the housekeeping
   * pass for evictions (access_count==0) and after successful
   * promotions to long-term memories.
   */
  deleteById(id: string): Promise<void>

  /**
   * Bulk-increment the `survival_count` of the given rows by 1. Called
   * by the housekeeping pass for rows that were neither evicted nor
   * promoted in the current compaction. No-op when the list is empty.
   */
  incrementSurvivalCount(ids: string[]): Promise<void>
}
