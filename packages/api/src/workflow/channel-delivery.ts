/**
 * Workflow channel delivery — pushes an `assistant_call` step's text output
 * to a user channel. The execution-side counterpart of the
 * `assistant_call.deliver` step field.
 *
 * Reuses the per-channel adapter path the scheduled-job executor uses
 * (`packages/api/src/scheduling/executor.ts`): Telegram BYO token → shared
 * default, Slack BYO, WhatsApp connector. DB-first — the message is
 * persisted into the messaging-channel delivery session before the push, so
 * a failed push still surfaces in that channel's history.
 *
 * Web is NOT a delivery target: the web UI is a pull surface, so a scheduled
 * / workflow push there only landed an unsolicited message in the user's main
 * chat thread. `web` deliveries are dropped here (a no-op) — scheduled output
 * goes to a messaging channel or, for a doc-maintaining job, updates the
 * page in place (the one-step reminder workflow omits `deliver` entirely).
 * Legacy jobs whose stored `deliver.channelType` is still 'web' become silent
 * no-ops on their next fire.
 *
 * This bridges the scheduling ⇄ workflow gap — it gives a one-step workflow
 * the channel-delivery capability a scheduled job has.
 *
 * Spec: docs/architecture/engine/scheduled-jobs.md → "Channel delivery".
 *
 * [COMP:workflow/channel-delivery]
 */

import type { DeliverToChannel, DeliveryOutcome } from '@use-brian/core'
import { sanitizeDeliveryText } from '@use-brian/shared'
import {
  createSlackAdapter,
  createTelegramAdapter,
  createWhatsAppAdapter,
  createMsTeamsAdapter,
} from '@use-brian/channels'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import { findOrCreateSession, addSessionMessage } from '../db/sessions.js'
import { query } from './../db/client.js'

export type WorkflowChannelDeliveryOptions = {
  /** BYO Telegram + Slack credentials. */
  integrationStore?: ChannelIntegrationStore
  /** Shared official Telegram bot — fallback when an assistant has no BYO row. */
  defaultTelegramBotToken?: string
  /** WhatsApp delivery via the wa-connector. */
  waConnectorUrl?: string
  waConnectorSecret?: string
}

export function createWorkflowChannelDelivery(
  options: WorkflowChannelDeliveryOptions,
): DeliverToChannel {
  return async ({ assistantId, userId, channelType, channelId, text, threadRef }): Promise<DeliveryOutcome> => {
    // Strip any model scaffolding / meta-commentary before it is persisted to
    // the delivery session OR pushed to the channel — a cron-framed turn can
    // echo a "Message body:" planning preamble and a duplicated body (see
    // sanitizeDeliveryText). Idempotent: the core executor already sanitized
    // for the workflow path; this defends every DeliverToChannel caller.
    const deliverable = sanitizeDeliveryText(text)
    if (!deliverable) return { status: 'skipped', channelType, reason: 'empty_text' }

    // Web is not a delivery target — drop it (see the file header). The web UI
    // is a pull surface; persisting here would re-introduce the scheduled-job
    // clutter in the user's main chat thread. Doc-maintaining jobs omit
    // `deliver` so they never reach this path; legacy 'web' jobs surface a
    // typed `web_not_a_target` skip so the run-detail page shows the no-op
    // (and the authoring guard steers new workflows away from `web`).
    if (channelType === 'web') return { status: 'skipped', channelType, reason: 'web_not_a_target' }

    // DB-first: persist into the messaging-channel delivery session so the
    // message survives a failed channel push.
    const session = await findOrCreateSession({
      assistantId,
      userId,
      channelType,
      channelId,
    })
    await addSessionMessage({
      sessionId: session.id,
      role: 'assistant',
      content: [{ type: 'text', text: deliverable }],
    })

    if (channelType === 'telegram') {
      let token = options.defaultTelegramBotToken
      if (options.integrationStore) {
        const integ = await options.integrationStore.getCredentialsForAssistantSystem(
          assistantId,
          'telegram',
        )
        if (integ) token = (integ.credentials as { bot_token: string }).bot_token
      }
      if (!token) return { status: 'skipped', channelType, reason: 'no_integration' }
      // `threadRef` (an earlier delivery's message id) posts this one as a
      // reply; the returned message id lets a later `deliver.thread` step
      // reply under THIS message. See workflow.md → deliver `thread`.
      const tgMessageId = await createTelegramAdapter({ token }).sendMessage(
        channelId,
        { text: deliverable, format: 'markdown' },
        threadRef ? { threadTs: threadRef } : undefined,
      )
      return { status: 'delivered', channelType, channelId, messageId: tgMessageId || undefined }
    }

    if (channelType === 'slack') {
      if (!options.integrationStore) return { status: 'skipped', channelType, reason: 'no_integration' }
      const integ = await options.integrationStore.getCredentialsForAssistantSystem(
        assistantId,
        'slack',
      )
      if (!integ) return { status: 'skipped', channelType, reason: 'no_integration' }
      // `threadRef` (an earlier delivery's Slack ts) posts into that thread;
      // the returned ts anchors later `deliver.thread` steps.
      const slackTs = await createSlackAdapter({
        botToken: (integ.credentials as { bot_token: string }).bot_token,
        botUserId: integ.botUserId ?? undefined,
      }).sendMessage(
        channelId,
        { text: deliverable, format: 'markdown' },
        threadRef ? { threadTs: threadRef } : undefined,
      )
      return { status: 'delivered', channelType, channelId, messageId: slackTs || undefined }
    }

    if (channelType === 'msteams') {
      if (!options.integrationStore) return { status: 'skipped', channelType, reason: 'no_integration' }
      const integ = await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'msteams')
      if (!integ) return { status: 'skipped', channelType, reason: 'no_integration' }
      const creds = integ.credentials as { app_id: string; app_password: string; tenant_id: string }
      // Teams proactive delivery needs a serviceUrl — there is no inbound
      // Activity here. Use the last-seen one persisted on the integration config
      // (msteams.md → "Outbound / proactive"); absent it, we cannot reach the
      // conversation yet, so skip rather than fail.
      const serviceUrl = integ.config?.msteamsServiceUrl
      if (!serviceUrl) return { status: 'skipped', channelType, reason: 'no_recipient' }
      const msgId = await createMsTeamsAdapter({
        appId: creds.app_id,
        appPassword: creds.app_password,
        tenantId: creds.tenant_id,
        serviceUrl,
        botId: integ.botUserId ?? undefined,
      }).sendMessage(channelId, { text: deliverable, format: 'markdown' })
      return { status: 'delivered', channelType, channelId, messageId: msgId || undefined }
    }

    if (channelType === 'whatsapp') {
      if (!options.waConnectorUrl || !options.waConnectorSecret) {
        return { status: 'skipped', channelType, reason: 'no_integration' }
      }
      // channelId may be a placeholder ('notifications') when the workflow
      // wasn't authored from a WhatsApp chat — resolve a real JID.
      let waChannelId = channelId
      if (!waChannelId.includes('@')) {
        const waSession = await query<{ channel_id: string }>(
          `SELECT channel_id FROM sessions
           WHERE assistant_id = $1 AND user_id = $2 AND channel_type = 'whatsapp'
             AND channel_id != 'notifications'
           ORDER BY last_active_at DESC LIMIT 1`,
          [assistantId, userId],
        )
        if (!waSession.rows[0]) return { status: 'skipped', channelType, reason: 'no_recipient' }
        waChannelId = waSession.rows[0].channel_id
      }
      await createWhatsAppAdapter({
        connectorUrl: options.waConnectorUrl,
        connectorSecret: options.waConnectorSecret,
        connectionId: 'system',
      }).sendMessage(waChannelId, { text: deliverable, format: 'plain' })
      return { status: 'delivered', channelType, channelId: waChannelId }
    }

    return { status: 'skipped', channelType, reason: 'no_integration' }
  }
}
