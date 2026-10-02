import { nativeDecisionMetadata } from '@use-brian/core'
import { NativeAccountingUnavailableError } from './accounting.js'
import { nativeAccountingFor, nativePrice, validatedNativeReceipt } from './accounting-capability.js'
import type { NativeAccountingCapability, NativeAttemptPreparation, NativeBillingSettlement } from './accounting.js'
import { NATIVE_NEXT_ACTION, NATIVE_VERIFY_PROGRESS, type LLMProvider, type NativeDecisionRuntime, type UsageStore } from '@use-brian/core'
import { registryRowForPricing, type ProviderAvailability } from '@use-brian/shared/model-registry'
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
  /** Deployment-reviewed exact route. Vision capability alone is NOT approval.
   * Called with trusted workspace context; must enforce that workspace's data policy. */
  resolveGrounder?: (context: Parameters<NativeRuntimeFactory>[0]) => Promise<{
    provider: LLMProvider; model: string; nativeGrounding: true; providerKeySource: 'user' | 'platform'
  } | null>
}

// Per grant, non-refundable. At $100 / million tokens this over-reserves the
// built-in text lanes. Vision requires an explicitly larger reviewed budget.
export const NATIVE_DEFAULT_BUDGET = { tokens: 262144, costUsd: 26.2144, attemptTokens: 32768, attemptCostUsd: 3.2768 }

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
      const decisionRoute = await options.decisionRuntime.resolveRoute({ workspaceId: context.workspaceId, kind: 'execution', evaluationSegment: 'global', operation, questionKinds: ['choice'] })
      if (decisionRoute.llm === null) return null
    }
    const selection = resolveChatModelSelection('standard', plan, budgetStatus, options.configuredProviders)
    const custom = await options.resolveWorkspaceCustomLlm({ workspaceId: context.workspaceId, requestedTier: selection.logicalTier, allowDefault: true, allowFailureFallback: false })
    if (!custom && options.configuredProviders.size === 0) return null
    if (custom?.fallback.enabled || (custom && (custom.inputTokenLimit < 32768 || custom.maxTokens < 2048))) return null
    const grounder = await options.resolveGrounder?.(context)
    if (grounder && (!grounder.nativeGrounding || !grounder.model || !grounder.provider.models.includes(grounder.model))) return null
    const selectedProvider = custom?.provider ?? options.provider
    const selectedModel = custom?.selector ?? selection.servingModel
    // Reject unsafe identifiers before any inference, not at audit persistence.
    if (!NativeAttemptSchema.shape.requestedModel.safeParse(selectedModel).success
      || (grounder && !NativeAttemptSchema.shape.requestedModel.safeParse(grounder.model).success)) return null
    // The concrete factory applies chat alias resolution again; custom: IDs are
    // not registry aliases. Pin the already-resolved route at the provider seam.
    const pinnedProvider: LLMProvider = {
      name: selectedProvider.name, models: [selectedModel],
      createSession: selectedProvider.createSession.bind(selectedProvider),
      stream: request => selectedProvider.stream({ ...request, model: selectedModel, allowProviderFallback: false }),
    }
    const route = { provider: pinnedProvider, model: selectedModel, plan, budgetStatus, grounder: grounder ?? undefined }
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
