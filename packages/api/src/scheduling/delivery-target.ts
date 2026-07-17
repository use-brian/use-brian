/**
 * Resolves a scheduled job's stored `(channelType, channelId)` into a
 * human-readable delivery target label for the scheduling tools' result
 * envelope. The model surfaces this so the user knows the EXACT chat / forum
 * topic a scheduled update will post to — closing the "is it really going to
 * this topic?" confidence gap that the type-only `deliveryChannel` enum leaves
 * open on its own.
 *
 * Telegram group titles + topic names come from the opportunistic seen-chats
 * inventory (`channel_integrations.config.seenChats`), populated by the BYO
 * webhook. A topic the bot never saw a `forum_topic_created` / `_edited`
 * service message for degrades to `topic #<id>` — still unambiguous, just not
 * pretty. The label is intentionally English-only today (a system descriptor,
 * not assistant prose); localising it would require threading the assistant's
 * language into the scheduling tool context.
 *
 * Injected into `createSchedulingTools` from `apps/api/src/index.ts`.
 *
 * Spec: docs/architecture/engine/scheduled-jobs.md → "Delivery-target capture".
 *
 * [COMP:scheduling/delivery-target]
 */
import { parseTopicChannelId } from '@use-brian/channels'
import type { DeliveryTargetResolver } from '@use-brian/core'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'

export function createDeliveryTargetResolver(
  integrationStore?: ChannelIntegrationStore,
): DeliveryTargetResolver {
  return async ({ assistantId, channelType, channelId }) => {
    if (channelType === 'web') return { label: 'Web chat' }

    if (channelType === 'telegram') {
      const { chatId, messageThreadId } = parseTopicChannelId(channelId)
      let chatTitle: string | null = null
      let topicName: string | null = null
      if (integrationStore) {
        try {
          const integ = await integrationStore.getCredentialsForAssistantSystem(
            assistantId,
            'telegram',
          )
          const seen = integ?.config.seenChats?.find((c) => c.chatId === chatId)
          chatTitle = seen?.chatTitle ?? null
          if (messageThreadId != null) {
            topicName = seen?.topics.find((t) => t.topicId === messageThreadId)?.name ?? null
          }
        } catch {
          // Best-effort — fall through to an id-only label.
        }
      }
      const groupPart = chatTitle ? `group "${chatTitle}"` : `chat ${chatId}`
      if (messageThreadId == null) return { label: `Telegram · ${groupPart}` }
      const topicPart = topicName ? `topic "${topicName}"` : `topic #${messageThreadId}`
      return { label: `Telegram · ${groupPart} · ${topicPart}`, topicId: messageThreadId }
    }

    if (channelType === 'slack') return { label: `Slack · channel ${channelId}` }
    if (channelType === 'whatsapp') return { label: 'WhatsApp' }
    return { label: channelType }
  }
}
