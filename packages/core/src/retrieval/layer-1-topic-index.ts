/**
 * Layer 1 — pre-agent topic-aware memory index.
 *
 * Runs once per turn before the model sees the prompt. Two pieces:
 *
 *   1. `classifyTopicTags` — Flash-class LLM call (~$0.0002/turn; attribute
 *      usage as `overhead:topic-analyzer`). Reads a recent-conversation
 *      snippet plus the session's topic-history average and emits ranked
 *      topic tags + an intent-shift signal.
 *
 *   2. `assembleTopicBiasedMemoryIndex` — pure ranking step. Takes the
 *      already-fetched recency-ranked memory slice (caller fetches via
 *      `MemoryStore.getIndexRanked`), applies a SOFT tag-overlap weighting,
 *      a minority-topic boost when intent shifts hard, then MMR
 *      diversification. Output drops straight into
 *      `buildMemoryContext({ memoryIndex })`.
 *
 *   3. `runLayer1TopicIndex` — convenience wrapper that does (1) then (2).
 *
 * Spec: docs/architecture/brain/retrieval-layer.md §"Layer 1 — Topic-aware
 * memory index injection" (cost target + I/O contract) and §"Tunable knobs"
 * (knob defaults). MMR formula mirrors §"Hybrid retrieval shape" canonical
 * form — the function is intentionally embedding-free here. WS-8 / WU-5.7
 * (`rrf.ts` / `mmr.ts`) will ship a vector-aware MMR; this file's
 * token-Jaccard similarity is the stopgap until then.
 *
 * Fallback policy mirrors `memory/topic-classifier.ts`: any provider error
 * or parse failure degrades to `{ tags: [], shift: 'none', confidence: 0 }`
 * so downstream code always gets a usable analysis (the assembler then
 * degenerates to plain recency ordering of inputs).
 */

import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'
import type { MemoryEntry } from '../memory/context-builder.js'

// ── Types ────────────────────────────────────────────────────────────

export type IntentShift = 'none' | 'low' | 'high'

export type TopicAnalysis = {
  /** Ranked topic tags (most-confident first), already normalized. */
  inferred_topic_tags: string[]
  inferred_intent_shift: IntentShift
  /** 0..1 — 0 signals the fallback path (parse failed / no signal). */
  confidence: number
  /** Provider usage; null when the call itself threw. Attribute as `overhead:topic-analyzer`. */
  usage?: TokenUsage | null
  /** Echo of the model id passed in. */
  model?: string
}

export type TopicAnalyzerRecentTurn = {
  text: string
  /** Optional prior topic label (from memory/topic-classifier) — used as a soft prior. */
  topicLabel?: string | null
}

export type ClassifyTopicTagsOptions = {
  provider: LLMProvider
  /** Cheap model — production should pass a Gemini Flash id. */
  model: string
  recentUserTurns: TopicAnalyzerRecentTurn[]
  currentMessage: string
  /**
   * The session's topic-tag history average — the set of tags seen often
   * enough this session to count as "the dominant context." Used both as
   * a prior for the classifier and as the comparison set for the
   * intent-shift = 'high' minority-topic boost in the assembler.
   */
  sessionHistoryTags: string[]
  /**
   * Optional founder-supplied bound on what tags the classifier may emit.
   * Mirrors `workspaces.topic_analyzer_config.allowed_domain_tags`.
   * Empty / undefined = unbounded.
   */
  allowedTags?: string[]
}

export type AssembleOptions = {
  candidates: MemoryEntry[]
  analysis: TopicAnalysis
  /** Tags considered "the dominant context this session" — used for the high-shift minority boost. */
  sessionHistoryTags: string[]
  /**
   * 0.0 = no filter; 1.0 = aggressive (still soft, never zeroed). Default 0.7
   * per retrieval.md §"Tunable knobs" (`memory_index_topic_filter_strength`).
   */
  topicFilterStrength?: number
  /**
   * Score increment applied to minority-topic candidates when
   * `analysis.inferred_intent_shift === 'high'`. Default 0.5 — comparable
   * to the magnitude of the tag-overlap boost so a hard pivot can lift
   * minority content above the dominant tag.
   */
  intentShiftBoost?: number
  /**
   * MMR balance: relevance vs. diversity. Default 0.6 per
   * retrieval.md §"Tunable knobs" (`mmr_lambda`).
   */
  mmrLambda?: number
  /** Top-K cap on the returned slice. Default 12 (matches typical memory-index cap). */
  k?: number
}

export type Layer1Result = {
  analysis: TopicAnalysis
  memoryIndex: MemoryEntry[]
}

export type RunLayer1Options = ClassifyTopicTagsOptions & {
  candidates: MemoryEntry[]
  topicFilterStrength?: number
  intentShiftBoost?: number
  mmrLambda?: number
  k?: number
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_FILTER_STRENGTH = 0.7
const DEFAULT_INTENT_SHIFT_BOOST = 0.5
const DEFAULT_MMR_LAMBDA = 0.6
const DEFAULT_K = 12

const FALLBACK_ANALYSIS: TopicAnalysis = {
  inferred_topic_tags: [],
  inferred_intent_shift: 'none',
  confidence: 0,
}

const CLASSIFIER_SYSTEM_PROMPT =
  'You are a topic-tag analyzer for a conversational assistant. ' +
  'Respond with ONE JSON object and nothing else. No markdown fences, no commentary.'

// ── classifyTopicTags ────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/^['"“”]+|['"“”.,;:!?]+$/g, '')
    .replace(/\s+/g, '_')
}

function buildClassifierPrompt(opts: ClassifyTopicTagsOptions): string {
  const recent = opts.recentUserTurns.length > 0
    ? opts.recentUserTurns
        .map((t, i) => {
          const label = t.topicLabel ? ` [topic: ${t.topicLabel}]` : ''
          return `  ${i + 1}.${label} ${truncate(t.text, 200)}`
        })
        .join('\n')
    : '  (none)'

  const history = opts.sessionHistoryTags.length > 0
    ? opts.sessionHistoryTags.slice(0, 20).map((t) => `  - ${t}`).join('\n')
    : '  (none)'

  const allowed = opts.allowedTags && opts.allowedTags.length > 0
    ? `\n\nAllowed tags (STRICT — only emit tags from this list):\n${opts.allowedTags.slice(0, 50).map((t) => `  - ${t}`).join('\n')}`
    : ''

  return `Infer topic tags for the user's new message so the assistant can bias its memory index.

Recent user turns (oldest → newest):
${recent}

Session topic-history tags (the dominant context so far):
${history}${allowed}

Current message:
  "${truncate(opts.currentMessage, 500)}"

Output JSON only, matching this shape:
{
  "inferred_topic_tags": ["<tag>", "<tag>"],   // ranked, most-confident first; 0-3 tags
  "inferred_intent_shift": "none" | "low" | "high",
  "confidence": 0.0-1.0
}

Tag rules:
- Tags are short, namespaced lowercase identifiers (e.g. "domain:marketing", "project:acme-launch", "person:brian").
- Prefer reusing tags from the Session topic-history list when they match.
- Snake_case for multi-word names; never include spaces.
- 0 tags is a valid answer when the current message is generic / off-topic / chit-chat.

Intent-shift rules:
- "none": the message is on the same topic(s) as the session history.
- "low": the message touches a known topic from history but with a different angle.
- "high": the message pivots to a topic that does NOT appear in the session history.

Confidence rules:
- Below 0.5 for very short or ambiguous messages.
- Above 0.8 only when the tag is unambiguous from the message itself.`
}

function coerceShift(raw: unknown): IntentShift {
  return raw === 'high' || raw === 'low' || raw === 'none' ? raw : 'none'
}

/**
 * Classify topic tags + intent shift for the current user turn. Always
 * returns an analysis — falls back to `{ tags: [], shift: 'none',
 * confidence: 0 }` on any error. Callers should treat `confidence === 0`
 * as "no signal" and `assembleTopicBiasedMemoryIndex` correctly degenerates
 * to plain recency ordering in that case.
 */
export async function classifyTopicTags(
  opts: ClassifyTopicTagsOptions,
): Promise<TopicAnalysis> {
  let usage: TokenUsage | null = null
  try {
    const response = await collectStream(
      opts.provider.stream({
        model: opts.model,
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildClassifierPrompt(opts) }],
        // Gemini Flash 3 preview consumes thinking tokens before visible
        // output — a tight cap truncates the JSON and forces the fallback
        // path. 2000 leaves headroom for a 3-tag JSON object. Same budget
        // logic as memory/topic-classifier.ts:163-169.
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
    if (!jsonMatch) return { ...FALLBACK_ANALYSIS, usage, model: opts.model }

    const parsed = JSON.parse(jsonMatch[0]) as {
      inferred_topic_tags?: unknown
      inferred_intent_shift?: unknown
      confidence?: unknown
    }

    let tags: string[] = []
    if (Array.isArray(parsed.inferred_topic_tags)) {
      const seen = new Set<string>()
      for (const t of parsed.inferred_topic_tags) {
        if (typeof t !== 'string') continue
        const norm = normalizeTag(t)
        if (norm.length === 0 || seen.has(norm)) continue
        if (opts.allowedTags && opts.allowedTags.length > 0
            && !opts.allowedTags.includes(norm)) continue
        seen.add(norm)
        tags.push(norm)
        if (tags.length >= 3) break
      }
    }

    const shift = coerceShift(parsed.inferred_intent_shift)

    let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
    if (!Number.isFinite(confidence)) confidence = 0
    confidence = Math.max(0, Math.min(1, confidence))

    return {
      inferred_topic_tags: tags,
      inferred_intent_shift: shift,
      confidence,
      usage,
      model: opts.model,
    }
  } catch {
    return { ...FALLBACK_ANALYSIS, usage, model: usage ? opts.model : undefined }
  }
}

// ── assembleTopicBiasedMemoryIndex ───────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'them', 'this', 'that',
  'as', 'from', 'about', 'into',
])

function tokenize(s: string): Set<string> {
  const out = new Set<string>()
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function scoreCandidate(
  m: MemoryEntry,
  rank: number,
  totalCandidates: number,
  analysis: TopicAnalysis,
  sessionHistoryTags: Set<string>,
  strength: number,
  intentShiftBoost: number,
): number {
  // Recency base in (0, 1] — rank 0 ≈ 1.0, last rank still positive so a
  // tag-match boost on the oldest candidate can outrank a non-match on the
  // newest. Spec calls for soft weighting, not hard cutoffs.
  const baseScore = totalCandidates > 0
    ? 1 - rank / totalCandidates
    : 1

  let score = baseScore

  // Soft tag filter — additive so a non-zero boost lifts low-recency rows
  // that strongly match. Skipped when the classifier produced no tags or
  // the founder dialed strength to 0.
  if (analysis.inferred_topic_tags.length > 0 && strength > 0) {
    const memTags = new Set(m.tags)
    const overlaps = analysis.inferred_topic_tags.some((t) => memTags.has(t))
    score += overlaps ? strength : -strength * 0.5
  }

  // Minority-topic boost on high intent shift: lift rows whose tags do NOT
  // appear in the session-history average. Independent of the tag-overlap
  // logic — kicks in even when the classifier emitted no specific tags but
  // detected the pivot. Spec §"Layer 1" line 238.
  if (analysis.inferred_intent_shift === 'high' && sessionHistoryTags.size > 0) {
    const inHistory = m.tags.some((t) => sessionHistoryTags.has(t))
    if (!inHistory) score += intentShiftBoost
  }

  return score
}

/**
 * Score + MMR-diversify candidates per the spec. Pure function; safe to
 * call without a provider when the analysis is a known fallback.
 */
export function assembleTopicBiasedMemoryIndex(
  opts: AssembleOptions,
): MemoryEntry[] {
  if (opts.candidates.length === 0) return []

  const strength = opts.topicFilterStrength ?? DEFAULT_FILTER_STRENGTH
  const intentShiftBoost = opts.intentShiftBoost ?? DEFAULT_INTENT_SHIFT_BOOST
  const lambda = opts.mmrLambda ?? DEFAULT_MMR_LAMBDA
  const k = Math.max(1, opts.k ?? DEFAULT_K)

  const sessionHistory = new Set(opts.sessionHistoryTags)

  // Score every candidate. Stable secondary sort by original index
  // preserves recency ordering when scores tie.
  const scored = opts.candidates.map((m, i) => ({
    memory: m,
    rank: i,
    score: scoreCandidate(
      m,
      i,
      opts.candidates.length,
      opts.analysis,
      sessionHistory,
      strength,
      intentShiftBoost,
    ),
    tokens: tokenize(m.summary),
  }))

  // MMR selection over the scored set. Token-Jaccard similarity is a
  // placeholder for vector cosine — WS-8 / WU-5.7 will swap it.
  const remaining = scored.slice()
  const selected: typeof scored = []
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0
    let bestScore = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]
      let maxSim = 0
      for (const s of selected) {
        const sim = jaccard(cand.tokens, s.tokens)
        if (sim > maxSim) maxSim = sim
      }
      const mmr = lambda * cand.score - (1 - lambda) * maxSim
      if (
        mmr > bestScore ||
        (mmr === bestScore && cand.rank < remaining[bestIdx].rank)
      ) {
        bestScore = mmr
        bestIdx = i
      }
    }
    selected.push(remaining[bestIdx])
    remaining.splice(bestIdx, 1)
  }

  return selected.map((s) => s.memory)
}

// ── runLayer1TopicIndex ──────────────────────────────────────────────

/**
 * One-call entry point — classify + assemble. The coordinator wires this
 * into `apps/api`'s chat route (it replaces the raw `getIndexRanked` →
 * `buildMemoryContext` hop with one that biases the slice by inferred
 * topic). The returned `analysis` is also what callers log to
 * `analytics_events` as `overhead:topic-analyzer`.
 */
export async function runLayer1TopicIndex(
  opts: RunLayer1Options,
): Promise<Layer1Result> {
  const analysis = await classifyTopicTags(opts)
  const memoryIndex = assembleTopicBiasedMemoryIndex({
    candidates: opts.candidates,
    analysis,
    sessionHistoryTags: opts.sessionHistoryTags,
    topicFilterStrength: opts.topicFilterStrength,
    intentShiftBoost: opts.intentShiftBoost,
    mmrLambda: opts.mmrLambda,
    k: opts.k,
  })
  return { analysis, memoryIndex }
}
