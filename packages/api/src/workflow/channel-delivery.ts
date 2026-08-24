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
  createWhatsAppCloudAdapter,
  createMsTeamsAdapter,
  createFeishuAdapter,
  createCustomAdapter,
  describeSlackError,
  isSlackApiError,
} from '@use-brian/channels'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import type { CustomChannelStore } from '../db/custom-channel-store.js'
import { findOrCreateSession, addSessionMessage } from '../db/sessions.js'
import { query } from './../db/client.js'
import { whatsappCloudUserAllowed } from '../whatsapp/cloud-access.js'
import { createFeishuApi } from '../feishu/client.js'
import type { FeishuCredentials } from '../db/channel-integrations.js'

export type WorkflowChannelDeliveryOptions = {
  /** BYO Telegram + Slack credentials. */
  integrationStore?: ChannelIntegrationStore
  /** Shared official Telegram bot — fallback when an assistant has no BYO row. */
  defaultTelegramBotToken?: string
  /** WhatsApp delivery via the wa-connector. */
  waConnectorUrl?: string
  waConnectorSecret?: string
  /** Injectable clock for customer-service-window checks. */
  now?: () => number
  /**
   * Custom (bridge-driven) channel outbox. A custom delivery enqueues a
   * `message` item on the workspace channel for the bridge to pull
   * (docs/architecture/channels/custom-channel.md).
   */
  customChannelStore?: Pick<CustomChannelStore, 'enqueue'>
}

/**
 * Frame a Slack push failure for the model. The raw throw is
 * `Slack API chat.postMessage: channel_not_found` — a bare code that names
 * neither what did not happen nor what to do about it, and which the executor
 * copies verbatim into the step run's `__delivery.error` (the model's ONLY
 * account of the delivery). `describeSlackError` supplies the diagnosis, the
 * next step and the retry verdict; this adds what the code cannot know — that
 * this was a WORKFLOW DELIVERY, to which channel/thread, and that the message
 * did not reach anyone. See docs/architecture/engine/tool-executor.md →
 * "Failure copy".
 */
function slackDeliveryFailure(err: unknown, channelId: string, threadRef?: string): string {
  const where = threadRef
    ? `Slack channel \`${channelId}\` (as a reply in thread \`${threadRef}\`)`
    : `Slack channel \`${channelId}\``
  // Non-Slack throws (network, adapter bug) never reached Slack at all —
  // describeSlackError passes them through as their bare message, so the
  // retry verdict has to be supplied here.
  const verdict = isSlackApiError(err)
    ? ''
    : ' Slack never answered this call (a network or adapter failure, not a Slack rejection), so retry once; if it fails again, tell the user Slack delivery is not getting through.'
  return `Slack delivery FAILED — this step's output was NOT posted to ${where}. ${describeSlackError(err)}${verdict} The text is saved in the assistant's Slack session history so it is not lost, but nobody was notified: do not tell the user it was sent.`
}

export function createWorkflowChannelDelivery(
  options: WorkflowChannelDeliveryOptions,
): DeliverToChannel {
  return async ({
    workspaceId,
    assistantId,
    userId,
    channelType,
    channelId,
    channelIntegrationId,
    text,
    threadRef,
    replyToTrigger,
  }): Promise<DeliveryOutcome> => {
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

    if (replyToTrigger) {
      if (channelType !== 'whatsapp' || !channelIntegrationId) {
        return { status: 'skipped', channelType, reason: 'provider_mismatch' }
      }
      const occurredAt = Date.parse(replyToTrigger.occurredAt)
      const now = options.now?.() ?? Date.now()
      if (!Number.isFinite(occurredAt) || now - occurredAt >= 24 * 60 * 60 * 1000) {
        return { status: 'skipped', channelType, reason: 'customer_service_window_expired' }
      }
      if (!options.integrationStore) {
        return { status: 'skipped', channelType, reason: 'no_integration' }
      }
      const integration = await options.integrationStore.getCredentialsForAssistantIntegrationSystem(
        workspaceId,
        assistantId,
        channelIntegrationId,
        'whatsapp',
        channelId,
      )
      if (!integration) return { status: 'skipped', channelType, reason: 'no_integration' }
      const credentials = integration.credentials as {
        provider?: unknown
        access_token?: unknown
        phone_number_id?: unknown
        graph_api_version?: unknown
      }
      if (
        credentials.provider !== 'cloud_api'
        || typeof credentials.access_token !== 'string'
        || typeof credentials.phone_number_id !== 'string'
        || credentials.phone_number_id !== replyToTrigger.providerAccountId
      ) {
        return { status: 'skipped', channelType, reason: 'provider_mismatch' }
      }
      if (!whatsappCloudUserAllowed(
        integration.config ?? {},
        replyToTrigger.actorId,
        replyToTrigger.recipientType === 'group',
      )) {
        return { status: 'skipped', channelType, reason: 'access_denied' }
      }

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
      const messageId = await createWhatsAppCloudAdapter({
        accessToken: credentials.access_token,
        phoneNumberId: credentials.phone_number_id,
        graphApiVersion: typeof credentials.graph_api_version === 'string'
          ? credentials.graph_api_version
          : undefined,
        recipientType: replyToTrigger.recipientType,
      }).sendMessage(channelId, { text: deliverable, format: 'markdown' })
      return {
        status: 'delivered',
        channelType,
        channelId,
        messageId: messageId || undefined,
      }
    }

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
      const tokens: string[] = []
      if (options.integrationStore) {
        const integ = channelIntegrationId
          ? await options.integrationStore.getCredentialsForAssistantIntegrationSystem(
              workspaceId,
              assistantId,
              channelIntegrationId,
              'telegram',
              channelId,
            )
          : await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'telegram')
        const byoToken = integ && (integ.credentials as { bot_token?: string }).bot_token
        if (byoToken) tokens.push(byoToken)
      }
      if (!channelIntegrationId && options.defaultTelegramBotToken && !tokens.includes(options.defaultTelegramBotToken)) {
        tokens.push(options.defaultTelegramBotToken)
      }
      if (tokens.length === 0) return { status: 'skipped', channelType, reason: 'no_integration' }
      // `threadRef` (an earlier delivery's message id) posts this one as a
      // reply; the returned message id lets a later `deliver.thread` step
      // reply under THIS message. See workflow.md → deliver `thread`.
      for (const [index, token] of tokens.entries()) {
        try {
          const tgMessageId = await createTelegramAdapter({ token }).sendMessage(
            channelId,
            { text: deliverable, format: 'markdown' },
            threadRef ? { threadTs: threadRef } : undefined,
          )
          return { status: 'delivered', channelType, channelId, messageId: tgMessageId || undefined }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const canTryNext = index < tokens.length - 1
            && /Telegram API sendMessage:.*chat not found/i.test(message)
          if (!canTryNext) throw err
        }
      }
      throw new Error('Telegram delivery exhausted all configured bots')
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
      try {
        const slackTs = await createSlackAdapter({
          botToken: (integ.credentials as { bot_token: string }).bot_token,
          botUserId: integ.botUserId ?? undefined,
        }).sendMessage(
          channelId,
          { text: deliverable, format: 'markdown' },
          threadRef ? { threadTs: threadRef } : undefined,
        )
        return { status: 'delivered', channelType, channelId, messageId: slackTs || undefined }
      } catch (err) {
        // Return the typed `failed` outcome rather than throwing: the executor
        // would otherwise stamp the raw `Slack API <method>: <code>` message
        // into `__delivery.error`. Same control flow, model-actionable copy.
        return { status: 'failed', channelType, error: slackDeliveryFailure(err, channelId, threadRef) }
      }
    }

    if (channelType === 'feishu') {
      if (!options.integrationStore) return { status: 'skipped', channelType, reason: 'no_integration' }
      const integ = channelIntegrationId
        ? await options.integrationStore.getCredentialsForAssistantIntegrationSystem(
            workspaceId,
            assistantId,
            channelIntegrationId,
            'feishu',
            channelId,
          )
        : await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'feishu')
      if (!integ) return { status: 'skipped', channelType, reason: 'no_integration' }
      const credentials = integ.credentials as FeishuCredentials
      const adapter = createFeishuAdapter({
        api: createFeishuApi({
          appId: credentials.app_id,
          appSecret: credentials.app_secret,
          brand: credentials.brand,
        }),
        botOpenId: integ.botUserId ?? undefined,
        config: { replyInThread: integ.config?.replyInThread ?? true },
      })
      const messageId = await adapter.sendMessage(
        channelId,
        { text: deliverable, format: 'markdown' },
        threadRef ? { threadTs: threadRef } : undefined,
      )
      return { status: 'delivered', channelType, channelId, messageId: messageId || undefined }
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

    if (channelType === 'custom') {
      if (!options.integrationStore || !options.customChannelStore) {
        return { status: 'skipped', channelType, reason: 'no_integration' }
      }
      // The workspace channel is the delivery "account"; `channelId` here is
      // the peer (conversation) id on the bridged platform. Resolve the
      // channel through the assistant's routing (exact integration when the
      // step pinned one), then enqueue for the bridge.
      const integ = channelIntegrationId
        ? await options.integrationStore.getCredentialsForAssistantIntegrationSystem(
            workspaceId,
            assistantId,
            channelIntegrationId,
            'custom',
            channelId,
          )
        : await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'custom')
      if (!integ) return { status: 'skipped', channelType, reason: 'no_integration' }
      const workspaceChannelId = integ.channelId
      const enqueue = options.customChannelStore
      const outboxId = await createCustomAdapter({
        enqueue: (item) => enqueue.enqueue(workspaceChannelId, { type: item.type, peerId: item.peerId, payload: item.payload }),
      }).sendMessage(channelId, {
        text: deliverable,
        format: 'markdown',
      })
      return { status: 'delivered', channelType, channelId, messageId: outboxId || undefined }
    }

    if (channelType === 'whatsapp') {
      if (!options.waConnectorUrl || !options.waConnectorSecret) {
        return { status: 'skipped', channelType, reason: 'no_integration' }
      }
      // channelId may be a placeholder ('notifications') when the workflow
      // wasn't authored from a WhatsApp chat — resolve a real JID.
      let waChannelId = channelId
      if (waChannelId === 'notifications') {
        const waSession = await query<{ channel_id: string }>(
          `SELECT channel_id FROM sessions
           WHERE assistant_id = $1 AND user_id = $2 AND channel_type = 'whatsapp'
              AND channel_id LIKE '%@%'
           ORDER BY last_active_at DESC LIMIT 1`,
          [assistantId, userId],
        )
        if (!waSession.rows[0]) return { status: 'skipped', channelType, reason: 'no_recipient' }
        waChannelId = waSession.rows[0].channel_id
      }
      if (!waChannelId.includes('@')) {
        return { status: 'skipped', channelType, reason: 'no_integration' }
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
