/** TypeSafe System One / Jev decision adapter. [COMP:decisions/typesafe] */

import { nativeDecisionMetadata, nativeDecisionResponse } from '../native-provenance.js'
import type {
  DecisionAnswer,
  DecisionCapabilities,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  JsonValue,
} from '../types.js'
import { DecisionProviderError } from '../types.js'
import { assertDecisionCapabilities, validateDecisionResponse } from '../validate.js'

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export const TYPESAFE_JEV_CAPABILITIES: DecisionCapabilities = {
  primitives: ['choice', 'boolean', 'score'],
  batch: true,
  maxOptions: 255,
  maxQuestions: 64,
  maxRubricLevels: 10,
  maxInputTokens: 64_000,
  uncertainty: ['native_distribution'],
}

export type TypeSafeTransportRequest = {
  /** Trusted native invocation policy; never populated from response/state. */
  nativeStrict?: true
  url: string
  headers: Record<string, string>
  body: JsonValue
  signal?: AbortSignal
}

export type TypeSafeTransportResponse = {
  status: number
  body: unknown
  headers?: Record<string, string | undefined>
}

export type TypeSafeTransport = (
  request: TypeSafeTransportRequest,
) => Promise<TypeSafeTransportResponse>

export function createFetchTypeSafeTransport(fetchFn: typeof fetch = fetch): TypeSafeTransport {
  return async (request) => {
    const response = await fetchFn(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: request.signal,
      ...(request.nativeStrict ? { redirect: 'error' as const } : {}),
    })
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return {
      status: response.status,
      body,
      headers: { 'retry-after': response.headers.get('retry-after') ?? undefined },
    }
  }
}

function retryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

function statusFailure(response: TypeSafeTransportResponse): DecisionProviderError {
  const common = {
    status: response.status,
    retryAfterMs: retryAfterMs(response.headers?.['retry-after']),
    dispatched: true,
  }
  if (response.status === 401 || response.status === 403) {
    return new DecisionProviderError('authentication', 'TypeSafe authentication failed', common)
  }
  if (response.status === 422 || response.status === 400) {
    return new DecisionProviderError('invalid_request', 'TypeSafe rejected the decision request', common)
  }
  if (response.status === 429) return new DecisionProviderError('rate_limit', 'TypeSafe rate limit exceeded', common)
  if (response.status === 529) return new DecisionProviderError('overloaded', 'TypeSafe is overloaded', common)
  if (response.status >= 500) return new DecisionProviderError('transport', 'TypeSafe server failure', common)
  return new DecisionProviderError('transport', `TypeSafe request failed (${response.status})`, common)
}

function wireQuestions(request: DecisionRequest): Record<string, JsonValue> {
  return Object.fromEntries(request.questions.map((question) => {
    if (question.kind === 'choice') {
      return [question.id, {
        type: 'choice',
        instructions: question.prompt,
        criteria: Object.fromEntries(question.options.map((option) => [
          option.value,
          option.description ?? null,
        ])),
      }]
    }
    if (question.kind === 'boolean') {
      return [question.id, {
        type: 'noul',
        instructions: question.prompt,
        ...(question.criteria ? { criteria: question.criteria } : {}),
      }]
    }
    return [question.id, {
      type: 'score',
      instructions: question.prompt,
      criteria: question.rubric.map((level) => level.description),
    }]
  }))
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DecisionProviderError('invalid_response', `TypeSafe ${field} must be an object`, { dispatched: true })
  }
  return value as Record<string, unknown>
}

function numberMap(value: unknown): Record<string, number> {
  const record = asRecord(value, 'probabilities')
  return Object.fromEntries(Object.entries(record).map(([key, probability]) => {
    if (typeof probability !== 'number') {
      throw new DecisionProviderError('invalid_response', 'TypeSafe probability must be numeric', { dispatched: true })
    }
    return [key, probability]
  }))
}

function parseAnswers(request: DecisionRequest, body: Record<string, unknown>): DecisionAnswer[] {
  const answers = asRecord(body.answers, 'answers')
  return request.questions.map((question): DecisionAnswer => {
    const answer = asRecord(answers[question.id], `answer '${question.id}'`)
    if (question.kind === 'choice') {
      if (answer.type !== 'choice' || typeof answer.choice !== 'string') {
        throw new DecisionProviderError('invalid_response', `TypeSafe choice '${question.id}' is malformed`, { dispatched: true })
      }
      return {
        kind: 'choice',
        questionId: question.id,
        value: answer.choice,
        evidence: {
          source: 'native_distribution',
          probabilities: numberMap(answer.probabilities),
          ...(typeof answer.confidence === 'number' ? {
            confidence: answer.confidence,
            definition: 'TypeSafe distribution-derived confidence',
          } : {}),
        },
      }
    }
    if (question.kind === 'boolean') {
      if (answer.type !== 'noul' || typeof answer.noul !== 'number') {
        throw new DecisionProviderError('invalid_response', `TypeSafe noul '${question.id}' is malformed`, { dispatched: true })
      }
      return {
        kind: 'boolean',
        questionId: question.id,
        value: answer.noul >= 0.5,
        pTrue: answer.noul,
        evidence: {
          source: 'native_distribution',
          definition: 'TypeSafe Noul probability of true; no separate confidence',
        },
      }
    }
    if (answer.type !== 'score' || typeof answer.score !== 'number') {
      throw new DecisionProviderError('invalid_response', `TypeSafe score '${question.id}' is malformed`, { dispatched: true })
    }
    const wireProbabilities = numberMap(answer.probabilities)
    const probabilities = Object.fromEntries(question.rubric.map((level, index) => [
      String(level.value),
      wireProbabilities[String(index)],
    ])) as Record<string, number>
    return {
      kind: 'score',
      questionId: question.id,
      value: answer.score,
      ...(typeof answer.legend === 'object' && answer.legend !== null
        ? { legend: answer.legend as Record<string, string> }
        : {}),
      evidence: {
        source: 'native_distribution',
        probabilities,
        ...(typeof answer.confidence === 'number' ? {
          confidence: answer.confidence,
          definition: 'TypeSafe distribution-derived confidence',
        } : {}),
      },
    }
  })
}

export function createTypeSafeDecisionProvider(options: {
  apiKey: string
  transport?: TypeSafeTransport
  endpoint?: string
  capabilities?: DecisionCapabilities
}): DecisionProvider {
  if (!options.apiKey.trim()) throw new Error('TypeSafe API key must not be empty')
  const transport = options.transport ?? createFetchTypeSafeTransport()
  const capabilities = options.capabilities ?? TYPESAFE_JEV_CAPABILITIES

  return {
    id: 'typesafe',
    supportsNativeStrict: true,
    capabilities,
    async evaluate(request): Promise<DecisionResponse> {
      assertDecisionCapabilities(request, capabilities)
      if (request.signal?.aborted) throw new DecisionProviderError('cancelled', 'decision call cancelled')
      if (request.deadlineAt !== undefined && request.deadlineAt <= Date.now()) {
        throw new DecisionProviderError('timeout', 'decision deadline exhausted')
      }
      const controller = new AbortController()
      const onAbort = () => controller.abort(request.signal?.reason)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      const timeout = request.deadlineAt === undefined
        ? undefined
        : setTimeout(() => controller.abort(new Error('decision deadline exhausted')), Math.max(0, request.deadlineAt - Date.now()))
      try {
        let wire: TypeSafeTransportResponse
        try {
          wire = await transport({
            ...(request.nativeStrict ? { nativeStrict: true as const } : {}),
            url: options.endpoint ?? DEFAULT_ENDPOINT,
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              'content-type': 'application/json',
            },
            body: {
              state: request.state,
              model: request.model.wireId,
              questions: wireQuestions(request),
            },
            signal: controller.signal,
          })
        } catch (error) {
          if (controller.signal.aborted) {
            const kind = request.signal?.aborted ? 'cancelled' : 'timeout'
            throw new DecisionProviderError(kind, kind === 'cancelled' ? 'decision call cancelled' : 'decision deadline exhausted', { dispatched: true, ...(!request.nativeStrict ? { cause: error } : {}) })
          }
          throw new DecisionProviderError('transport', 'TypeSafe transport failed', { dispatched: true, ...(!request.nativeStrict ? { cause: error } : {}) })
        }
        if (wire.status < 200 || wire.status >= 300) throw statusFailure(wire)
        const body = asRecord(wire.body, 'response')
        const model = typeof body.model === 'string' ? body.model : request.model.wireId
        const usage = typeof body.usage === 'object' && body.usage !== null
          ? body.usage as Record<string, unknown>
          : undefined
        const response: DecisionResponse = {
          providerId: 'typesafe',
          ...(request.nativeStrict ? { nativeMetadata: nativeDecisionMetadata({
            actualModel: body.model ?? null,
            usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : null,
          }) } : {}),
          model: { catalogId: request.model.catalogId, wireId: model },
          answers: parseAnswers(request, body),
          ...(usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
            ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
            : {}),
        }
        return validateDecisionResponse(request, request.nativeStrict ? nativeDecisionResponse(response) : response)
      } catch (error) {
        if (!request.nativeStrict) throw error
        // Response validation can interpolate provider-controlled probability
        // keys. Neither those messages nor nested transport causes may escape.
        throw new DecisionProviderError(error instanceof DecisionProviderError ? error.kind : 'invalid_response',
          'TypeSafe native request failed', { dispatched: true,
            ...(error instanceof DecisionProviderError ? { status: error.status, retryAfterMs: error.retryAfterMs } : {}),
          })
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
        request.signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
