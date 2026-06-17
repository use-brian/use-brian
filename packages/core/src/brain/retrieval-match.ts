/**
 * Retrieval-side local-match enqueue (Q3b of the brain-ingestion-
 * classification design thread).
 *
 * On every chat-route memory retrieval, check whether any retrieved
 * memory's summary mentions an entity that already exists in the
 * workspace. If yes — and we haven't already enqueued a candidate for
 * the same (memory_id, target_entity_id) pair — create a `mentioned`
 * edge linking the memory to the entity, and write an audit row in
 * `brain_candidates` so the action appears in `listBrainCandidates` /
 * `/brain recent`.
 *
 * The match is purely local — no LLM in the hot path. The signal is
 * usage-weighted: memories that get pulled into chat turns by retrieval
 * are exactly the ones worth linking eagerly.
 *
 * Failure isolated: every internal call is try/catch; this entire
 * function is invoked fire-and-forget from the chat route. A bug here
 * MUST NOT block memory retrieval.
 */

import type { AccessContext } from '../security/access-context.js'
import type { EntityLinksStore, EntityStore } from '../entities/types.js'
import type { BrainCandidateStore } from './candidates-types.js'

export interface RetrievedMemoryRef {
  id: string
  summary: string
}

export interface LocalMatchCheckDeps {
  ctx: AccessContext
  entityStore: EntityStore
  entityLinks: EntityLinksStore
  candidates: BrainCandidateStore
}

const PROPER_NOUN_PATTERN = /\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}\b/g

/**
 * Extract capitalized proper-noun phrases from a memory summary —
 * candidate entity references. The pattern matches 1-4 capitalized
 * words in sequence (e.g. "Alice", "Hinson HQ", "Notion Blocks API").
 * Returns deduplicated phrases in source order.
 */
export function extractProperNounCandidates(summary: string): string[] {
  if (!summary) return []
  const matches = summary.match(PROPER_NOUN_PATTERN)
  if (!matches) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of matches) {
    const norm = m.trim()
    if (norm.length < 2) continue
    if (seen.has(norm.toLowerCase())) continue
    seen.add(norm.toLowerCase())
    out.push(norm)
  }
  return out
}

/**
 * For each retrieved memory, look up any matching entities by display
 * name and enqueue an applied `edge` candidate per match. Skip the
 * memory entirely if its proper-noun extraction returns nothing
 * (`Likes ramen` has no capitalized phrase, so no entity match is
 * possible).
 *
 * Cap on the per-memory match count keeps a verbose memory summary
 * from fanning out into N candidate writes.
 */
export async function runLocalMatchCheck(
  memories: readonly RetrievedMemoryRef[],
  deps: LocalMatchCheckDeps,
  opts: { maxMatchesPerMemory?: number } = {},
): Promise<void> {
  const maxMatches = opts.maxMatchesPerMemory ?? 3
  for (const memory of memories) {
    const candidates = extractProperNounCandidates(memory.summary)
    if (candidates.length === 0) continue

    let matched = 0
    for (const phrase of candidates) {
      if (matched >= maxMatches) break
      try {
        const entity = await deps.entityStore.findByName(deps.ctx, phrase)
        if (!entity) continue
        await enqueueEdgeCandidate(memory, entity.id, deps)
        matched += 1
      } catch (err) {
        // Per-phrase failure — log and continue. Never throw out of
        // this loop; the chat retrieval has already returned.
        console.warn(
          `[retrieval-match] phrase "${phrase}" failed for memory ${memory.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }
}

async function enqueueEdgeCandidate(
  memory: RetrievedMemoryRef,
  entityId: string,
  deps: LocalMatchCheckDeps,
): Promise<void> {
  const link = await deps.entityLinks.create({
    sourceKind: 'memory',
    sourceId: memory.id,
    targetKind: 'entity',
    targetId: entityId,
    edgeType: 'mentioned',
    workspaceId: deps.ctx.workspaceId,
    source: 'extracted',
    userId: deps.ctx.userId,
    assistantId: deps.ctx.assistantId,
  })
  await deps.candidates.enqueue({
    workspaceId: deps.ctx.workspaceId,
    memoryId: memory.id,
    suggestedAction: 'edge',
    targetKind: 'entity_link',
    targetId: link.id,
    reason: 'retrieval-side local-match — memory summary mentions an existing entity',
    confidence: 0.6,
    autoApplied: true,
    createdByUserId: deps.ctx.userId,
    createdByAssistantId: deps.ctx.assistantId,
  })
}
