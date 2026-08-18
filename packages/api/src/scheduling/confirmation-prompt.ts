/**
 * Confirmation-prompt delivery for deferred tool confirmations.
 *
 * Lifted from the legacy scheduled-job executor at the Phase 2 cutover. A
 * scheduled job's workflow `assistant_call` step runs in the callee executor
 * (`packages/api/src/inter-assistant/executor.ts`); when its inner query loop
 * hits an `ask`-policy MCP tool, the callee parks the confirmation and calls
 * this to prompt the user on the step's `deliver` channel — inline buttons
 * (Telegram), keyword instructions (Slack/WhatsApp), or persist-only (web).
 *
 * The user's reply reaches the suspended resolver through the shared
 * in-memory registry (`confirmation-registry.ts`); this module only sends
 * the outbound prompt.
 *
 * See docs/architecture/engine/scheduled-jobs.md → "Deferred confirmations".
 * Component tag: [COMP:scheduling/confirmation-prompt].
 */

import type { ToolConfirmationRequest } from '@use-brian/core'
import {
  createSlackAdapter,
  createTelegramAdapter,
  createWhatsAppAdapter,
  describeSlackError,
  isSlackApiError,
} from '@use-brian/channels'
import { getToolDisplayName, formatConfirmationInput } from '@use-brian/shared'
import { query } from '../db/client.js'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'

export type ConfirmationPromptTarget = {
  workspaceId?: string
  /** Assistant whose channel credentials resolve the outbound adapter. */
  assistantId: string
  channelType: string
  channelId: string
  channelIntegrationId?: string
}

export type ConfirmationPromptDeps = {
  integrationStore?: ChannelIntegrationStore
  defaultTelegramBotToken?: string
  waConnectorUrl?: string
  waConnectorSecret?: string
}

/**
 * Resolve a Telegram bot token: BYO `channel_integrations` row first, then
 * the official shared Use Brian bot. `undefined` → neither is configured and
 * the caller falls through to persist-only.
 */
export async function resolveTelegramBotToken(
  assistantId: string,
  deps: ConfirmationPromptDeps,
  channelIntegrationId?: string,
  channelId?: string,
  workspaceId?: string,
): Promise<string | undefined> {
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
      ? (integration.credentials as { bot_token: string }).bot_token
      : undefined
  }
  if (deps.integrationStore) {
    const integration = await deps.integrationStore.getCredentialsForAssistantSystem(assistantId, 'telegram')
    if (integration) return (integration.credentials as { bot_token: string }).bot_token
  }
  return deps.defaultTelegramBotToken
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

  try {
    if (target.channelType === 'telegram') {
      const botToken = await resolveTelegramBotToken(
        target.assistantId,
        deps,
        target.channelIntegrationId,
        target.channelId,
        target.workspaceId,
      )
      if (!botToken) {
        return {
          delivered: false,
          channelType: target.channelType,
          reason: `The confirmation prompt for \`${req.toolName}\` could not be sent: this assistant has no connected Telegram bot and no shared bot is configured, so chat \`${target.channelId}\` cannot be reached and the user was never asked. Connect Telegram for this assistant (Studio → Channels); the parked tool call will time out unanswered until then.`,
        }
      }
      {
        const adapter = createTelegramAdapter({ token: botToken })
        const actions = [
          { id: 'allow', label: 'Allow', data: `mcp_confirm:${req.toolCallId}:allow` },
          { id: 'deny', label: 'Deny', data: `mcp_confirm:${req.toolCallId}:deny` },
        ]
        if (allowPersist) {
          actions.push(
            { id: 'always', label: 'Always Allow', data: `mcp_confirm:${req.toolCallId}:always_allow` },
            { id: 'never', label: 'Always Deny', data: `mcp_confirm:${req.toolCallId}:always_deny` },
          )
        }
        await adapter.sendMessage(target.channelId, {
          text: `${displayName}${inputSummary}\n\nAllow this action?`,
          actions,
        })
      }
    } else if (target.channelType === 'slack') {
      const integration = deps.integrationStore
        ? await deps.integrationStore.getCredentialsForAssistantSystem(
            target.assistantId,
            'slack',
          )
        : null
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
        await adapter.sendMessage(target.channelId, {
          text: `${displayName}${inputSummary}\n\n${replyHint}`,
        })
      }
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
        const waSession = await query<{ channel_id: string }>(
          `SELECT channel_id FROM sessions
           WHERE assistant_id = $1 AND channel_type = 'whatsapp'
              AND channel_id LIKE '%@%'
           ORDER BY last_active_at DESC LIMIT 1`,
          [target.assistantId],
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
        const adapter = createWhatsAppAdapter({
          connectorUrl: deps.waConnectorUrl,
          connectorSecret: deps.waConnectorSecret,
          connectionId: 'system',
        })
        const replyHint = allowPersist
          ? 'Reply: *allow* / *deny* / *always* / *never*'
          : 'Reply: *allow* / *deny*'
        await adapter.sendMessage(waChannelId, {
          text: `*${displayName}*${inputSummary}\n\nAllow this action?\n${replyHint}`,
        })
      }
    }
    // 'web' — persist-only; the user sees the confirmation on next visit.
    return { delivered: true, channelType: target.channelType }
  } catch (err) {
    const reason = promptFailure(err, target, req.toolName)
    console.error(`[confirmation-prompt] delivery failed for ${target.channelType}:`, reason)
    return { delivered: false, channelType: target.channelType, reason }
  }
}
