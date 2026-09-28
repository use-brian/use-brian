/**
 * Bounded two-stage decision cascade (historical internal name: Hydra).
 *
 * [COMP:decisions/hydra]
 */

import type {
  DecisionDisposition,
  DecisionFailureKind,
  DecisionFollowUpReason,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  DecisionUsage,
} from './types.js'
import { DecisionProviderError } from './types.js'

export type DecisionMode = 'llm_only' | 'shadow' | 'hybrid'

export type DecisionEvaluationProfile = {
  id: string
  version: string
  mode: 'shadow' | 'hybrid'
  operationId: string
  operationVersion: string
  stateVersion: string
  questionVersion: string
  modelCatalogId: string
  modelWireId: string
  status: 'evaluation' | 'approved'
  evidence: 'recorded' | 'synthetic'
  totalTimeoutMs: number
  primaryTimeoutMs: number
  maxAttempts: 2
  /** Required in shadow mode; 0 < rate <= 1. */
  shadowSampleRate?: number
}

export type DecisionRoute = {
  mode: DecisionMode
  primary?: DecisionProvider
  profile?: DecisionEvaluationProfile
  allowOperationalFailover?: boolean
  allowInvalidResponseRecovery?: boolean
  /** Test/evaluation harness only. Production activation never sets this. */
  allowSyntheticProfile?: boolean
}

export type DecisionAttemptStage =
  | 'primary_decision'
  | 'generation'
  | 'uncertainty_review'
  | 'operational_failover'
  | 'llm_only'

export type DecisionAttemptRecord = {
  runId: string
  operationId: string
  attempt: number
  stage: DecisionAttemptStage
  providerId: string
  modelCatalogId: string
  modelWireId: string
  latencyMs: number
  outcome: 'success' | 'error'
  disposition?: 'complete' | 'follow_up' | 'unavailable'
  followUpReason?: DecisionFollowUpReason
  failureKind?: DecisionFailureKind
  usage?: DecisionUsage
}

export type DecisionCompletionKind =
  | 'llm_only'
  | 'generation'
  | 'uncertainty_review'
  | 'operational_failover'
  | 'shadow_legacy'

export type DecisionCompletion<T> = {
  result: T
  providerId: string
  model: { catalogId: string; wireId: string }
  usage?: DecisionUsage
}

export type DecisionCompletionContext = {
  kind: DecisionCompletionKind
  runId: string
  request: DecisionRequest
  /** Present for generation; deliberately omitted from independent review. */
  primaryResponse?: DecisionResponse
  followUpReason?: DecisionFollowUpReason
  signal: AbortSignal
  deadlineAt?: number
}

export type DecisionCascadeOperation<T> = {
  decide(response: DecisionResponse): DecisionDisposition<T>
  validateResult(result: T): T
  safeFailure(reason: DecisionFailureKind): T
  completeWithLlm(context: DecisionCompletionContext): Promise<DecisionCompletion<T>>
}

export type DecisionCascadePath =
  | 'llm_only'
  | 'primary_complete'
  | 'generation'
  | 'uncertainty_review'
  | 'operational_failover'
  | 'shadow_legacy'
  | 'safe_default'

export type DecisionCascadeResult<T> = {
  runId: string
  result: T
  path: DecisionCascadePath
  attempts: number
  primaryResponse?: DecisionResponse
  failureKind?: DecisionFailureKind
}

export type ExecuteDecisionCascadeOptions<T> = {
  request: DecisionRequest
  operation: DecisionCascadeOperation<T>
  route: DecisionRoute
  onAttempt?: (record: DecisionAttemptRecord) => void | Promise<void>
  now?: () => number
  random?: () => number
}

const TRANSIENT_FAILURES: ReadonlySet<DecisionFailureKind> = new Set([
  'rate_limit',
  'overloaded',
  'transport',
  'timeout',
])

export function normalizeDecisionFailure(error: unknown): DecisionProviderError {
  if (error instanceof DecisionProviderError) return error
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new DecisionProviderError('cancelled', 'decision call cancelled', { cause: error })
  }
  return new DecisionProviderError('transport', 'decision provider failed', { cause: error })
}

function configError(message: string): never {
  throw new DecisionProviderError('policy_denied', message)
}

export function validateDecisionRoute(
  request: DecisionRequest,
  route: DecisionRoute,
): void {
  if (route.mode === 'llm_only') return
  if (!route.primary) configError(`${route.mode} route requires a primary decision provider`)
  const profile = route.profile
  if (!profile) configError(`${route.mode} route requires an explicit evaluation profile`)
  if (profile.mode !== route.mode) configError('evaluation profile mode does not match route mode')
  if (
    profile.operationId !== request.operation.id ||
    profile.operationVersion !== request.operation.version ||
    profile.stateVersion !== request.operation.stateVersion ||
    profile.questionVersion !== request.operation.questionVersion
  ) configError('evaluation profile does not match operation/question/state versions')
  if (
    profile.modelCatalogId !== request.model.catalogId ||
    profile.modelWireId !== request.model.wireId
  ) configError('evaluation profile does not match the pinned decision model')
  if (
    !Number.isFinite(profile.totalTimeoutMs) || profile.totalTimeoutMs <= 0 ||
    !Number.isFinite(profile.primaryTimeoutMs) || profile.primaryTimeoutMs <= 0 ||
    profile.primaryTimeoutMs >= profile.totalTimeoutMs
  ) configError('evaluation profile requires positive primary < total timeouts')
  if (profile.maxAttempts !== 2) configError('v1 decision profiles require maxAttempts=2')
  if (route.mode === 'shadow') {
    if (
      profile.shadowSampleRate === undefined ||
      !Number.isFinite(profile.shadowSampleRate) ||
      profile.shadowSampleRate <= 0 || profile.shadowSampleRate > 1
    ) configError('shadow profile requires 0 < shadowSampleRate <= 1')
  }
  if (route.mode === 'hybrid' && profile.status !== 'approved') {
    configError('hybrid route requires an approved evaluation profile')
  }
  if (
    route.mode === 'hybrid' &&
    profile.evidence !== 'recorded' &&
    route.allowSyntheticProfile !== true
  ) configError('hybrid production route requires recorded evaluation evidence')
}

function earlierDeadline(request: DecisionRequest, timeoutMs: number, now: number): number {
  const local = now + timeoutMs
  return request.deadlineAt === undefined ? local : Math.min(local, request.deadlineAt)
}

function failureStage(
  reason: DecisionFollowUpReason,
): 'generation' | 'uncertainty_review' {
  return reason === 'generation_required' ? 'generation' : 'uncertainty_review'
}

async function withDeadline<T>(params: {
  parent?: AbortSignal
  deadlineAt?: number
  now: () => number
  call(signal: AbortSignal): Promise<T>
}): Promise<T> {
  if (params.parent?.aborted) throw new DecisionProviderError('cancelled', 'decision call cancelled')
  if (params.deadlineAt !== undefined && params.deadlineAt <= params.now()) {
    throw new DecisionProviderError('timeout', 'decision deadline exhausted')
  }
  const controller = new AbortController()
  let rejectInterrupt: ((reason: DecisionProviderError) => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject
  })
  const onAbort = () => {
    controller.abort(params.parent?.reason)
    rejectInterrupt?.(new DecisionProviderError('cancelled', 'decision call cancelled'))
  }
  params.parent?.addEventListener('abort', onAbort, { once: true })
  let timeout: ReturnType<typeof setTimeout> | undefined
  let deadlineReached = false
  if (params.deadlineAt !== undefined) {
    timeout = setTimeout(() => {
      deadlineReached = true
      controller.abort(new Error('decision deadline exhausted'))
      rejectInterrupt?.(new DecisionProviderError('timeout', 'decision deadline exhausted'))
    }, Math.max(0, params.deadlineAt - params.now()))
  }
  try {
    return await Promise.race([params.call(controller.signal), interrupted])
  } catch (error) {
    if (params.parent?.aborted) {
      throw new DecisionProviderError('cancelled', 'decision call cancelled', { cause: error })
    }
    if (deadlineReached || (params.deadlineAt !== undefined && params.deadlineAt <= params.now())) {
      throw new DecisionProviderError('timeout', 'decision deadline exhausted', { cause: error })
    }
    throw error
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    params.parent?.removeEventListener('abort', onAbort)
  }
}

export async function executeDecisionCascade<T>(
  options: ExecuteDecisionCascadeOptions<T>,
): Promise<DecisionCascadeResult<T>> {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const { request, operation, route } = options
  validateDecisionRoute(request, route)

  let attempts = 0
  const emit = async (record: DecisionAttemptRecord): Promise<void> => {
    await options.onAttempt?.(record)
  }

  const safe = (kind: DecisionFailureKind): DecisionCascadeResult<T> => ({
    runId: request.runId,
    result: operation.validateResult(operation.safeFailure(kind)),
    path: 'safe_default',
    attempts,
    failureKind: kind,
  })

  const runCompletion = async (
    kind: DecisionCompletionKind,
    stage: DecisionAttemptStage,
    deadlineAt?: number,
    primaryResponse?: DecisionResponse,
    followUpReason?: DecisionFollowUpReason,
  ): Promise<DecisionCompletion<T>> => {
    attempts += 1
    const startedAt = now()
    try {
      const completion = await withDeadline({
        parent: request.signal,
        deadlineAt,
        now,
        call: (signal) => operation.completeWithLlm({
          kind,
          runId: request.runId,
          request: { ...request, signal, deadlineAt },
          ...(kind === 'generation' && primaryResponse ? { primaryResponse } : {}),
          ...(followUpReason ? { followUpReason } : {}),
          signal,
          deadlineAt,
        }),
      })
      const validated = { ...completion, result: operation.validateResult(completion.result) }
      await emit({
        runId: request.runId,
        operationId: request.operation.id,
        attempt: attempts,
        stage,
        providerId: completion.providerId,
        modelCatalogId: completion.model.catalogId,
        modelWireId: completion.model.wireId,
        latencyMs: Math.max(0, now() - startedAt),
        outcome: 'success',
        ...(followUpReason ? { followUpReason } : {}),
        ...(completion.usage ? { usage: completion.usage } : {}),
      })
      return validated
    } catch (error) {
      const failure = normalizeDecisionFailure(error)
      await emit({
        runId: request.runId,
        operationId: request.operation.id,
        attempt: attempts,
        stage,
        providerId: 'llm',
        modelCatalogId: 'unknown',
        modelWireId: 'unknown',
        latencyMs: Math.max(0, now() - startedAt),
        outcome: 'error',
        failureKind: failure.kind,
        ...(followUpReason ? { followUpReason } : {}),
      })
      throw failure
    }
  }

  if (route.mode === 'llm_only') {
    try {
      const completion = await runCompletion('llm_only', 'llm_only', request.deadlineAt)
      return { runId: request.runId, result: completion.result, path: 'llm_only', attempts }
    } catch (error) {
      const failure = normalizeDecisionFailure(error)
      if (failure.kind === 'cancelled') throw failure
      return safe(failure.kind)
    }
  }

  const profile = route.profile!
  const totalDeadline = earlierDeadline(request, profile.totalTimeoutMs, now())
  const sampled = route.mode !== 'shadow' || random() < profile.shadowSampleRate!
  if (!sampled) {
    try {
      const completion = await runCompletion('llm_only', 'llm_only', totalDeadline)
      return { runId: request.runId, result: completion.result, path: 'llm_only', attempts }
    } catch (error) {
      const failure = normalizeDecisionFailure(error)
      if (failure.kind === 'cancelled') throw failure
      return safe(failure.kind)
    }
  }

  attempts += 1
  const primaryAttempt = attempts
  const primaryStartedAt = now()
  const primaryDeadline = Math.min(totalDeadline, now() + profile.primaryTimeoutMs)
  let primaryResponse: DecisionResponse | undefined
  let primaryFailure: DecisionProviderError | undefined
  let disposition: DecisionDisposition<T> | undefined
  try {
    primaryResponse = await withDeadline({
      parent: request.signal,
      deadlineAt: primaryDeadline,
      now,
      call: (signal) => route.primary!.evaluate({ ...request, signal, deadlineAt: primaryDeadline }),
    })
    disposition = operation.decide(primaryResponse)
    await emit({
      runId: request.runId,
      operationId: request.operation.id,
      attempt: primaryAttempt,
      stage: 'primary_decision',
      providerId: primaryResponse.providerId,
      modelCatalogId: primaryResponse.model.catalogId,
      modelWireId: primaryResponse.model.wireId,
      latencyMs: Math.max(0, now() - primaryStartedAt),
      outcome: 'success',
      disposition: disposition.kind,
      ...(disposition.kind === 'follow_up' ? { followUpReason: disposition.reason } : {}),
      ...(primaryResponse.usage ? { usage: primaryResponse.usage } : {}),
    })
  } catch (error) {
    primaryFailure = normalizeDecisionFailure(error)
    await emit({
      runId: request.runId,
      operationId: request.operation.id,
      attempt: primaryAttempt,
      stage: 'primary_decision',
      providerId: route.primary!.id,
      modelCatalogId: request.model.catalogId,
      modelWireId: request.model.wireId,
      latencyMs: Math.max(0, now() - primaryStartedAt),
      outcome: 'error',
      failureKind: primaryFailure.kind,
    })
  }

  if (request.signal?.aborted || primaryFailure?.kind === 'cancelled') {
    throw new DecisionProviderError('cancelled', 'decision call cancelled')
  }

  if (route.mode === 'shadow') {
    try {
      const completion = await runCompletion('shadow_legacy', 'llm_only', totalDeadline)
      return {
        runId: request.runId,
        result: completion.result,
        path: 'shadow_legacy',
        attempts,
        ...(primaryResponse ? { primaryResponse } : {}),
      }
    } catch (error) {
      const failure = normalizeDecisionFailure(error)
      if (failure.kind === 'cancelled') throw failure
      return safe(failure.kind)
    }
  }

  if (primaryFailure) {
    const recoverInvalid = primaryFailure.kind === 'invalid_response' && route.allowInvalidResponseRecovery !== false
    const recoverTransient = TRANSIENT_FAILURES.has(primaryFailure.kind) && route.allowOperationalFailover !== false
    if (!recoverInvalid && !recoverTransient) return safe(primaryFailure.kind)
    if (totalDeadline <= now()) return safe('timeout')
    try {
      const completion = await runCompletion(
        'operational_failover',
        'operational_failover',
        totalDeadline,
      )
      return { runId: request.runId, result: completion.result, path: 'operational_failover', attempts }
    } catch (error) {
      const failure = normalizeDecisionFailure(error)
      if (failure.kind === 'cancelled') throw failure
      return safe(failure.kind)
    }
  }

  if (!disposition || !primaryResponse) return safe('invalid_response')
  if (disposition.kind === 'complete') {
    try {
      return {
        runId: request.runId,
        result: operation.validateResult(disposition.result),
        path: 'primary_complete',
        attempts,
        primaryResponse,
      }
    } catch {
      if (route.allowInvalidResponseRecovery === false || totalDeadline <= now()) {
        return safe('invalid_response')
      }
      try {
        const completion = await runCompletion('operational_failover', 'operational_failover', totalDeadline)
        return { runId: request.runId, result: completion.result, path: 'operational_failover', attempts, primaryResponse }
      } catch (error) {
        const failure = normalizeDecisionFailure(error)
        if (failure.kind === 'cancelled') throw failure
        return safe(failure.kind)
      }
    }
  }
  if (disposition.kind === 'unavailable') return safe(disposition.reason)
  if (totalDeadline <= now()) return safe('timeout')
  try {
    const stage = failureStage(disposition.reason)
    const completion = await runCompletion(
      disposition.reason === 'generation_required' ? 'generation' : 'uncertainty_review',
      stage,
      totalDeadline,
      primaryResponse,
      disposition.reason,
    )
    return {
      runId: request.runId,
      result: completion.result,
      path: stage,
      attempts,
      primaryResponse,
    }
  } catch (error) {
    const failure = normalizeDecisionFailure(error)
    if (failure.kind === 'cancelled') throw failure
    return safe(failure.kind)
  }
}
