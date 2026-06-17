/**
 * Episodic-memory retrieval + system-prompt formatting.
 *
 * Given the per-turn topic classification, fetch the most-relevant
 * episodic-memory rows for the active topic (and any related topics on
 * cross-topic turns) and format them into a `# Relevant topic history`
 * system-prompt block.
 *
 * Retrieval policy:
 *   - state = 'continue'     → return null (raw recent turns already
 *                              carry the info; injecting would just be noise)
 *   - state = 'shift'        → no episodic rows for a brand-new topic; return null
 *   - state = 'resume'       → top 3 rows for the active topic
 *   - state = 'cross-topic'  → top 2 rows for active + top 1 each for
 *                              up to 2 related topics
 *
 * Token budget: ~2000 tokens total. If the assembled block exceeds this,
 * oldest rows are dropped first.
 */

import type { EpisodicStore, EpisodicMemoryRecord } from './episodic-types.js'
import type { TopicClassification } from './topic-classifier.js'

const ROUGH_CHARS_PER_TOKEN = 4
const DEFAULT_TOKEN_BUDGET = 2_000

export type FetchEpisodicContextOptions = {
  store: EpisodicStore
  sessionId: string
  classification: TopicClassification | null
  tokenBudget?: number
}

export async function fetchEpisodicContext(
  opts: FetchEpisodicContextOptions,
): Promise<string | null> {
  const c = opts.classification
  if (!c || c.confidence === 0) return null
  if (c.state === 'continue' || c.state === 'shift') return null

  const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET

  // Fetch rows. Resume = deeper pull on the active topic. Cross-topic =
  // shallower pull on multiple topics so the block stays bounded.
  let rows: EpisodicMemoryRecord[] = []
  if (c.state === 'resume') {
    rows = await opts.store.fetchByTopic({
      sessionId: opts.sessionId,
      topicLabel: c.topic_label,
      limit: 3,
    })
  } else {
    // cross-topic
    const active = await opts.store.fetchByTopic({
      sessionId: opts.sessionId,
      topicLabel: c.topic_label,
      limit: 2,
    })
    rows = [...active]
    const related = c.related_topics ?? []
    for (const label of related.slice(0, 2)) {
      const r = await opts.store.fetchByTopic({
        sessionId: opts.sessionId,
        topicLabel: label,
        limit: 1,
      })
      rows = rows.concat(r)
    }
  }

  if (rows.length === 0) return null

  // Format. Trim to budget by dropping oldest rows first (rows are
  // already newest-first within each fetch, so drop from the tail).
  let assembled = formatEpisodicBlock(rows)
  while (estimateChars(assembled) > budget * ROUGH_CHARS_PER_TOKEN && rows.length > 1) {
    rows = rows.slice(0, -1)
    assembled = formatEpisodicBlock(rows)
  }

  return assembled
}

function formatEpisodicBlock(rows: EpisodicMemoryRecord[]): string {
  const byTopic = new Map<string, EpisodicMemoryRecord[]>()
  for (const r of rows) {
    const arr = byTopic.get(r.topicLabel) ?? []
    arr.push(r)
    byTopic.set(r.topicLabel, arr)
  }

  const sections: string[] = []
  for (const [label, topicRows] of byTopic) {
    const bodies = topicRows.map((r) => r.summary.trim()).join('\n\n---\n\n')
    sections.push(`## ${label}\n\n${bodies}`)
  }

  return (
    '# Relevant topic history\n\n' +
    'The following summaries describe earlier discussions in this session on topics the ' +
    "user's current message refers to. Use them as context; do not re-explain facts they " +
    "already cover.\n\n" +
    sections.join('\n\n')
  )
}

function estimateChars(s: string): number {
  return s.length
}
