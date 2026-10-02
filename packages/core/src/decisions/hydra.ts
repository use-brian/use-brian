/**
 * Bounded two-stage decision cascade (historical internal name: Hydra).
 *
 * [COMP:decisions/hydra]
 */

import { nativeDecisionResponse } from './native-provenance.js'
import { randomUUID } from 'node:crypto'
import type {
  DecisionDisposition,
  DecisionFailureKind,
  DecisionFollowUpReason,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  DecisionUsage,
  JsonValue,
} from './types.js'
import { DecisionProviderError } from './types.js'
import type { LLMProvider } from '../providers/types.js'
import { isJsonValue } from './validate.js'

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
  evaluationSegment: string
  status: 'evaluation' | 'approved' | 'operator_override'
  evidence: 'recorded' | 'synthetic' | 'operator_override'
  totalTimeoutMs: number
  primaryTimeoutMs: number
  maxAttempts: 2
  /** Versioned operation/model-specific thresholds; never inherited implicitly. */
  policy?: JsonValue
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
  /** Explicit deployment-owner authority; requires matching operator_override profile metadata. */
  operatorOverride?: boolean
}

export type DecisionAttemptStage =
  | 'primary_decision'
  | 'generation'
  | 'uncertainty_review'
  | 'operational_failover'
  | 'llm_only'

export type DecisionAttemptRecord = {
  nativeMetadata?: DecisionResponse['nativeMetadata']
  /** Native invocation reconciliation; pending events never carry billable usage.
   * Logical timeout does not mean the underlying provider promise has drained. */
  invocationId?: string
  invocationState?: 'pending' | 'settled'
  interrupted?: boolean
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
  decide(
    response: DecisionResponse,
    context: { profile?: DecisionEvaluationProfile },
  ): DecisionDisposition<T>
  validateResult(result: T): T
  safeFailure(reason: DecisionFailureKind): T
  completeWithLlm(context: DecisionCompletionContext): Promise<DecisionCompletion<T>>
}

/** LLM lane selected by the API composition for a decision follow-up. */
export type DecisionCompletionRoute = {
  provider: LLMProvider
  modelId: string
}

/** Operation contract accepted by the workspace-aware decision runtime. */
export type DecisionExecutionOperation<T> = Omit<
  DecisionCascadeOperation<T>,
  'completeWithLlm'
> & {
  completeWithLlm(
    context: DecisionCompletionContext & { llm: DecisionCompletionRoute },
  ): Promise<DecisionCompletion<T>>
}

export type DecisionExecutionRunOptions<T> = {
  workspaceId?: string
  /** Caller-resolved allowed LLM lane (for BYO/custom-provider parity). */
  llm?: DecisionCompletionRoute
  request: Omit<DecisionRequest, 'model'>
  operation: DecisionExecutionOperation<T>
}

export type DecisionObservationOperation<T> = Pick<
  DecisionCascadeOperation<T>,
  'decide' | 'validateResult'
>

export type DecisionObservationRunOptions<T> = {
  workspaceId?: string
  request: Omit<DecisionRequest, 'model'>
  operation: DecisionObservationOperation<T>
}

export type DecisionObservationResult<T> = {
  runId: string
  path: 'skipped' | 'observed_complete' | 'observed_follow_up' | 'observed_unavailable' | 'observed_error'
  attempts: 0 | 1
  disposition?: DecisionDisposition<T>
  primaryResponse?: DecisionResponse
  failureKind?: DecisionFailureKind
}

/** Core-facing structural port; implemented by the API composition runtime. */
export interface DecisionExecutionPort {
  run<T>(options: DecisionExecutionRunOptions<T>): Promise<DecisionCascadeResult<T>>
  /**
   * Run only the configured decision-provider stage. The result is evidence,
   * never caller authority; `llm_only` and unsampled shadow routes do no work.
   */
  observe<T>(options: DecisionObservationRunOptions<T>): Promise<DecisionObservationResult<T>>
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

export type ExecuteDecisionObservationOptions<T> = {
  request: DecisionRequest
  operation: DecisionObservationOperation<T>
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
  if (profile.evaluationSegment !== (request.evaluationSegment ?? 'global')) {
    configError('evaluation profile does not match the request evidence segment')
  }
  if (
    !Number.isFinite(profile.totalTimeoutMs) || profile.totalTimeoutMs <= 0 ||
    !Number.isFinite(profile.primaryTimeoutMs) || profile.primaryTimeoutMs <= 0 ||
    profile.primaryTimeoutMs >= profile.totalTimeoutMs
  ) configError('evaluation profile requires positive primary < total timeouts')
  if (profile.maxAttempts !== 2) configError('v1 decision profiles require maxAttempts=2')
  if (profile.policy !== undefined && !isJsonValue(profile.policy)) {
    configError('evaluation profile policy must be JSON-compatible')
  }
  if (route.mode === 'shadow') {
    if (
      profile.shadowSampleRate === undefined ||
      !Number.isFinite(profile.shadowSampleRate) ||
      profile.shadowSampleRate <= 0 || profile.shadowSampleRate > 1
    ) configError('shadow profile requires 0 < shadowSampleRate <= 1')
  }
  if (route.mode === 'hybrid') {
    if (route.operatorOverride === true) {
      if (profile.status !== 'operator_override' || profile.evidence !== 'operator_override') {
        configError('operator override route requires matching override profile metadata')
      }
    } else {
      if (profile.status !== 'approved') {
        configError('hybrid route requires an approved evaluation profile')
      }
      if (profile.evidence !== 'recorded' && route.allowSyntheticProfile !== true) {
        configError('hybrid production route requires recorded evaluation evidence')
      }
    }
  } else if (route.operatorOverride === true) {
    configError('operator override authority is valid only for hybrid routes')
  }
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
  // Keep unrelated decision accounting unchanged. Native LLM completions own
  // their stream lifecycle at the adapter; only primary provider promises need
  // reconciliation here. The central API recorder still bills primary usage.
  const invocationId = ['computer.next-action', 'computer.verify-progress'].includes(request.operation.id) ? randomUUID() : undefined
  const primaryDurationStart = invocationId ? performance.now() : primaryStartedAt
  const primaryDuration = () => invocationId
    ? Math.max(0, Math.round(performance.now() - primaryDurationStart))
    : Math.max(0, now() - primaryStartedAt)
  let providerPromise: Promise<DecisionResponse> | undefined
  let providerSettled = false
  let providerResult: DecisionResponse | undefined
  const primaryBase = { runId: request.runId, operationId: request.operation.id, attempt: primaryAttempt,
    stage: 'primary_decision' as const, providerId: route.primary!.id,
    modelCatalogId: request.model.catalogId, modelWireId: request.model.wireId }
  let usageEmitted = false
  const emitPrimary = (record: DecisionAttemptRecord) => {
    // A downstream audit failure must never re-bill a successful provider when
    // it is caught by the logical cascade. Non-native tracing stays unchanged.
    if (invocationId) {
      const response = providerResult
      record = { ...record, nativeMetadata: response?.nativeMetadata ?? { actualModel: null, usage: null },
        ...(response ? { modelCatalogId: response.model.catalogId, modelWireId: response.model.wireId, usage: response.usage } : { usage: undefined }) }
    }
    if (invocationId && record.usage) {
      if (usageEmitted) return emit({ ...record, usage: undefined })
      usageEmitted = true
    }
    return emit(record)
  }
  const admitted = invocationId ? emitPrimary({ ...primaryBase, invocationId, invocationState: 'pending', interrupted: false,
    outcome: 'error', latencyMs: 0 }) : Promise.resolve()
  // Pre-aborted requests may never enter dispatch; still observe ledger errors.
  void admitted.catch(() => {})
  try {
    primaryResponse = await withDeadline({
      parent: request.signal,
      deadlineAt: primaryDeadline,
      now,
      call: (signal) => {
        const dispatch = () => {
          if (invocationId && route.primary!.supportsNativeStrict !== true) {
            throw new DecisionProviderError('policy_denied', 'Native provenance unsupported')
          }
          if (signal.aborted) throw new DecisionProviderError('cancelled', 'decision call cancelled')
          return route.primary!.evaluate({ ...request, ...(invocationId ? { nativeStrict: true as const } : {}), signal, deadlineAt: primaryDeadline })
        }
        providerPromise = (invocationId ? admitted.then(dispatch) : dispatch())
          .then(response => { providerSettled = true; providerResult = invocationId ? nativeDecisionResponse(response) : response; return providerResult }, error => { providerSettled = true; throw error })
        return providerPromise
      },
    })
    if (invocationId && (!primaryResponse.nativeMetadata?.actualModel || !primaryResponse.nativeMetadata.usage || primaryResponse.nativeMetadata.actualModel !== request.model.wireId)) {
      throw new DecisionProviderError('policy_denied', 'Native provider provenance unavailable', { dispatched: true })
    }
    disposition = operation.decide(primaryResponse, { profile })
    await emitPrimary({
      ...(invocationId ? { invocationId, invocationState: 'settled' as const, interrupted: false } : {}),
      runId: request.runId,
      operationId: request.operation.id,
      attempt: primaryAttempt,
      stage: 'primary_decision',
      providerId: primaryResponse.providerId,
      modelCatalogId: primaryResponse.model.catalogId,
      modelWireId: primaryResponse.model.wireId,
      latencyMs: primaryDuration(),
      outcome: 'success',
      disposition: disposition.kind,
      ...(disposition.kind === 'follow_up' ? { followUpReason: disposition.reason } : {}),
      ...(primaryResponse.usage ? { usage: primaryResponse.usage } : {}),
    })
  } catch (error) {
    primaryFailure = normalizeDecisionFailure(error)
    const pending = !!providerPromise && !providerSettled
    const pendingReport = emitPrimary({
      ...(invocationId ? { invocationId, invocationState: pending ? 'pending' as const : 'settled' as const,
        interrupted: primaryFailure.kind === 'timeout' || primaryFailure.kind === 'cancelled',
        ...(!pending && providerResult?.usage ? { usage: providerResult.usage } : {}) } : {}),
      runId: request.runId,
      operationId: request.operation.id,
      attempt: primaryAttempt,
      stage: 'primary_decision',
      providerId: route.primary!.id,
      modelCatalogId: request.model.catalogId,
      modelWireId: request.model.wireId,
      latencyMs: primaryDuration(),
      outcome: 'error',
      failureKind: primaryFailure.kind,
    })
    if (invocationId && pending) {
      // Attach once even if settlement raced the pending audit write. Never call
      // decide(), validateResult(), or resume the cascade with this late value.
      void pendingReport.catch(() => {}).then(() => providerPromise!.then(response => emitPrimary({ ...primaryBase, invocationId,
        invocationState: 'settled', interrupted: true, latencyMs: primaryDuration(),
        providerId: response.providerId, modelCatalogId: response.model.catalogId, modelWireId: response.model.wireId,
        outcome: 'success', ...(response.usage ? { usage: response.usage } : {}) }),
      () => emitPrimary({ ...primaryBase, invocationId, invocationState: 'settled', interrupted: true,
        latencyMs: primaryDuration(), outcome: 'error' })))
        .catch(() => { /* Durable pending audit remains unresolved; never retry a charge blindly. */ })
    }
    if (invocationId && (primaryFailure.kind === 'timeout' || primaryFailure.kind === 'cancelled')) {
      void pendingReport.catch(() => {})
    } else await pendingReport
  }

  if (request.signal?.aborted || primaryFailure?.kind === 'cancelled') {
    throw new DecisionProviderError('cancelled', 'decision call cancelled')
  }

  if (invocationId && primaryFailure) return safe(primaryFailure.kind)

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

/**
 * Execute a non-authoritative decision-provider observation.
 *
 * This deliberately has no LLM completion lane. Domain callers continue their
 * mandatory legacy work regardless of the returned disposition.
 */
export async function executeDecisionObservation<T>(
  options: ExecuteDecisionObservationOptions<T>,
): Promise<DecisionObservationResult<T>> {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const { request, operation, route } = options
  validateDecisionRoute(request, route)
  if (route.mode === 'llm_only') {
    return { runId: request.runId, path: 'skipped', attempts: 0 }
  }

  const profile = route.profile!
  if (route.mode === 'shadow' && random() >= profile.shadowSampleRate!) {
    return { runId: request.runId, path: 'skipped', attempts: 0 }
  }

  const startedAt = now()
  const totalDeadline = earlierDeadline(request, profile.totalTimeoutMs, startedAt)
  const primaryDeadline = Math.min(totalDeadline, startedAt + profile.primaryTimeoutMs)
  try {
    const response = await withDeadline({
      parent: request.signal,
      deadlineAt: primaryDeadline,
      now,
      call: (signal) => route.primary!.evaluate({ ...request, signal, deadlineAt: primaryDeadline }),
    })
    let disposition = operation.decide(response, { profile })
    if (disposition.kind === 'complete') {
      disposition = { kind: 'complete', result: operation.validateResult(disposition.result) }
    }
    await options.onAttempt?.({
      runId: request.runId,
      operationId: request.operation.id,
      attempt: 1,
      stage: 'primary_decision',
      providerId: response.providerId,
      modelCatalogId: response.model.catalogId,
      modelWireId: response.model.wireId,
      latencyMs: Math.max(0, now() - startedAt),
      outcome: 'success',
      disposition: disposition.kind,
      ...(disposition.kind === 'follow_up' ? { followUpReason: disposition.reason } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
    })
    const path = disposition.kind === 'complete'
      ? 'observed_complete'
      : disposition.kind === 'follow_up'
        ? 'observed_follow_up'
        : 'observed_unavailable'
    return { runId: request.runId, path, attempts: 1, disposition, primaryResponse: response }
  } catch (error) {
    const failure = normalizeDecisionFailure(error)
    await options.onAttempt?.({
      runId: request.runId,
      operationId: request.operation.id,
      attempt: 1,
      stage: 'primary_decision',
      providerId: route.primary!.id,
      modelCatalogId: request.model.catalogId,
      modelWireId: request.model.wireId,
      latencyMs: Math.max(0, now() - startedAt),
      outcome: 'error',
      failureKind: failure.kind,
    })
    if (failure.kind === 'cancelled') throw failure
    return {
      runId: request.runId,
      path: 'observed_error',
      attempts: 1,
      failureKind: failure.kind,
    }
  }
}
