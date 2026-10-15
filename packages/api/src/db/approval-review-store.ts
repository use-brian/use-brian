/**
 * Persistence for explicitly delegated approval review (migration 757).
 *
 * Writes run on the owner pool behind the domain services in
 * `../approval-review/`, which own every authority decision. Viewer reads run
 * on the app pool (`queryWithRLS`) so the scope-source policies apply; the
 * services add the approval source predicate on top.
 *
 * Spec: docs/architecture/features/approval-review.md
 *
 * [COMP:api/approval-review-assignment]
 */
import type pg from 'pg'
import type {
  ActionDescriptor,
  ApprovalReviewAssignmentStatus,
  ApprovalReviewOrigin,
  ApprovalReviewScopeKind,
  ParameterPolicy,
  ReviewOutcome,
} from '@use-brian/core'
import { getPool, queryWithRLS } from './client.js'

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

const sys = (): Queryable => getPool()

// ── Assignments ───────────────────────────────────────────────────────────

export type ApprovalReviewAssignment = {
  id: string
  workspaceId: string
  reviewerAssistantId: string
  delegatorUserId: string
  scopeKind: ApprovalReviewScopeKind
  scopeId: string
  parameterPolicy: ParameterPolicy
  status: ApprovalReviewAssignmentStatus
  revision: number
  origin: ApprovalReviewOrigin
  instructionReceipt: Record<string, unknown>
  sourceCeiling: Record<string, unknown>
  idempotencyKey: string
  payloadDigest: string
  createdAt: Date
  updatedAt: Date
  revokedAt: Date | null
  revokedByUserId: string | null
  revokeReason: string | null
}

const ASSIGNMENT_COLS = `id, workspace_id AS "workspaceId", reviewer_assistant_id AS "reviewerAssistantId",
  delegator_user_id AS "delegatorUserId", scope_kind AS "scopeKind", scope_id AS "scopeId",
  parameter_policy AS "parameterPolicy", status, revision, origin, instruction_receipt AS "instructionReceipt",
  source_ceiling AS "sourceCeiling", idempotency_key AS "idempotencyKey", payload_digest AS "payloadDigest",
  created_at AS "createdAt", updated_at AS "updatedAt", revoked_at AS "revokedAt",
  revoked_by_user_id AS "revokedByUserId", revoke_reason AS "revokeReason"`

export async function insertAssignment(db: Queryable, row: {
  workspaceId: string
  reviewerAssistantId: string
  delegatorUserId: string
  scopeKind: ApprovalReviewScopeKind
  scopeId: string
  parameterPolicy: ParameterPolicy
  origin: ApprovalReviewOrigin
  instructionReceipt: Record<string, unknown>
  sourceCeiling: Record<string, unknown>
  idempotencyKey: string
  payloadDigest: string
}): Promise<ApprovalReviewAssignment> {
  const r = await db.query<ApprovalReviewAssignment>(
    `INSERT INTO approval_review_assignments (workspace_id, reviewer_assistant_id, delegator_user_id, scope_kind, scope_id,
       parameter_policy, origin, instruction_receipt, source_ceiling, idempotency_key, payload_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${ASSIGNMENT_COLS}`,
    [row.workspaceId, row.reviewerAssistantId, row.delegatorUserId, row.scopeKind, row.scopeId,
      JSON.stringify(row.parameterPolicy), row.origin, JSON.stringify(row.instructionReceipt),
      JSON.stringify(row.sourceCeiling), row.idempotencyKey, row.payloadDigest])
  return r.rows[0]
}

export async function getAssignmentSystem(id: string, db: Queryable = sys(), lock = false): Promise<ApprovalReviewAssignment | null> {
  const r = await db.query<ApprovalReviewAssignment>(
    `SELECT ${ASSIGNMENT_COLS} FROM approval_review_assignments WHERE id = $1${lock ? ' FOR SHARE' : ''}`, [id])
  return r.rows[0] ?? null
}

export async function findAssignmentByKey(workspaceId: string, idempotencyKey: string, db: Queryable = sys()): Promise<ApprovalReviewAssignment | null> {
  const r = await db.query<ApprovalReviewAssignment>(
    `SELECT ${ASSIGNMENT_COLS} FROM approval_review_assignments WHERE workspace_id = $1 AND idempotency_key = $2`,
    [workspaceId, idempotencyKey])
  return r.rows[0] ?? null
}

export async function findActiveAssignmentForScope(workspaceId: string, scopeKind: ApprovalReviewScopeKind, scopeId: string, db: Queryable = sys()): Promise<ApprovalReviewAssignment | null> {
  const r = await db.query<ApprovalReviewAssignment>(
    `SELECT ${ASSIGNMENT_COLS} FROM approval_review_assignments
     WHERE workspace_id = $1 AND scope_kind = $2 AND scope_id = $3 AND status = 'active'`,
    [workspaceId, scopeKind, scopeId])
  return r.rows[0] ?? null
}

/** Active assignments touching any of the given scopes (system read for review). */
export async function listActiveAssignmentsForScopes(
  workspaceId: string,
  scopes: ReadonlyArray<{ kind: ApprovalReviewScopeKind; id: string }>,
  db: Queryable = sys(),
): Promise<ApprovalReviewAssignment[]> {
  if (!scopes.length) return []
  const r = await db.query<ApprovalReviewAssignment>(
    `SELECT ${ASSIGNMENT_COLS} FROM approval_review_assignments
     WHERE workspace_id = $1 AND status = 'active'
       AND (scope_kind, scope_id) IN (SELECT * FROM unnest($2::text[], $3::uuid[]))`,
    [workspaceId, scopes.map((s) => s.kind), scopes.map((s) => s.id)])
  return r.rows
}

export async function updateAssignment(db: Queryable, id: string, expectedRevision: number, patch: {
  reviewerAssistantId?: string
  parameterPolicy?: ParameterPolicy
  sourceCeiling?: Record<string, unknown>
}): Promise<ApprovalReviewAssignment | null> {
  const r = await db.query<ApprovalReviewAssignment>(
    `UPDATE approval_review_assignments SET
       reviewer_assistant_id = coalesce($3, reviewer_assistant_id),
       parameter_policy = coalesce($4::jsonb, parameter_policy),
       source_ceiling = coalesce($5::jsonb, source_ceiling),
       revision = revision + 1, updated_at = now()
     WHERE id = $1 AND revision = $2 AND status = 'active' RETURNING ${ASSIGNMENT_COLS}`,
    [id, expectedRevision, patch.reviewerAssistantId ?? null,
      patch.parameterPolicy ? JSON.stringify(patch.parameterPolicy) : null,
      patch.sourceCeiling ? JSON.stringify(patch.sourceCeiling) : null])
  return r.rows[0] ?? null
}

export async function revokeAssignmentRow(db: Queryable, id: string, expectedRevision: number | null, byUserId: string | null, reason: string): Promise<ApprovalReviewAssignment | null> {
  const r = await db.query<ApprovalReviewAssignment>(
    `UPDATE approval_review_assignments SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $3,
       revoke_reason = $4, revision = revision + 1, updated_at = now()
     WHERE id = $1 AND status = 'active' AND ($2::int IS NULL OR revision = $2) RETURNING ${ASSIGNMENT_COLS}`,
    [id, expectedRevision, byUserId, reason.slice(0, 500)])
  return r.rows[0] ?? null
}

/** Viewer list: RLS keeps only assignments whose scope source the viewer can read. */
export async function listAssignmentsForViewer(userId: string, workspaceId: string, filter: { status?: ApprovalReviewAssignmentStatus } = {}): Promise<ApprovalReviewAssignment[]> {
  const r = await queryWithRLS<ApprovalReviewAssignment>(userId,
    `SELECT ${ASSIGNMENT_COLS} FROM approval_review_assignments
     WHERE workspace_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT 200`,
    [workspaceId, filter.status ?? null])
  return r.rows
}

export async function getAssignmentForViewer(userId: string, id: string): Promise<ApprovalReviewAssignment | null> {
  const r = await queryWithRLS<ApprovalReviewAssignment>(userId, `SELECT ${ASSIGNMENT_COLS} FROM approval_review_assignments WHERE id = $1`, [id])
  return r.rows[0] ?? null
}

// ── Patterns ──────────────────────────────────────────────────────────────

export type ApprovalPatternStatus = 'proposed' | 'active' | 'suspended' | 'revoked'
export type ApprovalPattern = {
  id: string
  workspaceId: string
  patternKey: string
  procedureKind: 'workflow' | 'browser_skill'
  procedureId: string
  stepKey: string
  actionKind: string
  identityKey: string
  descriptor: ActionDescriptor
  parameterPolicy: ParameterPolicy
  status: ApprovalPatternStatus
  version: number
  revision: number
  supportSince: Date
  activatedAt: Date | null
  suspendedReason: string | null
  revokedAt: Date | null
  revokedByUserId: string | null
  revokeReason: string | null
  createdAt: Date
  updatedAt: Date
}

const PATTERN_COLS = `id, workspace_id AS "workspaceId", pattern_key AS "patternKey", procedure_kind AS "procedureKind",
  procedure_id AS "procedureId", step_key AS "stepKey", action_kind AS "actionKind", identity_key AS "identityKey",
  descriptor, parameter_policy AS "parameterPolicy", status, version, revision::int AS revision,
  support_since AS "supportSince", activated_at AS "activatedAt", suspended_reason AS "suspendedReason",
  revoked_at AS "revokedAt", revoked_by_user_id AS "revokedByUserId", revoke_reason AS "revokeReason",
  created_at AS "createdAt", updated_at AS "updatedAt"`

export async function findLiveLineage(db: Queryable, workspaceId: string, patternKey: string, lock = false): Promise<ApprovalPattern | null> {
  const r = await db.query<ApprovalPattern>(
    `SELECT ${PATTERN_COLS} FROM approval_patterns WHERE workspace_id = $1 AND pattern_key = $2 AND status <> 'revoked'${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId, patternKey])
  return r.rows[0] ?? null
}

export async function getPatternSystem(id: string, db: Queryable = sys(), lock: '' | 'share' | 'update' = ''): Promise<ApprovalPattern | null> {
  const r = await db.query<ApprovalPattern>(
    `SELECT ${PATTERN_COLS} FROM approval_patterns WHERE id = $1${lock === 'share' ? ' FOR SHARE' : lock === 'update' ? ' FOR UPDATE' : ''}`, [id])
  return r.rows[0] ?? null
}

/**
 * Open a new lineage. `support_since` is the later of now and the last
 * revocation of this key, so a revoked lineage's evidence never re-qualifies.
 */
export async function createLineage(db: Queryable, row: {
  workspaceId: string
  patternKey: string
  descriptor: ActionDescriptor
  parameterPolicy: ParameterPolicy
}): Promise<ApprovalPattern> {
  const p = row.descriptor.procedure
  const r = await db.query<ApprovalPattern>(
    `INSERT INTO approval_patterns (workspace_id, pattern_key, procedure_kind, procedure_id, step_key, action_kind,
       identity_key, descriptor, parameter_policy, version, support_since)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9,
            coalesce((SELECT max(version) FROM approval_patterns WHERE workspace_id = $1 AND pattern_key = $2), 0) + 1,
            greatest(now(), coalesce((SELECT max(revoked_at) FROM approval_patterns WHERE workspace_id = $1 AND pattern_key = $2), now()))
     RETURNING ${PATTERN_COLS}`,
    [row.workspaceId, row.patternKey, p.kind, p.id, p.stepId, row.descriptor.actionKind, row.descriptor.identity,
      JSON.stringify(row.descriptor), JSON.stringify(row.parameterPolicy)])
  return r.rows[0]
}

export async function setPatternStatus(db: Queryable, id: string, status: Exclude<ApprovalPatternStatus, 'revoked'>, reason: string | null): Promise<ApprovalPattern | null> {
  const r = await db.query<ApprovalPattern>(
    `UPDATE approval_patterns SET status = $2,
       suspended_reason = CASE WHEN $2 = 'suspended' THEN $3 ELSE NULL END,
       activated_at = CASE WHEN $2 = 'active' THEN coalesce(activated_at, now()) ELSE activated_at END,
       revision = revision + 1, updated_at = now()
     WHERE id = $1 AND status <> 'revoked' RETURNING ${PATTERN_COLS}`,
    [id, status, reason])
  return r.rows[0] ?? null
}

export async function revokePatternRow(db: Queryable, id: string, expectedRevision: number | null, byUserId: string | null, reason: string): Promise<ApprovalPattern | null> {
  const r = await db.query<ApprovalPattern>(
    `UPDATE approval_patterns SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $3, revoke_reason = $4,
       suspended_reason = NULL, revision = revision + 1, updated_at = now()
     WHERE id = $1 AND status <> 'revoked' AND ($2::int IS NULL OR revision = $2) RETURNING ${PATTERN_COLS}`,
    [id, expectedRevision, byUserId, reason.slice(0, 500)])
  return r.rows[0] ?? null
}

/** Live lineages for one procedure step (definition-change invalidation). */
export async function listLiveLineagesForStep(db: Queryable, workspaceId: string, kind: 'workflow' | 'browser_skill', procedureId: string, stepKey: string): Promise<ApprovalPattern[]> {
  const r = await db.query<ApprovalPattern>(
    `SELECT ${PATTERN_COLS} FROM approval_patterns
     WHERE workspace_id = $1 AND procedure_kind = $2 AND procedure_id = $3 AND step_key = $4 AND status IN ('proposed', 'active')`,
    [workspaceId, kind, procedureId, stepKey])
  return r.rows
}

export async function listPatternsForViewer(userId: string, workspaceId: string, filter: { procedureId?: string; status?: ApprovalPatternStatus } = {}): Promise<ApprovalPattern[]> {
  const r = await queryWithRLS<ApprovalPattern>(userId,
    `SELECT ${PATTERN_COLS} FROM approval_patterns
     WHERE workspace_id = $1 AND ($2::uuid IS NULL OR procedure_id = $2) AND ($3::text IS NULL OR status = $3)
     ORDER BY updated_at DESC LIMIT 200`,
    [workspaceId, filter.procedureId ?? null, filter.status ?? null])
  return r.rows
}

export async function getPatternForViewer(userId: string, id: string): Promise<ApprovalPattern | null> {
  const r = await queryWithRLS<ApprovalPattern>(userId, `SELECT ${PATTERN_COLS} FROM approval_patterns WHERE id = $1`, [id])
  return r.rows[0] ?? null
}

// ── Support ───────────────────────────────────────────────────────────────

export type PatternSupport = {
  id: string
  patternId: string
  approvalId: string
  chainKey: string
  decision: 'approved' | 'rejected'
  humanUserId: string | null
  decidedAt: Date
  approvalStatus: string | null
}

export async function insertSupport(db: Queryable, row: {
  workspaceId: string
  patternId: string
  approvalId: string
  chainKey: string
  decision: 'approved' | 'rejected'
  humanUserId: string
  sourceSessionId: string | null
  workflowRunId: string | null
}): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO approval_pattern_support (workspace_id, pattern_id, approval_id, chain_key, decision, human_user_id, source_session_id, workflow_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (pattern_id, approval_id) DO NOTHING`,
    [row.workspaceId, row.patternId, row.approvalId, row.chainKey, row.decision, row.humanUserId, row.sourceSessionId, row.workflowRunId])
  return (r.rowCount ?? 0) > 0
}

/**
 * Support joined to the CURRENT state of its source request. Superseded or
 * no-longer-human rows read back as withdrawn.
 */
export async function listSupportSystem(db: Queryable, patternId: string): Promise<PatternSupport[]> {
  const r = await db.query<PatternSupport>(
    `SELECT s.id, s.pattern_id AS "patternId", s.approval_id AS "approvalId", s.chain_key AS "chainKey", s.decision,
            s.human_user_id AS "humanUserId", s.decided_at AS "decidedAt", a.status AS "approvalStatus"
     FROM approval_pattern_support s LEFT JOIN pending_approvals a ON a.id = s.approval_id
     WHERE s.pattern_id = $1 ORDER BY s.decided_at`,
    [patternId])
  return r.rows
}

export async function listSupportForViewer(userId: string, patternId: string): Promise<PatternSupport[]> {
  const r = await queryWithRLS<PatternSupport>(userId,
    `SELECT s.id, s.pattern_id AS "patternId", s.approval_id AS "approvalId", s.chain_key AS "chainKey", s.decision,
            s.human_user_id AS "humanUserId", s.decided_at AS "decidedAt", NULL::text AS "approvalStatus"
     FROM approval_pattern_support s WHERE s.pattern_id = $1 ORDER BY s.decided_at`,
    [patternId])
  return r.rows
}

// ── Delegated receipts ────────────────────────────────────────────────────

export type DelegatedResolution = {
  id: string
  workspaceId: string
  approvalId: string
  assignmentId: string
  assignmentRevision: number
  reviewerAssistantId: string
  delegatorUserId: string
  patternId: string
  patternVersion: number
  patternRevision: number
  supportApprovalIds: string[]
  actionDigest: string
  authority: Record<string, unknown>
  idempotencyKey: string
  requestDigest: string
  createdAt: Date
  consumedAt: Date | null
  invalidatedAt: Date | null
  invalidationReason: string | null
}

const RECEIPT_COLS = `id, workspace_id AS "workspaceId", approval_id AS "approvalId", assignment_id AS "assignmentId",
  assignment_revision AS "assignmentRevision", reviewer_assistant_id AS "reviewerAssistantId",
  delegator_user_id AS "delegatorUserId", pattern_id AS "patternId", pattern_version AS "patternVersion",
  pattern_revision::int AS "patternRevision", support_approval_ids AS "supportApprovalIds", action_digest AS "actionDigest",
  authority, idempotency_key AS "idempotencyKey", request_digest AS "requestDigest", created_at AS "createdAt",
  consumed_at AS "consumedAt", invalidated_at AS "invalidatedAt", invalidation_reason AS "invalidationReason"`

export async function insertReceipt(db: Queryable, row: Omit<DelegatedResolution, 'id' | 'createdAt' | 'consumedAt' | 'invalidatedAt' | 'invalidationReason'>): Promise<DelegatedResolution> {
  const r = await db.query<DelegatedResolution>(
    `INSERT INTO approval_delegated_resolutions (workspace_id, approval_id, assignment_id, assignment_revision, reviewer_assistant_id,
       delegator_user_id, pattern_id, pattern_version, pattern_revision, support_approval_ids, action_digest, authority,
       idempotency_key, request_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${RECEIPT_COLS}`,
    [row.workspaceId, row.approvalId, row.assignmentId, row.assignmentRevision, row.reviewerAssistantId, row.delegatorUserId,
      row.patternId, row.patternVersion, row.patternRevision, row.supportApprovalIds, row.actionDigest,
      JSON.stringify(row.authority), row.idempotencyKey, row.requestDigest])
  return r.rows[0]
}

export async function getReceiptByApproval(approvalId: string, db: Queryable = sys()): Promise<DelegatedResolution | null> {
  const r = await db.query<DelegatedResolution>(`SELECT ${RECEIPT_COLS} FROM approval_delegated_resolutions WHERE approval_id = $1`, [approvalId])
  return r.rows[0] ?? null
}

export async function getReceiptByKey(workspaceId: string, key: string, db: Queryable = sys()): Promise<DelegatedResolution | null> {
  const r = await db.query<DelegatedResolution>(
    `SELECT ${RECEIPT_COLS} FROM approval_delegated_resolutions WHERE workspace_id = $1 AND idempotency_key = $2`, [workspaceId, key])
  return r.rows[0] ?? null
}

export async function getReceiptForViewer(userId: string, approvalId: string): Promise<DelegatedResolution | null> {
  const r = await queryWithRLS<DelegatedResolution>(userId, `SELECT ${RECEIPT_COLS} FROM approval_delegated_resolutions WHERE approval_id = $1`, [approvalId])
  return r.rows[0] ?? null
}

export async function invalidateReceipt(id: string, reason: string, db: Queryable = sys()): Promise<void> {
  await db.query(
    `UPDATE approval_delegated_resolutions SET invalidated_at = now(), invalidation_reason = $2
     WHERE id = $1 AND invalidated_at IS NULL`, [id, reason.slice(0, 200)])
}

export async function markReceiptConsumed(id: string, db: Queryable = sys()): Promise<void> {
  await db.query(`UPDATE approval_delegated_resolutions SET consumed_at = coalesce(consumed_at, now()) WHERE id = $1`, [id])
}

// ── Attempts ──────────────────────────────────────────────────────────────

export type ReviewAttempt = {
  id: string
  approvalId: string
  assignmentId: string | null
  reviewerAssistantId: string | null
  trigger: 'created' | 'requested' | 'reviewer_tool'
  outcome: ReviewOutcome
  reasons: string[]
  explanation: string | null
  patternId: string | null
  createdAt: Date
}

const ATTEMPT_COLS = `id, approval_id AS "approvalId", assignment_id AS "assignmentId", reviewer_assistant_id AS "reviewerAssistantId",
  trigger, outcome, reasons, explanation, pattern_id AS "patternId", created_at AS "createdAt"`

export async function insertAttempt(db: Queryable, row: {
  workspaceId: string
  approvalId: string
  assignmentId: string | null
  reviewerAssistantId: string | null
  trigger: ReviewAttempt['trigger']
  outcome: ReviewOutcome
  reasons: string[]
  explanation: string | null
  patternId: string | null
}): Promise<ReviewAttempt> {
  const r = await db.query<ReviewAttempt>(
    `INSERT INTO approval_review_attempts (workspace_id, approval_id, assignment_id, reviewer_assistant_id, trigger, outcome, reasons, explanation, pattern_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${ATTEMPT_COLS}`,
    [row.workspaceId, row.approvalId, row.assignmentId, row.reviewerAssistantId, row.trigger, row.outcome, row.reasons,
      row.explanation?.slice(0, 2000) ?? null, row.patternId])
  return r.rows[0]
}

export async function latestAttemptsForViewer(userId: string, approvalIds: string[]): Promise<Map<string, ReviewAttempt>> {
  if (!approvalIds.length) return new Map()
  const r = await queryWithRLS<ReviewAttempt>(userId,
    `SELECT DISTINCT ON (approval_id) ${ATTEMPT_COLS} FROM approval_review_attempts
     WHERE approval_id = ANY($1::uuid[]) ORDER BY approval_id, created_at DESC`, [approvalIds])
  return new Map(r.rows.map((a) => [a.approvalId, a]))
}

// ── Attention seen-state ──────────────────────────────────────────────────

export async function markAttentionSeen(userId: string, workspaceId: string, itemKeys: string[]): Promise<void> {
  if (!itemKeys.length) return
  await sys().query(
    `INSERT INTO approval_review_attention_seen (workspace_id, user_id, item_key)
     SELECT $1, $2, k FROM unnest($3::text[]) AS k
     ON CONFLICT (workspace_id, user_id, item_key) DO UPDATE SET seen_at = now()`,
    [workspaceId, userId, itemKeys.slice(0, 200)])
}

export async function listAttentionSeen(userId: string, workspaceId: string): Promise<Set<string>> {
  const r = await queryWithRLS<{ item_key: string }>(userId,
    `SELECT item_key FROM approval_review_attention_seen WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId])
  return new Set(r.rows.map((x) => x.item_key))
}

// ── Operational routes ────────────────────────────────────────────────────

export type RouteRef = {
  kind: 'browser_profile' | 'connector_instance'
  id: string
  accountKey: string
  /** `local` routes depend on a member's machine; `remote`/`connector` are always-on. */
  locality: 'local' | 'remote' | 'connector'
  operations?: string[]
}

export type RouteBinding = {
  id: string
  workspaceId: string
  workflowId: string
  intended: RouteRef
  alternatives: RouteRef[]
  createdByUserId: string | null
  revision: number
  updatedAt: Date
}

const BINDING_COLS = `id, workspace_id AS "workspaceId", workflow_id AS "workflowId", intended, alternatives,
  created_by_user_id AS "createdByUserId", revision, updated_at AS "updatedAt"`

export async function getRouteBindingSystem(workflowId: string, db: Queryable = sys()): Promise<RouteBinding | null> {
  const r = await db.query<RouteBinding>(`SELECT ${BINDING_COLS} FROM operational_route_bindings WHERE workflow_id = $1`, [workflowId])
  return r.rows[0] ?? null
}

export async function getRouteBindingForViewer(userId: string, workflowId: string): Promise<RouteBinding | null> {
  const r = await queryWithRLS<RouteBinding>(userId, `SELECT ${BINDING_COLS} FROM operational_route_bindings WHERE workflow_id = $1`, [workflowId])
  return r.rows[0] ?? null
}

export async function upsertRouteBinding(row: {
  workspaceId: string
  workflowId: string
  intended: RouteRef
  alternatives: RouteRef[]
  userId: string
  expectedRevision: number | null
}): Promise<RouteBinding | null> {
  const r = await sys().query<RouteBinding>(
    `INSERT INTO operational_route_bindings (workspace_id, workflow_id, intended, alternatives, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workflow_id) DO UPDATE SET intended = EXCLUDED.intended, alternatives = EXCLUDED.alternatives,
       revision = operational_route_bindings.revision + 1, updated_at = now()
       WHERE $6::int IS NOT NULL AND operational_route_bindings.revision = $6
     RETURNING ${BINDING_COLS}`,
    [row.workspaceId, row.workflowId, JSON.stringify(row.intended), JSON.stringify(row.alternatives), row.userId, row.expectedRevision])
  return r.rows[0] ?? null
}

export type RouteEvent = {
  id: string
  workspaceId: string
  workflowId: string
  workflowRunId: string | null
  lostRoute: RouteRef | null
  outcome: 'selected' | 'blocked'
  selectedRoute: RouteRef | null
  blocker: string | null
  resolvedAt: Date | null
  createdAt: Date
}

const EVENT_COLS = `id, workspace_id AS "workspaceId", workflow_id AS "workflowId", workflow_run_id AS "workflowRunId",
  lost_route AS "lostRoute", outcome, selected_route AS "selectedRoute", blocker, resolved_at AS "resolvedAt", created_at AS "createdAt"`

export async function insertRouteEvent(row: Omit<RouteEvent, 'id' | 'createdAt' | 'resolvedAt'>): Promise<RouteEvent> {
  const r = await sys().query<RouteEvent>(
    `INSERT INTO operational_route_events (workspace_id, workflow_id, workflow_run_id, lost_route, outcome, selected_route, blocker)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${EVENT_COLS}`,
    [row.workspaceId, row.workflowId, row.workflowRunId, row.lostRoute ? JSON.stringify(row.lostRoute) : null, row.outcome,
      row.selectedRoute ? JSON.stringify(row.selectedRoute) : null, row.blocker])
  return r.rows[0]
}

export async function listOpenRouteBlockersForViewer(userId: string, workspaceId: string): Promise<RouteEvent[]> {
  const r = await queryWithRLS<RouteEvent>(userId,
    `SELECT ${EVENT_COLS} FROM operational_route_events
     WHERE workspace_id = $1 AND outcome = 'blocked' AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 50`, [workspaceId])
  return r.rows
}

export async function resolveRouteBlockers(workspaceId: string, workflowId: string): Promise<void> {
  await sys().query(
    `UPDATE operational_route_events SET resolved_at = now()
     WHERE workspace_id = $1 AND workflow_id = $2 AND outcome = 'blocked' AND resolved_at IS NULL`, [workspaceId, workflowId])
}

/** Schema readiness: the route answers 503 rather than half-working on an unmigrated database. */
export async function approvalReviewSchemaReady(): Promise<boolean> {
  const r = await sys().query<{ ready: boolean }>(
    `SELECT to_regclass('public.approval_delegated_resolutions') IS NOT NULL
        AND to_regclass('public.operational_route_events') IS NOT NULL AS ready`)
  return r.rows[0]?.ready === true
}
