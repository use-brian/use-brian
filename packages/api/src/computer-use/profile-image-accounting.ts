import { randomUUID } from 'node:crypto'
import type { NativeImageAttempt, NativeImageSettlement, ToolContext } from '@use-brian/core'
import type { NativeGrant } from '@use-brian/computer-control/protocol.js'
import { registryRowForPricing } from '@use-brian/shared/model-registry'
import { NativeAccountingUnavailableError, NativeBillingAdmissionSchema, nativeAccountingHash, type NativeAccountingCapability } from './accounting.js'
import { nativePrice, validatedNativeReceipt } from './accounting-capability.js'
import { NativeAttemptSchema, type NativeComputerService, type NativeScope } from './service.js'

export type ProfileImageAccounting = (context: ToolContext, grant: NativeGrant, scope: NativeScope) => Promise<NativeImageAttempt>

/** Content-free durable admission/settlement for one NORMAL chat model call.
 * No task/goal runner, and no dependence on SSE delivery or publication authority.
 * The original immutable scope survives Stop/revocation. One invocation key owns
 * one insertion receipt; query-loop excludes it from the main_response charge. */
export function createProfileImageAccounting(service: Pick<NativeComputerService, 'recordAttempt' | 'assertProfilePublication'>,
  accounting: NativeAccountingCapability): ProfileImageAccounting {
  return async (context, grant, scope) => {
    const requestedModel = context.engineRuntime?.model
    if (!requestedModel || !('profileId' in grant.identity) || scope.taskId !== null) throw new NativeAccountingUnavailableError('admission')
    await service.assertProfilePublication(scope, grant)
    await context.authority?.assertCurrent()
    context.abortSignal.throwIfAborted()
    const key = { nativeSessionId: grant.identity.sessionId, invocationId: randomUUID() }
    const admission = NativeBillingAdmissionSchema.parse({ version: 1, backend: accounting.backend, key,
      scope: { userId: scope.userId, actorUserId: context.workspaceActorUserId ?? scope.userId, workspaceId: scope.workspaceId,
        assistantId: scope.assistantId, conversationId: scope.conversationId, taskId: null, profileId: grant.identity.profileId,
        grantId: grant.grantId, deploymentId: grant.identity.deploymentId, epoch: grant.epoch },
      owner: 'adapter', requestedModel, lane: 'vision', stage: 'direct', operation: 'ground', perceptionPath: 'vision', providerKeySource: 'platform' })
    const pending = NativeAttemptSchema.parse({ attemptId: key.invocationId, invocationState: 'pending', interrupted: false,
      requestedModel, model: null, providerKind: 'other', lane: 'vision', outcome: 'pending', operation: 'ground', stage: 'direct',
      perceptionPath: 'vision', fallbackReason: 'none', disposition: null, durationMs: 0, usage: null,
      incurredCostUsd: null, estimatedBilledCostUsd: null, providerKeySource: 'platform' })
    await service.recordAttempt({ scope: { ...scope }, sessionId: key.nativeSessionId, grantId: grant.grantId, attempt: pending })
    if ((await accounting.admit(admission)).status !== 'admitted') throw new NativeAccountingUnavailableError('admission')
    let settled: Promise<void> | undefined
    let settlementHash: string | undefined
    return { settle(result: NativeImageSettlement) {
      // Duplicate consumer/finalization paths share the same settlement. Durable
      // receipt validation still arbitrates process/transport retries of this key.
      const hash = nativeAccountingHash(result)
      if (settlementHash && settlementHash !== hash) return Promise.reject(new NativeAccountingUnavailableError())
      settlementHash = hash
      settled ??= (async () => {
        const quote = nativePrice(result.actualModel, result.usage ?? undefined, 'platform')
        const provider = result.actualModel ? registryRowForPricing(result.actualModel)?.provider : undefined
        const providerKind = NativeAttemptSchema.shape.providerKind.safeParse(provider).data ?? 'other'
        const attempt = NativeAttemptSchema.parse({ ...pending, invocationState: 'settled', model: result.actualModel,
          providerKind, usage: result.usage, outcome: result.outcome, interrupted: result.interrupted, durationMs: result.durationMs,
          incurredCostUsd: quote.incurred, estimatedBilledCostUsd: quote.estimated })
        // No live-grant, authority.execute or AbortSignal here. A consumed call
        // remains attributable after consent/turn authority has been withdrawn.
        const prepared = await accounting.prepare({ key, attempt, ledgerModel: result.actualModel, modelTier: quote.modelTier, price: quote.price })
        if (prepared.status === 'not_ready' && result.outcome === 'failed' && (!result.actualModel || !result.usage || !quote.price)) return // durable unknown audit, NOT free usage
        if (prepared.status !== 'prepared') throw new NativeAccountingUnavailableError()
        const reconciled = await accounting.reconcile(key)
        if (reconciled.status !== 'recorded' || !validatedNativeReceipt(reconciled.receipt, key, prepared.intentHash)) throw new NativeAccountingUnavailableError()
      })()
      return settled
    } }
  }
}
