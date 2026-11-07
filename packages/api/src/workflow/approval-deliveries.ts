/**
 * Approval prompt deliveries — Phase C (Q4 §12).
 *
 * Dispatch a confirmation-style notification over the chosen channel.
 * Best-effort — the web Approvals panel is always a valid response surface
 * even when delivery fails.
 *
 * Channel cards mirror tool-confirmation UX: title + details + Allow/Deny
 * actions whose reply text is the existing `approve <id>` / `reject <id>`
 * command path. Personal web chat destinations receive the same card text
 * as an assistant message in the verified session.
 *
 * [COMP:channels/approval-deliveries]
 */

import type { DeliverToChannel } from '@use-brian/core'
import { query } from '../db/client.js'
import { addSessionMessage, findSessionById } from '../db/sessions.js'
import type { ApprovalDeliveryDispatcher } from './approval.js'

export type ApprovalDeliveryDeps = {
  deliverToChannel?: DeliverToChannel
  webBaseUrl: string
  /** Token for the official Use Brian Telegram bot. Optional — telegram delivery is skipped when absent. */
  telegramBotToken?: string
}

export function createApprovalDeliveryDispatcher(
  deps: ApprovalDeliveryDeps,
): ApprovalDeliveryDispatcher {
  return async (params) => {
    const deepLink = `${deps.webBaseUrl}/w/${params.workspaceId}/p?panel=approvals&approval=${params.approvalId}`
    const message = composeMessage(params, deepLink)
    const actions = confirmationActions(params.approvalId)

    // Verified personal web chat: post the confirmation card into that session.
    // The Approvals panel remains available; web inbox (`channelId: 'queue'`) stays a no-op push.
    const webSessionId =
      params.recentTarget?.channelType === 'web'
        ? params.recentTarget.channelId
        : params.deliveryChannelType === 'web' && params.deliveryChannelId && params.deliveryChannelId !== 'queue'
          ? params.deliveryChannelId
          : null
    if (webSessionId) {
      await deliverWebChat(params, webSessionId, message)
      return
    }

    if (params.deliveryChannelType === 'web') {
      // Web inbox — the Approvals panel surfaces the row independently.
      return
    }

    if (params.recentTarget) {
      if (!deps.deliverToChannel || !params.assistantId) return
      const outcome = await deps.deliverToChannel({
        ...params.recentTarget,
        workspaceId: params.workspaceId,
        assistantId: params.assistantId,
        userId: params.approverUserId,
        text: message,
        actions,
        // Public confirmation card text — still passes the destination-audience gate.
        scopeEvidence: { sensitivity: 'public', compartments: [], projectIds: [] },
      })
      if (outcome.status !== 'delivered') {
        console.warn(
          `[approval-deliveries] ${params.recentTarget.channelType} delivery ${outcome.status}; approval ${params.approvalId} relies on web UI`,
          outcome,
        )
      }
      return
    }

    if (params.deliveryChannelType === 'telegram') {
      if (!deps.telegramBotToken) {
        console.warn(
          `[approval-deliveries] telegram delivery skipped (no bot token configured) for approval ${params.approvalId}`,
        )
        return
      }
      const chatId = await resolveTelegramChatId(params.approverUserId)
      // The reply-to-approve fallback addresses the approver alone. A group
      // (negative chat id) is not the approver's audience.
      if (chatId?.startsWith('-')) {
        console.warn(
          `[approval-deliveries] latest telegram chat for approval ${params.approvalId} is a group; relying on web UI`,
        )
        return
      }
      if (!chatId) {
        console.warn(
          `[approval-deliveries] no telegram chat_id for user ${params.approverUserId}; approval ${params.approvalId} relies on web UI`,
        )
        return
      }
      await sendTelegramMessage(deps.telegramBotToken, chatId, message)
      return
    }

    // 'slack' / 'whatsapp' — stubs without a recentTarget. Wire up when product needs it.
    console.warn(
      `[approval-deliveries] ${params.deliveryChannelType} delivery not yet implemented; approval ${params.approvalId} relies on web UI`,
    )
  }
}

function shortId(approvalId: string): string {
  return approvalId.slice(0, 8)
}

function confirmationActions(approvalId: string) {
  const id = shortId(approvalId)
  return [
    { id: 'allow', label: 'Allow', data: `approval:${approvalId}:allow`, replyText: `approve ${id}` },
    { id: 'deny', label: 'Deny', data: `approval:${approvalId}:deny`, replyText: `reject ${id}` },
  ]
}

function composeMessage(
  params: Parameters<ApprovalDeliveryDispatcher>[0],
  deepLink: string,
): string {
  const id = shortId(params.approvalId)
  const title = params.prompt?.title?.trim()
    || (params.externalAction
      ? 'An external agent action needs your approval'
      : 'A workflow action needs your approval')
  const details = params.prompt?.details?.trim()
  const question = `Allow this action?\nReply: approve / deny`
  return [
    `**${title}**`,
    ...(details ? ['', details] : []),
    '',
    question,
    '',
    `Reply with \`approve ${id}\` or \`reject ${id}\`,`,
    `or open: ${deepLink}`,
  ].join('\n')
}

async function deliverWebChat(
  params: Parameters<ApprovalDeliveryDispatcher>[0],
  sessionId: string,
  text: string,
): Promise<void> {
  if (!params.assistantId) return
  const session = await findSessionById(sessionId)
  if (!session
    || session.assistantId !== params.assistantId
    || session.userId !== params.approverUserId
    || session.channelType !== 'web') {
    console.warn(
      `[approval-deliveries] web chat session ${sessionId} unavailable for approval ${params.approvalId}; relying on web UI`,
    )
    return
  }
  try {
    await addSessionMessage({
      sessionId: session.id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      senderAssistantId: params.assistantId,
    })
  } catch (err) {
    console.warn(`[approval-deliveries] web chat delivery failed for approval ${params.approvalId}:`, err)
  }
}

async function resolveTelegramChatId(userId: string): Promise<string | null> {
  const result = await query<{ chatId: string }>(
    `SELECT channel_id AS "chatId" FROM channel_routes
     WHERE user_id = $1 AND channel_type = 'telegram'
     ORDER BY last_seen_at DESC NULLS LAST
     LIMIT 1`,
    [userId],
  )
  return result.rows[0]?.chatId ?? null
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '<no body>')
      console.warn(`[approval-deliveries] telegram sendMessage ${res.status}: ${detail}`)
    }
  } catch (err) {
    console.warn(`[approval-deliveries] telegram sendMessage failed:`, err)
  }
}
