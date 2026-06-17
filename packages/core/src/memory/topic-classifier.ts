/**
 * Per-turn topic classifier.
 *
 * Runs once per incoming user message against a cheap Flash model. Its
 * output drives three downstream consumers:
 *  1. Episodic retrieval — picks which topic rows to auto-inject.
 *  2. System-prompt topic hint — tells the main model what topic the
 *     current turn belongs to (#2).
 *  3. Message persistence — `topic_label` + `topic_confidence` are stored
 *     on the user message row for future queries and for #3 compaction
 *     to key its clustering.
 *
 * Classifier input intentionally includes the reply-to text as a
 * high-weight prior: when the user explicitly replies to an earlier
 * message, the classifier treats that as strong evidence without
 * forcing the topic (the reply might still shift the subject).
 *
 * On JSON-parse failure or provider error, we fall back to
 * `{ topic_label: '(uncategorized)', state: 'continue', confidence: 0 }`
 * so downstream code always gets a usable classification.
 *
 * Cost: ~1 Flash call per user turn (~$0.0001 each at current pricing).
 */

import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'

export type TopicState = 'continue' | 'shift' | 'resume' | 'cross-topic'

export type TopicClassification = {
  /** Normalized (lowercase, trimmed) free-form short label. */
  topic_label: string
  state: TopicState
  /** 0..1 — 0 signals the fallback path (parse failed / no signal). */
  confidence: number
  /** Non-empty on `cross-topic`; up to 2 topic labels from known topics. */
  related_topics?: string[]
  /**
   * API-reported usage of the classifier LLM call. Present when the call
   * reached the provider (even if the JSON parse later failed); null when
   * the call itself threw. Callers attribute it as `overhead:classifier`.
   */
  usage?: TokenUsage | null
  /** Model the classifier ran on; mirrors the options.model the caller passed. */
  model?: string
}

export type ClassifierRecentTurn = {
  text: string
  topicLabel: string | null
}

export type TopicClassifierOptions = {
  provider: LLMProvider
  /** Cheap model — production should pass Gemini Flash. */
  model: string
  recentUserTurns: ClassifierRecentTurn[]
  /**
   * Text of the message the user is explicitly replying to, if any.
   * Strong prior — the classifier is told the user is anchoring to this
   * message, but still free to classify the current turn as a shift.
   */
  replyToText: string | null
  currentMessage: string
  /** Distinct topic labels from the session so far; used to detect resume. */
  knownTopicsThisSession: string[]
}

const CLASSIFIER_SYSTEM_PROMPT =
  'You are a topic classifier for a conversational assistant. ' +
  'Respond with ONE JSON object and nothing else. No markdown fences, no commentary.'

const FALLBACK: TopicClassification = {
  topic_label: '(uncategorized)',
  state: 'continue',
  confidence: 0,
}

function buildClassifierPrompt(opts: TopicClassifierOptions): string {
  const recent = opts.recentUserTurns.length > 0
    ? opts.recentUserTurns
        .map((t, i) => {
          const label = t.topicLabel ? ` [topic: ${t.topicLabel}]` : ''
          return `  ${i + 1}.${label} ${truncate(t.text, 200)}`
        })
        .join('\n')
    : '  (none)'

  const known = opts.knownTopicsThisSession.length > 0
    ? opts.knownTopicsThisSession.slice(0, 20).map((t) => `  - ${t}`).join('\n')
    : '  (none)'

  const replyBlock = opts.replyToText
    ? `\n\nReply-to (STRONG PRIOR — the user is explicitly replying to this message):\n  "${truncate(opts.replyToText, 500)}"`
    : ''

  return `Classify the topic of the user's new message.

Recent user turns (oldest → newest, with prior topic labels if any):
${recent}

Known topics discussed earlier in this session:
${known}${replyBlock}

Current message:
  "${truncate(opts.currentMessage, 500)}"

Output JSON only, matching this shape:
{
  "topic_label": "<short lowercase free-form, 2-6 words>",
  "state": "continue" | "shift" | "resume" | "cross-topic",
  "confidence": 0.0-1.0,
  "related_topics": ["<label>", "<label>"]   // required when state is "cross-topic", otherwise omit
}

State rules:
- "continue": the current message is on the same topic as the previous user turn.
- "shift": a topic not discussed before in this session.
- "resume": returning to a topic that appears in "Known topics" but is NOT the previous turn's topic.
- "cross-topic": the current message references two or more known topics at once (list them in related_topics).

Label derivation rules (READ CAREFULLY):
- If an existing known topic matches, REUSE its exact label verbatim. Do NOT paraphrase, translate, or "improve" it.
- Derive new labels from the actual text of the conversation. Do NOT use external world knowledge to expand, translate, or canonicalize what the users wrote. If they only ever wrote the Chinese title of a movie, the label is the Chinese title — not the English title you happen to know.
- Match the language the users are actually writing in. If the conversation is in Chinese, the label is in Chinese. If English, English. Do not switch languages for the label.
- Prefer short, neutral noun phrases drawn from the surface text (2-6 words). Avoid full proper-noun titles the users never typed.
- Topic labels are lowercase, no quotes, no trailing punctuation.

Confidence rules:
- Reply-to is a strong prior. If the replied-to message was about topic X, default to X unless the current message genuinely pivots (then state is "shift" or "resume").
- If the current message is very short and ambiguous with no reply-to, keep confidence below 0.5.`
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/^['"“”]+|['"“”.,;:!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Classify the topic of the current user turn. Always returns a
 * classification — falls back to `(uncategorized) / continue / 0.0` on
 * any error. Callers should treat confidence === 0 as "no signal".
 */
export async function classifyTopic(
  opts: TopicClassifierOptions,
): Promise<TopicClassification> {
  let usage: TokenUsage | null = null
  try {
    const response = await collectStream(
      opts.provider.stream({
        model: opts.model,
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildClassifierPrompt(opts) }],
        // Gemini Flash 3 preview consumes "thinking tokens" before emitting
        // visible output. A 200-token cap was regularly exhausted before the
        // JSON object finished, yielding truncated output like `{"topic_label":`
        // which failed to parse and fell back to (uncategorized). 2000 is
        // safely over the worst-case thinking budget for a classification
        // this small.
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
    // Be forgiving if the model emits a leading sentence: grab the first {...} block.
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { ...FALLBACK, usage, model: opts.model }

    const parsed = JSON.parse(jsonMatch[0]) as {
      topic_label?: unknown
      state?: unknown
      confidence?: unknown
      related_topics?: unknown
    }

    const rawLabel = typeof parsed.topic_label === 'string' ? parsed.topic_label : ''
    const topic_label = normalizeLabel(rawLabel) || FALLBACK.topic_label

    const stateRaw = parsed.state
    const state: TopicState =
      stateRaw === 'continue' || stateRaw === 'shift' ||
      stateRaw === 'resume' || stateRaw === 'cross-topic'
        ? stateRaw
        : 'continue'

    let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
    if (!Number.isFinite(confidence)) confidence = 0
    confidence = Math.max(0, Math.min(1, confidence))

    let related_topics: string[] | undefined
    if (state === 'cross-topic' && Array.isArray(parsed.related_topics)) {
      related_topics = parsed.related_topics
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map(normalizeLabel)
        .filter((t) => t.length > 0 && t !== topic_label)
        .slice(0, 2)
      if (related_topics.length === 0) related_topics = undefined
    }

    return { topic_label, state, confidence, related_topics, usage, model: opts.model }
  } catch {
    // Call itself threw — no usage to attribute, caller records nothing.
    return { ...FALLBACK, usage, model: usage ? opts.model : undefined }
  }
}
