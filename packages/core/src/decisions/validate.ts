/** Runtime validation for Brian-owned decision requests and responses. */

import type {
  DecisionAnswer,
  DecisionCapabilities,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
  JsonValue,
  UncertaintyEvidence,
} from './types.js'
import { DecisionProviderError } from './types.js'

const DISTRIBUTION_EPSILON = 0.01

function invalid(message: string): never {
  throw new DecisionProviderError('invalid_response', message)
}

function invalidRequest(message: string): never {
  throw new DecisionProviderError('invalid_request', message)
}

export function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) invalidRequest(`${field} must not be empty`)
}

function validateQuestion(question: DecisionQuestion): void {
  requireNonEmpty(question.id, 'question.id')
  requireNonEmpty(question.prompt, `question '${question.id}' prompt`)

  if (question.kind === 'choice') {
    if (question.options.length < 2) invalidRequest(`choice '${question.id}' needs at least two options`)
    const values = new Set<string>()
    for (const option of question.options) {
      requireNonEmpty(option.value, `choice '${question.id}' option`)
      if (values.has(option.value)) invalidRequest(`choice '${question.id}' has duplicate option '${option.value}'`)
      values.add(option.value)
    }
    return
  }

  if (question.kind === 'score') {
    if (question.rubric.length < 2) invalidRequest(`score '${question.id}' needs at least two rubric levels`)
    for (const [index, level] of question.rubric.entries()) {
      if (level.value !== index) {
        invalidRequest(`score '${question.id}' rubric values must be consecutive zero-based indexes`)
      }
      requireNonEmpty(level.description, `score '${question.id}' rubric description`)
    }
  }
}

export function validateDecisionRequest(request: DecisionRequest): DecisionRequest {
  requireNonEmpty(request.runId, 'runId')
  requireNonEmpty(request.operation.id, 'operation.id')
  requireNonEmpty(request.operation.version, 'operation.version')
  requireNonEmpty(request.operation.stateVersion, 'operation.stateVersion')
  requireNonEmpty(request.operation.questionVersion, 'operation.questionVersion')
  requireNonEmpty(request.model.catalogId, 'model.catalogId')
  requireNonEmpty(request.model.wireId, 'model.wireId')
  if (!isJsonValue(request.state)) invalidRequest('state must be finite, acyclic JSON data')
  if (request.questions.length === 0) invalidRequest('at least one question is required')
  if (request.deadlineAt !== undefined && !Number.isFinite(request.deadlineAt)) {
    invalidRequest('deadlineAt must be finite')
  }
  const ids = new Set<string>()
  for (const question of request.questions) {
    validateQuestion(question)
    if (ids.has(question.id)) invalidRequest(`duplicate question id '${question.id}'`)
    ids.add(question.id)
  }
  return request
}

/** Conservative token estimate used only for pre-dispatch capability admission. */
export function estimateDecisionInputTokens(request: DecisionRequest): number {
  return Math.ceil(JSON.stringify({ state: request.state, questions: request.questions }).length / 4)
}

export function assertDecisionCapabilities(
  request: DecisionRequest,
  capabilities: DecisionCapabilities,
): void {
  validateDecisionRequest(request)
  if (!capabilities.batch && request.questions.length > 1) {
    throw new DecisionProviderError('unsupported_capability', 'provider does not support batched questions')
  }
  if (request.questions.length > capabilities.maxQuestions) {
    throw new DecisionProviderError('unsupported_capability', 'question count exceeds provider capability')
  }
  if (estimateDecisionInputTokens(request) > capabilities.maxInputTokens) {
    throw new DecisionProviderError('unsupported_capability', 'decision input exceeds provider token capability')
  }
  for (const question of request.questions) {
    if (!capabilities.primitives.includes(question.kind)) {
      throw new DecisionProviderError('unsupported_capability', `provider does not support ${question.kind}`)
    }
    if (question.kind === 'choice' && question.options.length > capabilities.maxOptions) {
      throw new DecisionProviderError('unsupported_capability', `choice '${question.id}' exceeds option capability`)
    }
    if (question.kind === 'score' && question.rubric.length > capabilities.maxRubricLevels) {
      throw new DecisionProviderError('unsupported_capability', `score '${question.id}' exceeds rubric capability`)
    }
  }
}

function validateProbability(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) invalid(`${field} must be between 0 and 1`)
}

function validateEvidence(
  evidence: UncertaintyEvidence,
  expectedKeys?: readonly string[],
): void {
  if (evidence.confidence !== undefined) validateProbability(evidence.confidence, 'confidence')
  const probabilities = evidence.probabilities
  if (!probabilities) return
  if (evidence.source !== 'native_distribution') {
    invalid('only native_distribution evidence may carry probabilities')
  }
  const actualKeys = Object.keys(probabilities).sort()
  if (expectedKeys) {
    const expected = [...expectedKeys].sort()
    if (actualKeys.length !== expected.length || actualKeys.some((key, i) => key !== expected[i])) {
      invalid('probability distribution keys do not cover the declared domain')
    }
  }
  let sum = 0
  for (const [key, probability] of Object.entries(probabilities)) {
    validateProbability(probability, `probability '${key}'`)
    sum += probability
  }
  if (Math.abs(sum - 1) > DISTRIBUTION_EPSILON) invalid('probability distribution must sum to 1')
}

function validateAnswer(question: DecisionQuestion, answer: DecisionAnswer): void {
  if (answer.questionId !== question.id) invalid(`answer id '${answer.questionId}' does not match '${question.id}'`)
  if (answer.kind !== question.kind) invalid(`answer '${question.id}' has the wrong primitive kind`)

  if (question.kind === 'choice' && answer.kind === 'choice') {
    const values = question.options.map((option) => option.value)
    if (!values.includes(answer.value)) invalid(`choice '${question.id}' selected an unknown option`)
    if (answer.evidence.source === 'native_distribution' && !answer.evidence.probabilities) {
      invalid(`choice '${question.id}' native distribution is missing`)
    }
    validateEvidence(answer.evidence, answer.evidence.probabilities ? values : undefined)
    return
  }

  if (question.kind === 'boolean' && answer.kind === 'boolean') {
    if (answer.pTrue !== undefined) validateProbability(answer.pTrue, `boolean '${question.id}' pTrue`)
    if (answer.evidence.source === 'native_distribution' && answer.pTrue === undefined) {
      invalid(`boolean '${question.id}' native probability is missing`)
    }
    validateEvidence(answer.evidence, answer.evidence.probabilities ? ['false', 'true'] : undefined)
    return
  }

  if (question.kind === 'score' && answer.kind === 'score') {
    const min = question.rubric[0]!.value
    const max = question.rubric[question.rubric.length - 1]!.value
    if (!Number.isFinite(answer.value) || answer.value < min || answer.value > max) {
      invalid(`score '${question.id}' falls outside its rubric`)
    }
    if (answer.evidence.source === 'native_distribution' && !answer.evidence.probabilities) {
      invalid(`score '${question.id}' native distribution is missing`)
    }
    const keys = question.rubric.map((level) => String(level.value))
    validateEvidence(answer.evidence, answer.evidence.probabilities ? keys : undefined)
  }
}

export function validateDecisionResponse(
  request: DecisionRequest,
  response: DecisionResponse,
): DecisionResponse {
  validateDecisionRequest(request)
  requireNonEmpty(response.providerId, 'response.providerId')
  requireNonEmpty(response.model.catalogId, 'response.model.catalogId')
  requireNonEmpty(response.model.wireId, 'response.model.wireId')
  if (response.answers.length !== request.questions.length) invalid('response must contain one answer per question')
  const byId = new Map<string, DecisionAnswer>()
  for (const answer of response.answers) {
    if (byId.has(answer.questionId)) invalid(`duplicate answer id '${answer.questionId}'`)
    byId.set(answer.questionId, answer)
  }
  for (const question of request.questions) {
    const answer = byId.get(question.id)
    if (!answer) invalid(`missing answer for '${question.id}'`)
    validateAnswer(question, answer)
  }
  if (response.usage) {
    for (const [field, value] of Object.entries(response.usage)) {
      if (!Number.isFinite(value) || value < 0) invalid(`usage.${field} must be finite and non-negative`)
    }
  }
  return response
}
