import { externalApprovals, ExternalApprovalError } from '../external-approvals/service.js'
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

import { externalAnswerSchema } from '../external-approvals/contracts.js'
import { canReadExternalApproval } from '../external-approvals/sql-store.js'
import { query } from '../db/client.js'
import type { PendingApprovalsStore } from '../db/pending-approvals-store.js'
import { resumeFromApproval, type ApprovalBridgeDeps } from './approval.js'

const APPROVE_RE = /^\s*(approve|reject)\s+([a-f0-9-]{6,})(?:\s+([\s\S]*))?\s*$/i

// Consume exactly one command separator; everything after it is literal answer text.
const ANSWER_RE = /^\s*answer\s+([a-f0-9-]{6,})(?:\s([\s\S]*))?$/i

export type ApprovalReplyMatch = {
  decision: 'approved' | 'rejected' | 'answered'
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
  scope?: { workspaceId: string; assistantId: string; channelId?: string; channelIntegrationId?: string; threadRef?: string; providerUserId?: string; authorized: () => Promise<boolean>; abortSignal?: AbortSignal },
): Promise<ApprovalReplyMatch | null> {
  const match = text.match(APPROVE_RE)
  const question = text.match(ANSWER_RE)
  if (!match && !question) return null
  const decision = question ? 'answered' : match![1].toLowerCase() === 'approve' ? 'approved' : 'rejected'
  const idPrefix = (question?.[1] ?? match![2]).toLowerCase()
  const answer = question?.[2]
  const reason = question ? undefined : match![3]?.trim() || undefined

  const unavailable = (status = 'unavailable'): ApprovalReplyMatch => ({
    decision, approvalId: idPrefix, reason, status, runId: null,
  })
  if (question && !externalAnswerSchema.safeParse(answer).success) return unavailable()
  if (scope?.abortSignal?.aborted) return unavailable('cancelled')
  if (scope && !await scope.authorized()) return unavailable()
  if (scope?.abortSignal?.aborted) return unavailable('cancelled')

  // Native rows remain assigned. External rows require an exact live channel
  // scope, then current member authority before prefix collision detection.
  const result = await query<{ id: string; kind?: string }>(
    `SELECT id, kind FROM pending_approvals
     WHERE ((kind = 'workflow_step' AND approver_user_id = $1 AND ${question ? 'false' : 'true'})
         OR (kind = 'external_action' AND $3::uuid IS NOT NULL AND $4::uuid IS NOT NULL
           AND delivery_channel_id = $5 AND $5::text IS NOT NULL
           AND $6::text IS NOT NULL AND EXISTS (
             SELECT 1 FROM external_approval_requests e
             JOIN workspace_external_approval_sources s ON s.id::text = e.source_id
             WHERE e.approval_id = pending_approvals.id AND s.revoked_at IS NULL
               AND (e.immutable_input->'request'->>'method'='question') IS ${question ? 'TRUE' : 'NOT TRUE'}
               AND s.channel_id = $5 AND s.channel_integration_id::text = $6
               AND (s.audience IS DISTINCT FROM 'conversation_members' OR s.thread_ref IS NOT DISTINCT FROM $7::text))))
       AND status = 'pending'
       AND kind IN ('workflow_step', 'external_action')
       AND (expires_at IS NULL OR expires_at > now())
       AND ($3::uuid IS NULL OR workspace_id = $3)
       AND ($4::uuid IS NULL OR originating_assistant_id = $4)
       AND id::text LIKE $2 || '%'
     ORDER BY created_at DESC`,
    [userId, idPrefix, scope?.workspaceId ?? null, scope?.assistantId ?? null, scope?.channelId ?? null, scope?.channelIntegrationId ?? null, scope?.threadRef ?? null],
  )
  // A recognized command is always consumed, including stale/foreign IDs.
  const candidates = []
  for (const row of result.rows) {
    if (question && row.kind !== 'external_action') continue
    if (row.kind !== 'external_action' || (scope?.channelId && scope.channelIntegrationId
      && await canReadExternalApproval(userId, row.id))) candidates.push(row)
  }
  if (candidates.length !== 1) return unavailable()

  if (scope?.abortSignal?.aborted) return unavailable('cancelled')
  const approvalId = candidates[0].id
  if (candidates[0].kind === 'external_action') {
    if (!scope || !await scope.authorized()) return unavailable()
    if (scope?.abortSignal?.aborted) return unavailable('cancelled')
    try {
      const actor = { userId, human: true, origin: 'channel' as const, channelId: scope.channelId, channelIntegrationId: scope.channelIntegrationId, threadRef: scope.threadRef, providerUserId: scope.providerUserId }
      const state = decision === 'answered'
        ? await externalApprovals().answer(approvalId, answer!, actor)
        : await externalApprovals().resolve(approvalId, decision, actor)
      if (decision === 'answered' && (state.status !== 'answered' || state.answer !== answer)) return unavailable()
      return { decision, approvalId, reason, status: state.status, runId: null }
    } catch (error) {
      if (error instanceof ExternalApprovalError) return unavailable()
      throw error
    }
  }
  if (decision === 'answered') return unavailable()
  const outcome = await resumeFromApproval(deps.bridgeDeps, approvalId, decision, userId, reason, scope?.abortSignal)
  return {
    decision,
    approvalId,
    reason,
    status: outcome.status,
    runId: outcome.runId,
  }
}
