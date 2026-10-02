import { NativeAccountingUnavailableError } from './computer-use/accounting.js'
import { nativeAccountingFor, validatedNativeReceipt } from './computer-use/accounting-capability.js'
import type { NativeAccountingCapability, NativeAttemptPreparation, NativeUsageReceipt } from './computer-use/accounting.js'
/**
 * Workspace-aware composition boundary for the decision cascade.
 *
 * Domain operations own questions and result policy. This runtime owns the
 * allowed route, configured adapter, model catalog lookup, and attribution.
 *
 * [COMP:decisions/runtime]
 */

import {
  calculateCost,
  nativeDecisionMetadata,
  NATIVE_NEXT_ACTION, NATIVE_VERIFY_PROGRESS,
  DecisionAdapterRegistry,
  DecisionProviderError,
  assertDecisionCapabilities,
  createTypeSafeDecisionProvider,
  executeDecisionCascade,
  executeDecisionObservation,
  type DecisionAttemptRecord,
  type DecisionCascadeOperation,
  type DecisionCascadeResult,
  type DecisionCompletionRoute,
  type DecisionEvaluationProfile,
  type DecisionExecutionOperation,
  type DecisionExecutionRunOptions,
  type DecisionObservationResult,
  type DecisionObservationRunOptions,
  type DecisionModelRef,
  type DecisionRequest,
  type DecisionProvider,
  type OverheadSource,
  type UsageStore,
} from '@use-brian/core'
import type { LLMProvider } from '@use-brian/core'
import {
  bracketFor,
  isDecisionModelRow,
  modelRates,
  registryRow,
  registryRowForPricing,
} from '@use-brian/shared/model-registry'

export type DecisionLlmRoute = DecisionCompletionRoute

export type DecisionRouteConfig = {
  mode: 'llm_only' | 'shadow' | 'hybrid'
  /** Required for shadow/hybrid. Must resolve to an active decision row. */
  primaryModelId?: string
  /** Undefined uses the boot default. Null explicitly denies an LLM route. */
  llm?: DecisionLlmRoute | null
  profile?: DecisionEvaluationProfile
  allowOperationalFailover?: boolean
  allowInvalidResponseRecovery?: boolean
  /** Offline tests/evaluation only; production resolvers never set this. */
  allowSyntheticProfile?: boolean
  /** Explicit deployment-wide authority; validated against operator_override profile metadata. */
  operatorOverride?: boolean
}

export type DecisionRouteContext = {
  workspaceId?: string
  /** Observation callers can collect evidence but never receive authority. */
  kind: 'execution' | 'observation'
  evaluationSegment: string
  operation: DecisionRequest['operation']
  questionKinds: DecisionRequest['questions'][number]['kind'][]
}

export type DecisionRouteResolver = (
  context: DecisionRouteContext,
) => DecisionRouteConfig | Promise<DecisionRouteConfig>

/** Server-owned attribution only. Never populate from request.state, model
 * output, or relay messages. Native boot captures this from its bound grant. */
export type TrustedDecisionBillingContext = {
  userId: string; actorUserId: string; assistantId: string; sessionId: string
  taskId: string; nativeSessionId: string
}

/** Produced only by the central recorder after a validated capability receipt. It is not
 * a provider response, a trace receipt, or an inference from reported usage. */
export type NativeDecisionBillingAcknowledgement = {
  kind: 'native_primary_billing_recorded'
  invocationId: string
  nativeSessionId: string
  workspaceId: string
  actualCostUsd: number
  /** Required for acceptance; legacy synthetic acknowledgements are ignored. */
  receipt?: NativeUsageReceipt
}
type DecisionAttemptCallback = (attempt: DecisionRuntimeAttempt) =>
  void | NativeDecisionBillingAcknowledgement | Promise<void | NativeDecisionBillingAcknowledgement>

function isNativePrimaryInvocation(attempt: DecisionRuntimeAttempt): boolean {
  return !!attempt.trustedBillingContext && !!attempt.invocationId && attempt.invocationState === 'settled'
    && attempt.stage === 'primary_decision'
    && [NATIVE_NEXT_ACTION.id, NATIVE_VERIFY_PROGRESS.id].some(id => id === attempt.operationId)
}

export type DecisionRuntimeAttempt = DecisionAttemptRecord & {
  /** Produced only by the trusted native per-run preparation seam. */
  nativeBillingPreparation?: NativeAttemptPreparation
  trustedBillingContext?: TrustedDecisionBillingContext
  workspaceId?: string
  configuredMode: DecisionRouteConfig['mode']
  effectiveMode: DecisionRouteConfig['mode']
  operatorOverride: boolean
}

type DecisionUsageTarget = {
  source: OverheadSource
  triggerKey: string
}

const DECISION_USAGE_TARGETS: Readonly<Record<string, DecisionUsageTarget>> = {
  'research.intent': { source: 'overhead:classifier', triggerKey: 'adaptive_research_classifier' },
  'research.split': { source: 'overhead:splitter', triggerKey: 'parallel_split_classifier' },
  'memory.usefulness': { source: 'overhead:nudge', triggerKey: 'memory_nudge' },
  'memory.topic': { source: 'overhead:classifier', triggerKey: 'topic_classifier' },
  'entity.disambiguation': { source: 'overhead:extraction', triggerKey: 'pipeline_b_entity_resolution' },
  'task.assistability': { source: 'overhead:goal-triage', triggerKey: 'goal_triage' },
  'task.readiness': { source: 'overhead:classifier', triggerKey: 'pipeline_b_task_readiness' },
  'memory.reclassification': { source: 'overhead:consolidation', triggerKey: 'memory_reclassification' },
  'entity.alias-clustering': { source: 'overhead:consolidation', triggerKey: 'entity_alias_clustering' },
  'skill.categorization': { source: 'overhead:skill-review', triggerKey: 'skill_categorization' },
  'ingest.extraction-gate': { source: 'overhead:classifier', triggerKey: 'ingest_extraction_gate' },
  'ingest.sensitivity': { source: 'overhead:classifier', triggerKey: 'sensitivity_classifier' },
  'feed.reply-classification': { source: 'overhead:distribution-classifier', triggerKey: 'feed_reply_classification' },
  'feed.draft-safety': { source: 'overhead:distribution-safety', triggerKey: 'feed_draft_safety' },
}

function usageTargetForOperation(operationId: string): DecisionUsageTarget {
  const configured = DECISION_USAGE_TARGETS[operationId]
  if (configured) return configured
  const normalized = operationId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return {
    source: 'overhead:classifier',
    triggerKey: normalized ? `decision_${normalized}` : 'decision_unknown',
  }
}

/**
 * True when the central decision-attempt meter owns this model's spend.
 * Caller-local LLM meters use this guard to avoid recording a successful
 * decision-provider result a second time.
 */
export function isCentrallyMeteredDecisionModel(modelId: string): boolean {
  const row = registryRowForPricing(modelId)
  return Boolean(row && isDecisionModelRow(row))
}

/**
 * Convert every priced primary decision-provider attempt into the same
 * UsageStore ledger used by the existing LLM paths. The workspace fallback
 * resolves the concrete billing user and assistant inside each store.
 * Recording is deliberately best-effort: metering must never change a
 * classifier result or trigger an LLM fallback.
 */
export function createDecisionAttemptUsageRecorder(
  usageStore: UsageStore | undefined,
): (attempt: DecisionRuntimeAttempt) => Promise<void>
export function createDecisionAttemptUsageRecorder(
  usageStore: UsageStore | undefined,
  options: { nativeAcknowledgements: true; nativeAccounting?: NativeAccountingCapability },
): (attempt: DecisionRuntimeAttempt) => Promise<void | NativeDecisionBillingAcknowledgement>
export function createDecisionAttemptUsageRecorder(
  usageStore: UsageStore | undefined,
  options?: { nativeAcknowledgements: true; nativeAccounting?: NativeAccountingCapability },
): (attempt: DecisionRuntimeAttempt) => Promise<void | NativeDecisionBillingAcknowledgement> {
  const capability = options?.nativeAccounting ?? nativeAccountingFor(usageStore)
  return async (attempt) => {
    const nativeScoped = [NATIVE_NEXT_ACTION.id, NATIVE_VERIFY_PROGRESS.id].some(id => id === attempt.operationId)
    if (nativeScoped) {
      // Independently reject synthetic legacy identity at the central owner.
      const evidence = nativeDecisionMetadata(attempt.nativeMetadata)
      const actual = evidence.actualModel ? registryRowForPricing(evidence.actualModel) : undefined
      if (!actual || !evidence.usage || attempt.modelWireId !== evidence.actualModel
        || attempt.modelCatalogId !== actual.alias
        || attempt.usage?.inputTokens !== evidence.usage.inputTokens
        || attempt.usage?.outputTokens !== evidence.usage.outputTokens) return
      // No generic store call, even when unsupported or preparation failed.
      if (!isNativePrimaryInvocation(attempt) || !capability || !attempt.usage || !isCentrallyMeteredDecisionModel(attempt.modelCatalogId)
        || attempt.nativeBillingPreparation?.status !== 'prepared') return
      const key = { nativeSessionId: attempt.trustedBillingContext!.nativeSessionId, invocationId: attempt.invocationId! }
      try {
        const result = await capability.reconcile(key)
        if (result.status !== 'recorded') return
        const receipt = validatedNativeReceipt(result.receipt, key, attempt.nativeBillingPreparation.intentHash)
        if (receipt && options?.nativeAcknowledgements) return Object.freeze({ kind: 'native_primary_billing_recorded' as const,
          invocationId: key.invocationId, nativeSessionId: key.nativeSessionId, workspaceId: attempt.workspaceId!,
          actualCostUsd: Number(receipt.amountUsd), receipt })
      } catch { /* Ambiguity is reconciled by exact key, never an unkeyed retry. */ }
      return
    }
    if (!usageStore || !attempt.workspaceId || attempt.stage !== 'primary_decision' || !attempt.usage
      || !isCentrallyMeteredDecisionModel(attempt.modelCatalogId)) return

    const target = usageTargetForOperation(attempt.operationId)
    const actualCostUsd = attempt.usage.costUsd ?? calculateCost(attempt.modelCatalogId, attempt.usage)
    const usage = attempt.usage
    const write = async (): Promise<void | NativeDecisionBillingAcknowledgement> => {
      try {
        await usageStore.recordUsage({
          userId: attempt.trustedBillingContext?.userId ?? '',
          assistantId: attempt.trustedBillingContext?.assistantId ?? '',
          ...(attempt.trustedBillingContext ? { actorUserId: attempt.trustedBillingContext.actorUserId } : {}),
          workspaceId: attempt.workspaceId,
          sessionId: attempt.trustedBillingContext?.sessionId ?? null,
          model: attempt.modelWireId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          actualCostUsd,
          source: attempt.trustedBillingContext ? 'included' : target.source,
          triggerKey: attempt.trustedBillingContext ? 'computer_use:native_decision' : target.triggerKey,
          providerKeySource: 'platform',
        })

      } catch (error) {
        console.error('[decision-metering] failed to record provider usage', {
          runId: attempt.runId,
          operationId: attempt.operationId,
          model: attempt.modelWireId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return write()
  }
}

export type DecisionRuntimeOutcome = {
  runId: string
  operationId: string
  workspaceId?: string
  configuredMode: DecisionRouteConfig['mode']
  effectiveMode: DecisionRouteConfig['mode']
  operatorOverride: boolean
  path: DecisionCascadeResult<unknown>['path']
  attempts: number
  failureKind?: DecisionCascadeResult<unknown>['failureKind']
}

export type DecisionRuntimeOperation<T> = DecisionExecutionOperation<T>

export type DecisionRuntimeRunOptions<T> = DecisionExecutionRunOptions<T> & {
  trustedBillingContext?: TrustedDecisionBillingContext
  /** Native-only durable admission/final audit+intent boundary, before central billing. */
  prepareNativeAttempt?: (attempt: DecisionRuntimeAttempt) => Promise<NativeAttemptPreparation>
  onAttempt?: (attempt: DecisionRuntimeAttempt, acknowledgement?: NativeDecisionBillingAcknowledgement) => void | Promise<void>
}

export interface DecisionRuntime {
  run<T>(options: DecisionRuntimeRunOptions<T>): Promise<DecisionCascadeResult<T>>
  observe<T>(options: DecisionObservationRunOptions<T>): Promise<DecisionObservationResult<T>>
  resolveRoute(context: DecisionRouteContext): Promise<DecisionRouteConfig>
  configuredAdapterIds(): readonly string[]
}

export type CreateDecisionRuntimeOptions = {
  llmProvider: LLMProvider
  defaultLlmModel: string | (() => string)
  /** Native-only admission prerequisite; never inferred from a void recorder. */
  nativeAccounting?: NativeAccountingCapability
  /** Optional Jev credential. Its absence leaves the runtime LLM-only. */
  typesafeApiKey?: string
  /** Optional injected registry for tests and additional transports. */
  adapters?: DecisionAdapterRegistry
  /** Registers additional transport factories without changing this runtime. */
  configureAdapters?: (registry: DecisionAdapterRegistry) => void
  resolveRoute?: DecisionRouteResolver
  onAttempt?: DecisionAttemptCallback
  onOutcome?: (outcome: DecisionRuntimeOutcome) => void | Promise<void>
}

function policyError(message: string): never {
  throw new DecisionProviderError('policy_denied', message)
}

function modelRef(modelId: string): DecisionModelRef {
  const row = registryRow(modelId)
  return row
    ? { catalogId: row.alias, wireId: row.apiModelId }
    : { catalogId: modelId, wireId: modelId }
}

function priceUsage(record: DecisionAttemptRecord): DecisionAttemptRecord {
  if (!record.usage || record.usage.costUsd !== undefined) return record
  const rates = modelRates(record.modelCatalogId) ?? modelRates(record.modelWireId)
  if (!rates) return record
  const bracket = bracketFor(rates, record.usage.inputTokens)
  return {
    ...record,
    usage: {
      ...record.usage,
      costUsd:
        (record.usage.inputTokens * bracket.inPerMTok
          + record.usage.outputTokens * bracket.outPerMTok) / 1_000_000,
    },
  }
}

function configuredPrimary(
  config: DecisionRouteConfig,
  adapters: DecisionAdapterRegistry,
): { provider?: DecisionProvider; model?: DecisionModelRef; effectiveMode: DecisionRouteConfig['mode'] } {
  if (config.mode === 'llm_only') return { effectiveMode: 'llm_only' }
  if (!config.primaryModelId) policyError(`${config.mode} route requires primaryModelId`)
  const row = registryRow(config.primaryModelId)
  if (!row || row.status !== 'active' || !isDecisionModelRow(row)) {
    policyError(`decision model '${config.primaryModelId}' is not an active decision model`)
  }
  const adapterId = row.decisionCapabilities.adapterId
  // Credential/config absence is resolved before execution, not normalized as
  // a provider outage. The supported LLM-only lane remains available.
  if (!adapters.has(adapterId)) return { effectiveMode: 'llm_only' }
  return {
    provider: adapters.create(adapterId, undefined),
    model: { catalogId: row.alias, wireId: row.decisionCapabilities.wireModelId },
    effectiveMode: config.mode,
  }
}

export function createDecisionRuntime(
  options: CreateDecisionRuntimeOptions,
): DecisionRuntime {
  const adapters = options.adapters ?? new DecisionAdapterRegistry()
  if (options.typesafeApiKey?.trim() && !adapters.has('typesafe')) {
    const apiKey = options.typesafeApiKey
    adapters.register('typesafe', () => createTypeSafeDecisionProvider({ apiKey }))
  }
  options.configureAdapters?.(adapters)
  const routeResolver: DecisionRouteResolver = options.resolveRoute
    ?? (() => ({ mode: 'llm_only' }))

  const resolveDefaultLlm = (): DecisionLlmRoute => ({
    provider: options.llmProvider,
    modelId: typeof options.defaultLlmModel === 'function'
      ? options.defaultLlmModel()
      : options.defaultLlmModel,
  })

  return {
    configuredAdapterIds: () => adapters.ids(),
    resolveRoute: async (context) => routeResolver(context),
    async observe<T>(runOptions: DecisionObservationRunOptions<T>): Promise<DecisionObservationResult<T>> {
      if ([NATIVE_NEXT_ACTION.id, NATIVE_VERIFY_PROGRESS.id].some(id => id === runOptions.request.operation.id)) {
        throw new Error('Native decisions require the scoped accounting run path')
      }
      const routeContext: DecisionRouteContext = {
        ...(runOptions.workspaceId ? { workspaceId: runOptions.workspaceId } : {}),
        kind: 'observation',
        evaluationSegment: runOptions.request.evaluationSegment ?? 'global',
        operation: runOptions.request.operation,
        questionKinds: runOptions.request.questions.map((question) => question.kind),
      }
      const config = await routeResolver(routeContext)
      const primary = configuredPrimary(config, adapters)
      const request: DecisionRequest = {
        ...runOptions.request,
        model: primary.model ?? modelRef(
          config.llm && config.llm !== null
            ? config.llm.modelId
            : resolveDefaultLlm().modelId,
        ),
      }
      if (primary.provider) assertDecisionCapabilities(request, primary.provider.capabilities)
      return executeDecisionObservation({
        request,
        operation: runOptions.operation,
        route: primary.effectiveMode === 'llm_only'
          ? { mode: 'llm_only' }
          : {
              mode: primary.effectiveMode,
              primary: primary.provider,
              profile: config.profile,
              allowSyntheticProfile: config.allowSyntheticProfile,
              operatorOverride: config.operatorOverride,
            },
        onAttempt: async (attempt) => {
          await options.onAttempt?.({
            ...priceUsage(attempt),
            ...(runOptions.workspaceId ? { workspaceId: runOptions.workspaceId } : {}),
            configuredMode: config.mode,
            effectiveMode: primary.effectiveMode,
            operatorOverride: config.profile?.evidence === 'operator_override',
          })
        },
      })
    },
    async run<T>(runOptions: DecisionRuntimeRunOptions<T>): Promise<DecisionCascadeResult<T>> {
      // One immutable identity per invocation cascade, including late callbacks.
      const trustedBillingContext = runOptions.trustedBillingContext ? Object.freeze({ ...runOptions.trustedBillingContext }) : undefined
      const nativeOperation = [NATIVE_NEXT_ACTION.id, NATIVE_VERIFY_PROGRESS.id].some(id => id === runOptions.request.operation.id)
      if (nativeOperation && (!options.nativeAccounting || !trustedBillingContext?.nativeSessionId || !runOptions.prepareNativeAttempt)) {
        throw new NativeAccountingUnavailableError('admission')
      }
      const routeContext: DecisionRouteContext = {
        ...(runOptions.workspaceId ? { workspaceId: runOptions.workspaceId } : {}),
        kind: 'execution',
        evaluationSegment: runOptions.request.evaluationSegment ?? 'global',
        operation: runOptions.request.operation,
        questionKinds: runOptions.request.questions.map((question) => question.kind),
      }
      const config = await routeResolver(routeContext)
      const primary = configuredPrimary(config, adapters)
      if (nativeOperation && primary.provider && primary.provider.supportsNativeStrict !== true) {
        throw new NativeAccountingUnavailableError('admission')
      }
      const llm = config.llm === undefined
        ? (runOptions.llm ?? resolveDefaultLlm())
        : config.llm
      if (!llm) policyError('decision route has no permitted LLM completion lane')

      const request: DecisionRequest = {
        ...runOptions.request,
        ...(nativeOperation ? { nativeStrict: true as const } : {}),
        model: primary.model ?? modelRef(llm.modelId),
      }
      if (primary.provider) assertDecisionCapabilities(request, primary.provider.capabilities)

      let nativeAdmissionDenied = false, nativeSettlementDenied = false
      const operation: DecisionCascadeOperation<T> = {
        ...runOptions.operation,
        completeWithLlm: (context) => {
          // An admission denial is not a provider transport error authorizing
          // failover. Profile/acceptance flags cannot bypass this native gate.
          if (nativeAdmissionDenied) throw new NativeAccountingUnavailableError('admission')
          if (nativeSettlementDenied) throw new NativeAccountingUnavailableError()
          return runOptions.operation.completeWithLlm({ ...context, llm })
        },
      }
      const result = await executeDecisionCascade({
        request,
        operation,
        route: primary.effectiveMode === 'llm_only'
          ? { mode: 'llm_only' }
          : {
              mode: primary.effectiveMode,
              primary: primary.provider,
              profile: config.profile,
              allowOperationalFailover: config.allowOperationalFailover,
              allowInvalidResponseRecovery: config.allowInvalidResponseRecovery,
              allowSyntheticProfile: config.allowSyntheticProfile,
              operatorOverride: config.operatorOverride,
            },
        onAttempt: async (attempt) => {
          const attributed: DecisionRuntimeAttempt = {
            ...(trustedBillingContext?.nativeSessionId && [NATIVE_NEXT_ACTION.id, NATIVE_VERIFY_PROGRESS.id].some(id => id === attempt.operationId) ? attempt : priceUsage(attempt)),
            ...(trustedBillingContext ? { trustedBillingContext } : {}),
            ...(runOptions.workspaceId ? { workspaceId: runOptions.workspaceId } : {}),
            configuredMode: config.mode,
            effectiveMode: primary.effectiveMode,
            operatorOverride: config.profile?.evidence === 'operator_override',
          }
          if (trustedBillingContext?.nativeSessionId && [NATIVE_NEXT_ACTION.id, NATIVE_VERIFY_PROGRESS.id].some(id => id === attributed.operationId)) {
            try {
              attributed.nativeBillingPreparation = await runOptions.prepareNativeAttempt?.(attributed) ?? { status: 'unsupported' }
              if (attributed.invocationState === 'pending' && !attributed.interrupted
                && attributed.nativeBillingPreparation.status !== 'admitted') {
                throw new NativeAccountingUnavailableError('admission')
              }
            }
            catch {
              if (attributed.invocationState === 'pending' && !attributed.interrupted) {
                nativeAdmissionDenied = true
                throw new NativeAccountingUnavailableError('admission')
              }
              attributed.nativeBillingPreparation = { status: 'unknown' }
            }
          }
          const nativeFinal = nativeOperation && attributed.stage === 'primary_decision'
            && attributed.invocationState === 'settled' && !attributed.interrupted
          if (nativeFinal && attributed.nativeBillingPreparation?.status !== 'prepared'
            ) nativeSettlementDenied = true
          let acknowledgement: void | NativeDecisionBillingAcknowledgement = undefined
          try { acknowledgement = await options.onAttempt?.(attributed) }
          catch (error) {
            if (!nativeOperation) throw error
            if (nativeFinal) nativeSettlementDenied = true
          }
          const valid = acknowledgement && isNativePrimaryInvocation(attributed)
            && acknowledgement.kind === 'native_primary_billing_recorded'
            && acknowledgement.invocationId === attributed.invocationId
            && acknowledgement.nativeSessionId === trustedBillingContext?.nativeSessionId
            && acknowledgement.workspaceId === attributed.workspaceId
            && attributed.nativeBillingPreparation?.status === 'prepared'
            && validatedNativeReceipt(acknowledgement.receipt, { nativeSessionId: trustedBillingContext!.nativeSessionId, invocationId: attributed.invocationId! }, attributed.nativeBillingPreparation.intentHash)
            && acknowledgement.actualCostUsd === Number(acknowledgement.receipt!.amountUsd)
          if (nativeFinal && attributed.nativeBillingPreparation?.status === 'prepared' && !valid) nativeSettlementDenied = true
          // Legacy void or lost receipts cannot authorize native effects. Do not
          // throw from the settlement callback: Hydra would re-emit it as a
          // provider error. Instead block failover/results at the run boundary.
          if (nativeOperation) {
            const receiptAcknowledgement = valid && acknowledgement ? acknowledgement : undefined
            void Promise.resolve().then(() => runOptions.onAttempt?.(attributed, receiptAcknowledgement)).catch(() => {})
          } else if (valid && acknowledgement) await runOptions.onAttempt?.(attributed, acknowledgement)
          else await runOptions.onAttempt?.(attributed)
        },
      })
      if (nativeAdmissionDenied) throw new NativeAccountingUnavailableError('admission')
      if (nativeSettlementDenied) throw new NativeAccountingUnavailableError()
      await options.onOutcome?.({
        runId: result.runId,
        operationId: request.operation.id,
        ...(runOptions.workspaceId ? { workspaceId: runOptions.workspaceId } : {}),
        configuredMode: config.mode,
        effectiveMode: primary.effectiveMode,
        operatorOverride: config.profile?.evidence === 'operator_override',
        path: result.path,
        attempts: result.attempts,
        ...(result.failureKind ? { failureKind: result.failureKind } : {}),
      })
      return result
    },
  }
}
