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

export type DecisionRuntimeAttempt = DecisionAttemptRecord & {
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
): (attempt: DecisionRuntimeAttempt) => Promise<void> {
  return async (attempt) => {
    if (
      !usageStore
      || !attempt.workspaceId
      || attempt.stage !== 'primary_decision'
      || !attempt.usage
      || !isCentrallyMeteredDecisionModel(attempt.modelCatalogId)
    ) return

    const target = usageTargetForOperation(attempt.operationId)
    try {
      await usageStore.recordUsage({
        userId: '',
        assistantId: '',
        workspaceId: attempt.workspaceId,
        sessionId: null,
        model: attempt.modelWireId,
        inputTokens: attempt.usage.inputTokens,
        outputTokens: attempt.usage.outputTokens,
        actualCostUsd: attempt.usage.costUsd
          ?? calculateCost(attempt.modelCatalogId, attempt.usage),
        source: target.source,
        triggerKey: target.triggerKey,
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
  onAttempt?: (attempt: DecisionRuntimeAttempt) => void | Promise<void>
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
  /** Optional Jev credential. Its absence leaves the runtime LLM-only. */
  typesafeApiKey?: string
  /** Optional injected registry for tests and additional transports. */
  adapters?: DecisionAdapterRegistry
  /** Registers additional transport factories without changing this runtime. */
  configureAdapters?: (registry: DecisionAdapterRegistry) => void
  resolveRoute?: DecisionRouteResolver
  onAttempt?: (attempt: DecisionRuntimeAttempt) => void | Promise<void>
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
      const routeContext: DecisionRouteContext = {
        ...(runOptions.workspaceId ? { workspaceId: runOptions.workspaceId } : {}),
        kind: 'execution',
        evaluationSegment: runOptions.request.evaluationSegment ?? 'global',
        operation: runOptions.request.operation,
        questionKinds: runOptions.request.questions.map((question) => question.kind),
      }
      const config = await routeResolver(routeContext)
      const primary = configuredPrimary(config, adapters)
      const llm = config.llm === undefined
        ? (runOptions.llm ?? resolveDefaultLlm())
        : config.llm
      if (!llm) policyError('decision route has no permitted LLM completion lane')

      const request: DecisionRequest = {
        ...runOptions.request,
        model: primary.model ?? modelRef(llm.modelId),
      }
      if (primary.provider) assertDecisionCapabilities(request, primary.provider.capabilities)

      const operation: DecisionCascadeOperation<T> = {
        ...runOptions.operation,
        completeWithLlm: (context) => runOptions.operation.completeWithLlm({
          ...context,
          llm,
        }),
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
            ...priceUsage(attempt),
            ...(runOptions.workspaceId ? { workspaceId: runOptions.workspaceId } : {}),
            configuredMode: config.mode,
            effectiveMode: primary.effectiveMode,
            operatorOverride: config.profile?.evidence === 'operator_override',
          }
          await options.onAttempt?.(attributed)
          await runOptions.onAttempt?.(attributed)
        },
      })
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
