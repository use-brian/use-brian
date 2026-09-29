/**
 * Approval prompt deliveries — Phase C (Q4 §12).
 *
 * Dispatch a short notification + deep-link / reply-instruction message
 * over the chosen channel. Best-effort — the web UI is always a valid
 * response surface even when delivery fails.
 *
 * V1 implements:
 *   - 'web'      → no-op (UI surfaces the row independently)
 *   - 'telegram' → looks up the user's preferred Telegram chat_id and
 *                  sends a one-message prompt via the official bot
 *
 * 'slack' and 'whatsapp' are stubbed with a console.warn — same shape
 * as the existing channel adapters, plug in when those audiences need it.
 *
 * [COMP:channels/approval-deliveries]
 */

import type { DeliverToChannel } from '@use-brian/core'
import { query } from '../db/client.js'
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
    if (params.deliveryChannelType === 'web') {
      // Web UI is always available; no push needed.
      return
    }

    const deepLink = `${deps.webBaseUrl}/w/${params.workspaceId}/approvals?focus=${params.approvalId}`

    if (params.recentTarget) {
      if (!deps.deliverToChannel || !params.assistantId) return
      const outcome = await deps.deliverToChannel({
        ...params.recentTarget,
        workspaceId: params.workspaceId,
        assistantId: params.assistantId,
        userId: params.approverUserId,
        text: composeMessage(params, deepLink),
        // The pushed text carries no run content (see composeMessage), so it
        // is public - and still passes the destination-audience gate rather
        // than skipping it as an evidence-less caller would.
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
      const message = composeMessage(params, deepLink)
      await sendTelegramMessage(deps.telegramBotToken, chatId, message)
      return
    }

    // 'slack' / 'whatsapp' — stubs. Wire up when product needs it.
    console.warn(
      `[approval-deliveries] ${params.deliveryChannelType} delivery not yet implemented; approval ${params.approvalId} relies on web UI`,
    )
  }
}

function composeMessage(
  params: Parameters<ApprovalDeliveryDispatcher>[0],
  deepLink: string,
): string {
  // Tool arguments are run content derived under the run's scope, and a push
  // destination is chosen by recency, not by who may read that scope. They
  // stay on the authorized web page this message links to.
  return [
    `🔐 *${params.workflowName}* asks to run \`${params.toolName}\`.`,
    ``,
    ...(params.recentTarget ? [`Approve or reject on the web: ${deepLink}`] : [
      `Reply with \`approve ${params.approvalId.slice(0, 8)}\` or \`reject ${params.approvalId.slice(0, 8)}\`,`,
      `or open: ${deepLink}`,
    ]),
  ].join('\n')
}

async function resolveTelegramChatId(userId: string): Promise<string | null> {
  // The user's most-recently-active Telegram channel route (the existing
  // table where we resolve preferred channels for scheduled-job delivery).
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
