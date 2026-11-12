/**
 * Pre-flight classifier for automatic parallel worker delegation.
 *
 * Determines whether a user message requires multiple independent research
 * tasks that can be run in parallel. Uses the Standard-tier model (Gemini
 * 3.1 Flash Lite) for the classification — the decision itself is cheap
 * (~200ms, ~50 tokens out). Standard-tier per the bucketed routing rules
 * in docs/architecture/platform/cost-and-pricing.md → Model routing
 * (extraction / classification / structured-output bucket).
 */

import { decisionUsageModelId } from '../decisions/usage.js'
import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'
import { bindScopeSources, boundScopeSources } from '../security/source-evidence.js'
import { DerivedScopeError } from '../security/derived-scope.js'
import type { SessionContextAuthority } from '../memory/session-state-types.js'
import { assertInputAuthority, assertProviderInputPreparation, captureInputAdmissionProvider, isInputAuthorityError, ownsInputAdmission } from '../providers/input-authority.js'
import { captureClassifierDecisionRuntime, assertClassifierBookkeeping, registerClassifierLlmCompletion } from '../decisions/authority-ownership.js'
import { decisionCompletionInput } from '../decisions/invocation.js'
import type { DecisionExecutionOperation } from '../decisions/index.js'
import type { DecisionExecutionPort, DecisionResponse } from '../decisions/index.js'

const CLASSIFIER_SYSTEM_PROMPT = `You decide if a user message requires parallel independent research.
Return JSON only. No explanation.

Split when ALL of these are true:
1. The task requires 2-3 genuinely INDEPENDENT topics
2. Each topic requires a separate search or lookup
3. The topics do NOT depend on each other (can be researched simultaneously)

Do NOT split when:
- Simple question or single lookup
- Follow-up on previous conversation context
- The topics are dependent (need result A before searching B)
- Message is short and casual
- Message is a greeting or acknowledgment
- A SINGLE broad search can cover the request (e.g. "best restaurants in Tokyo" = 1 search, not 10 individual restaurant searches)

RULES:
- Maximum 3 tasks. If you think of more, merge related ones.
- Each task prompt = 1 web search. Example: "Search for top rated restaurants in Osaka with price range info. Return top 5 with name, cuisine, and price range."
- Do NOT enumerate individual items as separate tasks (e.g. do NOT create one task per restaurant or per attraction).
- Do NOT write open-ended prompts like "research everything about X."
- Only write deeper prompts when the user EXPLICITLY asks for thorough/deep/comprehensive research.
- Each task prompt must have a clear end condition so the worker knows when to stop.

If split: {"split":true,"tasks":["self-contained research prompt 1","..."]}
If not: {"split":false}`

const MIN_MESSAGE_LENGTH = 40
const CLASSIFIER_MODEL = 'gemini-3.5-flash-lite'

export type SplitOptions = {
  /** Host-only, privately scope-bound canonical input authority. */
  authority?: SessionContextAuthority
  signal?: AbortSignal
  assertInputAuthority?: () => Promise<void>
  deadlineAt?: number
  provider: LLMProvider
  message: string
  minMessageLength?: number
  /**
   * Background-lane model. Callers with boot context (the API routes) pass an
   * id already checked servable against the configured providers; the default
   * keeps standalone/test use on the historical literal.
   */
  model?: string
  /** Provider-neutral decision cascade. Omitted preserves the legacy call. */
  decisionRuntime?: DecisionExecutionPort
  workspaceId?: string
  runId?: string
}

export type SplitResult = {
  /** Parallel task prompts, or null when splitting was not warranted. */
  tasks: string[] | null
  /** Token usage from the classifier call — null when no call was made. */
  usage: TokenUsage | null
  /** Model used for the call — null when no call was made. */
  model: string | null
}

const SPLIT_OPERATION = {
  id: 'research.split',
  version: '1',
  stateVersion: '1',
  questionVersion: '1',
} as const

function validateSplitResult(result: SplitResult): SplitResult {
  if (result.tasks === null) return result
  if (
    result.tasks.length < 2 || result.tasks.length > 3 ||
    result.tasks.some((task) => typeof task !== 'string' || task.trim().length === 0)
  ) throw new Error('splitter returned an invalid task set')
  return result
}

function primaryNoSplit(response: DecisionResponse): SplitResult | null {
  const answer = response.answers[0]
  if (answer?.kind !== 'boolean' || answer.value) return null
  return {
    tasks: null,
    usage: response.usage
      ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
      : null,
    model: decisionUsageModelId(response.model),
  }
}

async function classifySplitWithLlm(params: {
  provider: LLMProvider
  model: string
  message: string
  signal?: AbortSignal
  assertInputAuthority?: () => Promise<void>
  deadlineAt?: number
}): Promise<SplitResult> {
  const provider = captureInputAdmissionProvider(params.provider)
  const messages = [{ role: 'user' as const, content: params.message }]
  await assertProviderInputPreparation(provider, { model: params.model, messages }, params.assertInputAuthority)
  params.signal?.throwIfAborted()
  const stream = provider.stream({
    signal: params.signal,
    assertInputAuthority: params.assertInputAuthority,
    model: params.model,
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    messages,
    maxTokens: 512,
    temperature: 0,
  })

  const response = await collectStream(stream)
  params.signal?.throwIfAborted()
  await assertInputAuthority(params.assertInputAuthority)
  const text = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { tasks: null, usage: response.usage, model: response.model || params.model }

  const parsed = JSON.parse(jsonMatch[0]) as { split?: unknown; tasks?: unknown }
  if (
    parsed.split !== true || !Array.isArray(parsed.tasks) ||
    parsed.tasks.length < 2 || parsed.tasks.length > 3 ||
    parsed.tasks.some((task) => typeof task !== 'string' || task.trim().length === 0)
  ) return { tasks: null, usage: response.usage, model: response.model || params.model }

  return {
    tasks: parsed.tasks as string[],
    usage: response.usage,
    model: response.model || params.model,
  }
}

/**
 * Classify whether a user message should be split into parallel sub-tasks.
 *
 * Returns `tasks` (array of self-contained task prompts, or null if no split
 * is needed) together with the token usage + model so the caller can record
 * the classifier cost as `overhead:splitter`.
 */
async function classifySplitCurrent(options: SplitOptions): Promise<SplitResult> {
  const model = options.model ?? CLASSIFIER_MODEL
  const { provider, message, minMessageLength = MIN_MESSAGE_LENGTH } = options

  // Short messages never need splitting — short-circuit before the LLM call.
  if (message.length <= minMessageLength) return { tasks: null, usage: null, model: null }

  if (options.decisionRuntime) {
    const result = await options.decisionRuntime.run({
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      llm: { provider, modelId: model },
      request: {
        runId: options.runId ?? `research-split-${Date.now()}`,
        operation: SPLIT_OPERATION,
        state: { message },
        signal: options.signal,
        deadlineAt: options.deadlineAt,
        assertInputAuthority: options.assertInputAuthority,
        questions: [{
          kind: 'boolean',
          id: 'split',
          prompt: 'Does this request require two or three genuinely independent research searches?',
          criteria: {
            true: 'Two or three independent searches are required and can run concurrently',
            false: 'One search, a dependent sequence, a follow-up, or a casual request',
          },
        }],
      },
      operation: registerClassifierLlmCompletion<DecisionExecutionOperation<SplitResult>>({
        assertInputAuthority: options.assertInputAuthority,
        decide(response, { profile }) {
          const answer = response.answers[0]
          if (answer?.kind !== 'boolean') return { kind: 'unavailable', reason: 'invalid_response' }
          const policy = profile?.policy
          const uncertaintyMin = typeof policy === 'object' && policy !== null && !Array.isArray(policy)
            && typeof policy.uncertaintyMin === 'number'
            ? policy.uncertaintyMin
            : undefined
          const uncertaintyMax = typeof policy === 'object' && policy !== null && !Array.isArray(policy)
            && typeof policy.uncertaintyMax === 'number'
            ? policy.uncertaintyMax
            : undefined
          if (
            answer.pTrue !== undefined && uncertaintyMin !== undefined && uncertaintyMax !== undefined &&
            answer.pTrue >= uncertaintyMin && answer.pTrue <= uncertaintyMax
          ) {
            return { kind: 'follow_up', reason: 'uncertain' }
          }
          if (answer.value) return { kind: 'follow_up', reason: 'generation_required' }
          const terminal = primaryNoSplit(response)
          return terminal
            ? { kind: 'complete', result: terminal }
            : { kind: 'unavailable', reason: 'invalid_response' }
        },
        validateResult: validateSplitResult,
        safeFailure: () => ({ tasks: null, usage: null, model: null }),
        async completeWithLlm(context) {
          const result = await classifySplitWithLlm({
            provider: context.llm.provider,
            ...decisionCompletionInput(context, options),
            deadlineAt: options.deadlineAt,
            model: context.llm.modelId,
            message,
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
      }, route => ownsInputAdmission(route.provider, {
        model: route.modelId, messages: [{ role: 'user', content: message }],
      })),
    })
    return result.result
  }

  try {
    return await classifySplitWithLlm({ provider, model, message, signal: options.signal, assertInputAuthority: options.assertInputAuthority, deadlineAt: options.deadlineAt })
  } catch (error) {
    if (isInputAuthorityError(error)) throw error
    options.signal?.throwIfAborted()
    await assertInputAuthority(options.assertInputAuthority)
    // Any failure in classification → safe default, no split. Usage is lost
    // because the stream didn't complete — caller records nothing.
    return { tasks: null, usage: null, model: null }
  }
}


/** One continuous authority window, including deadline/cancellation recovery. */
export async function classifySplit(incoming: SplitOptions): Promise<SplitResult> {
  // Pin authored bytes, callbacks, and dispatch implementations before any await.
  const options = { ...incoming, message: structuredClone(incoming.message),
    provider: captureInputAdmissionProvider(incoming.provider) }
  const sources = boundScopeSources(incoming), authority = options.authority
  const execution = authority?.execution, accumulator = authority?.accumulator
  const current = execution?.security.authority.assertCurrent.bind(execution.security.authority)
  const lifecycle = execution?.lifecycle.abortSignal
  if (authority) {
    if (!sources.length || typeof options.assertInputAuthority !== 'function') throw new DerivedScopeError('scope_evidence_missing')
    accumulator!.note({ sources })
  } else if (sources.length) throw new DerivedScopeError('scope_evidence_missing')
  const observed = accumulator ? structuredClone(accumulator.evidence.sources ?? []) : sources
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : []), ...(lifecycle ? [lifecycle] : [])])
  let closed = false, refusal: unknown, pending: Promise<void> | undefined
  const closedError = new Error('The splitter authority window has closed')
  const lease = async () => {
    if (current) await assertInputAuthority(current)
    if (lifecycle?.aborted) throw Object.assign(new Error('The splitter context is unavailable.'), { reason: 'authority_changed', retrySafe: false })
  }
  // Caller/deadline cancellation never skips or poisons the live authority proof.
  const proof = async () => {
    try { await lease(); await assertInputAuthority(options.assertInputAuthority); await lease() }
    catch (error) { refusal = error; throw error }
  }
  const check = async () => {
    if (closed) throw closedError
    if (refusal) throw refusal
    if (pending) return pending
    pending = proof()
    try { await pending } finally { pending = undefined }
  }
  const active = async () => {
    if (closed) throw closedError
    if (pending) await pending
    if (refusal) throw refusal
    try { await lease() } catch (error) { refusal = error; throw error }
    signal.throwIfAborted()
  }
  const decisionRuntime = captureClassifierDecisionRuntime(options.decisionRuntime, check, active)
  const deadlineAt = Number.isFinite(options.deadlineAt) ? options.deadlineAt : undefined
  const timeoutError = new Error('splitter deadline exceeded')
  let timer: ReturnType<typeof setTimeout> | undefined
  let interrupt!: (error: unknown) => void
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject })
  const onAbort = () => interrupt(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  if (deadlineAt !== undefined) {
    const expire = () => { controller.abort(timeoutError); interrupt(timeoutError) }
    if (Date.now() >= deadlineAt) expire()
    else timer = setTimeout(expire, deadlineAt - Date.now())
  }
  const noSplit: SplitResult = { tasks: null, usage: null, model: null }
  try {
    let result = noSplit
    let failure: unknown
    try {
      result = await Promise.race([interrupted, (async () => {
        signal.throwIfAborted()
        await assertClassifierBookkeeping(check)
        signal.throwIfAborted()
        return classifySplitCurrent({ ...options, decisionRuntime, signal, deadlineAt, assertInputAuthority: check })
      })()])
    } catch (error) {
      if (isInputAuthorityError(error)) refusal = error
      else if (!signal.aborted) failure = error
    }
    // Close first: losing transports cannot start more proofs or obtain receipts.
    closed = true
    if (pending) await pending
    if (refusal) throw refusal
    await proof() // fresh validation AFTER joining any in-flight admission
    if (refusal) throw refusal
    options.signal?.throwIfAborted()
    if (failure) throw failure
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) result = noSplit
    return bindScopeSources(result, observed)
  } finally {
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    controller.abort()
  }
}
