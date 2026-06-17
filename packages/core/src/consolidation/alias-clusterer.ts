/**
 * Heal-time LLM alias clustering (alias-as-data, Phase 4).
 *
 * Pure backend orchestration. Given a slice of workspace entities,
 * asks the LLM to group records that refer to the same real-world
 * thing (e.g. "DD" + "DeltaDeFi" + "deltadefi-protocol"). Output is
 * tier-tagged with a confidence score; the caller decides whether to
 * auto-apply (merge + add-alias) or surface as a candidate for user
 * review.
 *
 * Why this exists despite Pipeline B already deduping by name:
 *
 *   The Pipeline B dedup only catches lexical collisions. Semantic
 *   aliases (`DD` → `DeltaDeFi`) need either user teaching (`noteAlias`)
 *   or a periodic LLM sweep. This module is the sweep — it runs as a
 *   third pass inside `runEntityDedupe` when the caller opts in.
 *
 * Bounded surface — at most one LLM call per invocation; the entity
 * list is capped at `MAX_ENTITIES_IN_PROMPT` so token cost is
 * predictable. For very large workspaces the caller can re-invoke
 * with different slices (kind filter, offset, etc.).
 *
 * [COMP:brain/alias-clusterer]
 */

import { z } from 'zod'
import { collectStream } from '../providers/accumulator.js'
import type { LLMProvider } from '../providers/types.js'
import type { EntityKind, EntityRecord } from '../entities/types.js'

const MAX_ENTITIES_IN_PROMPT = 200

const clusterSchema = z.object({
  canonical_id: z.string(),
  alias_ids: z.array(z.string()).min(1),
  reasoning: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
})

const clusterResponseSchema = z.object({
  clusters: z.array(clusterSchema).max(50),
})

export type AliasCluster = {
  canonicalEntityId: string
  canonicalDisplayName: string
  canonicalKind: EntityKind
  aliasEntityIds: string[]
  aliasDisplayNames: string[]
  reasoning: string
  confidence: number
}

export interface AliasClustererDeps {
  entities: readonly EntityRecord[]
  provider: LLMProvider
  model: string
}

const SYSTEM_PROMPT =
  'You group entity records by real-world identity. Given entities ' +
  'from one workspace, you decide which refer to the same thing. ' +
  'Output ONE JSON object and nothing else. No prose, no markdown.'

function buildPrompt(entities: readonly EntityRecord[]): string {
  const lines: string[] = []
  lines.push('Entities (id | kind | display_name | aliases):')
  for (const e of entities) {
    const aliases = e.aliases.length > 0 ? ` aliases=[${e.aliases.join(', ')}]` : ''
    lines.push(`- id=${e.id} kind=${e.kind} name="${e.displayName}"${aliases}`)
  }
  lines.push('')
  lines.push(
    'Group entities that refer to the SAME real-world thing.',
    'Output JSON only:',
    '{',
    '  "clusters": [',
    '    {',
    '      "canonical_id": "<id from the list — the most canonical/full name in the group>",',
    '      "alias_ids": ["<id>", "<id>"],',
    '      "reasoning": "<one sentence — why these are the same>",',
    '      "confidence": <0..1>',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- Singleton entities (no aliases) are OMITTED entirely. Only emit clusters of size >= 2.',
    '- canonical_id must be one of the input ids.',
    '- alias_ids must all be input ids and must NOT equal canonical_id.',
    '- Confidence >= 0.9 only when the link is clear (acronym, brand-shortform, org/repo, well-known nickname).',
    '- Confidence 0.6-0.85 for plausible-but-uncertain matches.',
    '- If you cannot articulate a clear reason, do NOT emit the cluster.',
    '- Do not merge across genuinely-distinct kinds (e.g. a `person` named "Hydra" is NOT the `product` named "Hydra").',
  )
  return lines.join('\n')
}

/**
 * Single LLM call that returns alias clusters. Throws nothing — bad
 * model output / network errors produce an empty result with a logged
 * warning. The caller treats empty as "nothing to apply".
 */
export async function clusterEntityAliases(
  deps: AliasClustererDeps,
): Promise<AliasCluster[]> {
  if (deps.entities.length < 2) return []
  const sliced = deps.entities.slice(0, MAX_ENTITIES_IN_PROMPT)
  const prompt = buildPrompt(sliced)
  const byId = new Map(sliced.map((e) => [e.id, e]))

  let raw: string
  try {
    const response = await collectStream(
      deps.provider.stream({
        model: deps.model,
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 4000,
        temperature: 0.1,
      }),
    )
    raw = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
  } catch (err) {
    console.warn(
      `[alias-clusterer] LLM call failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }

  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) {
    console.warn('[alias-clusterer] no JSON object in model output')
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch (err) {
    console.warn(
      `[alias-clusterer] JSON.parse failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }

  const result = clusterResponseSchema.safeParse(parsed)
  if (!result.success) {
    console.warn(
      `[alias-clusterer] schema mismatch: ${
        result.error.issues[0]?.message ?? 'unknown'
      }`,
    )
    return []
  }

  const out: AliasCluster[] = []
  for (const c of result.data.clusters) {
    const canonical = byId.get(c.canonical_id)
    if (!canonical) continue
    const aliases: EntityRecord[] = []
    for (const aid of c.alias_ids) {
      if (aid === c.canonical_id) continue
      const e = byId.get(aid)
      if (e) aliases.push(e)
    }
    if (aliases.length === 0) continue
    out.push({
      canonicalEntityId: canonical.id,
      canonicalDisplayName: canonical.displayName,
      canonicalKind: canonical.kind,
      aliasEntityIds: aliases.map((a) => a.id),
      aliasDisplayNames: aliases.map((a) => a.displayName),
      reasoning: c.reasoning,
      confidence: c.confidence,
    })
  }
  return out
}
