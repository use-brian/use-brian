/** Native text-only OpenAI Decisions adapter. [COMP:decisions/openai] */
import { decisionTransportBudget, registerDecisionTransportOwner } from '../transport-budget.js'
import { assertDecisionResponseAuthority } from '../authority-ownership.js'
import { assertInputAuthority, isInputAuthorityError } from '../../providers/input-authority.js'
import type { DecisionAnswer, DecisionCapabilities, DecisionProvider, DecisionRequest, DecisionResponse, JsonValue } from '../types.js'
import { DecisionProviderError } from '../types.js'
import { assertDecisionCapabilities, validateDecisionResponse } from '../validate.js'

const ENDPOINT = 'https://api.openai.com/v1/decisions'
const MODEL = 'gpt-6-luna'
const PROVIDER_ID = 'openai-decisions'

/** Token bounds are conservative HOST admission policy, not vendor context claims. */
export const OPENAI_DECISION_CAPABILITIES: DecisionCapabilities = Object.freeze({
  primitives: Object.freeze(['choice', 'boolean', 'score'] as const),
  batch: true,
  maxOptions: 255,
  maxQuestions: 400,
  maxRubricLevels: 10,
  maxInputTokens: 64_000,
  maxQuestionInputTokens: 32_000,
  uncertainty: Object.freeze(['native_distribution'] as const),
})

export type OpenAiDecisionTransportRequest = {
  url: string
  headers: Record<string, string>
  body: JsonValue
  signal?: AbortSignal
}
export type OpenAiDecisionTransportResponse = {
  status: number
  body: unknown
  headers?: Record<string, string | undefined>
}
export type OpenAiDecisionTransport = (request: OpenAiDecisionTransportRequest) => Promise<OpenAiDecisionTransportResponse>

export function createFetchOpenAiDecisionTransport(fetchFn: typeof fetch = fetch): OpenAiDecisionTransport {
  return async request => {
    const response = await fetchFn(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: request.signal,
      // Neither credentials nor admitted evidence may follow an upstream redirect.
      redirect: 'error',
    })
    let body: unknown
    try { body = await response.json() } catch (error) {
      if (isInputAuthorityError(error)) throw error
      body = null
    }
    return { status: response.status, body, headers: { 'retry-after': response.headers.get('retry-after') ?? undefined } }
  }
}

function invalid(): never {
  throw new DecisionProviderError('invalid_response', 'OpenAI decision response is invalid', { dispatched: true })
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid()
  return value
}
function tokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid()
  return value
}
function retryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = seconds * 1000
    return Number.isFinite(milliseconds) ? milliseconds : undefined
  }
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}
function statusFailure(wire: OpenAiDecisionTransportResponse): DecisionProviderError {
  const common = { status: wire.status, retryAfterMs: retryAfterMs(wire.headers?.['retry-after']), dispatched: true }
  const kind = wire.status === 401 || wire.status === 403 ? 'authentication'
    : wire.status === 400 || wire.status === 422 ? 'invalid_request'
    : wire.status === 429 ? 'rate_limit'
    : wire.status === 529 || wire.status === 503 ? 'overloaded'
    : wire.status === 408 || wire.status === 504 ? 'timeout' : 'transport'
  return new DecisionProviderError(kind, `OpenAI decision request failed: ${kind}`, common)
}
function wireQuestions(request: DecisionRequest): JsonValue[] {
  return request.questions.map(question => {
    const base = { name: question.id, instructions: question.prompt }
    if (question.kind === 'choice') return {
      ...base, type: 'choice', choices: question.options.map(option => ({
        value: option.value, ...(option.description !== undefined ? { description: option.description } : {}),
      })),
    }
    if (question.kind === 'boolean') return {
      ...base, type: 'predicate',
      // A fixed label and JSON preserve both criteria verbatim, including empty strings.
      instructions: question.criteria === undefined ? question.prompt
        : `${question.prompt}\n\nBoolean criteria (JSON; keys true and false identify the outcome):\n${JSON.stringify(question.criteria)}`,
    }
    return { ...base, type: 'score', levels: question.rubric.map(level => ({ label: String(level.value), description: level.description })) }
  })
}
function distribution(value: unknown, domain: string[], score: boolean): Record<string, number> {
  if (!Array.isArray(value) || value.length !== domain.length) invalid()
  const entries: [string, number][] = []
  const seen = new Set<string>()
  for (const item of value) {
    const entry = record(item)
    const key = score ? entry.label : entry.value
    if (typeof key !== 'string' || !domain.includes(key) || seen.has(key)) invalid()
    if (score && (typeof entry.value !== 'number' || !Number.isInteger(entry.value) || domain[entry.value] !== key)) invalid()
    seen.add(key)
    entries.push([key, probability(entry.probability)])
  }
  return Object.fromEntries(entries)
}
function parseResponse(request: DecisionRequest, value: unknown): DecisionResponse {
  const body = record(value)
  // A refusal is whole-call policy denial, never a partial verdict or provider text.
  if (Array.isArray(body.answers) && body.answers.some(answer =>
    typeof answer === 'object' && answer !== null && (answer as Record<string, unknown>).type === 'refusal')) {
    throw new DecisionProviderError('policy_denied', 'OpenAI decision request denied by policy', { dispatched: true })
  }
  if (body.model !== MODEL || !Array.isArray(body.answers) || body.answers.length !== request.questions.length) invalid()
  const wireAnswers = body.answers
  const answers = request.questions.map((question, index): DecisionAnswer => {
    const answer = record(wireAnswers[index])
    if (answer.name !== question.id) invalid()
    if (question.kind === 'boolean') {
      if (answer.type !== 'predicate') invalid()
      const pTrue = probability(answer.probability)
      return { kind: 'boolean', questionId: question.id, value: pTrue >= 0.5, pTrue,
        evidence: { source: 'native_distribution' } }
    }
    if (answer.type !== question.kind) invalid()
    const confidence = probability(answer.confidence)
    if (question.kind === 'choice') {
      if (typeof answer.choice !== 'string') invalid()
      return { kind: 'choice', questionId: question.id, value: answer.choice,
        evidence: { source: 'native_distribution', confidence,
          probabilities: distribution(answer.probabilities, question.options.map(option => option.value), false) } }
    }
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)) invalid()
    return { kind: 'score', questionId: question.id, value: answer.score,
      evidence: { source: 'native_distribution', confidence,
        probabilities: distribution(answer.probabilities, question.rubric.map(level => String(level.value)), true) } }
  })
  const usage = record(body.usage)
  const reportedInputTokens = tokens(usage.input_tokens)
  const outputTokens = tokens(usage.output_tokens)
  const totalTokens = reportedInputTokens + outputTokens
  if (!Number.isSafeInteger(totalTokens)) invalid()
  if (usage.total_tokens !== undefined && tokens(usage.total_tokens) !== totalTokens) invalid()
  for (const field of ['input_tokens_details', 'output_tokens_details']) {
    if (usage[field] !== undefined) {
      for (const count of Object.values(record(usage[field]))) tokens(count)
    }
  }
  const inputDetails = usage.input_tokens_details === undefined ? undefined : record(usage.input_tokens_details)
  const cacheReadTokens = inputDetails?.cached_tokens === undefined ? undefined : tokens(inputDetails.cached_tokens)
  const cacheWriteTokens = inputDetails?.cache_write_tokens === undefined ? undefined : tokens(inputDetails.cache_write_tokens)
  const cachedTokens = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  if (!Number.isSafeInteger(cachedTokens) || cachedTokens > reportedInputTokens) invalid()
  // OpenAI's input total includes reads and writes. Each token is billed once;
  // core inputTokens is fresh-only, and cache-write pricing is not additive.
  const inputTokens = reportedInputTokens - cachedTokens
  return validateDecisionResponse(request, { providerId: PROVIDER_ID, model: { ...request.model }, answers,
    usage: { inputTokens, outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    } })
}

export function createOpenAiDecisionProvider(options: {
  apiKey: string
  transport?: OpenAiDecisionTransport
  capabilities?: DecisionCapabilities
}): DecisionProvider {
  if (!options.apiKey.trim()) throw new Error('OpenAI API key must not be empty')
  const apiKey = options.apiKey
  const transport = options.transport ?? createFetchOpenAiDecisionTransport()
  const capabilities = options.capabilities ?? OPENAI_DECISION_CAPABILITIES
  const provider: DecisionProvider = {
    id: PROVIDER_ID, capabilities,
    async evaluate(request): Promise<DecisionResponse> {
      await assertInputAuthority(request.assertInputAuthority)
      try {
        if (request.model.wireId !== MODEL) throw new DecisionProviderError('unsupported_capability', 'OpenAI decision model is unsupported')
        // Overrides may narrow policy, but cannot enlarge documented wire/host limits.
        assertDecisionCapabilities(request, OPENAI_DECISION_CAPABILITIES)
        if (capabilities !== OPENAI_DECISION_CAPABILITIES) assertDecisionCapabilities(request, capabilities)
      } catch (error) {
        if (isInputAuthorityError(error)) throw error
        const kind = error instanceof DecisionProviderError ? error.kind : 'invalid_request'
        throw new DecisionProviderError(kind, 'OpenAI decision request is not supported')
      }
      if (request.signal?.aborted) throw new DecisionProviderError('cancelled', 'decision call cancelled')
      if (request.deadlineAt !== undefined && request.deadlineAt <= Date.now()) throw new DecisionProviderError('timeout', 'decision deadline exhausted')
      const controller = new AbortController()
      const onAbort = () => controller.abort(request.signal?.reason)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      const timeout = request.deadlineAt === undefined ? undefined
        : setTimeout(() => controller.abort(), Math.max(0, request.deadlineAt - Date.now()))
      const transportBudget = decisionTransportBudget(request)
      let transportTimer: ReturnType<typeof setTimeout> | undefined
      try {
        let wire: OpenAiDecisionTransportResponse
        try {
          if (transportBudget !== undefined) transportTimer = setTimeout(() => controller.abort(), transportBudget)
          wire = await transport({ url: ENDPOINT,
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: { model: request.model.wireId, input: JSON.stringify(request.state), questions: wireQuestions(request) },
            signal: controller.signal,
          })
        } catch (error) {
          if (isInputAuthorityError(error)) throw error
          if (controller.signal.aborted) throw new DecisionProviderError(request.signal?.aborted ? 'cancelled' : 'timeout', 'decision call interrupted', { dispatched: true })
          // Do not retain arbitrary transport errors (even as cause): they can contain secrets.
          throw new DecisionProviderError('transport', 'OpenAI decision transport failed', { dispatched: true })
        } finally {
          if (transportTimer !== undefined) clearTimeout(transportTimer)
        }
        // Primary transport budget ends at acquisition; total deadline and authority remain live.
        if (controller.signal.aborted) throw new DecisionProviderError(request.signal?.aborted ? 'cancelled' : 'timeout', 'decision call interrupted', { dispatched: true })
        await assertDecisionResponseAuthority(request)
        if (controller.signal.aborted || request.deadlineAt !== undefined && request.deadlineAt <= Date.now()) {
          throw new DecisionProviderError(request.signal?.aborted ? 'cancelled' : 'timeout', 'decision call interrupted', { dispatched: true })
        }
        record(wire)
        if (!Number.isInteger(wire.status) || wire.status < 100 || wire.status > 599) invalid()
        if (wire.status < 200 || wire.status >= 300) throw statusFailure(wire)
        try { return parseResponse(request, wire.body) } catch (error) {
          if (isInputAuthorityError(error)) throw error
          if (error instanceof DecisionProviderError && error.kind === 'policy_denied') throw error
          invalid()
        }
      } finally {
        if (transportTimer !== undefined) clearTimeout(transportTimer)
        if (timeout !== undefined) clearTimeout(timeout)
        request.signal?.removeEventListener('abort', onAbort)
      }
    },
  }
  return options.transport ? provider : registerDecisionTransportOwner(provider, options.capabilities === undefined)
}
