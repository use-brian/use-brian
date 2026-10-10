import { confirmationDecisionLabel, interpretConfirmationEvent, type NormalizedConfirmationEvent } from '@use-brian/core'
import type { DeferredConfirmationStore } from '../db/deferred-confirmation-store.js'
import { schedulerCallbackDeliveryScope, findSchedulerChannelConfirmations, tryResolveSchedulerConfirmation, type SchedulerChannelScope } from '../scheduling/confirmation-registry.js'
import { isInboxSentinel } from '../session-kind.js'
export type DeferredChannelScope = SchedulerChannelScope

/** After live conversational confirmation handling, before questions/LLM.
 * Null means unrelated text. Recognized callbacks never become chat, including
 * legacy entries without delivery provenance. Requires current actor membership.
 */
export async function maybeHandleChannelDeferredConfirmation(params: {
  scope: DeferredChannelScope
  event: NormalizedConfirmationEvent
  store?: DeferredConfirmationStore
  messageId?: string
  authorized: () => Promise<boolean>
  abortSignal?: AbortSignal
}): Promise<string | null> {
  const explicit = params.event.kind !== 'text'
  if (params.event.kind === 'action'
    && (typeof params.event.data !== 'string' || !params.event.data.startsWith('mcp_confirm:'))) return null
  const parsed = interpretConfirmationEvent(params.event)
  if (parsed.status !== 'decision') return explicit ? 'This confirmation is unavailable.' : null
  // Only recognized decision keywords, never arbitrary text/implicit rejection.
  const resolutionScope = params.event.kind === 'action' && parsed.toolCallId && params.messageId
    ? schedulerCallbackDeliveryScope(parsed.toolCallId, params.scope, params.messageId) ?? params.scope
    : params.scope
  const candidates = findSchedulerChannelConfirmations(resolutionScope, parsed.toolCallId)
  if (candidates.length !== 1) return explicit || candidates.length > 1 ? 'This confirmation is unavailable or ambiguous.' : null
  const binding = candidates[0]!
  const { toolCallId } = binding
  if (params.messageId && binding.delivery.messageId && params.messageId !== binding.delivery.messageId) {
    return 'This confirmation is unavailable.'
  }
  if ((parsed.decision === 'always_allow' || parsed.decision === 'always_deny') && !binding.allowPersistentApproval) {
    return 'Persistent approval is not available for this action.'
  }
  try {
    if (params.abortSignal?.aborted) return 'Stopped. No action was approved.'
    if (!await params.authorized()) return 'You are not authorized to answer this confirmation.'
    // The existing scheduler registry is authoritative even if DB persistence
    // is unwired. Where present, its safety-net row is an additional actor gate.
    if (params.store) {
      const row = await params.store.findByToolCallId(toolCallId)
      if (!row || row.status !== 'pending' || row.expiresAt.getTime() <= Date.now()
        || row.userId !== params.scope.userId || row.assistantId !== params.scope.assistantId
        || row.channelType !== params.scope.channelType
        || (row.channelId !== params.scope.channelId && !isInboxSentinel(row.channelId))) {
        return 'This confirmation is unavailable.'
      }
    }
    if (params.abortSignal?.aborted) return 'Stopped. No action was approved.'
    if (!tryResolveSchedulerConfirmation(toolCallId, parsed.decision, resolutionScope)) {
      return 'This confirmation is no longer active. No action was approved.'
    }
    await params.store?.markResolved(toolCallId, parsed.decision)
    return confirmationDecisionLabel(parsed.decision)
  } catch {
    return 'The confirmation could not be processed. Check the action status before retrying.'
  }
}
