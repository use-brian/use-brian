/**
 * Shared delivery utility for inter-assistant responses.
 *
 * Delivers a message to the caller's original or preferred channel.
 * Same pattern as packages/api/src/scheduling/executor.ts delivery.
 * DB-first: always persists to session, then pushes to channel adapter.
 */

import { findOrCreateSession, addSessionMessage } from '../db/sessions.js'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import { createSlackAdapter, createTelegramAdapter, createWhatsAppAdapter } from '@sidanclaw/channels'
import { sanitizeDeliveryText } from '@sidanclaw/shared'

export type DeliveryParams = {
  assistantId: string
  userId: string
  text: string
  /** Original session where the user asked (if known). */
  sessionId?: string
  /** Original channel type (web/telegram/slack/whatsapp). */
  channelType?: string
  /** Original channel ID (chat ID, thread ID, etc.). */
  channelId?: string
  integrationStore?: ChannelIntegrationStore
  /**
   * Official shared sidanclaw bot token. Used for Telegram delivery when
   * the assistant has no BYO `channel_integrations` row.
   */
  defaultTelegramBotToken?: string
  /** Required for WhatsApp delivery — the wa-connector URL. */
  waConnectorUrl?: string
  /** Required for WhatsApp delivery — the shared secret. */
  waConnectorSecret?: string
}

/**
 * Deliver a message to a user's channel.
 * Persists to the session first (DB-first), then pushes via channel adapter.
 */
export async function deliverToChannel(params: DeliveryParams): Promise<void> {
  const { assistantId, userId, integrationStore, defaultTelegramBotToken } = params
  // Strip any model scaffolding / meta-commentary before it is persisted or
  // pushed — the relayed callee response can carry a planning preamble or a
  // duplicated body the same way scheduled output does (see sanitizeDeliveryText).
  const text = sanitizeDeliveryText(params.text)

  // Broadcasts are deliberate (open question 8). A caller with no explicit
  // channel target persists to the web/notification session below
  // (channel_type 'web' → no outbound push) — there is no per-assistant
  // priority waterfall. It was removed with `notification_priority` in the
  // workspace-channels migration (C2). See docs/architecture/channels/adapter-pattern.md.
  const channelType = params.channelType ?? 'web'
  const channelId = params.channelId ?? 'default'

  // Only persist to notification session if delivering to web (avoid double notification)
  if (channelType === 'web' || channelType === 'notification') {
    const notifSession = await findOrCreateSession({
      assistantId,
      userId,
      channelType: 'notification',
      channelId: 'notifications',
    })
    await addSessionMessage({
      sessionId: notifSession.id,
      role: 'assistant',
      content: [{ type: 'text', text }],
    })
  }

  // Also persist to the original session if specified (for in-context delivery)
  if (params.sessionId) {
    await addSessionMessage({
      sessionId: params.sessionId,
      role: 'assistant',
      content: [{ type: 'text', text }],
    })
  }

  // Channel push
  try {
    if (channelType === 'telegram') {
      const byo = integrationStore
        ? await integrationStore.getCredentialsForAssistantSystem(assistantId, 'telegram')
        : null
      const botToken = byo
        ? (byo.credentials as { bot_token: string }).bot_token
        : defaultTelegramBotToken
      if (botToken) {
        const adapter = createTelegramAdapter({ token: botToken })
        await adapter.sendMessage(channelId, { text, format: 'markdown' })
      }
    } else if (channelType === 'slack' && integrationStore) {
      const integration = await integrationStore.getCredentialsForAssistantSystem(assistantId, 'slack')
      if (integration) {
        const adapter = createSlackAdapter({
          botToken: (integration.credentials as { bot_token: string }).bot_token,
          botUserId: integration.botUserId ?? undefined,
        })
        await adapter.sendMessage(channelId, { text, format: 'markdown' })
      }
    } else if (channelType === 'whatsapp' && params.waConnectorUrl && params.waConnectorSecret) {
      const adapter = createWhatsAppAdapter({
        connectorUrl: params.waConnectorUrl,
        connectorSecret: params.waConnectorSecret,
        connectionId: 'system',
      })
      await adapter.sendMessage(channelId, { text, format: 'markdown' })
    }
    // 'web' — persist-only; shows in the session on next page load
  } catch (err) {
    console.error('[deliver] channel push failed, falling back to web notification:', err)
    // Fallback: persist to web notification so the message isn't lost
    try {
      const notifSession = await findOrCreateSession({
        assistantId,
        userId,
        channelType: 'notification',
        channelId: 'notifications',
      })
      await addSessionMessage({
        sessionId: notifSession.id,
        role: 'assistant',
        content: [{ type: 'text', text }],
      })
    } catch (fallbackErr) {
      console.error('[deliver] web notification fallback also failed:', fallbackErr)
    }
  }
}
