/**
 * Chat attention and request inspection (D41, A09, A12).
 *
 * Attention items are DERIVED from native state, never a parallel queue:
 * pending requests waiting on the viewer (with reviewer and last attempt),
 * recent decisions a reviewer made on the viewer's behalf, and open route
 * blockers. Every item passes the same source predicate as the approvals
 * queue (`getById` / RLS); resolving the request removes it; seen state only
 * quiets the badge. No timer, reminder or outbound send.
 *
 * Spec: docs/architecture/features/approval-review.md → "Surfaces"
 *
 * [COMP:api/approval-review-resolution]
 */
import { getPool, queryWithRLS } from '../db/client.js'
import { createPendingApprovalsStore, type PendingApproval } from '../db/pending-approvals-store.js'
import {
  getReceiptForViewer,
  latestAttemptsForViewer,
  listAttentionSeen,
  listOpenRouteBlockersForViewer,
  markAttentionSeen,
  type ReviewAttempt,
} from '../db/approval-review-store.js'
import { loadRequestFacts } from './source.js'
import { effectiveAssignmentFor } from './patterns.js'
import { checkReview } from './resolution.js'
import { workspaceRole, type ReviewActor } from './common.js'
import { ApprovalReviewError } from './errors.js'

export type AttentionReview = {
  assignmentId: string
  reviewerAssistantId: string
  reviewerName: string | null
  lastAttempt: { outcome: ReviewAttempt['outcome']; reasons: string[]; at: string } | null
} | null

export type AttentionItem =
  | { key: string; kind: 'approval_waiting'; approvalId: string; approvalKind: string; toolName: string | null; summary: string | null
      createdAt: string; sessionId: string | null; workflowRunId: string | null; projectIds: string[]; review: AttentionReview; seen: boolean }
  | { key: string; kind: 'delegated_decision'; approvalId: string; receiptId: string; reviewerAssistantId: string; reviewerName: string | null
      toolName: string | null; decidedAt: string; invalidated: boolean; sessionId: string | null; projectIds: string[]; seen: boolean }
  | { key: string; kind: 'route_blocker'; eventId: string; workflowId: string; blocker: string; createdAt: string; projectIds: string[]; seen: boolean }

async function assistantNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const r = await getPool().query<{ id: string; name: string }>('SELECT id, name FROM assistants WHERE id = ANY($1::uuid[])', [ids])
  return new Map(r.rows.map((x) => [x.id, x.name]))
}

function summaryOf(a: PendingApproval): string | null {
  const lines = a.approvalPayload.displayLines
  if (Array.isArray(lines) && typeof lines[0] === 'string') return lines[0].slice(0, 200)
  if (typeof a.approvalPayload.description === 'string') return a.approvalPayload.description.slice(0, 200)
  if (typeof a.approvalPayload.label === 'string') return a.approvalPayload.label.slice(0, 200)
  return null
}

export async function listAttention(actor: ReviewActor, workspaceId: string, filter: { sessionId?: string | null; projectId?: string | null } = {}) {
  if (!await workspaceRole(actor.userId, workspaceId)) throw new ApprovalReviewError('not_found', 404, 'Not found')
  const store = createPendingApprovalsStore()
  const seen = await listAttentionSeen(actor.userId, workspaceId)
  const pending = (await store.listPendingForWorkspace(actor.userId, workspaceId))
    .filter((a) => a.approverUserId === actor.userId && a.kind !== 'department_access').slice(0, 100)
  const attempts = await latestAttemptsForViewer(actor.userId, pending.map((a) => a.id))
  const items: AttentionItem[] = []
  const reviewers: string[] = []
  for (const a of pending) {
    const facts = await loadRequestFacts(a)
    const assignment = await effectiveAssignmentFor(facts)
    if (assignment) reviewers.push(assignment.reviewerAssistantId)
    const attempt = attempts.get(a.id)
    items.push({
      key: `approval:${a.id}`, kind: 'approval_waiting', approvalId: a.id, approvalKind: a.kind, toolName: a.toolName ?? null,
      summary: summaryOf(a), createdAt: a.createdAt.toISOString(), sessionId: a.blockingSessionId, workflowRunId: a.workflowRunId ?? null,
      projectIds: facts.projectIds, seen: seen.has(`approval:${a.id}`),
      review: assignment ? {
        assignmentId: assignment.id, reviewerAssistantId: assignment.reviewerAssistantId, reviewerName: null,
        lastAttempt: attempt ? { outcome: attempt.outcome, reasons: attempt.reasons, at: attempt.createdAt.toISOString() } : null,
      } : null,
    })
  }
  // Decisions a reviewer made on this person's behalf in the last week.
  const recent = await queryWithRLS<{ approval_id: string; id: string; reviewer_assistant_id: string; created_at: Date; invalidated_at: Date | null }>(actor.userId,
    `SELECT r.approval_id, r.id, r.reviewer_assistant_id, r.created_at, r.invalidated_at
     FROM approval_delegated_resolutions r JOIN pending_approvals p ON p.id = r.approval_id
     WHERE r.workspace_id = $1 AND p.approver_user_id = $2 AND r.created_at > now() - interval '7 days'
     ORDER BY r.created_at DESC LIMIT 50`, [workspaceId, actor.userId])
  for (const r of recent.rows) {
    const a = await store.getById(actor.userId, r.approval_id)
    if (!a) continue
    const facts = await loadRequestFacts(a)
    reviewers.push(r.reviewer_assistant_id)
    items.push({
      key: `decision:${r.id}`, kind: 'delegated_decision', approvalId: a.id, receiptId: r.id, reviewerAssistantId: r.reviewer_assistant_id,
      reviewerName: null, toolName: a.toolName ?? null, decidedAt: r.created_at.toISOString(), invalidated: r.invalidated_at !== null,
      sessionId: a.blockingSessionId, projectIds: facts.projectIds, seen: seen.has(`decision:${r.id}`),
    })
  }
  for (const e of await listOpenRouteBlockersForViewer(actor.userId, workspaceId)) {
    const wf = (await getPool().query<{ context_project_id: string | null }>('SELECT context_project_id FROM workflows WHERE id = $1', [e.workflowId])).rows[0]
    items.push({
      key: `route:${e.id}`, kind: 'route_blocker', eventId: e.id, workflowId: e.workflowId, blocker: e.blocker ?? 'unknown',
      createdAt: e.createdAt.toISOString(), projectIds: wf?.context_project_id ? [wf.context_project_id] : [], seen: seen.has(`route:${e.id}`),
    })
  }
  const names = await assistantNames([...new Set(reviewers)])
  for (const item of items) {
    if (item.kind === 'approval_waiting' && item.review) item.review.reviewerName = names.get(item.review.reviewerAssistantId) ?? null
    if (item.kind === 'delegated_decision') item.reviewerName = names.get(item.reviewerAssistantId) ?? null
  }
  const scoped = items.filter((item) => {
    if (filter.projectId) return item.projectIds.includes(filter.projectId)
    if (filter.sessionId) return 'sessionId' in item && item.sessionId === filter.sessionId
    return true
  })
  return { items: scoped, unseen: scoped.filter((i) => !i.seen).length }
}

export async function markSeen(actor: ReviewActor, workspaceId: string, keys: string[]) {
  if (!await workspaceRole(actor.userId, workspaceId)) throw new ApprovalReviewError('not_found', 404, 'Not found')
  const valid = keys.filter((k) => /^(approval|decision|route):[0-9a-f-]{36}$/.test(k)).slice(0, 200)
  await markAttentionSeen(actor.userId, workspaceId, valid)
  return { marked: valid.length }
}

/** Request inspection: native state, effective reviewer, receipt and a dry-run explanation. */
export async function inspectRequest(actor: ReviewActor, workspaceId: string, approvalId: string) {
  const store = createPendingApprovalsStore()
  const approval = await store.getById(actor.userId, approvalId)
  if (!approval || approval.workspaceId !== workspaceId) throw new ApprovalReviewError('not_found', 404, 'Not found')
  const facts = await loadRequestFacts(approval)
  const assignment = await effectiveAssignmentFor(facts)
  const receipt = await getReceiptForViewer(actor.userId, approvalId)
  const attempt = (await latestAttemptsForViewer(actor.userId, [approvalId])).get(approvalId) ?? null
  const dryRun = approval.status === 'pending' ? await checkReview(approval, facts, assignment, { kind: 'system' }) : null
  const names = await assistantNames(assignment ? [assignment.reviewerAssistantId] : [])
  return {
    request: {
      id: approval.id, kind: approval.kind, status: approval.status, toolName: approval.toolName ?? null, summary: summaryOf(approval),
      approverUserId: approval.approverUserId, resolutionOrigin: approval.resolutionOrigin ?? null,
      sessionId: approval.blockingSessionId, workflowRunId: approval.workflowRunId ?? null, createdAt: approval.createdAt.toISOString(),
    },
    assignment: assignment ? {
      id: assignment.id, scopeKind: assignment.scopeKind, scopeId: assignment.scopeId, revision: assignment.revision,
      reviewerAssistantId: assignment.reviewerAssistantId, reviewerName: names.get(assignment.reviewerAssistantId) ?? null,
      delegatorUserId: assignment.delegatorUserId, parameterPolicy: assignment.parameterPolicy,
    } : null,
    eligibility: dryRun ? (dryRun.ok ? { eligible: true, patternId: dryRun.lineage.id } : { eligible: false, reasons: dryRun.reasons, patternId: dryRun.patternId }) : null,
    receipt: receipt ? {
      id: receipt.id, reviewerAssistantId: receipt.reviewerAssistantId, delegatorUserId: receipt.delegatorUserId, patternId: receipt.patternId,
      patternVersion: receipt.patternVersion, createdAt: receipt.createdAt.toISOString(), consumedAt: receipt.consumedAt?.toISOString() ?? null,
      invalidationReason: receipt.invalidationReason,
    } : null,
    lastAttempt: attempt ? { outcome: attempt.outcome, reasons: attempt.reasons, explanation: attempt.explanation, at: attempt.createdAt.toISOString() } : null,
  }
}
