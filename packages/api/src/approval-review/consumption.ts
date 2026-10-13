/**
 * Delegated receipt revalidation at consumption (D48, A08, A10).
 *
 * A consumer of an approved request (workflow resume, browser terminal-send
 * poll, staged-write apply) must not trust `status = 'approved'` when the
 * decision was delegated. `validateDelegatedReceipt` re-derives current
 * authority: the assignment is still active at the receipt's revision, the
 * reviewer still holds `configure` and is admitted to the source, the
 * pattern is still the active lineage version the decision used, the
 * delegator still holds the request and can read its source, the request
 * still matches the pattern (current step definition), and D47 still holds.
 * A failure invalidates the receipt so every later consumer stops too.
 *
 * Spec: docs/architecture/features/approval-review.md → "Consumption"
 *
 * [COMP:api/approval-review-consumption]
 */
import { humanOnlyCategory, matchPattern } from '@use-brian/core'
import { getPool } from '../db/client.js'
import { createPendingApprovalsStore, type PendingApproval } from '../db/pending-approvals-store.js'
import {
  getAssignmentSystem,
  getPatternSystem,
  getReceiptByApproval,
  invalidateReceipt,
  markReceiptConsumed,
  type DelegatedResolution,
  type Queryable,
} from '../db/approval-review-store.js'
import { loadRequestFacts, reviewerAdmission } from './source.js'
import { evaluateLineage } from './patterns.js'

export type ReceiptCheck =
  | { ok: true; receipt: DelegatedResolution }
  | { ok: false; reason: string; receipt: DelegatedResolution | null }

export async function validateDelegatedReceipt(approval: PendingApproval, db: Queryable = getPool()): Promise<ReceiptCheck> {
  const receipt = await getReceiptByApproval(approval.id, db)
  const fail = async (reason: string): Promise<ReceiptCheck> => {
    if (receipt && !receipt.invalidatedAt) await invalidateReceipt(receipt.id, reason, db)
    return { ok: false, reason, receipt }
  }
  if (!receipt) return { ok: false, reason: 'receipt_missing', receipt: null }
  if (receipt.invalidatedAt) return { ok: false, reason: receipt.invalidationReason ?? 'receipt_invalidated', receipt }
  if (approval.resolutionOrigin !== 'delegated_assistant' || approval.status !== 'approved') return fail('request_state_changed')

  const assignment = await getAssignmentSystem(receipt.assignmentId, db)
  if (!assignment || assignment.status !== 'active') return fail('assignment_revoked')
  if (assignment.revision !== receipt.assignmentRevision || assignment.reviewerAssistantId !== receipt.reviewerAssistantId) return fail('assignment_changed')
  if (assignment.delegatorUserId !== approval.approverUserId || receipt.delegatorUserId !== approval.approverUserId) return fail('delegator_not_approver')

  const facts = await loadRequestFacts(approval, db)
  const reviewer = await reviewerAdmission(receipt.reviewerAssistantId, approval.workspaceId, facts, db)
  if (!reviewer.ok) return fail(reviewer.reason)

  const delegatorView = await createPendingApprovalsStore().getById(receipt.delegatorUserId, approval.id)
  if (!delegatorView) return fail('delegator_source_denied')

  const pattern = await getPatternSystem(receipt.patternId, db)
  if (!pattern || pattern.status === 'revoked') return fail('pattern_revoked')
  if (pattern.status !== 'active') return fail(pattern.suspendedReason ?? 'pattern_suspended')
  if (pattern.version !== receipt.patternVersion) return fail('pattern_changed')
  const evaluation = await evaluateLineage(db, pattern)
  if (!evaluation.qualifies) return fail(evaluation.contradicted ? 'unresolved_denial' : 'pattern_unqualified')

  if (!facts.descriptor.ok) return fail(`unresolved:${facts.descriptor.reason}`)
  const d = facts.descriptor.descriptor
  const match = matchPattern(pattern, d)
  if (!match.ok) return fail(`mismatch:${match.reason}`)
  const category = humanOnlyCategory({ actionKind: d.actionKind, parameters: d.parameters, effectTexts: d.effectTexts,
    ceiling: typeof approval.approvalPayload.ceiling === 'string' ? approval.approvalPayload.ceiling : null })
  if (category) return fail(`human_only:${category}`)
  return { ok: true, receipt }
}

/** Validate then record consumption. Only a validated receipt is ever marked consumed. */
export async function consumeDelegatedReceipt(approval: PendingApproval): Promise<ReceiptCheck> {
  const check = await validateDelegatedReceipt(approval)
  if (check.ok) await markReceiptConsumed(check.receipt.id)
  return check
}
