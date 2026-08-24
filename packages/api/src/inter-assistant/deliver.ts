/**
 * Shared delivery utility for inter-assistant responses.
 *
 * Delivers a message to the caller's original or preferred channel.
 * Same pattern as packages/api/src/scheduling/executor.ts delivery.
 * DB-first: always persists to session, then pushes to channel adapter.
 */

import { findOrCreateSession, addSessionMessage } from '../db/sessions.js'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import type { FeishuCredentials } from '../db/channel-integrations.js'
import {
  createFeishuAdapter,
  createSlackAdapter,
  createTelegramAdapter,
  createWhatsAppAdapter,
  describeSlackError,
  isSlackApiError,
} from '@use-brian/channels'
import { sanitizeDeliveryText } from '@use-brian/shared'
import { createFeishuApi } from '../feishu/client.js'

export type DeliveryParams = {
  assistantId: string
  userId: string
  text: string
  /** Original session where the user asked (if known). */
  sessionId?: string
  /** Original channel type (web/telegram/slack/whatsapp/feishu). */
  channelType?: string
  /** Original channel ID (chat ID, thread ID, etc.). */
  channelId?: string
  integrationStore?: ChannelIntegrationStore
  /**
   * Official shared Use Brian bot token. Used for Telegram delivery when
   * the assistant has no BYO `channel_integrations` row.
   */
  defaultTelegramBotToken?: string
  /** Required for WhatsApp delivery — the wa-connector URL. */
  waConnectorUrl?: string
  /** Required for WhatsApp delivery — the shared secret. */
  waConnectorSecret?: string
}

/**
 * Outcome of one relay delivery. `delivered: false` means the channel push did
 * NOT reach the user, and `reason` says what did not happen, why, what to do
 * next, and whether the same call can ever succeed — including where the text
 * ended up (the in-app notification fallback, or nowhere). Additive: callers
 * that ignore the return value are unaffected, so a caller that CAN tell the
 * model (the A2A relay, the proactive live-view hand-off) has an account to
 * relay instead of a silent `console.error`.
 */
export type ChannelDeliveryResult = {
  delivered: boolean
  channelType: string
  /**
   * Model-actionable diagnosis when `delivered` is false: what did not happen,
   * why, the next step, and whether the same call can ever succeed. Absent on
   * success. See docs/architecture/engine/tool-executor.md → "Failure copy".
   */
  reason?: string
}

/**
 * Deliver a message to a user's channel.
 * Persists to the session first (DB-first), then pushes via channel adapter.
 */
export async function deliverToChannel(params: DeliveryParams): Promise<ChannelDeliveryResult> {
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

  // Channel push. Every branch that cannot send returns a typed
  // `delivered: false` with the missing surface + the remedy named — a
  // "connect Slack" gap must never look like a sent message (the
  // no-integration silent-success shape).
  try {
    if (channelType === 'telegram') {
      const byo = integrationStore
        ? await integrationStore.getCredentialsForAssistantSystem(assistantId, 'telegram')
        : null
      const botToken = byo
        ? (byo.credentials as { bot_token: string }).bot_token
        : defaultTelegramBotToken
      if (!botToken) {
        return {
          delivered: false,
          channelType,
          reason: `Not delivered to Telegram: this assistant has no connected Telegram bot, and no shared bot is configured, so there is no way to reach chat \`${channelId}\` and the message was not delivered. Connect Telegram for this assistant (Studio → Channels) before promising a Telegram delivery; retrying will not help until then.`,
        }
      }
      const adapter = createTelegramAdapter({ token: botToken })
      await adapter.sendMessage(channelId, { text, format: 'markdown' })
    } else if (channelType === 'slack') {
      const integration = integrationStore
        ? await integrationStore.getCredentialsForAssistantSystem(assistantId, 'slack')
        : null
      if (!integration) {
        return {
          delivered: false,
          channelType,
          reason: `Not delivered to Slack: this assistant has no connected Slack workspace, so channel \`${channelId}\` cannot be posted to and the message was not delivered. Connect Slack for this assistant (Studio → Channels → Slack) before promising a Slack delivery; retrying will not help until then.`,
        }
      }
      const adapter = createSlackAdapter({
        botToken: (integration.credentials as { bot_token: string }).bot_token,
        botUserId: integration.botUserId ?? undefined,
      })
      await adapter.sendMessage(channelId, { text, format: 'markdown' })
    } else if (channelType === 'feishu') {
      const integration = integrationStore
        ? await integrationStore.getCredentialsForAssistantSystem(assistantId, 'feishu')
        : null
      if (!integration) {
        return {
          delivered: false,
          channelType,
          reason: `Not delivered to Feishu / Lark: this assistant has no connected enterprise app, so chat \`${channelId}\` cannot be posted to and the message was not delivered. Connect Feishu / Lark for this assistant in Studio before promising delivery; retrying will not help until then.`,
        }
      }
      const credentials = integration.credentials as FeishuCredentials
      const adapter = createFeishuAdapter({
        api: createFeishuApi({
          appId: credentials.app_id,
          appSecret: credentials.app_secret,
          brand: credentials.brand,
        }),
        botOpenId: integration.botUserId ?? undefined,
      })
      await adapter.sendMessage(channelId, { text, format: 'markdown' })
    } else if (channelType === 'whatsapp') {
      if (!params.waConnectorUrl || !params.waConnectorSecret) {
        return {
          delivered: false,
          channelType,
          reason: `Not delivered to WhatsApp: no WhatsApp connector is configured for this deployment, so \`${channelId}\` cannot be reached and the message was not delivered. Retrying will not help until WhatsApp is connected for this deployment.`,
        }
      }
      if (!channelId.includes('@')) {
        return {
          delivered: false,
          channelType,
          reason: `Not delivered to WhatsApp: \`${channelId}\` is not a WhatsApp JID (those look like \`15551234567@s.whatsapp.net\`), so there is no recipient to send to and the message was not delivered. Use the JID from the WhatsApp session this request came from; this exact value will keep failing.`,
        }
      }
      const adapter = createWhatsAppAdapter({
        connectorUrl: params.waConnectorUrl,
        connectorSecret: params.waConnectorSecret,
        connectionId: 'system',
      })
      await adapter.sendMessage(channelId, { text, format: 'markdown' })
    }
    // 'web' / 'notification' — persist-only; the message shows in the session
    // on next page load, which IS the delivery on that surface.
    return { delivered: true, channelType }
  } catch (err) {
    // The relayed text NEVER reached the user's channel. `describeSlackError`
    // turns Slack's bare `{ ok: false, error: '<code>' }` into what failed,
    // why, the next step and the retry verdict; every other channel passes
    // through as its own message. Framed here with the one thing the code
    // cannot know — that this was an inter-assistant relay to this channel,
    // and that the message is only visible in-app now.
    const diagnosis = channelType === 'slack'
      ? `Slack delivery FAILED — the relayed message was NOT posted to Slack channel \`${channelId}\`. ${describeSlackError(err)}${
          isSlackApiError(err)
            ? ''
            : ' Slack never answered this call (a network or adapter failure, not a Slack rejection): retry once, and if it fails again tell the user Slack delivery is not getting through.'
        }`
      : `Delivery to ${channelType} FAILED — the relayed message was NOT pushed to \`${channelId}\` (${
          err instanceof Error ? err.message : String(err)
        }).`
    console.error('[deliver] channel push failed, falling back to web notification:', diagnosis)
    // Fallback: persist to web notification so the message isn't lost. Whether
    // it landed decides the last sentence — claiming "saved to notifications"
    // when the fallback ALSO failed would be the same lie one layer down.
    let salvaged = false
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
      salvaged = true
    } catch (fallbackErr) {
      console.error('[deliver] web notification fallback also failed:', fallbackErr)
    }
    return {
      delivered: false,
      channelType,
      reason: salvaged
        ? `${diagnosis} The text was saved to the in-app notifications instead, so the user only sees it if they open the app: do not tell them it was sent to ${channelType}.`
        : `${diagnosis} The in-app notification fallback also failed, so this text was not stored anywhere and the user cannot see it at all — do not tell them it was sent, and say it again here if it matters.`,
    }
  }
}
