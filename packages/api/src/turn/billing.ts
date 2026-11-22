/**
 * Who pays for a turn, and who acted (unified-sessions D2, L18).
 *
 *   - A personal session bills its human: the turn's actor.
 *   - A workspace session (a web room, a draft, an anchored thread, a
 *     provider group) bills the WORKSPACE pool: the workspace billing party
 *     (`billingPartyForAssistant`), with the addresser recorded as the actor.
 *     Several people share the conversation, so no one member's allowance
 *     should carry it.
 *   - A machine lane names its payer explicitly (A2A caller-pays, workflow
 *     owner); the kernel takes it as given.
 *
 * The actor is always recorded, so per-member analytics are unchanged.
 *
 * [COMP:api/turn-kernel]
 */
import type { QueryUsageSnapshot } from '@use-brian/agent-runtime/engine/query-loop.js'
import type { TokenUsage } from '@use-brian/agent-runtime/providers/types.js'
import { calculateCost } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import { billingPartyForAssistant, type AssistantBillingIdentity } from '../billing-party.js'
import type { SessionPolicy } from '../session-kind.js'

export type TurnBilling = {
  /** The account charged (`usage.user_id`). */
  payerUserId: string
  /** The human who drove the turn (`usage.actor_user_id`), when there is one. */
  actorUserId: string | null
}

export async function resolveTurnBilling(params: {
  policy: Pick<SessionPolicy, 'billing'>
  assistant: AssistantBillingIdentity
  actorUserId: string | null
  /** A machine lane's explicit payer; wins over the policy. */
  explicitPayerUserId?: string
  /** Test seam. */
  resolveWorkspaceParty?: (assistant: AssistantBillingIdentity) => Promise<string>
}): Promise<TurnBilling> {
  if (params.explicitPayerUserId) {
    return { payerUserId: params.explicitPayerUserId, actorUserId: params.actorUserId }
  }
  if (params.policy.billing === 'workspace' && params.assistant.workspaceId) {
    const party = await (params.resolveWorkspaceParty ?? billingPartyForAssistant)(params.assistant)
    return { payerUserId: party, actorUserId: params.actorUserId }
  }
  if (params.actorUserId) return { payerUserId: params.actorUserId, actorUserId: params.actorUserId }
  return {
    payerUserId: await (params.resolveWorkspaceParty ?? billingPartyForAssistant)(params.assistant),
    actorUserId: null,
  }
}

/** Main-loop billing metadata belongs to the original turn; spend belongs to
 * the canonical producer. No mutable route/store options survive capture. */
export type TurnUsageRow = Parameters<import('@use-brian/agent-runtime/billing/cost-tracker.js').UsageStore['recordUsage']>[0]
export type TurnUsageBilling = {
  metadata: Readonly<Pick<TurnUsageRow,
    'userId' | 'actorUserId' | 'assistantId' | 'sessionId' | 'workspaceId' |
    'modelTier' | 'source' | 'userMessageId' | 'triggerKey' | 'providerKeySource'>>
  costPolicy: 'calculate' | 'reported_or_calculated'
  recordUsage: (row: TurnUsageRow) => Promise<void>
  onError?: (error: unknown) => void | Promise<void>
  /** Existing completion-only obligations, independently gated by their host. */
  afterSettlement?: (row: Readonly<TurnUsageRow>) => void | Promise<void>
}

export type TurnUsageSettlement =
  | { status: 'recorded' | 'no_usage' | 'not_configured' }
  | { status: 'failed'; error: unknown }

/** A context request can promote the main model. The previous producer's
 * cumulative spend and actual key source end at that round boundary. */
export type PriorTurnSpend = { spend: QueryUsageSnapshot; keySource: 'user' | 'platform'; nextTier: string }
function followingUsage(total: TokenUsage, prior: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens - prior.inputTokens, outputTokens: total.outputTokens - prior.outputTokens,
    cacheReadTokens: (total.cacheReadTokens ?? 0) - (prior.cacheReadTokens ?? 0),
    cacheWriteTokens: (total.cacheWriteTokens ?? 0) - (prior.cacheWriteTokens ?? 0),
    ...(total.calculatedCostUsd === undefined ? {} : { calculatedCostUsd: total.calculatedCostUsd - (prior.calculatedCostUsd ?? 0) }),
  }
}

export function captureTurnUsageBilling(registration: TurnUsageBilling, producerKeySource?: () => 'user' | 'platform' | undefined) {
  const metadata = Object.freeze({ ...registration.metadata })
  const { costPolicy, recordUsage, onError, afterSettlement } = registration
  return async (spend: QueryUsageSnapshot | null, prior?: PriorTurnSpend): Promise<TurnUsageSettlement> => {
    if (!spend) return { status: 'no_usage' }
    const currentKey = producerKeySource?.() ?? metadata.providerKeySource
    const rowFor = ({ model, totalUsage: usage }: QueryUsageSnapshot, providerKeySource = currentKey, modelTier = metadata.modelTier): TurnUsageRow => ({
      ...metadata, model, modelTier, providerKeySource,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
      actualCostUsd: providerKeySource === 'user' ? 0
        : costPolicy === 'reported_or_calculated' ? usage.calculatedCostUsd ?? calculateCost(model, usage)
          : calculateCost(model, usage),
    })
    const rows = prior ? [rowFor(prior.spend, prior.keySource)] : [rowFor(spend)]
    if (prior) {
      const usage = followingUsage(spend.totalUsage, prior.spend.totalUsage)
      if (usage.inputTokens || usage.outputTokens || usage.cacheReadTokens || usage.cacheWriteTokens) {
        rows.push(rowFor({ model: spend.model, totalUsage: usage }, currentKey, prior.nextTier))
      }
    }
    let outcome: TurnUsageSettlement = { status: 'recorded' }
    for (const row of rows) {
      try { await recordUsage({ ...row }) }
      catch (error) {
        outcome = { status: 'failed', error }
        try { await onError?.(error) } catch (reportError) { outcome = { status: 'failed', error: reportError } }
      }
    }
    // The original completion-only surcharge still observes the complete turn once.
    const completionRow = { ...rows[rows.length - 1], inputTokens: spend.totalUsage.inputTokens,
      outputTokens: spend.totalUsage.outputTokens, cacheReadTokens: spend.totalUsage.cacheReadTokens,
      cacheWriteTokens: spend.totalUsage.cacheWriteTokens, actualCostUsd: rows.reduce((sum, row) => sum + row.actualCostUsd, 0) }
    try { await afterSettlement?.(Object.freeze(completionRow)) }
    catch (error) { outcome = { status: 'failed', error } }
    return outcome
  }
}
