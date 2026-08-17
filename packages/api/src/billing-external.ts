/**
 * The single seam that turns `ToolResult.meta.externalCost_*` into a billable
 * `usage_tracking` row.
 *
 * Every integration that spends money per call flows through here. It used to
 * live inside `routes/chat.ts`, which meant only the interactive chat lane
 * recorded external tool spend: a `webSearch` inside a workflow step, a
 * scheduled job, or an A2A consult ran the same paid API and wrote NOTHING.
 * Extracting it made the recording class-wide - the callee executor
 * (`inter-assistant/executor.ts`) calls it on its own tool results, which
 * closed that gap for search and made the in-process engine tools meterable
 * in the first place.
 *
 * See docs/architecture/platform/cost-and-pricing.md → "External API cost
 * tracking policy". [COMP:api/billing-external]
 */

import {
  calculateCost,
  decodeExternalCostMeta,
  sanitize,
  type AnalyticsLogger,
  type ToolResultMeta,
  type UsageStore,
} from '@use-brian/core'

export type RecordExternalCostParams = {
  toolMeta: ToolResultMeta | undefined
  usageStore: UsageStore | undefined
  userId: string
  assistantId: string
  sessionId: string
  /**
   * Links the row to the user message that caused it. The chat lane stamps
   * it; callee runs deliberately leave it unset, which (with a non-
   * `main_response` trigger) keeps them COGS-only rather than credit-bearing.
   */
  userMessageId?: string | null
  /** Chat lane only: a free-plan turn records `source='free'`. */
  userPlan?: string
  /**
   * Stamps the row so callee-lane external spend is separable from chat's in
   * the cost dashboard. Chat defaults to an explicit external-tool trigger so
   * linked tool-cost rows cannot be mistaken for legacy main responses.
   */
  triggerKey?: string
  /** Channel recorded on the failure analytics event. Defaults to `'web'`. */
  channelType?: string
  analytics: AnalyticsLogger | undefined
}

/**
 * Write a `usage_tracking` row for an external-API cost attached to a
 * tool result. No-op when `toolMeta` carries no `externalCost_*` fields.
 */
export async function recordExternalCostFromMeta(params: RecordExternalCostParams): Promise<void> {
  if (!params.usageStore) return
  const cost = decodeExternalCostMeta(params.toolMeta)
  if (!cost) return

  const actualCostUsd =
    cost.kind === 'per-token'
      ? calculateCost(cost.model, {
          inputTokens: cost.inputTokens,
          outputTokens: cost.outputTokens,
          cacheReadTokens: cost.cacheReadTokens ?? 0,
        })
      : cost.flatCostUsd

  const inputTokens = cost.kind === 'per-token' ? cost.inputTokens : 0
  const outputTokens = cost.kind === 'per-token' ? cost.outputTokens : 0
  const cacheReadTokens = cost.kind === 'per-token' ? cost.cacheReadTokens ?? 0 : 0

  try {
    await params.usageStore.recordUsage({
      userId: params.userId,
      assistantId: params.assistantId,
      sessionId: params.sessionId,
      model: cost.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      actualCostUsd,
      source: params.userPlan === 'free' ? 'free' : 'included',
      userMessageId: params.userMessageId ?? undefined,
      triggerKey: params.triggerKey
        ?? (params.toolMeta?.searchProvider ? 'web_search_external_tool' : 'external_tool'),
    })
  } catch (err) {
    console.error('External cost tracking failed:', err)
    params.analytics?.logEvent({
      userId: params.userId,
      assistantId: params.assistantId,
      sessionId: params.sessionId,
      eventName: 'usage_tracking_error',
      channelType: params.channelType ?? 'web',
      metadata: {
        error_type: sanitize((err as Error)?.name ?? 'unknown'),
        external_cost_model: sanitize(cost.model),
      },
    })
  }
}
