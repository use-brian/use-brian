/**
 * Domain summaries store — Layer 3 domain index produced by Deep
 * consolidation. See docs/architecture/context-engine/memory-system.md
 * ("Domain Summary Index") and docs/architecture/context-engine/memory-consolidation.md
 * ("Phase 3 — Deep").
 *
 * Rows are upserted per (assistant_id, user_id, app_id, domain) tuple.
 * Once a user crosses the MVP threshold (~50 memories), these rows
 * replace the raw non-identity memory list in the Layer 3 context
 * block, keeping it constant-size at scale.
 */

import { query } from './client.js'

export type DomainSummary = {
  id: string
  assistantId: string
  userId: string
  appId: string | null
  domain: string
  summary: string
  memoryCount: number
  memoryIds: string[]
  updatedAt: Date
}

const DOMAIN_SUMMARY_SELECT = `
  id, assistant_id as "assistantId", user_id as "userId", app_id as "appId",
  domain, summary, memory_count as "memoryCount", memory_ids as "memoryIds",
  updated_at as "updatedAt"
`

export async function upsertDomainSummary(params: {
  assistantId: string
  userId: string
  appId: string | null
  domain: string
  summary: string
  memoryIds: string[]
}): Promise<void> {
  await query(
    `INSERT INTO domain_summaries (assistant_id, user_id, app_id, domain, summary, memory_count, memory_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (assistant_id, user_id, app_id, domain)
     DO UPDATE SET
       summary = EXCLUDED.summary,
       memory_count = EXCLUDED.memory_count,
       memory_ids = EXCLUDED.memory_ids,
       updated_at = now()`,
    [
      params.assistantId, params.userId, params.appId,
      params.domain, params.summary, params.memoryIds.length, params.memoryIds,
    ],
  )
}

/**
 * Delete any domain summaries for (assistant, user, app) whose domain is
 * NOT in `keepDomains`. Called at the end of a Deep run so stale buckets
 * disappear after a rename or topic shift. Returns the number of rows
 * removed.
 */
export async function pruneStaleDomainSummaries(
  assistantId: string,
  userId: string,
  appId: string | null,
  keepDomains: string[],
): Promise<number> {
  // Use `app_id IS NOT DISTINCT FROM $3` so null matches null in the WHERE
  // clause — plain `=` would treat (null = null) as unknown and wipe the
  // shared-scope row unintentionally.
  const result = await query(
    `DELETE FROM domain_summaries
     WHERE assistant_id = $1 AND user_id = $2
       AND app_id IS NOT DISTINCT FROM $3
       AND NOT (domain = ANY($4))`,
    [assistantId, userId, appId, keepDomains],
  )
  return result.rowCount ?? 0
}

export async function listDomainSummaries(
  assistantId: string,
  userId: string,
  appId?: string | null,
): Promise<DomainSummary[]> {
  if (appId === undefined) {
    const result = await query<DomainSummary>(
      `SELECT ${DOMAIN_SUMMARY_SELECT} FROM domain_summaries
       WHERE assistant_id = $1 AND user_id = $2
       ORDER BY domain`,
      [assistantId, userId],
    )
    return result.rows
  }
  const result = await query<DomainSummary>(
    `SELECT ${DOMAIN_SUMMARY_SELECT} FROM domain_summaries
     WHERE assistant_id = $1 AND user_id = $2
       AND app_id IS NOT DISTINCT FROM $3
     ORDER BY domain`,
    [assistantId, userId, appId],
  )
  return result.rows
}
