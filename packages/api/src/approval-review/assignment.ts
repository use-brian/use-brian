/**
 * Explicit, human-authored reviewer assignment (D44-D46).
 *
 * Only an authenticated human may assign, change or revoke. The actor comes
 * from the authentication context (`ReviewActor`), never from tool arguments
 * or quoted text: a programmatic (MCP) or unattended caller is refused with
 * `human_intent_required`. The delegating human must hold the decision they
 * delegate (the request's approver, or the person who may configure the
 * workflow / skill / task / session whose requests they approve), and the
 * reviewer must hold `configure` and be admitted to the scope's source.
 *
 * Spec: docs/architecture/features/approval-review.md → "Product contract"
 *
 * [COMP:api/approval-review-assignment]
 */
import {
  assignReviewerInputSchema,
  changeAssignmentInputSchema,
  digestOf,
  type ApprovalReviewScopeKind,
  type AssignReviewerInput,
  type ChangeAssignmentInput,
} from '@use-brian/core'
import { getPool, queryWithRLS } from '../db/client.js'
import { createPendingApprovalsStore } from '../db/pending-approvals-store.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { readSessionById } from '../db/sessions.js'
import { gateSessionRead } from '../session-read-authority.js'
import {
  findActiveAssignmentForScope,
  findAssignmentByKey,
  getAssignmentForViewer,
  insertAssignment,
  revokeAssignmentRow,
  updateAssignment,
  type ApprovalReviewAssignment,
} from '../db/approval-review-store.js'
import { loadRequestFacts, reviewerAdmission, scopeSourceContext } from './source.js'
import { ApprovalReviewError } from './errors.js'
import { appendApprovalReviewAudit as audit, workspaceRole, type ReviewActor } from './common.js'

export type { ReviewActor } from './common.js'

function requireHuman(actor: ReviewActor): asserts actor is ReviewActor & { origin: 'ui' | 'chat' } {
  if (!actor.human || actor.origin === 'mcp') {
    throw new ApprovalReviewError('human_intent_required', 403, 'Only a person can assign, change or revoke an approval reviewer.')
  }
}

const notFound = () => new ApprovalReviewError('not_found', 404, 'Not found')

/**
 * The delegating human may delegate this scope's decisions. Returns the
 * source context for reviewer admission. Restricted existence is reported
 * as not found.
 */
async function delegationRight(actor: ReviewActor, workspaceId: string, scopeKind: ApprovalReviewScopeKind, scopeId: string) {
  const role = await workspaceRole(actor.userId, workspaceId)
  if (!role) throw notFound()
  const admin = role === 'owner' || role === 'admin'
  if (scopeKind === 'request') {
    const approval = await createPendingApprovalsStore().getById(actor.userId, scopeId)
    if (!approval || approval.workspaceId !== workspaceId) throw notFound()
    if (approval.approverUserId !== actor.userId) throw new ApprovalReviewError('delegation_not_yours', 403, 'Only the approver of this request can delegate it.')
    if (approval.status !== 'pending') throw new ApprovalReviewError('request_not_pending', 409, `This request is already ${approval.status}.`)
    const facts = await loadRequestFacts(approval)
    return { projectIds: facts.projectIds, compartments: facts.compartments, sensitivity: facts.sensitivity }
  }
  if (scopeKind === 'workflow') {
    const w = (await queryWithRLS<{ created_by: string }>(actor.userId,
      'SELECT created_by FROM workflows WHERE id = $1 AND workspace_id = $2', [scopeId, workspaceId])).rows[0]
    if (!w) throw notFound()
    if (!admin && w.created_by !== actor.userId) throw new ApprovalReviewError('delegation_not_yours', 403, 'Only the workflow owner or a workspace admin can set its reviewer.')
  } else if (scopeKind === 'browser_skill') {
    const b = (await queryWithRLS<{ created_by: string | null }>(actor.userId,
      'SELECT created_by FROM browser_skills WHERE id = $1 AND workspace_id = $2', [scopeId, workspaceId])).rows[0]
    if (!b) throw notFound()
    if (!admin && b.created_by !== actor.userId) throw new ApprovalReviewError('delegation_not_yours', 403, 'Only the skill author or a workspace admin can set its reviewer.')
  } else if (scopeKind === 'task') {
    const t = (await queryWithRLS<{ user_id: string | null; created_by_user_id: string | null; assignee_id: string | null }>(actor.userId,
      'SELECT user_id, created_by_user_id, assignee_id FROM tasks WHERE id = $1 AND workspace_id = $2', [scopeId, workspaceId])).rows[0]
    if (!t) throw notFound()
    if (!admin && ![t.user_id, t.created_by_user_id, t.assignee_id].includes(actor.userId)) {
      throw new ApprovalReviewError('delegation_not_yours', 403, 'Only the task owner, its assignee or a workspace admin can set its reviewer.')
    }
  } else {
    const session = await readSessionById(scopeId)
    const inWorkspace = (await getPool().query('SELECT 1 FROM sessions WHERE id = $1 AND workspace_id = $2', [scopeId, workspaceId])).rows.length > 0
    if (!session || !inWorkspace || await gateSessionRead(actor.userId, session) !== null) throw notFound()
  }
  const context = await scopeSourceContext(workspaceId, scopeKind, scopeId)
  if (!context) throw notFound()
  return context
}

export type AssignmentResult = { outcome: 'created' | 'duplicate'; assignment: ApprovalReviewAssignment }

export async function assignReviewer(actor: ReviewActor, workspaceId: string, raw: unknown): Promise<AssignmentResult> {
  requireHuman(actor)
  const parsed = assignReviewerInputSchema.safeParse(raw)
  if (!parsed.success) throw new ApprovalReviewError('invalid_input', 400, parsed.error.issues.map((i) => i.message).join('; '))
  const input: AssignReviewerInput = parsed.data
  const policy = input.parameterPolicy ?? {}
  const payloadDigest = digestOf({ r: input.reviewerAssistantId, k: input.scopeKind, s: input.scopeId, p: policy, d: actor.userId })
  const prior = await findAssignmentByKey(workspaceId, input.idempotencyKey)
  if (prior) {
    if (prior.payloadDigest !== payloadDigest) throw new ApprovalReviewError('idempotency_conflict', 409, 'This key was already used for a different assignment.')
    return { outcome: 'duplicate', assignment: prior }
  }
  const context = await delegationRight(actor, workspaceId, input.scopeKind, input.scopeId)
  const admission = await reviewerAdmission(input.reviewerAssistantId, workspaceId, context)
  if (!admission.ok) throw new ApprovalReviewError(admission.reason, 422, reviewerMessage(admission.reason))
  if (await findActiveAssignmentForScope(workspaceId, input.scopeKind, input.scopeId)) {
    throw new ApprovalReviewError('assignment_exists', 409, 'This scope already has a reviewer. Change or revoke it instead.')
  }
  let assignment: ApprovalReviewAssignment
  try {
    assignment = await insertAssignment(getPool(), {
      workspaceId, reviewerAssistantId: input.reviewerAssistantId, delegatorUserId: actor.userId,
      scopeKind: input.scopeKind, scopeId: input.scopeId, parameterPolicy: policy, origin: actor.origin,
      instructionReceipt: { origin: actor.origin, at: new Date().toISOString(), ...cleanReceipt(actor.receipt) },
      sourceCeiling: { reviewerClearance: admission.clearance, sensitivity: context.sensitivity, projectIds: context.projectIds, compartments: context.compartments },
      idempotencyKey: input.idempotencyKey, payloadDigest,
    })
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const raced = await findAssignmentByKey(workspaceId, input.idempotencyKey)
      if (raced && raced.payloadDigest === payloadDigest) return { outcome: 'duplicate', assignment: raced }
      throw new ApprovalReviewError('assignment_exists', 409, 'This scope already has a reviewer. Change or revoke it instead.')
    }
    throw err
  }
  await audit(workspaceId, actor.userId, 'approval_review.assigned', assignment.id, {
    reviewerAssistantId: assignment.reviewerAssistantId, scopeKind: assignment.scopeKind, scopeId: assignment.scopeId, origin: actor.origin,
  })
  notifyWorkspaceChange(workspaceId, 'approval', 'update', assignment.id)
  return { outcome: 'created', assignment }
}

export async function changeAssignment(actor: ReviewActor, workspaceId: string, assignmentId: string, raw: unknown): Promise<ApprovalReviewAssignment> {
  requireHuman(actor)
  const parsed = changeAssignmentInputSchema.safeParse(raw)
  if (!parsed.success) throw new ApprovalReviewError('invalid_input', 400, parsed.error.issues.map((i) => i.message).join('; '))
  const input: ChangeAssignmentInput = parsed.data
  const current = await getAssignmentForViewer(actor.userId, assignmentId)
  if (!current || current.workspaceId !== workspaceId) throw notFound()
  if (current.delegatorUserId !== actor.userId) throw new ApprovalReviewError('delegation_not_yours', 403, 'Only the person who made this assignment can change it.')
  if (current.status !== 'active') throw new ApprovalReviewError('assignment_revoked', 409, 'This assignment was revoked.')
  const context = await delegationRight(actor, workspaceId, current.scopeKind, current.scopeId)
  const reviewer = input.reviewerAssistantId ?? current.reviewerAssistantId
  const admission = await reviewerAdmission(reviewer, workspaceId, context)
  if (!admission.ok) throw new ApprovalReviewError(admission.reason, 422, reviewerMessage(admission.reason))
  const updated = await updateAssignment(getPool(), assignmentId, input.expectedRevision, {
    reviewerAssistantId: input.reviewerAssistantId,
    parameterPolicy: input.parameterPolicy,
    sourceCeiling: { reviewerClearance: admission.clearance, sensitivity: context.sensitivity, projectIds: context.projectIds, compartments: context.compartments },
  })
  if (!updated) throw new ApprovalReviewError('stale_revision', 409, 'This assignment changed. Refresh and try again.')
  await audit(workspaceId, actor.userId, 'approval_review.assignment_changed', assignmentId, {
    previous: { reviewerAssistantId: current.reviewerAssistantId, parameterPolicy: current.parameterPolicy, revision: current.revision },
    next: { reviewerAssistantId: updated.reviewerAssistantId, parameterPolicy: updated.parameterPolicy, revision: updated.revision },
  })
  notifyWorkspaceChange(workspaceId, 'approval', 'update', assignmentId)
  return updated
}

export async function revokeAssignment(actor: ReviewActor, workspaceId: string, assignmentId: string, body: { expectedRevision?: number; reason?: string } = {}): Promise<ApprovalReviewAssignment> {
  requireHuman(actor)
  const current = await getAssignmentForViewer(actor.userId, assignmentId)
  if (!current || current.workspaceId !== workspaceId) throw notFound()
  const role = await workspaceRole(actor.userId, workspaceId)
  if (current.delegatorUserId !== actor.userId && role !== 'owner' && role !== 'admin') {
    throw new ApprovalReviewError('delegation_not_yours', 403, 'Only the person who made this assignment or a workspace admin can revoke it.')
  }
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const revoked = await revokeAssignmentRow(client, assignmentId, body.expectedRevision ?? null, actor.userId, body.reason ?? 'revoked')
    if (!revoked) {
      await client.query('ROLLBACK')
      if (current.status === 'revoked') return current
      throw new ApprovalReviewError('stale_revision', 409, 'This assignment changed. Refresh and try again.')
    }
    // Pending delegated use stops: any receipt not yet consumed is invalidated.
    await client.query(
      `UPDATE approval_delegated_resolutions SET invalidated_at = now(), invalidation_reason = 'assignment_revoked'
       WHERE assignment_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`, [assignmentId])
    await client.query('COMMIT')
    await audit(workspaceId, actor.userId, 'approval_review.assignment_revoked', assignmentId, { reason: body.reason ?? null })
    notifyWorkspaceChange(workspaceId, 'approval', 'update', assignmentId)
    return revoked
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

function cleanReceipt(r: ReviewActor['receipt']): Record<string, unknown> {
  if (!r) return {}
  return {
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(r.messageId ? { messageId: r.messageId } : {}),
    ...(r.text ? { text: r.text.slice(0, 1000) } : {}),
    ...(r.selection ? { selection: r.selection.slice(0, 200) } : {}),
  }
}

export function reviewerMessage(reason: string): string {
  switch (reason) {
    case 'reviewer_unavailable': return 'That assistant is not available in this workspace.'
    case 'reviewer_lacks_configure': return 'That assistant does not hold the configure capability. A workspace admin grants it on the assistant first.'
    case 'reviewer_not_admitted': return 'That assistant cannot see this work (clearance, Project roster or Department).'
    default: return 'That assistant cannot review this work.'
  }
}

