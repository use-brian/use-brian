import { query } from './client.js'
import type { EpisodicMessageSpan } from '@use-brian/core'

export type EpisodicMemoryRow = {
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
  survivalCount: number
}

const SELECT = `
  id,
  user_id as "userId",
  assistant_id as "assistantId",
  session_id as "sessionId",
  topic_label as "topicLabel",
  summary,
  message_span as "messageSpan",
  entity_refs as "entityRefs",
  created_at as "createdAt",
  last_accessed_at as "lastAccessedAt",
  access_count as "accessCount",
  survival_count as "survivalCount"
`

export async function createEpisodicMemory(params: {
  userId: string
  assistantId: string
  sessionId: string
  topicLabel: string
  summary: string
  messageSpan: EpisodicMessageSpan
  entityRefs?: unknown[]
}): Promise<EpisodicMemoryRow> {
  const result = await query<EpisodicMemoryRow>(
    `INSERT INTO episodic_memories
       (user_id, assistant_id, session_id, topic_label, summary, message_span, entity_refs)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SELECT}`,
    [
      params.userId,
      params.assistantId,
      params.sessionId,
      params.topicLabel,
      params.summary,
      JSON.stringify(params.messageSpan),
      params.entityRefs ? JSON.stringify(params.entityRefs) : null,
    ],
  )
  return result.rows[0]
}

/**
 * Fetch rows for (session, topic_label) ordered newest-accessed first.
 * Bumps last_accessed_at + access_count on the returned rows.
 */
export async function fetchEpisodicByTopic(params: {
  sessionId: string
  topicLabel: string
  limit?: number
}): Promise<EpisodicMemoryRow[]> {
  const limit = params.limit ?? 3
  const result = await query<EpisodicMemoryRow>(
    `UPDATE episodic_memories
        SET last_accessed_at = now(),
            access_count = access_count + 1
      WHERE id IN (
        SELECT id FROM episodic_memories
         WHERE session_id = $1 AND topic_label = $2
         ORDER BY last_accessed_at DESC
         LIMIT $3
      )
     RETURNING ${SELECT}`,
    [params.sessionId, params.topicLabel, limit],
  )
  // Preserve newest-first ordering that the inner SELECT applied.
  return result.rows.sort(
    (a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime(),
  )
}

export async function fetchEpisodicBySession(params: {
  sessionId: string
  limit?: number
}): Promise<EpisodicMemoryRow[]> {
  const limit = params.limit ?? 50
  const result = await query<EpisodicMemoryRow>(
    `SELECT ${SELECT}
     FROM episodic_memories
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [params.sessionId, limit],
  )
  return result.rows
}

/**
 * Enumerate distinct topic labels in a session, newest first by
 * most-recent episode creation.
 */
export async function listEpisodicTopicsBySession(params: {
  sessionId: string
  limit?: number
}): Promise<string[]> {
  const limit = params.limit ?? 20
  const result = await query<{ topicLabel: string }>(
    `SELECT topic_label as "topicLabel"
     FROM (
       SELECT topic_label, MAX(created_at) AS last_created
       FROM episodic_memories
       WHERE session_id = $1
       GROUP BY topic_label
       ORDER BY last_created DESC
       LIMIT $2
     ) t`,
    [params.sessionId, limit],
  )
  return result.rows.map((r) => r.topicLabel)
}

/**
 * Fetch every episodic row for a session without bumping access
 * counters. Used by the compaction housekeeping pass to decide which
 * rows to evict, promote, or keep.
 */
export async function listEpisodicBySession(
  sessionId: string,
): Promise<EpisodicMemoryRow[]> {
  const result = await query<EpisodicMemoryRow>(
    `SELECT ${SELECT}
     FROM episodic_memories
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId],
  )
  return result.rows
}

export async function deleteEpisodicById(id: string): Promise<void> {
  await query(`DELETE FROM episodic_memories WHERE id = $1`, [id])
}

/**
 * Bulk-increment survival_count by 1 for the given rows. No-op for
 * an empty id list so the caller doesn't have to guard.
 */
export async function incrementEpisodicSurvivalCount(
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  await query(
    `UPDATE episodic_memories
        SET survival_count = survival_count + 1
      WHERE id = ANY($1::uuid[])`,
    [ids],
  )
}
