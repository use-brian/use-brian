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

import { decisionUsageModelId } from '../decisions/usage.js'
import { registryRow } from '@use-brian/shared/model-registry'
import { bindScopeSources, boundScopeSources } from '../security/source-evidence.js'
import { isTrivialChatMessage } from '../classification/trivial-chat.js'
import { DerivedScopeError } from '../security/derived-scope.js'
import { assertInputAuthority, assertProviderInputPreparation, captureInputAdmissionProvider, isInputAuthorityError } from '../providers/input-authority.js'
import type { SessionContextAuthority } from './session-state-types.js'
import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'
import type { DecisionAnswer, DecisionExecutionPort, DecisionResponse } from '../decisions/index.js'
import { DecisionProviderError } from '../decisions/types.js'
import { decisionCompletionInput } from '../decisions/invocation.js'
import { captureClassifierDecisionRuntime, assertClassifierBookkeeping } from '../decisions/authority-ownership.js'

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
  /** Cheap model, or the host's configured standard fallback. */
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
  /** Provider-neutral decision cascade. Omitted preserves the legacy call. */
  decisionRuntime?: DecisionExecutionPort
  workspaceId?: string
  runId?: string
  /** Host-only canonical invocation; the complete options object must be privately bound. */
  authority?: SessionContextAuthority
  /** Rechecks local, field and independent source rights, including provider retries. */
  /** False when host input includes attachments, non-text blocks or an explicit reply. */
  allowTrivialShortcut?: boolean
  assertInputAuthority?: () => Promise<void>
  /** Cancels classifier transports with the containing turn. */
  signal?: AbortSignal
  /** Optional absolute host deadline; can only narrow the classifier budget. */
  deadlineAt?: number
}

type BoundedTopicClassifierOptions = TopicClassifierOptions & {
  signal: AbortSignal
  deadlineAt: number
}

const TOPIC_CLASSIFIER_TIMEOUT_MS = 2_000
const SLOW_TOPIC_CLASSIFIER_TIMEOUT_MS = 8_000

/** Routing hides the serving provider's name; use its exact registry identity,
 * not model-name substrings. Unknown models retain the fast default. The
 * standard OpenAI-compatible lane may also serve the host's background work
 * when Flash is unavailable. Neither lane gets an unbounded generation wait.
 */
function topicClassifierTimeoutMs({ provider, model }: TopicClassifierOptions): number {
  const row = registryRow(model)
  const servingProvider = provider.name === 'routing' ? row?.provider : provider.name
  if (servingProvider === 'openai-codex') return SLOW_TOPIC_CLASSIFIER_TIMEOUT_MS
  if (servingProvider?.startsWith('openai-compat:') && row?.class === 'standard-pro') {
    return SLOW_TOPIC_CLASSIFIER_TIMEOUT_MS
  }
  return TOPIC_CLASSIFIER_TIMEOUT_MS
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
 * ordinary provider/parse error. Authority refusals propagate. Callers should treat confidence === 0 as "no signal".
 */
async function classifyTopicWithLlm(
  opts: BoundedTopicClassifierOptions,
): Promise<TopicClassification> {
  let usage: TokenUsage | null = null
  let servedModel = opts.model
  const provider = captureInputAdmissionProvider(opts.provider)
  try {
    const messages = [{ role: 'user' as const, content: buildClassifierPrompt(opts) }]
    await assertProviderInputPreparation(provider, { model: opts.model, messages }, opts.assertInputAuthority)
    opts.signal.throwIfAborted()
    const response = await collectStream(
      provider.stream({
        model: opts.model,
        assertInputAuthority: opts.assertInputAuthority,
        signal: opts.signal,
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        messages,
        // Keep room for complete JSON on providers with mandatory reasoning,
        // while requesting their smallest reasoning budget for this task.
        maxTokens: 2000,
        temperature: 0.1,
        thinkingLevel: 'low',
      }),
    )

    await assertInputAuthority(opts.assertInputAuthority)
    opts.signal.throwIfAborted()
    usage = response.usage
    servedModel = response.model || opts.model

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')

    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
    // Be forgiving if the model emits a leading sentence: grab the first {...} block.
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { ...FALLBACK, usage, model: servedModel }

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

    return { topic_label, state, confidence, related_topics, usage, model: servedModel }
  } catch (error) {
    if (isInputAuthorityError(error)) throw error
    await assertInputAuthority(opts.assertInputAuthority)
    // Call itself threw — no usage to attribute, caller records nothing.
    return { ...FALLBACK, usage, model: usage ? servedModel : undefined }
  }
}

const TOPIC_OPERATION = {
  id: 'memory.topic',
  version: '1',
  stateVersion: '1',
  questionVersion: '1',
} as const

function answerConfidence(answer: DecisionAnswer): number {
  if (answer.evidence.confidence !== undefined) return answer.evidence.confidence
  if (answer.kind === 'boolean' && answer.pTrue !== undefined) {
    return answer.value ? answer.pTrue : 1 - answer.pTrue
  }
  if (answer.kind === 'choice') return answer.evidence.probabilities?.[answer.value] ?? 0
  return 0
}

function validateTopicResult(result: TopicClassification): TopicClassification {
  if (!result.topic_label.trim()) throw new Error('topic classifier returned an empty label')
  if (!['continue', 'shift', 'resume', 'cross-topic'].includes(result.state)) {
    throw new Error('topic classifier returned an invalid state')
  }
  if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
    throw new Error('topic classifier returned invalid confidence')
  }
  if (result.state === 'cross-topic' && (!result.related_topics || result.related_topics.length === 0)) {
    throw new Error('cross-topic classification requires related topics')
  }
  return result
}

function decideTopic(
  response: DecisionResponse,
  knownTopics: readonly string[],
  policy: import('../decisions/index.js').JsonValue | undefined,
) {
  const state = response.answers.find((answer) => answer.questionId === 'state')
  const topic = response.answers.find((answer) => answer.questionId === 'topic')
  if (state?.kind !== 'choice' || topic?.kind !== 'choice') {
    return { kind: 'unavailable' as const, reason: 'invalid_response' as const }
  }
  const reviewBelow = typeof policy === 'object' && policy !== null && !Array.isArray(policy)
    && typeof policy.reviewBelow === 'number'
    ? policy.reviewBelow
    : undefined
  if (
    reviewBelow !== undefined &&
    Math.min(answerConfidence(state), answerConfidence(topic)) < reviewBelow
  ) return { kind: 'follow_up' as const, reason: 'uncertain' as const }

  // Insufficient signal is a declared, valid answer, not a provider failure.
  // Keep the policy review above this terminal safe classification.
  if (
    (state.value === 'continue' || state.value === 'resume') &&
    topic.value === '__uncategorized__'
  ) {
    return {
      kind: 'complete' as const,
      result: {
        ...FALLBACK,
        usage: response.usage
          ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
          : null,
        model: decisionUsageModelId(response.model),
      } satisfies TopicClassification,
    }
  }
  if (
    (state.value === 'continue' || state.value === 'resume') &&
    knownTopics.includes(topic.value)
  ) {
    return {
      kind: 'complete' as const,
      result: {
        topic_label: topic.value,
        state: state.value,
        confidence: Math.min(answerConfidence(state), answerConfidence(topic)),
        usage: response.usage
          ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
          : null,
        model: decisionUsageModelId(response.model),
      } satisfies TopicClassification,
    }
  }
  if (state.value === 'shift' || state.value === 'cross-topic' || topic.value === '__new_topic__') {
    return { kind: 'follow_up' as const, reason: 'generation_required' as const }
  }
  return { kind: 'unavailable' as const, reason: 'invalid_response' as const }
}

/**
 * Classify the topic of the current user turn. Always returns a
 * classification - falls back to `(uncategorized) / continue / 0.0` on any
 * ordinary provider/parse error. Authority refusals propagate. Existing known labels can terminate in the decision provider; new
 * labels and cross-topic payloads use one LLM completion.
 */
async function classifyTopicCurrent(
  opts: BoundedTopicClassifierOptions,
): Promise<TopicClassification> {
  if (!opts.decisionRuntime) return classifyTopicWithLlm(opts)

  const knownTopics = [...new Set([
    ...opts.knownTopicsThisSession,
    ...opts.recentUserTurns.flatMap((turn) => turn.topicLabel ? [turn.topicLabel] : []),
  ])].filter((label) => label.trim().length > 0).slice(0, 20)

  try {
    const cascade = await opts.decisionRuntime.run({
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      llm: { provider: opts.provider, modelId: opts.model },
      request: {
        runId: opts.runId ?? `memory-topic-${Date.now()}`,
        signal: opts.signal,
        deadlineAt: opts.deadlineAt,
        operation: TOPIC_OPERATION,
        state: {
          recentUserTurns: opts.recentUserTurns.slice(-8),
          replyToText: opts.replyToText,
          currentMessage: opts.currentMessage,
          knownTopics,
        },
        questions: [
          {
            kind: 'choice',
            id: 'state',
            prompt: 'Is this turn continuing, shifting, resuming, or combining known topics?',
            options: [
              { value: 'continue' },
              { value: 'shift' },
              { value: 'resume' },
              { value: 'cross-topic' },
            ],
          },
          {
            kind: 'choice',
            id: 'topic',
            prompt: 'Select the exact existing topic label, or choose new topic when none matches.',
            options: [
              ...knownTopics.map((value) => ({ value })),
              { value: '__new_topic__', description: 'No existing topic label matches' },
              { value: '__uncategorized__', description: 'There is not enough topic signal' },
            ],
          },
        ],
      },
      operation: {
        assertInputAuthority: opts.assertInputAuthority,
        decide: (response, { profile }) => decideTopic(response, knownTopics, profile?.policy),
        validateResult: validateTopicResult,
        safeFailure: () => ({ ...FALLBACK }),
        async completeWithLlm(context) {
          const result = await classifyTopicWithLlm({
            ...opts,
            provider: context.llm.provider,
            model: context.llm.modelId,
            decisionRuntime: undefined,
            ...decisionCompletionInput(context, opts),
            deadlineAt: Math.min(opts.deadlineAt, context.deadlineAt ?? opts.deadlineAt),
          })
          return {
            result,
            providerId: context.llm.provider.name,
            model: { catalogId: context.llm.modelId, wireId: result.model ?? context.llm.modelId },
            ...(result.usage ? {
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
              },
            } : {}),
          }
        },
      },
    })
    await assertClassifierBookkeeping(opts.assertInputAuthority)
    if (cascade.failureKind === 'timeout') {
      console.warn('[topic-classifier] decision deadline exceeded; using uncategorized fallback')
    }
    return cascade.result
  } catch (error) {
    if (isInputAuthorityError(error)) throw error
    await assertClassifierBookkeeping(opts.assertInputAuthority)
    if (error instanceof DecisionProviderError && error.kind === 'timeout') {
      console.warn('[topic-classifier] decision deadline exceeded; using uncategorized fallback')
    }
    return { ...FALLBACK }
  }
}

/** Current, complete input evidence survives every classifier decision and fallback. */
export async function classifyTopic(incoming: TopicClassifierOptions): Promise<TopicClassification> {
  const opts = { ...incoming }
  const inputs = boundScopeSources(incoming), authority = opts.authority
  const execution = authority?.execution, accumulator = authority?.accumulator
  const assertCurrent = execution?.security.authority.assertCurrent.bind(execution.security.authority)
  const lifecycleSignal = execution?.lifecycle.abortSignal
  if (authority) {
    if (inputs.length === 0 || typeof opts.assertInputAuthority !== 'function') {
      throw new DerivedScopeError('scope_evidence_missing')
    }
    accumulator!.note({ sources: inputs })
  } else if (inputs.length > 0) {
    throw new DerivedScopeError('scope_evidence_missing')
  }
  // Capture bytes and host callbacks before any awaited lease or route lookup.
  const input = structuredClone({ recentUserTurns: opts.recentUserTurns, replyToText: opts.replyToText,
    currentMessage: opts.currentMessage, knownTopicsThisSession: opts.knownTopicsThisSession })
  const observed = accumulator ? structuredClone(accumulator.evidence.sources ?? []) : inputs
  // Recovery may not turn an earlier refusal into success if a later probe
  // happens to pass. One invocation has one continuous authority window.
  let refusal: unknown
  let pending: Promise<void> | undefined
  let closed = false
  const closedError = new Error('The topic classifier authority window has closed')
  const check = async () => {
    // A canceled transport may unwind after fallback has returned and the
    // caller has added annotation/history evidence to its live accumulator.
    // That work no longer owns a model boundary in the continuing turn.
    if (closed) throw closedError
    if (refusal) throw refusal
    if (pending) return pending
    pending = (async () => {
      if (assertCurrent) {
        await assertInputAuthority(assertCurrent)
        if (lifecycleSignal!.aborted) {
          throw Object.assign(new Error('The model context is unavailable.'), { reason: 'authority_changed', retrySafe: false })
        }
      }
      await assertInputAuthority(opts.assertInputAuthority)
    })().catch(error => { refusal = error; throw error })
    try { await pending } finally { pending = undefined }
  }
  const active = async () => {
    if (closed) throw closedError
    if (refusal) throw refusal
    if (pending) await pending
    opts.signal?.throwIfAborted()
    try {
      if (assertCurrent) {
        await assertInputAuthority(assertCurrent)
        if (lifecycleSignal!.aborted) {
          throw Object.assign(new Error('The model context is unavailable.'), { reason: 'authority_changed', retrySafe: false })
        }
      }
    } catch (error) { refusal = error; throw error }
    opts.signal?.throwIfAborted()
    if (refusal) throw refusal
  }
  const decisionRuntime = captureClassifierDecisionRuntime(opts.decisionRuntime, check, active)
  await assertClassifierBookkeeping(check)
  if (opts.allowTrivialShortcut !== false && !input.replyToText && isTrivialChatMessage(input.currentMessage)) {
    const prior = [...input.recentUserTurns].reverse().find(turn => turn.topicLabel)?.topicLabel
    const finalCheck = check()
    closed = true
    await finalCheck
    return bindScopeSources({ ...FALLBACK, topic_label: prior ? normalizeLabel(prior) || FALLBACK.topic_label : FALLBACK.topic_label,
      usage: null }, observed)
  }
  const controller = new AbortController()
  const signal = AbortSignal.any([
    controller.signal,
    ...(opts.signal ? [opts.signal] : []),
    ...(lifecycleSignal ? [lifecycleSignal] : []),
  ])
  const startedAt = Date.now()
  const deadlineAt = Math.min(startedAt + topicClassifierTimeoutMs(opts),
    Number.isFinite(opts.deadlineAt) ? opts.deadlineAt! : Infinity)
  const timeoutMs = Math.max(0, deadlineAt - startedAt)
  const timeoutError = new Error('topic classifier deadline exceeded')
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    if (timeoutMs === 0) {
      controller.abort(timeoutError)
      reject(timeoutError)
      return
    }
    timer = setTimeout(() => {
      controller.abort(timeoutError)
      reject(timeoutError)
    }, timeoutMs)
  })
  let result: TopicClassification
  let timedOut = false
  try {
    try {
      result = await Promise.race([
        classifyTopicCurrent({ ...opts, ...input, decisionRuntime, assertInputAuthority: check, signal, deadlineAt }),
        deadline,
      ])
    } catch (error) {
      if (isInputAuthorityError(error)) throw error
      if (error !== timeoutError) throw error
      // The final admission below joins any pending check and preserves a
      // sticky refusal. Do not finish it here and immediately start it again.
      timedOut = true
      result = { ...FALLBACK }
    }
    // Start (or join) the last check, then close new callback entries before
    // awaiting it. A losing cascade cannot start another check in the
    // microtask between this validation completing and our return.
    const finalCheck = check()
    closed = true
    await finalCheck
    if (timedOut) console.warn('[topic-classifier] deadline exceeded; using uncategorized fallback', {
      timeoutMs,
    })
    return bindScopeSources(result, observed)
  } finally {
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }
}
