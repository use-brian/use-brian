/**
 * Workspace-aware composition boundary for the decision cascade.
 *
 * Domain operations own questions and result policy. This runtime owns the
 * allowed route, configured adapter, model catalog lookup, and attribution.
 *
 * [COMP:decisions/runtime]
 */

import {
  DecisionAdapterRegistry,
  DecisionProviderError,
  assertDecisionCapabilities,
  createTypeSafeDecisionProvider,
  executeDecisionCascade,
  type DecisionAttemptRecord,
  type DecisionCascadeOperation,
  type DecisionCascadeResult,
  type DecisionCompletionRoute,
  type DecisionEvaluationProfile,
  type DecisionExecutionOperation,
  type DecisionExecutionRunOptions,
  type DecisionModelRef,
  type DecisionRequest,
  type DecisionProvider,
} from '@use-brian/core'
import type { LLMProvider } from '@use-brian/core'
import {
  bracketFor,
  isDecisionModelRow,
  modelRates,
  registryRow,
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
}

export type DecisionRouteContext = {
  workspaceId?: string
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
}

export type DecisionRuntimeOutcome = {
  runId: string
  operationId: string
  workspaceId?: string
  configuredMode: DecisionRouteConfig['mode']
  effectiveMode: DecisionRouteConfig['mode']
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
    async run<T>(runOptions: DecisionRuntimeRunOptions<T>): Promise<DecisionCascadeResult<T>> {
      const routeContext: DecisionRouteContext = {
        ...(runOptions.workspaceId ? { workspaceId: runOptions.workspaceId } : {}),
        operation: runOptions.request.operation,
        questionKinds: runOptions.request.questions.map((question) => question.kind),
      }
      const config = await routeResolver(routeContext)
      const primary = configuredPrimary(config, adapters)
      const llm = config.llm === undefined ? resolveDefaultLlm() : config.llm
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
            },
        onAttempt: async (attempt) => {
          const attributed: DecisionRuntimeAttempt = {
            ...priceUsage(attempt),
            ...(runOptions.workspaceId ? { workspaceId: runOptions.workspaceId } : {}),
            configuredMode: config.mode,
            effectiveMode: primary.effectiveMode,
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
        path: result.path,
        attempts: result.attempts,
        ...(result.failureKind ? { failureKind: result.failureKind } : {}),
      })
      return result
    },
  }
}
