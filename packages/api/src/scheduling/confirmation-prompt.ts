/**
 * Confirmation-prompt delivery for deferred tool confirmations.
 *
 * Lifted from the legacy scheduled-job executor at the Phase 2 cutover. A
 * scheduled job's workflow `assistant_call` step runs in the callee executor
 * (`packages/api/src/inter-assistant/executor.ts`); when its inner query loop
 * hits an `ask`-policy MCP tool, the callee parks the confirmation and calls
 * this to prompt the user on the step's `deliver` channel — inline buttons
 * (Telegram/Feishu), keyword instructions (Slack/WhatsApp), or persist-only
 * (web).
 *
 * The user's reply reaches the suspended resolver through the shared
 * in-memory registry (`confirmation-registry.ts`); this module only sends
 * the outbound prompt.
 *
 * See docs/architecture/engine/scheduled-jobs.md → "Deferred confirmations".
 * Component tag: [COMP:scheduling/confirmation-prompt].
 */

import { buildConfirmationActions, type ToolConfirmationRequest } from '@use-brian/core'
import {
  createSlackAdapter,
  createFeishuAdapter,
  createTelegramAdapter,
  createWhatsAppAdapter,
  createCustomAdapter,
  createMsTeamsAdapter,
  describeSlackError,
  isSlackApiError,
} from '@use-brian/channels'
import { getToolDisplayName, formatConfirmationInput } from '@use-brian/shared'
import { bindSchedulerConfirmationDelivery, clearSchedulerConfirmationDelivery, getSchedulerConfirmationActor,
  SHARED_TELEGRAM_CONFIRMATION_INTEGRATION, SYSTEM_WHATSAPP_CONFIRMATION_INTEGRATION } from './confirmation-registry.js'
import { query } from '../db/client.js'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import type { CustomChannelStore } from '../db/custom-channel-store.js'
import { createFeishuApi } from '../feishu/client.js'
import type { FeishuCredentials } from '../db/channel-integrations.js'
import type { AuthorizeDeliveryAudience } from '../context-scope/delivery-authority.js'

export type ConfirmationPromptTarget = {
  workspaceId?: string
  /** Assistant whose channel credentials resolve the outbound adapter. */
  assistantId: string
  channelType: string
  channelId: string
  channelIntegrationId?: string
  /** Resolved native thread anchor, not a workflow fromStep expression. */
  threadRef?: string
}

export type ConfirmationPromptDeps = {
  integrationStore?: ChannelIntegrationStore
  defaultTelegramBotToken?: string
  waConnectorUrl?: string
  waConnectorSecret?: string
  customChannelStore?: Pick<CustomChannelStore, 'enqueue'>
  authorizeDeliveryAudience?: AuthorizeDeliveryAudience
  scopeEvidence?: import('@use-brian/core').ScopeEvidence
  userId?: string
}

/**
 * Resolve a Telegram bot token: BYO `channel_integrations` row first, then
 * the official shared Use Brian bot. `undefined` → neither is configured and
 * the caller falls through to persist-only.
 */
async function resolveTelegramDelivery(
  assistantId: string,
  deps: ConfirmationPromptDeps,
  channelIntegrationId?: string,
  channelId?: string,
  workspaceId?: string,
): Promise<{ token: string; integrationId: string } | undefined> {
  if (channelIntegrationId) {
    if (!deps.integrationStore || !channelId || !workspaceId) return undefined
    const integration = await deps.integrationStore.getCredentialsForAssistantIntegrationSystem(
      workspaceId,
      assistantId,
      channelIntegrationId,
      'telegram',
      channelId,
    )
    return integration
      ? { token: (integration.credentials as { bot_token: string }).bot_token, integrationId: integration.id }
      : undefined
  }
  if (deps.integrationStore) {
    const integration = await deps.integrationStore.getCredentialsForAssistantSystem(assistantId, 'telegram')
    if (integration) return { token: (integration.credentials as { bot_token: string }).bot_token, integrationId: integration.id }
  }
  return deps.defaultTelegramBotToken ? { token: deps.defaultTelegramBotToken, integrationId: SHARED_TELEGRAM_CONFIRMATION_INTEGRATION } : undefined
}
export async function resolveTelegramBotToken(...params: Parameters<typeof resolveTelegramDelivery>): Promise<string | undefined> {
  return (await resolveTelegramDelivery(...params))?.token
}

/**
 * Outcome of the outbound prompt. `delivered: false` means the user was never
 * asked, so the parked confirmation can only time out — `reason` is the
 * model-actionable account of that (what did not happen, why, the next step,
 * the retry verdict). Additive: callers that ignore it are unaffected.
 */
export type ConfirmationPromptResult = {
  delivered: boolean
  channelType: string
  reason?: string
}

/**
 * Frame a confirmation-prompt push failure. The user was asked NOTHING, so the
 * suspended tool call can only time out — that consequence is the part the raw
 * error can never carry. Slack's bare `{ ok: false, error: '<code>' }` is
 * translated by `describeSlackError` (diagnosis + next step + retry verdict);
 * every other channel passes through as its own message.
 * See docs/architecture/engine/tool-executor.md → "Failure copy".
 */
function promptFailure(
  err: unknown,
  target: ConfirmationPromptTarget,
  toolName: string,
): string {
  const head = `The confirmation prompt for \`${toolName}\` was NOT delivered to ${target.channelType} \`${target.channelId}\`, so the user was never asked.`
  const body = target.channelType === 'slack'
    ? `${describeSlackError(err)}${
        isSlackApiError(err)
          ? ''
          : ' Slack never answered this call (a network or adapter failure, not a Slack rejection): retry once before giving up.'
      }`
    : err instanceof Error ? err.message : String(err)
  return `${head} ${body} The parked tool call will now time out unanswered — do not wait on an approval that was never requested; tell the user what needs approving through a channel that works.`
}

/**
 * Send a tool-confirmation prompt to a user channel. Best-effort — a
 * delivery failure is logged and returned, never thrown (the confirmation
 * still times out gracefully if the prompt never lands).
 */
export async function sendConfirmationPrompt(
  target: ConfirmationPromptTarget,
  req: ToolConfirmationRequest,
  deps: ConfirmationPromptDeps,
): Promise<ConfirmationPromptResult> {
  const displayName = getToolDisplayName(req.toolName)
  const lines = req.displayLines && req.displayLines.length > 0
    ? req.displayLines
    : formatConfirmationInput(req.input)
  const inputSummary = lines.length > 0 ? '\n\n' + lines.join('\n') : ''
  const allowPersist = req.allowPersistentApproval ?? false

  // Authorize the resolved provider destination before binding a usable reply.
  // WhatsApp's notifications placeholder is not the audience that receives it.
  const authorize = async (channelId: string, channelIntegrationId = target.channelIntegrationId) => {
    if (deps.scopeEvidence === undefined) return
    const refusal = 'The confirmation prompt was not delivered because its destination audience could not be verified.'
    if (!deps.authorizeDeliveryAudience || !target.workspaceId || !deps.userId) throw new Error(refusal)
    const audience = await deps.authorizeDeliveryAudience({
      workspaceId: target.workspaceId, assistantId: target.assistantId, userId: deps.userId,
      channelType: target.channelType, channelId,
      // System transport sentinels bind replies, but are not integration UUIDs.
      channelIntegrationId: channelIntegrationId?.startsWith('system:') ? undefined : channelIntegrationId,
      scopeEvidence: deps.scopeEvidence,
    })
    if (!audience.allowed) throw new Error(refusal)
  }
  const integrationFor = async (channelType: 'slack' | 'feishu' | 'custom' | 'msteams' | 'whatsapp', channelId = target.channelId) => {
    if (!deps.integrationStore) return null
    if (target.channelIntegrationId) return target.workspaceId
      ? deps.integrationStore.getCredentialsForAssistantIntegrationSystem(target.workspaceId, target.assistantId, target.channelIntegrationId, channelType, channelId)
      : null
    return deps.integrationStore.getCredentialsForAssistantSystem(target.assistantId, channelType)
  }
  const push = async (adapter: Pick<ReturnType<typeof createTelegramAdapter>, 'sendMessage'>,
    channelId: string, message: Parameters<typeof adapter.sendMessage>[1], integrationId: string,
  ) => {
    await authorize(channelId, integrationId)
    const bind = (messageId?: string) => {
      if (target.workspaceId && integrationId) bindSchedulerConfirmationDelivery(req.toolCallId, {
        workspaceId: target.workspaceId, assistantId: target.assistantId, integrationId,
        channelType: target.channelType, channelId, threadId: target.threadRef, messageId,
      }, allowPersist)
    }
    bind()
    const messageId = target.threadRef
      ? await adapter.sendMessage(channelId, message, { threadTs: target.threadRef })
      : await adapter.sendMessage(channelId, message)
    if (typeof messageId === 'string' && messageId) bind(messageId)
  }

  try {
    if (target.channelType === 'telegram') {
      const telegram = await resolveTelegramDelivery(
        target.assistantId,
        deps,
        target.channelIntegrationId,
        target.channelId,
        target.workspaceId,
      )
      if (!telegram) {
        return {
          delivered: false,
          channelType: target.channelType,
          reason: `The confirmation prompt for \`${req.toolName}\` could not be sent: this assistant has no connected Telegram bot and no shared bot is configured, so chat \`${target.channelId}\` cannot be reached and the user was never asked. Connect Telegram for this assistant (Studio → Channels); the parked tool call will time out unanswered until then.`,
        }
      }
      {
        const adapter = createTelegramAdapter({ token: telegram.token, strictTopic: true })
        const actions = buildConfirmationActions(req.toolCallId, allowPersist)
        await push(adapter, target.channelId, {
          text: `${displayName}${inputSummary}\n\nAllow this action?`,
          actions,
        }, telegram.integrationId)
      }
    } else if (target.channelType === 'slack') {
      const integration = await integrationFor('slack')
      if (!integration) {
        return {
          delivered: false,
          channelType: target.channelType,
          reason: `The confirmation prompt for \`${req.toolName}\` could not be sent: this assistant has no connected Slack workspace, so channel \`${target.channelId}\` cannot be posted to and the user was never asked. Connect Slack for this assistant (Studio → Channels → Slack); the parked tool call will time out unanswered until then.`,
        }
      }
      {
        const adapter = createSlackAdapter({
          botToken: (integration.credentials as { bot_token: string }).bot_token,
          botUserId: integration.botUserId ?? undefined,
        })
        const replyHint = allowPersist
          ? 'Reply: yes / no / always / never'
          : 'Reply: yes / no'
        await push(adapter, target.channelId, {
          text: `${displayName}${inputSummary}\n\n${replyHint}`,
        }, integration.id)
      }
    } else if (target.channelType === 'feishu') {
      const integration = await integrationFor('feishu')
      if (!integration) {
        return {
          delivered: false,
          channelType: target.channelType,
          reason: `The confirmation prompt for \`${req.toolName}\` could not be sent: this assistant has no connected Feishu or Lark app, so chat \`${target.channelId}\` cannot be posted to and the user was never asked. Connect Feishu / Lark for this assistant in Studio; the parked tool call will time out unanswered until then.`,
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
      const actions = buildConfirmationActions(req.toolCallId, allowPersist)
      await push(adapter, target.channelId, {
        text: `${displayName}${inputSummary}\n\nAllow this action?`,
        actions,
      }, integration.id)
    } else if (target.channelType === 'custom') {
      if (!deps.integrationStore || !deps.customChannelStore || !target.workspaceId) {
        return {
          delivered: false,
          channelType: target.channelType,
          reason: `The confirmation prompt for \`${req.toolName}\` could not be sent: no custom-channel bridge integration is available, so \`${target.channelId}\` was never asked. The parked tool call will time out unanswered.`,
        }
      }
      const integration = await integrationFor('custom')
      if (!integration) {
        return {
          delivered: false,
          channelType: target.channelType,
          reason: `The confirmation prompt for \`${req.toolName}\` could not be sent: this assistant has no connected custom-channel bridge, so \`${target.channelId}\` was never asked. The parked tool call will time out unanswered.`,
        }
      }
      const replyHint = allowPersist
        ? 'Reply: yes / no / always / never'
        : 'Reply: yes / no'
      await push(createCustomAdapter({
        enqueue: (item) => deps.customChannelStore!.enqueue(integration.channelId, item),
      }), target.channelId, {
        text: `${displayName}${inputSummary}\n\n${replyHint}`,
      }, integration.id)
    } else if (target.channelType === 'msteams') {
      const integration = await integrationFor('msteams')
      const serviceUrl = integration?.config?.msteamsServiceUrl
      if (!integration || !serviceUrl) return { delivered: false, channelType: target.channelType, reason: 'No Teams integration/service URL is available.' }
      const credentials = integration.credentials as { app_id: string; app_password: string; tenant_id: string }
      await push(createMsTeamsAdapter({ appId: credentials.app_id, appPassword: credentials.app_password,
        tenantId: credentials.tenant_id, serviceUrl, botId: integration.botUserId ?? undefined }), target.channelId,
      { text: `${displayName}${inputSummary}\n\nAllow this action?`, actions: buildConfirmationActions(req.toolCallId, allowPersist) }, integration.id)
    } else if (target.channelType === 'whatsapp') {
      if (!deps.waConnectorUrl || !deps.waConnectorSecret) {
        return {
          delivered: false,
          channelType: target.channelType,
          reason: `The confirmation prompt for \`${req.toolName}\` could not be sent: no WhatsApp connector is configured for this deployment, so \`${target.channelId}\` cannot be reached and the user was never asked. The parked tool call will time out unanswered.`,
        }
      }
      let waChannelId = target.channelId
      if (waChannelId === 'notifications') {
        const actor = getSchedulerConfirmationActor(req.toolCallId)
        if (!actor) return { delivered: false, channelType: target.channelType, reason: 'No verified confirmation actor for WhatsApp recipient lookup.' }
        const waSession = await query<{ channel_id: string }>(
          `SELECT channel_id FROM sessions
           WHERE assistant_id = $1 AND user_id = $2 AND channel_type = 'whatsapp'
              AND channel_id LIKE '%@%'
           ORDER BY last_active_at DESC LIMIT 1`,
          [target.assistantId, actor],
        )
        if (waSession.rows[0]) {
          waChannelId = waSession.rows[0].channel_id
        }
      }
      if (!waChannelId.includes('@')) {
        return {
          delivered: false,
          channelType: target.channelType,
          reason: `The confirmation prompt for \`${req.toolName}\` could not be sent: \`${waChannelId}\` is not a WhatsApp JID (those look like \`15551234567@s.whatsapp.net\`) and no WhatsApp session for this assistant resolves one, so the user was never asked. The parked tool call will time out unanswered; this exact target will keep failing.`,
        }
      }
      {
        const integration = await integrationFor('whatsapp', waChannelId)
        if (target.channelIntegrationId && !integration) return { delivered: false, channelType: target.channelType, reason: 'Selected WhatsApp integration is unavailable.' }
        if (integration && (integration.credentials as { provider?: string }).provider === 'cloud_api') {
          return { delivered: false, channelType: target.channelType, reason: 'Proactive Cloud API confirmations require a supported template/window; no prompt was sent.' }
        }
        const adapter = createWhatsAppAdapter({
          connectorUrl: deps.waConnectorUrl,
          connectorSecret: deps.waConnectorSecret,
          connectionId: integration?.channelId ?? 'system',
        })
        const replyHint = allowPersist
          ? 'Reply: *allow* / *deny* / *always* / *never*'
          : 'Reply: *allow* / *deny*'
        await push(adapter, waChannelId, {
          text: `*${displayName}*${inputSummary}\n\nAllow this action?\n${replyHint}`,
        }, integration?.id ?? SYSTEM_WHATSAPP_CONFIRMATION_INTEGRATION)
      }
    }
    if (!['web', 'telegram', 'slack', 'feishu', 'custom', 'msteams', 'whatsapp'].includes(target.channelType)) {
      return { delivered: false, channelType: target.channelType, reason: 'Unsupported confirmation delivery channel.' }
    }
    // 'web' — persist-only; the user sees the confirmation on next visit.
    if (target.channelType === 'web') await authorize(target.channelId)
    return { delivered: true, channelType: target.channelType }
  } catch (err) {
    clearSchedulerConfirmationDelivery(req.toolCallId)
    const reason = promptFailure(err, target, req.toolName)
    console.error(`[confirmation-prompt] delivery failed for ${target.channelType}:`, reason)
    return { delivered: false, channelType: target.channelType, reason }
  }
}
