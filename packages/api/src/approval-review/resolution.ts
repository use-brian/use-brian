/**
 * The ONLY delegated decision path (D40-D47, A06, A07).
 *
 * `reviewApprovalRequest` decides deterministically from current state; a
 * model may supply an explanation, never the decision. It resolves a request
 * only when its approver explicitly assigned a reviewer that holds
 * `configure` and is admitted to the source, the request is outside every
 * human-only category, and it exactly matches an ACTIVE lineage of the
 * approver's own human decisions. The claim is one transaction that locks
 * the assignment, pattern and reviewer grant at the revisions it checked and
 * flips `pending_approvals` with the same `status = 'pending'` predicate a
 * human response uses, so exactly one decision wins. It writes the delegated
 * receipt, never a human decision event or pattern support.
 *
 * Spec: docs/architecture/features/approval-review.md → "Review and resolution"
 *
 * [COMP:api/approval-review-resolution]
 */
import {
  digestOf,
  humanOnlyCategory,
  matchPattern,
  patternKeyFor,
  type ReviewOutcome,
  type ReviewReason,
} from '@use-brian/core'
import { getPool } from '../db/client.js'
import { createPendingApprovalsStore, type PendingApproval } from '../db/pending-approvals-store.js'
import {
  findLiveLineage,
  getReceiptByApproval,
  getReceiptByKey,
  insertAttempt,
  insertReceipt,
  type DelegatedResolution,
  type ReviewAttempt,
} from '../db/approval-review-store.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { loadRequestFacts, reviewerAdmission } from './source.js'
import { ELIGIBLE_KINDS, effectiveAssignmentFor, evaluateLineage } from './patterns.js'
import { appendApprovalReviewAudit } from './common.js'
import { ApprovalReviewError } from './errors.js'

export type ReviewRequester =
  | { kind: 'human'; userId: string }
  | { kind: 'assistant'; assistantId: string }
  | { kind: 'system' }

export type ReviewResult =
  | { outcome: 'resolved'; receipt: DelegatedResolution; replay: boolean; consumer?: unknown }
  | { outcome: Exclude<ReviewOutcome, 'resolved'>; reasons: ReviewReason[]; assignmentId: string | null; reviewerAssistantId: string | null; patternId: string | null }

/** Native consumers run after a successful claim (wired in boot). */
export type ReviewConsumers = {
  /** Continue the paused workflow run with the original executor. */
  workflowStep?: (approval: PendingApproval, receipt: DelegatedResolution) => Promise<unknown>
}

let defaultConsumers: ReviewConsumers = {}
/** Boot registers the native consumers once (the workflow approval bridge). */
export function configureApprovalReviewConsumers(consumers: ReviewConsumers): void {
  defaultConsumers = consumers
}

export async function reviewApprovalRequest(params: {
  workspaceId: string
  approvalId: string
  trigger: ReviewAttempt['trigger']
  requester: ReviewRequester
  idempotencyKey?: string
  explanation?: string | null
}, consumers: ReviewConsumers = defaultConsumers): Promise<ReviewResult> {
  const approvals = createPendingApprovalsStore()
  const approval = await approvals.getByIdSystem(params.approvalId)
  if (!approval || approval.workspaceId !== params.workspaceId) throw new ApprovalReviewError('not_found', 404, 'Not found')
  if (params.requester.kind === 'human' && !await approvals.getById(params.requester.userId, approval.id)) {
    throw new ApprovalReviewError('not_found', 404, 'Not found')
  }
  const key = params.idempotencyKey ?? `review:${approval.id}`
  const byKey = await getReceiptByKey(approval.workspaceId, key)
  if (byKey) {
    if (byKey.approvalId !== approval.id) throw new ApprovalReviewError('idempotency_conflict', 409, 'This key was already used for another request.')
    return { outcome: 'resolved', receipt: byKey, replay: true }
  }
  const prior = await getReceiptByApproval(approval.id)
  if (prior) return { outcome: 'resolved', receipt: prior, replay: true }

  const facts = await loadRequestFacts(approval)
  const assignment = await effectiveAssignmentFor(facts)
  const leave = async (outcome: 'needs_human' | 'blocked', reasons: ReviewReason[], patternId: string | null = null): Promise<ReviewResult> => {
    await insertAttempt(getPool(), {
      workspaceId: approval.workspaceId, approvalId: approval.id, assignmentId: assignment?.id ?? null,
      reviewerAssistantId: assignment?.reviewerAssistantId ?? null, trigger: params.trigger, outcome, reasons,
      explanation: params.explanation ?? null, patternId,
    })
    notifyWorkspaceChange(approval.workspaceId, 'approval', 'update', approval.id)
    return { outcome, reasons, assignmentId: assignment?.id ?? null, reviewerAssistantId: assignment?.reviewerAssistantId ?? null, patternId }
  }

  if (approval.status !== 'pending') return leave('blocked', ['not_pending'])
  if (approval.expiresAt && approval.expiresAt.getTime() <= Date.now()) return leave('blocked', ['expired'])
  if (!assignment) return leave('needs_human', ['no_assignment'])
  if (params.requester.kind === 'assistant' && params.requester.assistantId !== assignment.reviewerAssistantId) {
    return leave('blocked', ['reviewer_not_assigned'])
  }
  if (assignment.delegatorUserId !== approval.approverUserId) return leave('needs_human', ['delegator_not_approver'])
  if (!await approvals.getById(assignment.delegatorUserId, approval.id)) return leave('needs_human', ['delegator_source_denied'])
  const reviewer = await reviewerAdmission(assignment.reviewerAssistantId, approval.workspaceId, facts)
  if (!reviewer.ok) return leave('needs_human', [reviewer.reason])
  if (!ELIGIBLE_KINDS.has(approval.kind) || !facts.descriptor.ok) {
    return leave('needs_human', [`unresolved:${facts.descriptor.ok ? 'ineligible_kind' : facts.descriptor.reason}`])
  }
  const d = facts.descriptor.descriptor
  const category = humanOnlyCategory({ actionKind: d.actionKind, parameters: d.parameters, effectTexts: d.effectTexts,
    ceiling: typeof approval.approvalPayload.ceiling === 'string' ? approval.approvalPayload.ceiling : null })
  if (category) return leave('needs_human', [`human_only:${category}`])

  const lineage = await findLiveLineage(getPool(), approval.workspaceId, patternKeyFor(d, assignment.parameterPolicy))
  if (!lineage || lineage.status === 'proposed') return leave('needs_human', ['no_active_pattern'], lineage?.id ?? null)
  if (lineage.status !== 'active') return leave('needs_human', ['pattern_suspended'], lineage.id)
  const match = matchPattern(lineage, d)
  if (!match.ok) return leave('needs_human', [`mismatch:${match.reason}`], lineage.id)
  const evaluation = await evaluateLineage(getPool(), lineage)
  if (!evaluation.qualifies) return leave('needs_human', ['pattern_suspended'], lineage.id)

  // ── Atomic claim ──
  const client = await getPool().connect()
  let receipt: DelegatedResolution
  let claimed: PendingApproval
  try {
    await client.query('BEGIN')
    const a = (await client.query<{ status: string; revision: number; reviewer_assistant_id: string }>(
      'SELECT status, revision, reviewer_assistant_id FROM approval_review_assignments WHERE id = $1 FOR SHARE', [assignment.id])).rows[0]
    if (!a || a.status !== 'active' || a.revision !== assignment.revision || a.reviewer_assistant_id !== assignment.reviewerAssistantId) {
      await client.query('ROLLBACK')
      return leave('needs_human', ['assignment_changed'], lineage.id)
    }
    const p = (await client.query<{ status: string; revision: number; version: number }>(
      'SELECT status, revision::int AS revision, version FROM approval_patterns WHERE id = $1 FOR SHARE', [lineage.id])).rows[0]
    if (!p || p.status !== 'active' || p.revision !== lineage.revision) {
      await client.query('ROLLBACK')
      return leave('needs_human', ['pattern_changed'], lineage.id)
    }
    const locked = await reviewerAdmission(assignment.reviewerAssistantId, approval.workspaceId, facts, client, true)
    if (!locked.ok) {
      await client.query('ROLLBACK')
      return leave('needs_human', [locked.reason], lineage.id)
    }
    const flipped = await client.query(
      `UPDATE pending_approvals SET status = 'approved', responded_at = now(), responded_by = NULL,
         resolution_origin = 'delegated_assistant'
       WHERE id = $1 AND status = 'pending' AND (expires_at IS NULL OR expires_at > now())
       RETURNING id`, [approval.id])
    if (!flipped.rows[0]) {
      await client.query('ROLLBACK')
      const raced = await getReceiptByApproval(approval.id)
      if (raced) return { outcome: 'resolved', receipt: raced, replay: true }
      return leave('blocked', ['lost_race'], lineage.id)
    }
    receipt = await insertReceipt(client, {
      workspaceId: approval.workspaceId, approvalId: approval.id, assignmentId: assignment.id,
      assignmentRevision: assignment.revision, reviewerAssistantId: assignment.reviewerAssistantId,
      delegatorUserId: assignment.delegatorUserId, patternId: lineage.id, patternVersion: lineage.version,
      patternRevision: lineage.revision, supportApprovalIds: evaluation.countedApprovalIds, actionDigest: digestOf(d),
      authority: {
        reviewerClearance: reviewer.clearance, executorAssistantId: approval.originatingAssistantId,
        delegatorSourceAdmitted: true, humanOnly: null, checkedAt: new Date().toISOString(), trigger: params.trigger,
      },
      idempotencyKey: key,
      requestDigest: digestOf({ id: approval.id, kind: approval.kind, toolName: approval.toolName, arguments: approval.arguments, createdAt: approval.createdAt.toISOString() }),
    })
    await insertAttempt(client, {
      workspaceId: approval.workspaceId, approvalId: approval.id, assignmentId: assignment.id,
      reviewerAssistantId: assignment.reviewerAssistantId, trigger: params.trigger, outcome: 'resolved', reasons: [],
      explanation: params.explanation ?? null, patternId: lineage.id,
    })
    await client.query('COMMIT')
    claimed = (await approvals.getByIdSystem(approval.id))!
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if ((err as { code?: string }).code === '23505') {
      const raced = await getReceiptByKey(approval.workspaceId, key)
      if (raced?.approvalId === approval.id) return { outcome: 'resolved', receipt: raced, replay: true }
      throw new ApprovalReviewError('idempotency_conflict', 409, 'This key was already used for another request.')
    }
    throw err
  } finally {
    client.release()
  }
  await appendApprovalReviewAudit(approval.workspaceId, null, 'approval_review.delegated_decision', approval.id, {
    reviewerAssistantId: receipt.reviewerAssistantId, delegatorUserId: receipt.delegatorUserId, assignmentId: receipt.assignmentId,
    patternId: receipt.patternId, patternVersion: receipt.patternVersion, origin: 'delegated_assistant',
  })
  notifyWorkspaceChange(approval.workspaceId, 'approval', 'update', approval.id)
  let consumer: unknown
  if (claimed.kind === 'workflow_step' && consumers.workflowStep) {
    try {
      consumer = await consumers.workflowStep(claimed, receipt)
    } catch (err) {
      console.warn(`[approval-review] workflow continuation failed for ${approval.id}:`, err)
      consumer = { status: 'failed' }
    }
  }
  // Browser terminal sends need no dispatch: the runner's poll consumes the receipt.
  return { outcome: 'resolved', receipt, replay: false, consumer }
}

/**
 * Review-on-create hook: a newly paused request with an explicitly assigned
 * reviewer is reviewed immediately. Never throws into the producer.
 */
export async function reviewOnCreate(approval: Pick<PendingApproval, 'id' | 'workspaceId' | 'kind'>): Promise<ReviewResult | null> {
  if (!ELIGIBLE_KINDS.has(approval.kind)) return null
  try {
    const facts = await loadRequestFacts((await createPendingApprovalsStore().getByIdSystem(approval.id))!)
    if (!await effectiveAssignmentFor(facts)) return null
    return await reviewApprovalRequest({ workspaceId: approval.workspaceId, approvalId: approval.id, trigger: 'created', requester: { kind: 'system' } })
  } catch (err) {
    console.warn(`[approval-review] review on create skipped for ${approval.id}:`, err instanceof Error ? err.message : err)
    return null
  }
}
