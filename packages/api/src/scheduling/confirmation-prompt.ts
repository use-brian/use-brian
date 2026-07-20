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
import { createSlackAdapter, createTelegramAdapter, createWhatsAppAdapter } from '@use-brian/channels'
import { getToolDisplayName, formatConfirmationInput } from '@use-brian/shared'
import { query } from '../db/client.js'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'

export type ConfirmationPromptTarget = {
  /** Assistant whose channel credentials resolve the outbound adapter. */
  assistantId: string
  channelType: string
  channelId: string
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
): Promise<string | undefined> {
  if (deps.integrationStore) {
    const integration = await deps.integrationStore.getCredentialsForAssistantSystem(
      assistantId,
      'telegram',
    )
    if (integration) {
      return (integration.credentials as { bot_token: string }).bot_token
    }
  }
  return deps.defaultTelegramBotToken
}

/**
 * Send a tool-confirmation prompt to a user channel. Best-effort — a
 * delivery failure is logged, never thrown (the confirmation still times
 * out gracefully if the prompt never lands).
 */
export async function sendConfirmationPrompt(
  target: ConfirmationPromptTarget,
  req: ToolConfirmationRequest,
  deps: ConfirmationPromptDeps,
): Promise<void> {
  const displayName = getToolDisplayName(req.toolName)
  const lines = req.displayLines && req.displayLines.length > 0
    ? req.displayLines
    : formatConfirmationInput(req.input)
  const inputSummary = lines.length > 0 ? '\n\n' + lines.join('\n') : ''
  const allowPersist = req.allowPersistentApproval ?? false

  try {
    if (target.channelType === 'telegram') {
      const botToken = await resolveTelegramBotToken(target.assistantId, deps)
      if (botToken) {
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
    } else if (target.channelType === 'slack' && deps.integrationStore) {
      const integration = await deps.integrationStore.getCredentialsForAssistantSystem(
        target.assistantId,
        'slack',
      )
      if (integration) {
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
    } else if (target.channelType === 'whatsapp' && deps.waConnectorUrl && deps.waConnectorSecret) {
      let waChannelId = target.channelId
      if (!waChannelId.includes('@')) {
        const waSession = await query<{ channel_id: string }>(
          `SELECT channel_id FROM sessions
           WHERE assistant_id = $1 AND channel_type = 'whatsapp'
             AND channel_id != 'notifications'
           ORDER BY last_active_at DESC LIMIT 1`,
          [target.assistantId],
        )
        if (waSession.rows[0]) {
          waChannelId = waSession.rows[0].channel_id
        }
      }
      if (waChannelId.includes('@')) {
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
  } catch (err) {
    console.error(`[confirmation-prompt] delivery failed for ${target.channelType}:`, err)
  }
}
