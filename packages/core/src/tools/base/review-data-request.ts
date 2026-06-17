/**
 * Review data request tool — surfaces pending inter-assistant
 * data access requests as atomic confirmations.
 *
 * On web: uses the confirmation UI (approve/deny buttons).
 * On messaging channels (Telegram/Slack): executes directly —
 * the assistant handles approval conversationally.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'

export type ReviewDataRequestDeps = {
  /** Get pending ask_confirmation messages for this assistant. */
  getPendingRequests: (assistantId: string) => Promise<Array<{
    id: string
    sourceAssistantName?: string
    sourceOwnerHandle?: string
    category: string | null
    payload: { question?: string; draftResponse?: string }
  }>>
  /** Resolve a pending message (approve/reject). */
  resolveRequest: (messageId: string, decision: 'approved' | 'rejected') => Promise<void>
}

export function createReviewDataRequestTool(deps: ReviewDataRequestDeps): Tool {
  return buildTool({
    name: 'reviewDataRequest',
    description:
      'Review a pending data access request from another assistant. On web, this shows an approve/reject UI. On messaging channels, the assistant should describe the request and confirm the user wants to approve before calling this tool with action="approve".',
    inputSchema: z.object({
      messageId: z.string().describe('The pending message ID to review'),
      action: z.enum(['approve', 'reject']).describe('Whether to approve or reject the request'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,

    // Always require atomic user confirmation for data request approvals.
    // Every channel supports this: web/notification show buttons,
    // Telegram shows inline keyboards, Slack/WhatsApp use keyword matching.
    resolveConfirmation: async () => true,

    async execute(input, _context) {
      try {
        await deps.resolveRequest(input.messageId, input.action === 'approve' ? 'approved' : 'rejected')
        return {
          data: input.action === 'approve'
            ? 'Request approved. The response has been sent to the requesting assistant.'
            : 'Request rejected.',
        }
      } catch (err) {
        return { data: `Failed to ${input.action} request: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })
}
