import { nativeDecisionMetadata } from '@use-brian/core'
import { NativeAccountingUnavailableError } from './accounting.js'
import { nativeAccountingFor, nativePrice, validatedNativeReceipt } from './accounting-capability.js'
import type { NativeAccountingCapability, NativeAttemptPreparation, NativeBillingSettlement } from './accounting.js'
import { NATIVE_NEXT_ACTION, NATIVE_VERIFY_PROGRESS, type LLMProvider, type NativeDecisionRuntime, type UsageStore } from '@use-brian/core'
import { isRegistryModelAvailable, registryRow, registryRowForPricing, type ProviderAvailability } from '@use-brian/shared/model-registry'
import type { WorkspaceCustomLlmResolver } from '../custom-llm-runtime.js'
import type { CreditBudgetGate } from '../routes/route-helpers.js'
import { resolveChatModelSelection } from '../model-resolution.js'
import { createNativeComputerModelRuntimeFactory, type NativeModelRuntimeOptions } from './model-runtime.js'
import type { DecisionRuntime, NativeDecisionBillingAcknowledgement } from '../decision-runtime.js'
import type { NativeRuntimeFactory } from './composition.js'
import { NativeAttemptSchema, type NativeAttemptRecord, type NativeComputerService } from './service.js'

export type NativeAuditRecord = NativeAttemptRecord & {
  primaryBillingAcknowledgement?: NativeDecisionBillingAcknowledgement
}

/** Native-only persistence seam. Primary receipts do NOT call UsageStore or
 * acquire an adapter billing claim; the central recorder already owns the write. */
export function createNativeAttemptRecorder(service: Pick<NativeComputerService, 'recordAttempt'>) {
  return async (record: NativeAuditRecord): Promise<boolean> => {
    // Receipts describe a transaction already committed by its accounting owner.
    // NativeBoot never promotes billing state based on a callback/void success.
    if (record.primaryBillingAcknowledgement) return false
    return service.recordAttempt({ ...record, claimBilling: false })
  }
}

export type NativeBootOptions = {
  provider: LLMProvider
  configuredProviders: ProviderAvailability
  resolveWorkspaceCustomLlm: WorkspaceCustomLlmResolver
  getWorkspacePlan(workspaceId: string): Promise<string>
  checkCreditBudget?: CreditBudgetGate
  decisionRuntime: Omit<NativeDecisionRuntime, 'run'> & Pick<DecisionRuntime, 'run'>
  usageStore?: UsageStore
  nativeAccounting?: NativeAccountingCapability
  /** Metadata-only native attempts; primary billing remains centrally owned. */
  recordAttempt?: (record: NativeAuditRecord) => Promise<boolean | void>
  budget?: NativeModelRuntimeOptions['budget']
  /** Approval/data-policy check for the already resolved task route, NOT a
   * second model resolver. A different provider/model/key source is refused.
   * Called again before upload and before accepting output. */
  resolveGrounder?: (context: Parameters<NativeRuntimeFactory>[0], route: {
    provider: LLMProvider; model: string; providerKeySource: 'user' | 'platform'
  }) => Promise<{
    provider: LLMProvider; model: string; nativeGrounding: true; providerKeySource: 'user' | 'platform'
  } | null>
}

/** Legacy environment model setting is an approval pin only. A different global
 * hint must never select an alternative provider/model for the image upload. */
export function createNativeConfiguredGrounderApproval(accepted: boolean, approvedModel?: string): NonNullable<NativeBootOptions['resolveGrounder']> {
  return async (context, selected) => !accepted || !approvedModel || !context.workspaceId || selected.model !== approvedModel
    ? null : { ...selected, nativeGrounding: true }
}

// Per grant, non-refundable. At $100 / million tokens this over-reserves the
// built-in text lanes. Vision requires an explicitly larger reviewed budget.
export const NATIVE_DEFAULT_BUDGET = { tokens: 262144, costUsd: 26.2144, attemptTokens: 32768, attemptCostUsd: 3.2768 }

/** Persisted managed routes are exact selections, not tier hints. Mirror the
 * routing provider's live credential/catalog gate; never substitute a model. */
function managedModelAvailable(model: string, availability: ProviderAvailability): boolean {
  const row = registryRow(model)
  return !!row && isRegistryModelAvailable(row, availability)
}

export type NativeModelReadinessOptions = Pick<NativeBootOptions,
  'provider' | 'configuredProviders' | 'resolveWorkspaceCustomLlm' | 'getWorkspacePlan' | 'checkCreditBudget' | 'budget'> & {
  decisionRuntime: Pick<NativeDecisionRuntime, 'resolveRoute'>
  imageApproval?: { accepted: boolean; model?: string }
}
export type NativeModelReadiness = {
  blockers: ('model_unavailable' | 'credits_blocked' | 'budget_invalid' | 'provider_unsupported' | 'policy_denied')[]
  warnings: ('vision_not_checked' | 'vision_image_unsupported' | 'vision_approval_unaccepted' | 'vision_approval_mismatch' | 'vision_budget_insufficient' | 'native_strict_adapter_unverified')[]
  /** Route capability only, NOT approval, native input acceptance or a live probe. */
  imageSupported: boolean
  /** One reservation would fit; not a reservation or a whole-task guarantee. */
  visionAttemptFitsBudget: boolean
}

/** Read-only configuration inspection. Existing resolvers read policy/config and
 * construct providers; never call stream/createSession, runtime admission,
 * accounting or reserve here. No endpoint/model identifiers leave this seam.
 * Host-supplied getWorkspacePlan/checkCreditBudget/resolveRoute must be reads.
 * Resolver errors propagate for the caller to report a bounded check failure. */
export async function inspectNativeComputerModelReadiness(options: NativeModelReadinessOptions, workspaceId: string): Promise<NativeModelReadiness> {
  const result: NativeModelReadiness = { blockers: [], warnings: ['vision_not_checked'], imageSupported: false, visionAttemptFitsBudget: false }
  const budget = options.budget ?? NATIVE_DEFAULT_BUDGET
  if (!Object.values(budget).every(n => Number.isFinite(n) && n > 0) || budget.attemptTokens < 32768
    || budget.tokens < budget.attemptTokens || budget.costUsd < budget.attemptCostUsd) result.blockers.push('budget_invalid')
  else {
    const tokens = Math.max(budget.attemptTokens, 4 * 1024 * 1024 + 32768)
    result.visionAttemptFitsBudget = budget.tokens >= tokens && budget.costUsd >= budget.attemptCostUsd * (tokens / budget.attemptTokens)
  }
  if (!workspaceId) { result.blockers.push('model_unavailable'); return result }
  const plan = await options.getWorkspacePlan(workspaceId)
  const budgetStatus = (await options.checkCreditBudget?.(workspaceId, plan))?.status ?? 'ok'
  if (budgetStatus === 'blocked') { result.blockers.push('credits_blocked'); return result }
  const llmRoutes = []
  for (const operation of [NATIVE_NEXT_ACTION, NATIVE_VERIFY_PROGRESS]) {
    const route = await options.decisionRuntime.resolveRoute({ workspaceId, kind: 'execution', evaluationSegment: 'global', operation, questionKinds: ['choice'] })
    if (route.llm === null) { result.blockers.push('policy_denied'); return result }
    if (route.llm) llmRoutes.push(route.llm)
  }
  const selection = resolveChatModelSelection('standard', plan, budgetStatus, options.configuredProviders)
  const custom = await options.resolveWorkspaceCustomLlm({ workspaceId, requestedTier: selection.logicalTier, allowDefault: true, allowFailureFallback: false })
  if ((!custom && options.configuredProviders.size === 0)
    || (custom?.routeKind === 'managed' && !managedModelAvailable(custom.selector, options.configuredProviders))) {
    result.blockers.push('model_unavailable'); return result
  }
  if (custom?.fallback.enabled || (custom && (custom.inputTokenLimit < 32768 || custom.maxTokens < 2048))) {
    result.blockers.push('provider_unsupported'); return result
  }
  const model = custom?.selector ?? selection.servingModel
  if (!NativeAttemptSchema.shape.requestedModel.safeParse(model).success) { result.blockers.push('model_unavailable'); return result }
  const provider = custom?.provider ?? options.provider
  // LLMProvider exposes no affirmative native-strict support flag. Never infer
  // that contract from registration or vision support. Codex has an explicit
  // native_unsupported_adapter guard; reject it including routed Hydra LLMs.
  const unsupported = (p: LLMProvider, id: string) => p.name === 'openai-codex' || registryRow(id)?.provider === 'openai-codex'
  if (unsupported(provider, model) || (!custom && llmRoutes.some(r => unsupported(r.provider, r.modelId)))) result.blockers.push('provider_unsupported')
  result.warnings = ['native_strict_adapter_unverified']
  result.imageSupported = (!custom || custom.routeKind === 'managed' && custom.supportsVision)
    && !unsupported(provider, model) && registryRow(model)?.capabilities.vision === true && provider.models.includes(model)
  if (!result.imageSupported) result.warnings.push('vision_image_unsupported')
  if (!options.imageApproval?.accepted || !options.imageApproval.model) result.warnings.push('vision_approval_unaccepted')
  else if (options.imageApproval.model !== model) result.warnings.push('vision_approval_mismatch')
  if (!result.visionAttemptFitsBudget) result.warnings.push('vision_budget_insufficient')
  return result
}

export function createNativeComputerBootRuntimeFactory(options: NativeBootOptions): NativeRuntimeFactory {
  return async (context, grant, trace) => {
    if (!context.workspaceId || context.userId !== grant.identity.userId || context.workspaceId !== grant.identity.workspaceId || context.sessionId !== grant.identity.conversationId) return null
    // Task admission, not merely a best-effort ledger callback. Unsupported
    // stores must not incur new native inference or expose an effectful runtime.
    const accounting = options.nativeAccounting ?? nativeAccountingFor(options.usageStore)
    if (!accounting) return null
    const plan = await options.getWorkspacePlan(context.workspaceId)
    const budgetStatus = (await options.checkCreditBudget?.(context.workspaceId, plan))?.status ?? 'ok'
    if (budgetStatus === 'blocked') return null
    // Honor an explicit denied LLM lane BEFORE sending AX data to the planner.
    for (const operation of [NATIVE_NEXT_ACTION, NATIVE_VERIFY_PROGRESS]) {
      const decisionRoute = await options.decisionRuntime.resolveRoute({ workspaceId: context.workspaceId!, kind: 'execution', evaluationSegment: 'global', operation, questionKinds: ['choice'] })
      if (decisionRoute.llm === null) return null
    }
    const selection = resolveChatModelSelection('standard', plan, budgetStatus, options.configuredProviders)
    const custom = await options.resolveWorkspaceCustomLlm({ workspaceId: context.workspaceId, requestedTier: selection.logicalTier, allowDefault: true, allowFailureFallback: false })
    if ((!custom && options.configuredProviders.size === 0)
      || (custom?.routeKind === 'managed' && !managedModelAvailable(custom.selector, options.configuredProviders))) return null
    if (custom?.fallback.enabled || (custom && (custom.inputTokenLimit < 32768 || custom.maxTokens < 2048))) return null
    const selectedProvider = custom?.provider ?? options.provider
    const selectedModel = custom?.selector ?? selection.servingModel
    const providerKeySource = custom?.providerKeySource ?? 'platform'
    // Reject unsafe identifiers before any inference, not at audit persistence.
    if (!NativeAttemptSchema.shape.requestedModel.safeParse(selectedModel).success) return null
    // Custom endpoint probes establish image support, but their opaque selector
    // does not expose an immutable expected wire model to this runtime. Until
    // that contract exists, retain text-only custom support; never upload to a
    // platform substitute. Managed workspace routes have registry wire identity.
    const imageSupported = (!custom || custom.routeKind === 'managed' && custom.supportsVision)
      && registryRow(selectedModel)?.capabilities.vision === true
      && selectedProvider.models.includes(selectedModel)
    const selectedRoute = { provider: selectedProvider, model: selectedModel, providerKeySource }
    const approvedImageRoute = async () => {
      if (!imageSupported) return false
      const approved = await options.resolveGrounder?.(context, selectedRoute)
      return !!approved?.nativeGrounding && approved.provider === selectedProvider
        && approved.model === selectedModel && approved.providerKeySource === providerKeySource
    }
    const imageApproved = await approvedImageRoute()
    const assertImageRouteCurrent = async () => {
      const currentPlan = await options.getWorkspacePlan(context.workspaceId!)
      const currentBudget = (await options.checkCreditBudget?.(context.workspaceId!, currentPlan))?.status ?? 'ok'
      if (currentBudget === 'blocked') throw new Error('Native image route denied')
      const currentSelection = resolveChatModelSelection('standard', currentPlan, currentBudget, options.configuredProviders)
      const current = await options.resolveWorkspaceCustomLlm({ workspaceId: context.workspaceId!, requestedTier: currentSelection.logicalTier, allowDefault: true, allowFailureFallback: false })
      if ((current?.selector ?? currentSelection.servingModel) !== selectedModel
        || (current?.routeKind ?? null) !== (custom?.routeKind ?? null)
        || (current?.profileId ?? null) !== (custom?.profileId ?? null)
        || (current?.providerKeySource ?? 'platform') !== providerKeySource
        || current?.fallback.enabled || (current && (!current.supportsVision || current.inputTokenLimit < 32768 || current.maxTokens < 2048))
        || (current?.routeKind === 'managed' && !managedModelAvailable(current.selector, options.configuredProviders))
        || !selectedProvider.models.includes(selectedModel)
        || (!current && (options.provider !== selectedProvider || options.configuredProviders.size === 0))) throw new Error('Native image route changed')
      for (const operation of [NATIVE_NEXT_ACTION, NATIVE_VERIFY_PROGRESS]) {
        const currentRoute = await options.decisionRuntime.resolveRoute({ workspaceId: context.workspaceId!, kind: 'execution', evaluationSegment: 'global', operation, questionKinds: ['choice'] })
        if (currentRoute.llm === null) throw new Error('Native image data lane denied')
      }
      if (!await approvedImageRoute()) throw new Error('Native image approval revoked')
    }
    // Pin both modalities to the identical provider/model. Native strict mode
    // and actual wire-model evidence remain independently enforced below.
    const pinnedProvider: LLMProvider = {
      name: selectedProvider.name, models: [selectedModel],
      createSession: selectedProvider.createSession.bind(selectedProvider),
      stream: async function* (request) {
        if (custom?.routeKind === 'managed' && !managedModelAvailable(selectedModel, options.configuredProviders)) throw new Error('Native managed model unavailable')
        yield* selectedProvider.stream({ ...request, model: selectedModel, allowProviderFallback: false })
      },
    }
    const grounder = imageApproved ? { provider: pinnedProvider, model: selectedModel,
      nativeGrounding: true as const, providerKeySource, assertCurrent: assertImageRouteCurrent } : undefined
    const route = { provider: pinnedProvider, model: selectedModel, plan, budgetStatus, grounder }
    const scope = { userId: context.userId, workspaceId: context.workspaceId, assistantId: context.assistantId,
      conversationId: context.sessionId, taskId: grant.identity.taskId }
    let accountingDenied = false
    const denyAccounting = () => { accountingDenied = true; return new NativeAccountingUnavailableError() }
    const assertAccounting = () => { if (accountingDenied) throw new NativeAccountingUnavailableError() }
    const primaryRecords = new Map<string, NativeAuditRecord>()
    const primaryRequestedModels = new Map<string, string>()
    const actorUserId = context.workspaceActorUserId ?? context.userId
    // Do not cache receipts over changing payloads: every settlement must pass
    // the durable immutable-intent check, including concurrent duplicates.
    const prepareAttempt = async (record: NativeAuditRecord, ledgerModel: string | null, quote: ReturnType<typeof nativePrice>): Promise<NativeAttemptPreparation> => {
      const a = record.attempt, key = { nativeSessionId: record.sessionId, invocationId: a.attemptId }
      if (a.invocationState === 'pending') {
        if (!a.interrupted) assertAccounting()
        await options.recordAttempt?.(record)
        if (!a.operation) throw new NativeAccountingUnavailableError('admission')
        const admitted = await accounting.admit({ version: 1, backend: accounting.backend, key,
          scope: { ...scope, actorUserId, grantId: grant.grantId, epoch: grant.epoch, deploymentId: grant.identity.deploymentId },
          owner: a.lane === 'decision' ? 'central_primary' : 'adapter', requestedModel: a.requestedModel,
          lane: a.lane, stage: a.stage, operation: a.operation, perceptionPath: a.perceptionPath, providerKeySource: a.providerKeySource })
        if (admitted.status !== 'admitted') throw new NativeAccountingUnavailableError('admission')
        return { status: 'admitted' }
      }
      const settlement: NativeBillingSettlement = { key, attempt: a, ledgerModel, modelTier: quote.modelTier, price: quote.price }
      const prepared = await accounting.prepare(settlement)
      // Retain metadata for legacy/missing admissions, but NEVER retry their unkeyed billing.
      if (prepared.status === 'legacy') await options.recordAttempt?.(record)
      if (prepared.status === 'conflict') trace?.invalidate('invalid_metadata')
      return prepared
    }
    const prepare = async (...args: Parameters<typeof prepareAttempt>): Promise<NativeAttemptPreparation> => {
      const a = args[0].attempt
      try {
        const result = await prepareAttempt(...args)
        // Failed/interrupted providers may legitimately lack usage. That is not
        // a metering success, but there is no usable result to authorize either.
        if (!a.interrupted && result.status !== 'admitted' && result.status !== 'prepared'
          && !(result.status === 'not_ready' && a.outcome === 'failed')) accountingDenied = true
        return result
      } catch (error) { if (!a.interrupted) accountingDenied = true; throw error }
    }
    // Only this trusted API boundary adds billing identity. Do not accept it
    // from decision state, relay payloads, or model-generated arguments.
    const decisionRuntime: NativeDecisionRuntime = {
      resolveRoute: request => options.decisionRuntime.resolveRoute({ ...request, workspaceId: scope.workspaceId }),
      // Native progress and shadow selection use the scoped run path below.
      // Do not expose the legacy observation path without native attribution,
      // invocation reconciliation and exact operation-profile policy.
      observe: async () => { throw new Error('Native decisions require the scoped run path') },
      run: async request => {
        assertAccounting()
        const result = await options.decisionRuntime.run({ ...request, workspaceId: scope.workspaceId,
        trustedBillingContext: { userId: context.userId, actorUserId, assistantId: context.assistantId,
          sessionId: context.sessionId, taskId: grant.identity.taskId, nativeSessionId: grant.identity.sessionId },
        prepareNativeAttempt: async attempt => {
          // Completions already pass through the adapter meter below. The global
          // recorder alone reconciles Jev. This hook durably prepares its audit
          // and immutable intent first; it never calls the ledger/reconciler.
          if (attempt.stage !== 'primary_decision') return { status: 'not_ready' }
          const requestedModel = primaryRequestedModels.get(attempt.invocationId!) ?? attempt.modelCatalogId
          primaryRequestedModels.set(attempt.invocationId!, requestedModel)
          const evidence = nativeDecisionMetadata(attempt.nativeMetadata)
          const actualModel = evidence.actualModel
          const actualUsage = evidence.usage ?? undefined
          const quote = nativePrice(actualModel, actualUsage, 'platform')
          const record: NativeAuditRecord = { sessionId: grant.identity.sessionId, grantId: grant.grantId, scope,
            attempt: NativeAttemptSchema.parse({ attemptId: attempt.invocationId, invocationState: attempt.invocationState ?? 'settled', interrupted: attempt.interrupted ?? false, requestedModel, model: actualModel ? registryRowForPricing(actualModel)?.alias ?? actualModel : null, providerKind: 'typesafe',
              operation: attempt.operationId === NATIVE_NEXT_ACTION.id ? 'next-action'
                : attempt.operationId === NATIVE_VERIFY_PROGRESS.id ? 'verify-progress' : null,
              stage: 'primary_decision', perceptionPath: 'ax',
              disposition: NativeAttemptSchema.shape.disposition.safeParse(attempt.disposition).data ?? null,
              fallbackReason: NativeAttemptSchema.shape.fallbackReason.safeParse(attempt.followUpReason).data
                ?? (attempt.disposition === 'complete' ? 'none' : null),
              lane: 'decision', outcome: attempt.invocationState === 'pending' && !attempt.interrupted ? 'pending' : attempt.outcome === 'success' && !attempt.interrupted ? 'ok' : 'failed', durationMs: attempt.latencyMs,
              usage: actualUsage ?? null, incurredCostUsd: quote.incurred, estimatedBilledCostUsd: quote.estimated, providerKeySource: 'platform' }),
          }
          if (trace) {
            if (attempt.runId !== request.request.runId) trace.invalidate('invalid_metadata')
            else trace.recordInference(trace.correlationForSpan(request.request.runId), record.attempt)
          }
          primaryRecords.set(attempt.invocationId!, record)
          return prepare(record, actualModel, quote)
        },
        onAttempt: async (attempt, acknowledgement) => {
          const record = primaryRecords.get(attempt.invocationId!)
          if (record && acknowledgement?.receipt && attempt.nativeBillingPreparation?.status === 'prepared'
            && validatedNativeReceipt(acknowledgement.receipt, { nativeSessionId: grant.identity.sessionId, invocationId: attempt.invocationId! }, attempt.nativeBillingPreparation.intentHash)) {
            void Promise.resolve().then(() => options.recordAttempt?.({ ...record, primaryBillingAcknowledgement: acknowledgement })).catch(() => {})
          }
        },
        }).catch(error => {
          if (error instanceof NativeAccountingUnavailableError) accountingDenied = true
          throw error
        })
        // Hydra may normalize a completion error into abstention. Accounting
        // failure is infrastructure failure, never semantic uncertainty.
        assertAccounting()
        return result
      },
    }

    const runtime = await createNativeComputerModelRuntimeFactory({
      resolve: async () => route,
      // A workspace custom endpoint must not leak AX text into platform Hydra.
      // Its bounded selector uses that same endpoint and is metered below.
      decisionRuntime: custom ? undefined : decisionRuntime,
      localApprovalRequired: true,
      budget: options.budget ?? NATIVE_DEFAULT_BUDGET,
      meter: async event => {
        try {
          const providerKeySource = event.lane === 'vision' ? grounder!.providerKeySource : custom?.providerKeySource ?? 'platform'
          const model = event.model
          const row = model ? registryRowForPricing(model) : undefined
          // Provider.name may contain a credential-bearing custom endpoint URL.
          const kind = event.lane === 'text' && custom ? 'custom' : event.providerId
          const recognizedProvider = NativeAttemptSchema.shape.providerKind.safeParse(kind)
          const providerKind = NativeAttemptSchema.shape.providerKind.safeParse(recognizedProvider.success ? kind : row?.provider)
          const quote = nativePrice(model, event.usage, providerKeySource)
          const record: NativeAttemptRecord = {
            claimBilling: false,
            sessionId: grant.identity.sessionId, grantId: grant.grantId,
            scope,
            attempt: NativeAttemptSchema.parse({ attemptId: event.attemptId, invocationState: event.invocationState, interrupted: event.interrupted, requestedModel: event.requestedModel, model, providerKind: providerKind.success ? providerKind.data : 'other',
              operation: event.operation, stage: event.stage, perceptionPath: event.perceptionPath,
              fallbackReason: event.fallbackReason, disposition: event.disposition,
              lane: event.lane, outcome: event.outcome, durationMs: event.durationMs,
              usage: event.usage ?? null, incurredCostUsd: quote.incurred, estimatedBilledCostUsd: quote.estimated, providerKeySource }),
          }
          trace?.recordInference(event.trace, record.attempt)
          const prepared = await prepare(record, model, quote)
          if (prepared.status !== 'prepared') {
            if (!event.interrupted && event.invocationState === 'settled' && (!model || !event.usage)) throw denyAccounting()
            if (!event.interrupted) assertAccounting()
            return
          }
          // Adapter owns only text/vision. Primary reconcile is exclusively central.
          try {
            const key = { nativeSessionId: record.sessionId, invocationId: event.attemptId }
            const result = await accounting.reconcile(key)
            if (result.status !== 'recorded' || !validatedNativeReceipt(result.receipt, key, prepared.intentHash)) {
              if (result.status === 'recorded') trace?.invalidate('invalid_metadata')
              if (!event.interrupted) throw denyAccounting()
            }
          }
          catch {
            // Keep the immutable intent for accounting-only recovery. Do not
            // authorize effects with an unconfirmed on-time result or retry it.
            if (!event.interrupted) throw denyAccounting()
          }
          if (!event.interrupted) assertAccounting()
        } catch (error) {
          if (!event.interrupted) accountingDenied = true
          throw error instanceof NativeAccountingUnavailableError ? error
            : new NativeAccountingUnavailableError(event.invocationState === 'pending' ? 'admission' : 'settlement')
        }
      },
    })(context, grant, trace)
    return runtime && { ...runtime, accountingStatus: () => accountingDenied ? 'unavailable' as const : 'ready' as const }
  }
}
