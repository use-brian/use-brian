/**
 * Shared pending-message context builder for all channels.
 *
 * Fetches pending inter-assistant messages (approvals + responses),
 * builds system prompt injections, and marks messages as delivered.
 * Used by chat, telegram, slack, and whatsapp routes.
 *
 * See docs/plans/inter-assistant-communication.md.
 */

import type { PendingMessageStore } from '../db/pending-message-store.js'

export type PendingContextResult = {
  /** System prompt fragment to append (empty string if nothing pending). */
  promptFragment: string
  /** Number of pending approval requests found. */
  approvalCount: number
  /** Number of async responses found. */
  responseCount: number
}

/**
 * Build system prompt context for pending inter-assistant messages.
 *
 * Approvals are surfaced as a soft suggestion — the assistant should mention
 * them naturally if it fits the conversation, not force them on the user.
 * The user can say "check", "show", "review", or "approve" to enter the
 * structured review flow (handled per-channel).
 *
 * Responses are always relayed since the user explicitly requested them.
 */
export async function buildPendingContext(
  store: PendingMessageStore,
  userId: string,
  assistantId: string,
  channelType: 'web' | 'telegram' | 'slack' | 'whatsapp' | 'discord',
): Promise<PendingContextResult> {
  const pendingMessages = await store.getPendingForDelivery(userId, assistantId)
  if (pendingMessages.length === 0) {
    return { promptFragment: '', approvalCount: 0, responseCount: 0 }
  }

  const approvals = pendingMessages.filter((m) => m.messageType === 'ask_confirmation')
  const responses = pendingMessages.filter((m) => m.messageType === 'async_response')

  let promptFragment = ''

  // ── Approvals: soft suggestion ──
  if (approvals.length > 0) {
    const approvalSummaries = approvals.map((m) => {
      const payload = m.payload as { question?: string; draftResponse?: string }
      return `- ${m.sourceAssistantName ?? 'An assistant'} (${m.sourceOwnerHandle ?? 'unknown'}) is requesting access to your ${m.category ?? 'data'}. Question: "${payload.question ?? '(no question)'}". Message ID: ${m.id}`
    }).join('\n')

    if (channelType === 'web') {
      // Web has a reviewDataRequest tool with built-in UI — the assistant can
      // call it directly once the user acknowledges.
      promptFragment += `\n\n# Pending Data Requests\n\nYou have ${approvals.length} pending data request(s) from other assistants:\n\n${approvalSummaries}\n\nMention this naturally if it fits the conversation (e.g. "by the way, you have ${approvals.length} pending request${approvals.length > 1 ? 's' : ''} — would you like to review ${approvals.length > 1 ? 'them' : 'it'}?"). If your user is talking about something else, respond to their message first and mention the requests casually at the end. When they want to review, call reviewDataRequest for each request to show the approve/reject UI.`
    } else {
      // Messaging channels — the assistant mentions it and the user can say
      // "check" / "show" / "approve" to enter the per-channel approval flow.
      promptFragment += `\n\n# Pending Data Requests\n\nYou have ${approvals.length} pending data request(s) from other assistants:\n\n${approvalSummaries}\n\nMention this naturally if it fits the conversation (e.g. "by the way, you have ${approvals.length} pending request${approvals.length > 1 ? 's' : ''} — would you like to review ${approvals.length > 1 ? 'them' : 'it'}?"). If your user is talking about something else, respond to their message first and mention the requests casually at the end. When they confirm, call reviewDataRequest with action="approve" or action="reject". Do NOT call the tool until the user explicitly says yes or no.`
    }
  }

  // ── Responses: always relay ──
  if (responses.length > 0) {
    const responseSummaries = responses.map((m) => {
      const payload = m.payload as { question?: string; response?: string }
      return `- ${m.sourceAssistantName ?? 'An assistant'} (${m.sourceOwnerHandle ?? 'unknown'}) responded to your ${m.category ?? 'data'} request: "${(payload.response ?? '(no response)').slice(0, 200)}"`
    }).join('\n')
    promptFragment += `\n\n# Received Responses\n\nYou received ${responses.length} response(s) from other assistants:\n\n${responseSummaries}\n\nRelay these to your user.`
  }

  // ── Mark delivered/resolved ──
  await Promise.all(
    pendingMessages.map((m) =>
      m.messageType === 'async_response'
        ? store.resolve(userId, m.id, 'approved')
        : store.markDelivered(m.id)
    ),
  )

  return {
    promptFragment,
    approvalCount: approvals.length,
    responseCount: responses.length,
  }
}
