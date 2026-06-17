import { collectStream } from '../providers/accumulator.js'
import type { LLMProvider, TokenUsage } from '../providers/types.js'
import type { EntityCandidate, EntityMention } from './types.js'

export type ResolveTier = 'exact' | 'canonical_id' | 'fuzzy' | 'llm'

export type ResolveResult =
  | {
      status: 'resolved'
      tier: ResolveTier
      entityId: string
      score: number
      flagged?: boolean
      usage?: TokenUsage
      model?: string
    }
  | { status: 'no_match' }
  | {
      status: 'ambiguous'
      tier: ResolveTier
      candidates: EntityCandidate[]
      usage?: TokenUsage
      model?: string
    }

export interface ResolveOptions {
  mention: EntityMention
  candidates: EntityCandidate[]
  fuzzyThreshold?: number
  llm?: { provider: LLMProvider; model: string }
}

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/^['"“”]+|['"“”.,;:!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeCanonical(s: string): string {
  return s.toLowerCase().trim()
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatches = new Array<boolean>(a.length).fill(false)
  const bMatches = new Array<boolean>(b.length).fill(false)

  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance)
    const end = Math.min(i + matchDistance + 1, b.length)
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue
      if (a[i] !== b[j]) continue
      aMatches[i] = true
      bMatches[j] = true
      matches++
      break
    }
  }

  if (matches === 0) return 0

  let k = 0
  let transpositions = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  transpositions = Math.floor(transpositions / 2)

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3

  let prefix = 0
  const prefixCap = Math.min(4, Math.min(a.length, b.length))
  for (let i = 0; i < prefixCap; i++) {
    if (a[i] === b[i]) prefix++
    else break
  }

  return jaro + prefix * 0.1 * (1 - jaro)
}

function filterByKind(candidates: EntityCandidate[], kind: EntityMention['kind']): EntityCandidate[] {
  return candidates.filter((c) => c.kind === kind)
}

const DISAMBIGUATION_SYSTEM_PROMPT = `You are an entity disambiguation classifier.

The user mentions an entity by name. You will see a small list of candidate entities from the same workspace. Pick the single best match by id, or return "ambiguous" if you cannot confidently distinguish them.

Output ONLY a JSON object of one of these two shapes:
{"id": "<exact id from the candidate list>"}
{"id": "ambiguous"}

No prose, no markdown. If unsure, prefer "ambiguous" — a wrong guess is worse than asking the user.`

function buildDisambiguationPrompt(mention: EntityMention, candidates: EntityCandidate[]): string {
  const lines: string[] = []
  lines.push(`Mention: ${mention.display_name}`)
  if (mention.canonical_id) lines.push(`Mention canonical_id: ${mention.canonical_id}`)
  if (mention.context) lines.push(`Context: ${mention.context}`)
  lines.push(`Kind: ${mention.kind}`)
  lines.push('')
  lines.push('Candidates:')
  for (const c of candidates) {
    const parts: string[] = [`id=${c.id}`, `name="${c.display_name}"`]
    if (c.canonical_id) parts.push(`canonical_id="${c.canonical_id}"`)
    if (c.attributes && Object.keys(c.attributes).length > 0) {
      parts.push(`attributes=${JSON.stringify(c.attributes)}`)
    }
    lines.push(`- ${parts.join(' ')}`)
  }
  return lines.join('\n')
}

async function disambiguateWithLLM(
  mention: EntityMention,
  candidates: EntityCandidate[],
  llm: { provider: LLMProvider; model: string },
  fallbackTier: ResolveTier,
): Promise<ResolveResult> {
  let usage: TokenUsage | null = null
  try {
    const response = await collectStream(
      llm.provider.stream({
        model: llm.model,
        systemPrompt: DISAMBIGUATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildDisambiguationPrompt(mention, candidates) }],
        maxTokens: 2000,
        temperature: 0.1,
      }),
    )
    usage = response.usage

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')

    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { status: 'ambiguous', tier: fallbackTier, candidates, usage, model: llm.model }
    }

    const parsed = JSON.parse(jsonMatch[0]) as { id?: unknown }
    const id = typeof parsed.id === 'string' ? parsed.id : ''

    if (id === 'ambiguous' || !id) {
      return { status: 'ambiguous', tier: fallbackTier, candidates, usage, model: llm.model }
    }

    const picked = candidates.find((c) => c.id === id)
    if (!picked) {
      return { status: 'ambiguous', tier: fallbackTier, candidates, usage, model: llm.model }
    }

    return {
      status: 'resolved',
      tier: 'llm',
      entityId: picked.id,
      score: 1,
      flagged: true,
      usage,
      model: llm.model,
    }
  } catch {
    return { status: 'ambiguous', tier: fallbackTier, candidates, usage: usage ?? undefined, model: llm.model }
  }
}

export async function resolveEntity(opts: ResolveOptions): Promise<ResolveResult> {
  const threshold = opts.fuzzyThreshold ?? 0.85
  const kindFiltered = filterByKind(opts.candidates, opts.mention.kind)

  // Tier 1 — exact display_name (case-insensitive)
  const normalizedMention = normalizeName(opts.mention.display_name)
  const exactMatches = kindFiltered.filter(
    (c) => normalizeName(c.display_name) === normalizedMention,
  )
  if (exactMatches.length === 1) {
    return { status: 'resolved', tier: 'exact', entityId: exactMatches[0].id, score: 1 }
  }
  if (exactMatches.length > 1) {
    if (opts.llm) return disambiguateWithLLM(opts.mention, exactMatches, opts.llm, 'exact')
    return { status: 'ambiguous', tier: 'exact', candidates: exactMatches }
  }

  // Tier 2 — canonical_id exact
  if (opts.mention.canonical_id) {
    const target = normalizeCanonical(opts.mention.canonical_id)
    const canonicalMatches = kindFiltered.filter(
      (c) => c.canonical_id && normalizeCanonical(c.canonical_id) === target,
    )
    if (canonicalMatches.length === 1) {
      return { status: 'resolved', tier: 'canonical_id', entityId: canonicalMatches[0].id, score: 1 }
    }
    if (canonicalMatches.length > 1) {
      if (opts.llm) return disambiguateWithLLM(opts.mention, canonicalMatches, opts.llm, 'canonical_id')
      return { status: 'ambiguous', tier: 'canonical_id', candidates: canonicalMatches }
    }
  }

  // Tier 3 — fuzzy Jaro-Winkler
  const scored = kindFiltered
    .map((c) => ({ candidate: c, score: jaroWinkler(normalizedMention, normalizeName(c.display_name)) }))
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) return { status: 'no_match' }
  if (scored.length === 1) {
    return {
      status: 'resolved',
      tier: 'fuzzy',
      entityId: scored[0].candidate.id,
      score: scored[0].score,
      flagged: true,
    }
  }

  const fuzzyCandidates = scored.map((s) => s.candidate)
  if (opts.llm) return disambiguateWithLLM(opts.mention, fuzzyCandidates, opts.llm, 'fuzzy')
  return { status: 'ambiguous', tier: 'fuzzy', candidates: fuzzyCandidates }
}
