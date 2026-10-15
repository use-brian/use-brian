/**
 * Approval pattern lineages and human support (D40, D42, D43, D48).
 *
 * `captureHumanDecisionSupport` runs inside the native human respond
 * transaction. It is the ONLY writer of support: a delegated decision never
 * reaches it, so an AI decision can never become evidence. Each human
 * decision on an eligible workflow-step or browser-send request becomes one
 * support row on the lineage keyed by the request's action descriptor; three
 * distinct approved chains activate the lineage, a human rejection suspends
 * it until a human revokes it, and a changed step definition suspends the
 * lineages of that step.
 *
 * Spec: docs/architecture/features/approval-review.md → "Evidence"
 *
 * [COMP:api/approval-review-patterns]
 */
import type pg from 'pg'
import {
  countQualifyingSupport,
  humanOnlyCategory,
  patternKeyFor,
  resolveEffectiveAssignment,
  type ApprovalReviewScopeKind,
  type ParameterPolicy,
  type SupportEvaluation,
} from '@use-brian/core'
import { getPool } from '../db/client.js'
import type { PendingApproval } from '../db/pending-approvals-store.js'
import {
  createLineage,
  findLiveLineage,
  getPatternForViewer,
  insertSupport,
  listActiveAssignmentsForScopes,
  listLiveLineagesForStep,
  listPatternsForViewer,
  listSupportForViewer,
  listSupportSystem,
  revokePatternRow,
  setPatternStatus,
  type ApprovalPattern,
  type ApprovalPatternStatus,
  type Queryable,
} from '../db/approval-review-store.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { loadRequestFacts, type RequestFacts } from './source.js'
import { ApprovalReviewError } from './errors.js'
import { appendApprovalReviewAudit, workspaceRole, type ReviewActor } from './common.js'

export const ELIGIBLE_KINDS = new Set(['workflow_step', 'browser_skill_send'])

/** Scopes a request belongs to, most specific first. */
export function requestScopes(facts: RequestFacts): Array<{ kind: ApprovalReviewScopeKind; id: string }> {
  return [
    { kind: 'request' as const, id: facts.approval.id },
    ...(facts.taskId ? [{ kind: 'task' as const, id: facts.taskId }] : []),
    ...(facts.sessionId ? [{ kind: 'session' as const, id: facts.sessionId }] : []),
    ...(facts.procedure ? [{ kind: facts.procedure.kind, id: facts.procedure.id }] : []),
  ]
}

/** The effective assignment for a request (made by its approver), if any. */
export async function effectiveAssignmentFor(facts: RequestFacts, db: Queryable = getPool()) {
  const active = await listActiveAssignmentsForScopes(facts.approval.workspaceId, requestScopes(facts), db)
  const hit = resolveEffectiveAssignment(active, {
    approvalId: facts.approval.id, approverUserId: facts.approval.approverUserId,
    taskId: facts.taskId, sessionId: facts.sessionId, procedure: facts.procedure,
  })
  return hit ? active.find((a) => a.id === hit.id) ?? null : null
}

/** The policy that keys this request's lineage: its approver's explicit assignment, else exact. */
export async function policyFor(facts: RequestFacts, db: Queryable): Promise<ParameterPolicy> {
  return (await effectiveAssignmentFor(facts, db))?.parameterPolicy ?? {}
}

export async function evaluateLineage(db: Queryable, pattern: ApprovalPattern): Promise<SupportEvaluation> {
  const support = await listSupportSystem(db, pattern.id)
  return countQualifyingSupport(support.map((s) => ({
    approvalId: s.approvalId, chainKey: s.chainKey, decision: s.decision, humanOrigin: true, decidedAt: s.decidedAt,
    withdrawn: s.approvalStatus === null || s.approvalStatus === 'superseded' || s.approvalStatus === 'expired',
  })), pattern.supportSince)
}

/**
 * Record one HUMAN decision as support. Runs in the caller's transaction,
 * inside a savepoint: evidence capture never blocks or undoes a human
 * decision. Returns the lineage it touched, if any.
 */
export async function captureHumanDecisionSupport(
  client: pg.PoolClient,
  approval: PendingApproval,
  decision: 'approved' | 'rejected',
  humanUserId: string,
): Promise<ApprovalPattern | null> {
  if (!ELIGIBLE_KINDS.has(approval.kind)) return null
  await client.query('SAVEPOINT approval_support')
  try {
    const touched = await captureInner(client, approval, decision, humanUserId)
    await client.query('RELEASE SAVEPOINT approval_support')
    return touched
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT approval_support').catch(() => {})
    console.warn(`[approval-review] support capture skipped for ${approval.id}:`, err instanceof Error ? err.message : err)
    return null
  }
}

async function captureInner(client: pg.PoolClient, approval: PendingApproval, decision: 'approved' | 'rejected', humanUserId: string) {
  const facts = await loadRequestFacts(approval, client)
  if (!facts.descriptor.ok) return null
  const d = facts.descriptor.descriptor
  // Human-only actions never become delegable patterns (D47).
  if (humanOnlyCategory({ actionKind: d.actionKind, parameters: d.parameters, effectTexts: d.effectTexts })) return null
  const policy = await policyFor(facts, client)
  const key = patternKeyFor(d, policy)

  // A changed step definition (or skill version) invalidates the step's older lineages.
  for (const stale of await listLiveLineagesForStep(client, approval.workspaceId, d.procedure.kind, d.procedure.id, d.procedure.stepId)) {
    const p = stale.descriptor.procedure
    const changed = p.kind === 'workflow' && d.procedure.kind === 'workflow' ? p.definitionDigest !== d.procedure.definitionDigest
      : p.kind === 'browser_skill' && d.procedure.kind === 'browser_skill' ? p.version !== d.procedure.version : false
    if (changed) await setPatternStatus(client, stale.id, 'suspended', 'definition_changed')
  }

  let lineage = await findLiveLineage(client, approval.workspaceId, key, true)
  if (!lineage) lineage = await createLineage(client, { workspaceId: approval.workspaceId, patternKey: key, descriptor: d, parameterPolicy: policy })
  await insertSupport(client, {
    workspaceId: approval.workspaceId, patternId: lineage.id, approvalId: approval.id, chainKey: facts.chainKey,
    decision, humanUserId, sourceSessionId: facts.sessionId, workflowRunId: approval.workflowRunId ?? null,
  })
  const evaluation = await evaluateLineage(client, lineage)
  let next: ApprovalPattern | null = lineage
  if (evaluation.contradicted && lineage.status !== 'suspended') {
    next = await setPatternStatus(client, lineage.id, 'suspended', 'unresolved_denial')
  } else if (!evaluation.contradicted && evaluation.qualifies && lineage.status === 'proposed') {
    next = await setPatternStatus(client, lineage.id, 'active', null)
  }
  return next
}

// ── Inspection and revocation ─────────────────────────────────────────────

export type PatternView = ApprovalPattern & { support: { approvedChains: number; required: number; contradicted: boolean } }

export async function listPatterns(actor: ReviewActor, workspaceId: string, filter: { procedureId?: string; status?: ApprovalPatternStatus } = {}): Promise<PatternView[]> {
  if (!await workspaceRole(actor.userId, workspaceId)) throw new ApprovalReviewError('not_found', 404, 'Not found')
  const rows = await listPatternsForViewer(actor.userId, workspaceId, filter)
  const out: PatternView[] = []
  for (const p of rows) out.push({ ...p, support: await supportSummary(p) })
  return out
}

async function supportSummary(p: ApprovalPattern) {
  const e = await evaluateLineage(getPool(), p)
  return { approvedChains: e.distinctApprovedChains, required: 3, contradicted: e.contradicted }
}

export async function getPattern(actor: ReviewActor, workspaceId: string, patternId: string) {
  const p = await getPatternForViewer(actor.userId, patternId)
  if (!p || p.workspaceId !== workspaceId) throw new ApprovalReviewError('not_found', 404, 'Not found')
  // Support references only where the viewer can still read the original request.
  const support = await listSupportForViewer(actor.userId, patternId)
  return { pattern: { ...p, support: await supportSummary(p) }, supportRefs: support.map((s) => ({ approvalId: s.approvalId, decision: s.decision, decidedAt: s.decidedAt })) }
}

export async function revokePattern(actor: ReviewActor, workspaceId: string, patternId: string, body: { expectedRevision?: number; reason?: string } = {}) {
  if (!actor.human || actor.origin === 'mcp') throw new ApprovalReviewError('human_intent_required', 403, 'Only a person can revoke an approval pattern.')
  const p = await getPatternForViewer(actor.userId, patternId)
  if (!p || p.workspaceId !== workspaceId) throw new ApprovalReviewError('not_found', 404, 'Not found')
  const role = await workspaceRole(actor.userId, workspaceId)
  const owner = p.procedureKind === 'workflow'
    ? (await getPool().query<{ created_by: string }>('SELECT created_by FROM workflows WHERE id = $1', [p.procedureId])).rows[0]?.created_by
    : (await getPool().query<{ created_by: string | null }>('SELECT created_by FROM browser_skills WHERE id = $1', [p.procedureId])).rows[0]?.created_by
  const supporter = (await getPool().query('SELECT 1 FROM approval_pattern_support WHERE pattern_id = $1 AND human_user_id = $2 LIMIT 1', [patternId, actor.userId])).rows.length > 0
  if (role !== 'owner' && role !== 'admin' && owner !== actor.userId && !supporter) {
    throw new ApprovalReviewError('revoke_not_allowed', 403, 'Only a workspace admin, the procedure owner or a person whose approvals support this pattern can revoke it.')
  }
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const revoked = await revokePatternRow(client, patternId, body.expectedRevision ?? null, actor.userId, body.reason ?? 'revoked')
    if (!revoked) {
      await client.query('ROLLBACK')
      if (p.status === 'revoked') return p
      throw new ApprovalReviewError('stale_revision', 409, 'This pattern changed. Refresh and try again.')
    }
    await client.query(
      `UPDATE approval_delegated_resolutions SET invalidated_at = now(), invalidation_reason = 'pattern_revoked'
       WHERE pattern_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`, [patternId])
    await client.query('COMMIT')
    await appendApprovalReviewAudit(workspaceId, actor.userId, 'approval_review.pattern_revoked', patternId, { reason: body.reason ?? null, version: revoked.version })
    notifyWorkspaceChange(workspaceId, 'approval', 'update', patternId)
    return revoked
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
