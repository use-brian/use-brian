/**
 * Shared helper to attribute overhead LLM calls (classifier, compaction
 * summariser, extractor, reactive-compact) as `overhead:*` rows in the
 * UsageStore. Overhead rows carry full per-user / per-session / per-model
 * attribution but are excluded from billing math by the UsageStore — see
 * `packages/api/src/db/usage-store.ts` and `docs/platform/cost-and-pricing.md`
 * → "Overhead accounting".
 *
 * Usage is best-effort: failures are logged and swallowed so an overhead
 * recording error never breaks the main turn.
 */

import type { UsageStore, TokenUsage } from '@use-brian/core'
import { calculateCost, isOverheadSource } from '@use-brian/core'

export type RecordOverheadUsageParams = {
  usageStore: UsageStore | undefined
  /** Billing party — pays for the overhead call. */
  userId: string
  /**
   * Channel user who actually drove the message that triggered this
   * overhead. Optional — defaults to `userId` for the common case where
   * the chatter and the billing party are the same (web, Telegram).
   *
   * Pass it explicitly when they differ (API-channel shadow user, BYO
   * channels) so admin per-user analytics (`getUserTokens`, which filters
   * `WHERE actor_user_id = $1 GROUP BY user_message_id`) attributes the
   * overhead to the visible visitor — not the invisible owner. Without
   * this, shadow-user "tokens per turn" collapses to "tokens per message"
   * because the per-message rollup misses every overhead row.
   */
  actorUserId?: string
  assistantId: string
  sessionId: string
  userMessageId?: string | null
  model: string | null
  usage: TokenUsage | null | undefined
  source: string
  /**
   * Per-trigger LLM call identifier — see UsageStore.recordUsage. Optional;
   * forwarded straight through to the store. Migration 164.
   */
  triggerKey?: string
  /**
   * Seconds of audio this overhead call processed — see
   * UsageStore.recordUsage. Set by the voice-transcription paths so the
   * admin rollup can price speech-to-text per audio hour. Migration 353.
   */
  audioSeconds?: number
}

export async function recordOverheadUsage(
  params: RecordOverheadUsageParams,
): Promise<void> {
  if (!params.usageStore || !params.usage || !params.model) return
  if (!isOverheadSource(params.source)) {
    console.warn(`[overhead-usage] non-overhead source "${params.source}" — refusing to record`)
    return
  }
  try {
    await params.usageStore.recordUsage({
      userId: params.userId,
      actorUserId: params.actorUserId ?? params.userId,
      assistantId: params.assistantId,
      sessionId: params.sessionId,
      model: params.model,
      inputTokens: params.usage.inputTokens,
      outputTokens: params.usage.outputTokens,
      cacheReadTokens: params.usage.cacheReadTokens,
      cacheWriteTokens: params.usage.cacheWriteTokens,
      actualCostUsd: calculateCost(params.model, params.usage),
      source: params.source,
      userMessageId: params.userMessageId ?? undefined,
      triggerKey: params.triggerKey,
      ...(params.audioSeconds !== undefined ? { audioSeconds: params.audioSeconds } : {}),
    })
  } catch (err) {
    console.error(`[overhead-usage] failed to record ${params.source}:`, err)
  }
}
