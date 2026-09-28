/**
 * Provider-neutral typed decision contract.
 *
 * [COMP:decisions/contract]
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type DecisionPrimitive = 'choice' | 'boolean' | 'score'

export type DecisionOption = {
  value: string
  description?: string
}

export type ScoreRubricLevel = {
  value: number
  description: string
}

type DecisionQuestionBase = {
  id: string
  prompt: string
}

export type ChoiceQuestion = DecisionQuestionBase & {
  kind: 'choice'
  options: DecisionOption[]
}

export type BooleanQuestion = DecisionQuestionBase & {
  kind: 'boolean'
  criteria?: {
    true?: string
    false?: string
  }
}

export type ScoreQuestion = DecisionQuestionBase & {
  kind: 'score'
  rubric: ScoreRubricLevel[]
}

export type DecisionQuestion = ChoiceQuestion | BooleanQuestion | ScoreQuestion

export type UncertaintySource =
  | 'native_distribution'
  | 'self_reported'
  | 'unavailable'

export type UncertaintyEvidence = {
  source: UncertaintySource
  /** Vendor confidence, only when the provider actually returned it. */
  confidence?: number
  /** Human-readable vendor definition of confidence, when known. */
  definition?: string
  /** Native probability distribution. Never synthesized from a label. */
  probabilities?: Record<string, number>
}

type DecisionAnswerBase = {
  questionId: string
  evidence: UncertaintyEvidence
}

export type ChoiceAnswer = DecisionAnswerBase & {
  kind: 'choice'
  value: string
}

export type BooleanAnswer = DecisionAnswerBase & {
  kind: 'boolean'
  value: boolean
  /** Native or self-reported probability of true, when available. */
  pTrue?: number
}

export type ScoreAnswer = DecisionAnswerBase & {
  kind: 'score'
  value: number
  /** Provider legend retained for audit/debugging when supplied. */
  legend?: Record<string, string>
}

export type DecisionAnswer = ChoiceAnswer | BooleanAnswer | ScoreAnswer

export type DecisionOperationRef = {
  id: string
  version: string
  stateVersion: string
  questionVersion: string
}

export type DecisionModelRef = {
  /** Stable shared-catalog identifier. */
  catalogId: string
  /** Pinned identifier sent on the provider wire. */
  wireId: string
}

export type DecisionRequest = {
  runId: string
  operation: DecisionOperationRef
  model: DecisionModelRef
  /** Evidence cohort key, for example `global`, `en`, or a data-domain slug. */
  evaluationSegment?: string
  state: JsonValue
  questions: DecisionQuestion[]
  signal?: AbortSignal
  /** Absolute Unix milliseconds. */
  deadlineAt?: number
}

export type DecisionUsage = {
  inputTokens: number
  outputTokens: number
  /** Absent when the provider did not report or price the call. */
  costUsd?: number
}

export type DecisionResponse = {
  providerId: string
  model: DecisionModelRef
  answers: DecisionAnswer[]
  usage?: DecisionUsage
}

export type DecisionFailureKind =
  | 'rate_limit'
  | 'overloaded'
  | 'transport'
  | 'timeout'
  | 'cancelled'
  | 'authentication'
  | 'invalid_request'
  | 'invalid_response'
  | 'unsupported_capability'
  | 'policy_denied'

export class DecisionProviderError extends Error {
  readonly kind: DecisionFailureKind
  readonly status?: number
  readonly retryAfterMs?: number
  /** True when request bytes may have reached the remote provider. */
  readonly dispatched: boolean

  constructor(
    kind: DecisionFailureKind,
    message: string,
    options: {
      status?: number
      retryAfterMs?: number
      dispatched?: boolean
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DecisionProviderError'
    this.kind = kind
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs
    this.dispatched = options.dispatched ?? false
  }
}

export type DecisionCapabilities = {
  primitives: readonly DecisionPrimitive[]
  batch: boolean
  maxOptions: number
  maxQuestions: number
  maxRubricLevels: number
  maxInputTokens: number
  uncertainty: readonly UncertaintySource[]
}

export interface DecisionProvider {
  readonly id: string
  readonly capabilities: DecisionCapabilities
  evaluate(request: DecisionRequest): Promise<DecisionResponse>
}

export type DecisionFollowUpReason =
  | 'generation_required'
  | 'uncertain'
  | 'inconsistent'

export type DecisionDisposition<T> =
  | { kind: 'complete'; result: T }
  | { kind: 'follow_up'; reason: DecisionFollowUpReason }
  | { kind: 'unavailable'; reason: DecisionFailureKind }
