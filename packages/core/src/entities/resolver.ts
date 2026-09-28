import { collectStream } from '../providers/accumulator.js'
import type { LLMProvider, TokenUsage } from '../providers/types.js'
import type { EntityCandidate, EntityMention } from './types.js'
import type { DecisionExecutionPort, DecisionResponse } from '../decisions/index.js'
import { isJsonValue } from '../decisions/validate.js'

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
  decisionRuntime?: DecisionExecutionPort
  workspaceId?: string
  runId?: string
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
  let servedModel = llm.model
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
    servedModel = response.model || llm.model

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')

    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { status: 'ambiguous', tier: fallbackTier, candidates, usage, model: servedModel }
    }

    const parsed = JSON.parse(jsonMatch[0]) as { id?: unknown }
    const id = typeof parsed.id === 'string' ? parsed.id : ''

    if (id === 'ambiguous' || !id) {
      return { status: 'ambiguous', tier: fallbackTier, candidates, usage, model: servedModel }
    }

    const picked = candidates.find((c) => c.id === id)
    if (!picked) {
      return { status: 'ambiguous', tier: fallbackTier, candidates, usage, model: servedModel }
    }

    return {
      status: 'resolved',
      tier: 'llm',
      entityId: picked.id,
      score: 1,
      flagged: true,
      usage,
      model: servedModel,
    }
  } catch {
    return { status: 'ambiguous', tier: fallbackTier, candidates, usage: usage ?? undefined, model: servedModel }
  }
}

const ENTITY_OPERATION = {
  id: 'entity.disambiguation',
  version: '1',
  stateVersion: '1',
  questionVersion: '1',
} as const

function validateDisambiguationResult(
  result: ResolveResult,
  candidates: EntityCandidate[],
): ResolveResult {
  if (result.status === 'resolved' && !candidates.some((candidate) => candidate.id === result.entityId)) {
    throw new Error('entity disambiguation returned an id outside the candidate set')
  }
  if (result.status === 'ambiguous') {
    const expected = new Set(candidates.map((candidate) => candidate.id))
    if (result.candidates.some((candidate) => !expected.has(candidate.id))) {
      throw new Error('entity disambiguation returned an unknown candidate')
    }
  }
  return result
}

function primaryDisambiguation(
  response: DecisionResponse,
  candidates: EntityCandidate[],
  fallbackTier: ResolveTier,
  policy: import('../decisions/index.js').JsonValue | undefined,
) {
  const answer = response.answers[0]
  if (answer?.kind !== 'choice') {
    return { kind: 'unavailable' as const, reason: 'invalid_response' as const }
  }
  const selectedProbability = answer.evidence.probabilities?.[answer.value]
    ?? answer.evidence.confidence
  const reviewBelow = typeof policy === 'object' && policy !== null && !Array.isArray(policy)
    && typeof policy.reviewBelow === 'number'
    ? policy.reviewBelow
    : undefined
  if (reviewBelow !== undefined && selectedProbability !== undefined && selectedProbability < reviewBelow) {
    return { kind: 'follow_up' as const, reason: 'uncertain' as const }
  }
  const usage = response.usage
    ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
    : undefined
  if (answer.value === 'ambiguous') {
    return {
      kind: 'complete' as const,
      result: {
        status: 'ambiguous' as const,
        tier: fallbackTier,
        candidates,
        ...(usage ? { usage } : {}),
        model: response.model.wireId,
      },
    }
  }
  const picked = candidates.find((candidate) => candidate.id === answer.value)
  if (!picked) return { kind: 'unavailable' as const, reason: 'invalid_response' as const }
  return {
    kind: 'complete' as const,
    result: {
      status: 'resolved' as const,
      tier: 'llm' as const,
      entityId: picked.id,
      score: selectedProbability ?? 0,
      flagged: true,
      ...(usage ? { usage } : {}),
      model: response.model.wireId,
    },
  }
}

async function disambiguateCandidates(
  opts: ResolveOptions,
  candidates: EntityCandidate[],
  fallbackTier: ResolveTier,
): Promise<ResolveResult> {
  if (!opts.decisionRuntime) {
    return opts.llm
      ? disambiguateWithLLM(opts.mention, candidates, opts.llm, fallbackTier)
      : { status: 'ambiguous', tier: fallbackTier, candidates }
  }

  const decisionCandidates = candidates.map((candidate) => {
    const attributes: Record<string, import('../decisions/index.js').JsonValue> = {}
    for (const [key, value] of Object.entries(candidate.attributes ?? {})) {
      if (isJsonValue(value)) attributes[key] = value
    }
    return {
      id: candidate.id,
      kind: candidate.kind,
      display_name: candidate.display_name,
      canonical_id: candidate.canonical_id ?? null,
      attributes,
    }
  })

  try {
    const cascade = await opts.decisionRuntime.run<ResolveResult>({
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    ...(opts.llm ? { llm: { provider: opts.llm.provider, modelId: opts.llm.model } } : {}),
    request: {
      runId: opts.runId ?? `entity-disambiguation-${Date.now()}`,
      operation: ENTITY_OPERATION,
      state: {
        mention: {
          kind: opts.mention.kind,
          display_name: opts.mention.display_name,
          canonical_id: opts.mention.canonical_id ?? null,
          context: opts.mention.context ?? null,
        },
        candidates: decisionCandidates,
      },
      questions: [{
        kind: 'choice',
        id: 'entity',
        prompt: 'Choose exactly one supplied entity id, or ambiguous when the evidence does not distinguish them.',
        options: [
          ...candidates.map((candidate) => ({ value: candidate.id, description: candidate.display_name })),
          { value: 'ambiguous', description: 'The supplied evidence cannot safely distinguish candidates' },
        ],
      }],
    },
    operation: {
      decide: (response, { profile }) => primaryDisambiguation(
        response,
        candidates,
        fallbackTier,
        profile?.policy,
      ),
      validateResult: (result) => validateDisambiguationResult(result, candidates),
      safeFailure: () => ({ status: 'ambiguous', tier: fallbackTier, candidates }),
      async completeWithLlm(context) {
        const result = await disambiguateWithLLM(
          opts.mention,
          candidates,
          { provider: context.llm.provider, model: context.llm.modelId },
          fallbackTier,
        )
        return {
          result,
          providerId: context.llm.provider.name,
          model: {
            catalogId: context.llm.modelId,
            wireId: ('model' in result ? result.model : undefined) ?? context.llm.modelId,
          },
          ...('usage' in result && result.usage ? {
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            },
          } : {}),
        }
      },
    },
    })
    return cascade.result
  } catch {
    return { status: 'ambiguous', tier: fallbackTier, candidates }
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
    return disambiguateCandidates(opts, exactMatches, 'exact')
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
      return disambiguateCandidates(opts, canonicalMatches, 'canonical_id')
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
  return disambiguateCandidates(opts, fuzzyCandidates, 'fuzzy')
}
