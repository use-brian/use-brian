/**
 * `dispatchReactionFeedback` — Slack `reaction_added` + Telegram
 * `message_reaction` → `recordFeedback`.
 *
 * Each messaging-platform reaction handler hands the raw reaction
 * (emoji string + the channel-native message id + a user-resolver
 * callback) here. The helper:
 *
 *  1. Classifies the emoji via `classifyReaction` (shared map).
 *     Returns silently when the emoji is ambiguous (`🙏`, `👀`) so
 *     we never fabricate feedback the user didn't intend.
 *  2. Looks the assistant message up via
 *     `findSessionMessageByChannelTriple` — only matches assistant
 *     messages, so a reaction on the user's own message is ignored.
 *  3. Resolves the reacting user via the caller-supplied callback.
 *     The callback receives the resolved `assistantId` so it can
 *     map a platform user via `resolveChannelUser(... assistantId)`.
 *  4. Calls `recordFeedback`, which writes the analytics row + (for
 *     substantive negative feedback) the auto-memory. Reactions
 *     carry short `details` (e.g. `:thumbsdown:`) so they DO NOT
 *     trigger the auto-memory branch — they only land in the
 *     `analytics_events` stream the reflection consolidation reads.
 *
 * Returns `'ignored'` when the emoji is ambiguous OR the assistant
 * message wasn't found (e.g. reaction on a message that predates the
 * channel-id plumbing) OR the user resolver returned null. Returns
 * `'recorded'` on success. Errors from `recordFeedback` propagate.
 *
 * Spec: docs/architecture/brain/corrections.md → "Emoji reactions
 * as feedback signal".
 *
 * [COMP:brain/reaction-dispatch]
 */

import {
  classifyReaction,
  reactionDetailsLabel,
} from '@use-brian/shared'
import { findSessionMessageByChannelTriple } from '../db/sessions.js'
import { recordFeedback, type FeedbackSource } from './record.js'

export type ReactionDispatchInput = {
  source: FeedbackSource
  /** Channel-native chat id (Slack channel id, Telegram chat id). */
  channelId: string
  /** Channel-native message id the reaction targets (Slack `ts`,
   *  Telegram `message_id` as string). */
  channelMessageId: string
  /** Raw emoji as the platform delivers it: Slack name without
   *  colons (`thumbsup`, `+1`), Telegram unicode (`👍`). */
  rawEmoji: string
  /**
   * Resolve the reacting user to an internal user id. Receives the
   * `assistantId` for the assistant message that was reacted to —
   * pass it through to `resolveChannelUser(... assistantId)` so the
   * channel-user → internal-user mapping is scoped to the right
   * assistant. Return `null` to skip recording (e.g. couldn't
   * resolve, ambiguous identity).
   */
  resolveUserId: (assistantId: string) => Promise<string | null>
}

export type ReactionDispatchResult =
  | { status: 'recorded'; kind: 'positive' | 'negative'; messageId: string }
  | {
      status: 'ignored'
      reason: 'ambiguous_emoji' | 'message_not_found' | 'user_not_resolved'
    }

export async function dispatchReactionFeedback(
  input: ReactionDispatchInput,
): Promise<ReactionDispatchResult> {
  const classification = classifyReaction(input.rawEmoji)
  if (!classification) {
    return { status: 'ignored', reason: 'ambiguous_emoji' }
  }

  const channelType = input.source

  const target = await findSessionMessageByChannelTriple(
    channelType,
    input.channelId,
    input.channelMessageId,
  )
  if (!target) {
    return { status: 'ignored', reason: 'message_not_found' }
  }

  const userId = await input.resolveUserId(target.assistantId)
  if (!userId) {
    return { status: 'ignored', reason: 'user_not_resolved' }
  }

  await recordFeedback({
    userId,
    messageId: target.messageId,
    sessionId: target.sessionId,
    kind: classification.kind,
    issueType: classification.issueType,
    details: reactionDetailsLabel(input.rawEmoji),
    source: input.source,
    channelId: input.channelId,
  })

  return {
    status: 'recorded',
    kind: classification.kind,
    messageId: target.messageId,
  }
}
