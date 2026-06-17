/**
 * Conversation compaction.
 *
 * Full compaction: summarize entire conversation into a 6-section summary.
 * Memory extraction captures facts BEFORE compaction runs.
 * Post-compaction: model sees [summary] + [memories] + [cached results].
 */

import type { Message, LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'
/**
 * Output shape for `extractMemoriesBeforeCompaction`. Moved here from
 * the (now-retired) regex pattern-extractor as part of Q9's `extractPatterns`
 * cleanup. The LLM produces these rows; the writer converts them to
 * memory rows with `type` retired post-Phase-4 (the categorical
 * signal rides on tags now).
 */
export type ExtractedFact = {
  /** Memory type. `identity` is deprecated. */
  type: 'identity' | 'preference' | 'context'
  /** Optional tags. `self-profile` marks identity-flavored preferences. */
  tags?: string[]
  summary: string
  confidence: number
}

// ── Configuration ──────────────────────────────────────────────

/**
 * Per-model-tier base threshold. Keyed by the model that will run the next
 * turn, not by the user's plan — a Max-plan user sending a standard-model
 * turn should compact at 42k, since that turn will run on Flash.
 *
 * Callers map their resolved model through `modelToCompactionTier()`.
 */
export const COMPACT_THRESHOLDS = {
  standard: 42_000,
  pro: 187_000,
} as const

const SUMMARY_MAX_TOKENS = 4_000
const CIRCUIT_BREAKER_MAX_FAILURES = 3

// ── Compact prompts (per profile) ──────────────────────────────

/**
 * Linear profile: single 6-section summary. Used for web and cron where
 * sessions are typically single-topic or where the topic structure
 * doesn't need to survive compaction.
 */
const COMPACT_PROMPT_LINEAR = `Your task is to create a detailed summary of the conversation so far.

<analysis>
Think carefully about what information must be preserved for the conversation to continue seamlessly.
</analysis>

Your summary should include:

1. User's Current Request: What is the user trying to accomplish right now?
2. Decisions Made: What has been decided? (destinations, dates, activities, preferences expressed during this conversation)
3. Work In Progress: What was being actively worked on? Include specifics.
4. All User Messages: List every user message that is not a tool result.
5. Open Questions: What was the user asked but hasn't answered yet?
6. Next Step: What should happen next based on the most recent exchange?

IMPORTANT: Be specific. "User wants to visit Tokyo" is not enough.
"User is planning 5-day Tokyo trip March 10-15, vegetarian, budget ¥15,000/day food, Day 1-2 complete, Day 3 in progress" preserves continuity.

Note: Search results from this conversation are cached server-side. If the user references previous results, use retrieveCachedResults instead of re-searching.

Do NOT call any tools. Respond with text only.`

/**
 * Multi-topic profile: cluster the conversation by topic and emit one
 * section per topic. Used for persistent messaging sessions (Telegram,
 * Slack, WhatsApp) where users typically cover many unrelated topics in
 * one thread. Each section becomes an episodic-memory row that the
 * per-turn classifier can retrieve when the topic resumes.
 *
 * Output format is machine-parsed by parseMultiTopicOutput(). Stick to
 * the exact headers and the MESSAGE_SPAN line.
 */
const COMPACT_PROMPT_MULTI_TOPIC = `Your task is to cluster the conversation so far by topic and emit one section per distinct topic.

<analysis>
Identify every topic discussed — a topic is a coherent subject the user asked about, tracked through follow-ups. Different people, different questions, different domains are different topics. When the user switches subject, that is a new topic. When the user returns to an earlier subject, group those turns under the same topic.
</analysis>

For each topic, emit exactly this format:

## TOPIC: <short lowercase label, 2-6 words, free-form>

- User's state / what they wanted on this topic
- Key facts established and any decisions made
- Any corrections the user made ("no, not that, I meant X")
- Open questions or follow-ups the user hasn't answered
- Last activity or next step if the topic is ongoing

MESSAGE_SPAN: from=<first_sequence_num> to=<last_sequence_num> turns=<count>

Additional rules:
- Mark the topic the user was MOST RECENTLY discussing with " [ACTIVE]" appended to the TOPIC label (e.g. "## TOPIC: brian cheng research [ACTIVE]"). Exactly one topic gets this marker.
- If the conversation only covered one topic, emit a single section (still with MESSAGE_SPAN).
- Keep each topic's bullets to 3-6 items. Prioritize what a future turn would need to know to continue.
- Topic labels are lowercase, no quotes, no trailing punctuation. They become machine keys for retrieval.
- **Never bundle unrelated threads under a composite label.** Policies and scheduled nags (medication reminders, cron tasks, recurring follow-ups) are distinct topics from preferences (dietary, dislikes, style, communication). Different decisions, different resolution paths, different tiers of storage. A label like "pill reminder and dietary restrictions" is wrong — emit "pill reminder" and "dietary preferences" as separate TOPIC sections. When in doubt, split.
- Do NOT include a preamble, introduction, or closing. Output ONLY the TOPIC sections.
- Do NOT call any tools. Respond with text only.`

const COMPACT_PROMPTS: Record<CompactionProfile, string> = {
  linear: COMPACT_PROMPT_LINEAR,
  'multi-topic': COMPACT_PROMPT_MULTI_TOPIC,
}

// ── Token estimation ───────────────────────────────────────────

/**
 * Rough token estimate for compaction threshold checks.
 * Not used for billing (API-reported tokens are used there).
 *
 * Weights: CJK ≈ 1 char per token, everything else ≈ 4 chars per token.
 * A flat 4-chars-per-token heuristic silently undercounts CJK sessions by
 * ~4× — a 120K-token Chinese conversation would clock in at ~30K under
 * the old estimator, far below the messaging compaction threshold, and
 * compaction never fired. Hit in prod on 2026-04-17.
 */
export function estimateTokens(messages: Message[]): number {
  let tokens = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      tokens += estimateStringTokens(msg.content)
    } else {
      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            tokens += estimateStringTokens(block.text)
            break
          case 'image':
            tokens += 1_000
            break
          case 'tool_use':
            tokens += estimateStringTokens(block.name) + estimateStringTokens(JSON.stringify(block.input))
            break
          case 'tool_result':
            tokens += estimateStringTokens(block.content)
            break
        }
      }
    }
  }
  return tokens
}

export function estimateStringTokens(s: string): number {
  let cjk = 0
  let other = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (isCJKCodePoint(cp)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

function isCJKCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303F) || // CJK Symbols and Punctuation
    (cp >= 0x3040 && cp <= 0x309F) || // Hiragana
    (cp >= 0x30A0 && cp <= 0x30FF) || // Katakana
    (cp >= 0x3400 && cp <= 0x4DBF) || // CJK Unified Ideographs Ext A
    (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK Unified Ideographs
    (cp >= 0xAC00 && cp <= 0xD7AF) || // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) || // CJK Compatibility Ideographs
    (cp >= 0xFF00 && cp <= 0xFFEF) || // Halfwidth/Fullwidth Forms
    (cp >= 0x20000 && cp <= 0x2A6DF) || // CJK Unified Ideographs Ext B
    (cp >= 0x2A700 && cp <= 0x2EBEF)    // CJK Unified Ideographs Ext C/D/E/F
  )
}

// ── Compaction engine ──────────────────────────────────────────

export type CompactionProfile = 'linear' | 'multi-topic'
export type ChannelClass = 'messaging' | 'web' | 'cron'

/**
 * Parsed per-topic section from multi-topic compaction output.
 * The caller persists these as episodic_memories rows.
 */
export type EpisodeSection = {
  topicLabel: string
  summary: string
  messageSpan: { fromSequence: number; toSequence: number; turnCount: number }
  active: boolean
}

export type CompactionResult = {
  summary: string
  boundaryMessage: Message
  tokensBefore: number
  tokensAfter: number
  /**
   * API-reported token usage from the summariser call. Used by the
   * caller to attribute the compaction spend as an `overhead:compaction`
   * row so it shows on the admin dashboard without consuming the user's
   * budget. See docs/platform/cost-and-pricing.md → "Overhead accounting".
   */
  usage: TokenUsage
  /** Model that actually ran the summariser call — used for cost calc. */
  model: string
  /**
   * Only populated when profile === 'multi-topic' and parsing succeeded.
   * Empty array if parsing produced no sections. Undefined otherwise.
   */
  episodes?: EpisodeSection[]
}

export type CompactionOptions = {
  provider: LLMProvider
  model: string // use a cheap model (Flash)
  messages: Message[]
  systemPrompt: string
  /**
   * Which compaction prompt to use. Defaults to 'linear' for backward
   * compatibility. Messaging channels and cron should pass 'multi-topic'
   * so the output becomes episodic-memory rows.
   */
  profile?: CompactionProfile
  /**
   * Channel class for analytics / downstream decisions. Not used by
   * compactConversation itself today but surfaced on the options type so
   * callers don't have to carry it separately.
   */
  channelClass?: ChannelClass
}

/**
 * Compact a conversation. When `profile === 'multi-topic'`, the output
 * is parsed into `episodes` and the boundary message becomes a terse
 * pointer to the episodic store.
 */
export async function compactConversation(options: CompactionOptions): Promise<CompactionResult> {
  const profile: CompactionProfile = options.profile ?? 'linear'
  const prompt = COMPACT_PROMPTS[profile]
  const tokensBefore = estimateTokens(options.messages)

  const compactMessages: Message[] = [
    ...options.messages,
    { role: 'user', content: prompt },
  ]

  const response = await collectStream(
    options.provider.stream({
      model: options.model,
      messages: compactMessages,
      systemPrompt: options.systemPrompt,
      maxTokens: SUMMARY_MAX_TOKENS,
    }),
  )

  const summary = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.type === 'text' ? b.text : '')
    .join('')

  let episodes: EpisodeSection[] | undefined
  let boundaryText: string

  if (profile === 'multi-topic') {
    episodes = parseMultiTopicOutput(summary)
    if (episodes.length > 0) {
      const topics = episodes.map((e) => e.topicLabel).join(', ')
      const activeLabel = episodes.find((e) => e.active)?.topicLabel
      boundaryText =
        `[Conversation compacted at ${new Date().toISOString()}. ${tokensBefore} tokens summarized into ` +
        `${episodes.length} topic(s) in episodic memory: ${topics}.${activeLabel ? ` Active topic: ${activeLabel}.` : ''}]`
    } else {
      // Parse failure — fall back to stuffing the raw text in so nothing is lost.
      boundaryText =
        `[Conversation compacted at ${new Date().toISOString()}. ${tokensBefore} tokens summarized. ` +
        `Multi-topic parsing failed; raw summary follows.]\n\n${summary}`
    }
  } else {
    boundaryText = `[Conversation compacted at ${new Date().toISOString()}. ${tokensBefore} tokens summarized.]\n\n${summary}`
  }

  const boundaryMessage: Message = {
    role: 'system',
    content: boundaryText,
  }

  const tokensAfter = estimateTokens([boundaryMessage])

  return {
    summary,
    boundaryMessage,
    tokensBefore,
    tokensAfter,
    usage: response.usage,
    model: options.model,
    episodes,
  }
}

// ── Multi-topic output parser ──────────────────────────────────

/**
 * Parse the output of COMPACT_PROMPT_MULTI_TOPIC into EpisodeSection[].
 * Lenient: tolerates extra whitespace, markdown variants, missing ACTIVE
 * marker, missing MESSAGE_SPAN (defaults to 0/0/0). Returns empty array
 * on structural failure; callers treat that as a non-fatal degraded path.
 */
export function parseMultiTopicOutput(text: string): EpisodeSection[] {
  if (!text || !text.trim()) return []

  // Split on top-level `## TOPIC:` headers. Keep the header so we can read
  // the label back out per section.
  const parts = text.split(/(?=^##\s*TOPIC:\s*)/im).filter((p) => /^##\s*TOPIC:/i.test(p))
  const sections: EpisodeSection[] = []

  for (const part of parts) {
    const headerMatch = part.match(/^##\s*TOPIC:\s*(.+?)\s*$/im)
    if (!headerMatch) continue

    let rawLabel = headerMatch[1].trim()
    const active = /\[ACTIVE\]\s*$/i.test(rawLabel)
    rawLabel = rawLabel.replace(/\s*\[ACTIVE\]\s*$/i, '').trim()
    // Canonicalize: lowercase, strip trailing punctuation/quotes
    const topicLabel = rawLabel.toLowerCase().replace(/^['"“”]+|['"“”.,;:!?]+$/g, '').trim()
    if (!topicLabel) continue

    // MESSAGE_SPAN line — tolerate missing fields.
    const spanMatch = part.match(
      /MESSAGE_SPAN:\s*from=(\d+)\s+to=(\d+)(?:\s+turns=(\d+))?/i,
    )
    const messageSpan = spanMatch
      ? {
          fromSequence: parseInt(spanMatch[1], 10),
          toSequence: parseInt(spanMatch[2], 10),
          turnCount: spanMatch[3] ? parseInt(spanMatch[3], 10) : 0,
        }
      : { fromSequence: 0, toSequence: 0, turnCount: 0 }

    // Summary = everything between the header and MESSAGE_SPAN (or end).
    const afterHeader = part.slice(headerMatch[0].length)
    const spanIdx = spanMatch ? afterHeader.toUpperCase().indexOf('MESSAGE_SPAN:') : -1
    const summary = (spanIdx >= 0 ? afterHeader.slice(0, spanIdx) : afterHeader).trim()
    if (!summary) continue

    sections.push({ topicLabel, summary, messageSpan, active })
  }

  return sections
}

// ── Circuit breaker ────────────────────────────────────────────

/**
 * After tripping, the breaker reports closed again once this cooldown
 * elapses — a half-open probe. Without it, an `isOpen` consumer that skips
 * the compaction call would never get a success to reset the counter and the
 * breaker would deadlock open forever (a fresh wedge). On a failed probe the
 * cooldown re-arms; on a successful one the breaker fully closes.
 */
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000

/**
 * Compaction circuit breaker. Opens after `CIRCUIT_BREAKER_MAX_FAILURES`
 * consecutive failures so a consumer can degrade (e.g. to a deterministic
 * trim) instead of hammering a failing summariser, then half-opens after
 * `CIRCUIT_BREAKER_COOLDOWN_MS` to probe for recovery.
 *
 * `now` is injectable for deterministic tests; production uses `Date.now`.
 */
export function createCompactionCircuitBreaker(now: () => number = Date.now) {
  let consecutiveFailures = 0
  let openedAt: number | null = null

  return {
    get isOpen(): boolean {
      if (consecutiveFailures < CIRCUIT_BREAKER_MAX_FAILURES) return false
      // Half-open: once the cooldown elapses, report closed so exactly one
      // probe runs. recordSuccess/recordFailure below decide what happens next.
      if (openedAt !== null && now() - openedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) return false
      return true
    },

    recordSuccess() {
      consecutiveFailures = 0
      openedAt = null
    },

    recordFailure() {
      consecutiveFailures++
      if (consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
        // (Re)arm the cooldown on every at/over-threshold failure so a failed
        // half-open probe backs off again instead of probing every call.
        openedAt = now()
        if (consecutiveFailures === CIRCUIT_BREAKER_MAX_FAILURES) {
          console.error(`Compaction circuit breaker open after ${consecutiveFailures} consecutive failures`)
        }
      }
    },

    reset() {
      consecutiveFailures = 0
      openedAt = null
    },
  }
}

// ── Compaction check ───────────────────────────────────────────

export type CompactionTier = 'standard' | 'pro'

/**
 * Map a resolved provider model id to its compaction tier. The resolved
 * model is what's actually going to run the next turn (after plan and
 * budget downgrades), so the threshold matches the window the model will
 * see. Flash-class models (Standard `gemini-3.1-flash-lite` and Pro
 * `gemini-3-flash-preview`) use the standard ceiling; Pro 3.1 (research
 * escalation) and Flash 3.5 (Max default) use the pro ceiling — Flash 3.5
 * is paid at the Max-tier rate and ships with a 1M-token frontier window,
 * so compacting it at the Flash Lite threshold would silently shrink what
 * the user paid 5 credits for.
 *
 * Matches by substring so both the `resolveModel` aliases (`gemini-flash`,
 * `gemini-3.1-flash-lite`, `gemini-pro`) and the real provider IDs
 * (`gemini-3-flash-preview`, `gemini-3.1-flash-lite` / its retired
 * `-preview` SKU, `gemini-3.5-flash`, `gemini-3.1-pro-preview`) classify
 * correctly.
 */
export function modelToCompactionTier(model: string): CompactionTier {
  if (model.includes('gemini-3.5-flash')) return 'pro'
  if (model.includes('flash')) return 'standard'
  return 'pro'
}

/**
 * Per-channel-class multiplier on the plan threshold. Persistent
 * messaging channels (Telegram/Slack/WhatsApp) accumulate topics quickly
 * and benefit from more-frequent compaction, so their effective
 * threshold is half of the plan threshold.
 */
export const CHANNEL_CLASS_MULTIPLIER: Record<ChannelClass, number> = {
  messaging: 0.5,
  web: 1.0,
  cron: 1.0, // cron callers force compaction per-run regardless of threshold
}

/**
 * Check if compaction is needed based on token count. Pass `channelClass`
 * to apply the per-channel multiplier; omitted = no multiplier (1.0).
 */
export function needsCompaction(
  messages: Message[],
  tier: CompactionTier,
  channelClass?: ChannelClass,
): boolean {
  const baseThreshold = COMPACT_THRESHOLDS[tier]
  const multiplier = channelClass ? CHANNEL_CLASS_MULTIPLIER[channelClass] : 1.0
  return estimateTokens(messages) >= baseThreshold * multiplier
}

// ── Idle-based compaction tiers (messaging channels) ───────────

export type IdleCompactionLevel = 'none' | 'soft' | 'hard'

/**
 * Determine idle compaction level based on time since last activity.
 * Only for messaging channels (Telegram, Slack, WhatsApp).
 */
export function getIdleCompactionLevel(lastActiveAt: Date): IdleCompactionLevel {
  const hours = (Date.now() - lastActiveAt.getTime()) / (1000 * 60 * 60)
  if (hours > 24) return 'hard'
  if (hours > 4) return 'soft'
  return 'none'
}

// ── Pre-compaction memory extraction ──────────────────────────

const EXTRACTION_PROMPT = `Extract durable facts about the user from this conversation that should be remembered long-term, but only after running each candidate through the precedence ladder below. Memory is the LAST resort.

Precedence ladder (first-fit wins — emit at the FIRST tier that fits):
  1. Skip (do not emit) — actionable items the user (or their workspace) must DO. Tasks are written via a separate path; do NOT shoehorn them into a memory.
  2. Skip (do not emit) — proper-noun entities (people, companies, projects). Those are written via a separate path; do NOT capture them as facts.
  3. Memory — a durable preference, identity fact, or recurring context that doesn't fit as a task or an entity attribute. Examples: "User is vegetarian", "Team uses Linear", "User prefers async over meetings".
  4. Skip (do not emit) — ephemeral status, ack-only content, relative-time markers ("waiting on", "tomorrow"), per-cycle counters, in-flight task state.

Existing memories (do not duplicate):
{existingMemories}

Return a JSON array of objects, each with:
- "type": one of "identity", "preference", "context"
- "summary": one-line fact (e.g., "User is vegetarian", "User lives in Tokyo")

Negative examples (DO NOT emit any of these):
  - "I want to schedule a meeting" → skip (this is a task)
  - "Alice works at Notion" → skip (Alice + Notion are entities)
  - "Got it, thanks" → skip (ack)
  - "Waiting on Q2 feedback" → skip (ephemeral status)

If there are no new facts that pass the ladder, return an empty array: [].

Respond with ONLY the JSON array, no other text.`

export type PreCompactionExtractionOptions = {
  provider: LLMProvider
  model: string
  messages: Message[]
  existingMemories: string[]
}

export type PreCompactionExtractionResult = {
  facts: ExtractedFact[]
  /**
   * API-reported usage from the extractor LLM call. Null when the
   * extractor never ran (empty user text) or when the call threw — in
   * which case the caller has nothing to attribute.
   */
  usage: TokenUsage | null
  /** Model the extractor ran on; null if the call didn't happen. */
  model: string | null
}

/**
 * Safety net: extract user facts from conversation before compaction
 * destroys the raw messages. Runs both regex extraction ($0) and a cheap
 * LLM pass. Returns deduplicated facts ready for store.create() plus
 * the LLM call's token usage so the caller can attribute it as
 * `overhead:extraction` in the UsageStore.
 */
export async function extractMemoriesBeforeCompaction(
  options: PreCompactionExtractionOptions,
): Promise<PreCompactionExtractionResult> {
  // Collect all user message text
  const userText = options.messages
    .filter((m) => m.role === 'user')
    .map((m) => typeof m.content === 'string' ? m.content : m.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join(' '),
    )
    .join('\n')

  if (userText.trim().length === 0) {
    return { facts: [], usage: null, model: null }
  }

  // v2 (Q9): regex Phase 1 retired. Pre-compaction extraction is now
  // LLM-only — facts go through the same classification path as
  // Pipeline B so we stop emitting flat memories where tasks or entity
  // attributes would be more appropriate.
  const existingSet = new Set(options.existingMemories.map((m) => m.toLowerCase()))
  let llmFacts: ExtractedFact[] = []
  let usage: TokenUsage | null = null

  try {
    const prompt = EXTRACTION_PROMPT.replace(
      '{existingMemories}',
      options.existingMemories.length > 0
        ? options.existingMemories.map((m) => `- ${m}`).join('\n')
        : '(none)',
    )

    const response = await collectStream(
      options.provider.stream({
        model: options.model,
        messages: [
          ...options.messages,
          { role: 'user', content: prompt },
        ],
        systemPrompt: 'You are a fact extraction assistant. Return only valid JSON.',
        maxTokens: 1_000,
      }),
    )

    usage = response.usage

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    // Parse JSON — handle markdown code fences
    const jsonStr = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
    const parsed = JSON.parse(jsonStr) as Array<{ type: string; summary: string }>

    if (Array.isArray(parsed)) {
      llmFacts = parsed
        .filter((f) => f.type && f.summary && !existingSet.has(f.summary.toLowerCase()))
        .map((f) => ({
          type: f.type as ExtractedFact['type'],
          summary: f.summary,
          confidence: 0.6,
        }))
    }
  } catch {
    // LLM extraction is best-effort — regex facts are still returned.
    // `usage` may have been set before a JSON-parse failure; we keep it
    // so the caller still attributes the tokens we did consume.
  }

  // Dedup against existing memories — LLM facts only (regex retired).
  const seen = new Set<string>()
  const merged: ExtractedFact[] = []

  for (const fact of llmFacts) {
    const key = fact.summary.toLowerCase()
    if (seen.has(key) || existingSet.has(key)) continue
    seen.add(key)
    merged.push(fact)
  }

  return { facts: merged, usage, model: usage ? options.model : null }
}
