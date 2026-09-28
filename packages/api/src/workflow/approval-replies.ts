/**
 * Inbound channel reply handler — Phase C (Q4 §12).
 *
 * Recognizes `approve <id8>` / `reject <id8> [reason]` (case-insensitive)
 * in any chat-channel inbound message. When matched, resolves the short
 * id back to a `pending_approvals` row, verifies the approver matches,
 * and dispatches to the same `resumeFromApproval` path the route uses.
 *
 * Intended for the shared inbound interceptor before routes
 * forward the message to the chat pipeline. A matched reply short-
 * circuits — the model never sees the "approve" message.
 *
 * Returns null when the message is not a recognizable approval reply,
 * so the caller can continue with normal chat-pipeline handling.
 *
 * [COMP:channels/approval-replies]
 */

import { query } from '../db/client.js'
import type { PendingApprovalsStore } from '../db/pending-approvals-store.js'
import { resumeFromApproval, type ApprovalBridgeDeps } from './approval.js'

const APPROVE_RE = /^\s*(approve|reject)\s+([a-f0-9-]{6,})(?:\s+([\s\S]*))?\s*$/i

export type ApprovalReplyMatch = {
  decision: 'approved' | 'rejected'
  approvalId: string
  reason?: string
  status: string
  runId: string | null
}

export async function maybeHandleApprovalReply(
  deps: {
    approvalsStore: PendingApprovalsStore
    bridgeDeps: ApprovalBridgeDeps
  },
  userId: string,
  text: string,
  scope?: { workspaceId: string; assistantId: string; authorized: () => Promise<boolean>; abortSignal?: AbortSignal },
): Promise<ApprovalReplyMatch | null> {
  const match = text.match(APPROVE_RE)
  if (!match) return null
  const decision = match[1].toLowerCase() === 'approve' ? 'approved' : 'rejected'
  const idPrefix = match[2].toLowerCase()
  const reason = match[3]?.trim() || undefined

  const unavailable = (status = 'unavailable'): ApprovalReplyMatch => ({
    decision, approvalId: idPrefix, reason, status, runId: null,
  })
  if (scope?.abortSignal?.aborted) return unavailable('cancelled')
  if (scope && !await scope.authorized()) return unavailable()
  if (scope?.abortSignal?.aborted) return unavailable('cancelled')

  // Resolve the short id prefix to a full approval id, but only among
  // rows the user is the assigned approver for + still pending.
  const result = await query<{ id: string }>(
    `SELECT id FROM pending_approvals
     WHERE approver_user_id = $1
       AND status = 'pending'
       AND kind = 'workflow_step'
       AND (expires_at IS NULL OR expires_at > now())
       AND ($3::uuid IS NULL OR workspace_id = $3)
       AND ($4::uuid IS NULL OR originating_assistant_id = $4)
       AND id::text LIKE $2 || '%'
     ORDER BY created_at DESC
     LIMIT 2`,
    [userId, idPrefix, scope?.workspaceId ?? null, scope?.assistantId ?? null],
  )
  // A recognized command is always consumed, including stale/foreign IDs.
  if (result.rows.length !== 1) return unavailable()

  if (scope?.abortSignal?.aborted) return unavailable('cancelled')
  const approvalId = result.rows[0].id
  const outcome = await resumeFromApproval(deps.bridgeDeps, approvalId, decision, userId, reason)
  return {
    decision,
    approvalId,
    reason,
    status: outcome.status,
    runId: outcome.runId,
  }
}
