/**
 * Request facts and admission for delegated approval review.
 *
 * `loadRequestFacts` reads the native parents of a `pending_approvals` row
 * (workflow run + step + definition, source session, linked task) so the
 * descriptor is derived from what the server froze, never from model text.
 * `reviewerAdmission` decides whether the reviewing assistant may see the
 * request's source under its own clearance, Project roster and Department
 * edges. Both are system reads; viewer authority is checked separately
 * through the native approvals store.
 *
 * Spec: docs/architecture/features/approval-review.md → "Review and resolution"
 */
import { CONFIGURE_CAPABILITY, deriveActionDescriptor, type DescriptorResult } from '@use-brian/core'
import { getPool } from '../db/client.js'
import type { PendingApproval } from '../db/pending-approvals-store.js'
import type { Queryable } from '../db/approval-review-store.js'

export type RequestFacts = {
  approval: PendingApproval
  workflowId: string | null
  stepId: string | null
  taskId: string | null
  sessionId: string | null
  projectIds: string[]
  compartments: string[]
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
  descriptor: DescriptorResult
  /** Chain key: one logical example per native execution chain (D43). */
  chainKey: string
  procedure: { kind: 'workflow' | 'browser_skill'; id: string } | null
}

const RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 } as const
type Rank = keyof typeof RANK

function sensitivityOf(approval: PendingApproval): Rank {
  const v = approval.approvalPayload.sensitivity
  return v === 'public' || v === 'internal' || v === 'confidential' || v === 'restricted' ? v : 'internal'
}

function accountKeyOf(approval: PendingApproval): string | null {
  for (const v of [approval.approvalPayload.accountKey, approval.approvalPayload.mailboxAccountKey, approval.arguments?.account]) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 256)
  }
  return null
}

export async function loadRequestFacts(approval: PendingApproval, db: Queryable = getPool()): Promise<RequestFacts> {
  let workflowId: string | null = null
  let stepId: string | null = null
  let stepDefinition: unknown = null
  let taskId: string | null = null
  const projectIds = new Set<string>()
  const compartments = new Set<string>()
  if (approval.kind === 'workflow_step' && approval.workflowRunId) {
    const run = (await db.query<{ workflow_id: string; context_project_ids: string[]; context_compartments: string[]; input: Record<string, unknown>; step_id: string | null; definition: { steps?: Array<{ id: string }> } }>(
      `SELECT r.workflow_id, r.context_project_ids, r.context_compartments, r.input, s.step_id, w.definition
       FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
       LEFT JOIN workflow_step_runs s ON s.id = $2 AND s.run_id = r.id
       WHERE r.id = $1 AND r.workspace_id = $3`,
      [approval.workflowRunId, approval.workflowStepRunId, approval.workspaceId])).rows[0]
    if (run) {
      workflowId = run.workflow_id
      stepId = run.step_id
      stepDefinition = stepId ? run.definition?.steps?.find((s) => s.id === stepId) ?? null : null
      for (const p of run.context_project_ids ?? []) projectIds.add(p)
      for (const c of run.context_compartments ?? []) compartments.add(c)
      const trigger = (run.input?.trigger ?? {}) as Record<string, unknown>
      const event = (run.input?.event ?? {}) as Record<string, unknown>
      if (trigger.sourceType === 'task' && typeof event.taskId === 'string') taskId = event.taskId
    }
  }
  const sessionId = approval.blockingSessionId
  if (sessionId) {
    const s = (await db.query<{ context_project_id: string | null; context_compartments: string[] }>(
      'SELECT context_project_id, context_compartments FROM sessions WHERE id = $1 AND workspace_id = $2', [sessionId, approval.workspaceId])).rows[0]
    if (s?.context_project_id) projectIds.add(s.context_project_id)
    for (const c of s?.context_compartments ?? []) compartments.add(c)
    if (!taskId) {
      taskId = (await db.query<{ id: string }>(
        `SELECT id FROM tasks WHERE workspace_id = $1 AND source_session_id = $2 AND valid_to IS NULL ORDER BY created_at DESC LIMIT 1`,
        [approval.workspaceId, sessionId])).rows[0]?.id ?? null
    }
  }
  const descriptor = deriveActionDescriptor(approval.kind === 'workflow_step'
    ? {
        kind: 'workflow_step', toolName: approval.toolName ?? null, arguments: approval.arguments ?? {},
        workflowId, stepId, stepDefinition, accountKey: accountKeyOf(approval),
        originatingAssistantId: approval.originatingAssistantId,
        description: typeof approval.approvalPayload.description === 'string' ? approval.approvalPayload.description : null,
      }
    : approval.kind === 'browser_skill_send'
      ? { kind: 'browser_skill_send', payload: approval.approvalPayload }
      : { kind: approval.kind })
  const procedure = approval.kind === 'workflow_step' && workflowId
    ? { kind: 'workflow' as const, id: workflowId }
    : approval.kind === 'browser_skill_send' && typeof approval.approvalPayload.skillId === 'string'
      ? { kind: 'browser_skill' as const, id: approval.approvalPayload.skillId }
      : null
  return {
    approval, workflowId, stepId, taskId, sessionId,
    projectIds: [...projectIds], compartments: [...compartments],
    sensitivity: sensitivityOf(approval), descriptor, procedure,
    chainKey: approval.workflowRunId ? `run:${approval.workflowRunId}` : sessionId ? `session:${sessionId}` : `approval:${approval.id}`,
  }
}

export type ReviewerCheck =
  | { ok: true; clearance: string }
  | { ok: false; reason: 'reviewer_unavailable' | 'reviewer_lacks_configure' | 'reviewer_not_admitted' }

/**
 * The reviewer is in the workspace, holds `configure` now, and is admitted
 * to the source: clearance at least the request's sensitivity, a live roster
 * edge for every shared Project in scope, and a Department edge for every
 * Department compartment in scope.
 */
export async function reviewerAdmission(
  reviewerAssistantId: string,
  workspaceId: string,
  source: { projectIds: string[]; compartments: string[]; sensitivity: Rank },
  db: Queryable = getPool(),
  lockGrant = false,
): Promise<ReviewerCheck> {
  const assistant = (await db.query<{ clearance: string }>(
    'SELECT clearance FROM assistants WHERE id = $1 AND workspace_id = $2', [reviewerAssistantId, workspaceId])).rows[0]
  if (!assistant) return { ok: false, reason: 'reviewer_unavailable' }
  const grant = await db.query(
    `SELECT id FROM assistant_capabilities WHERE assistant_id = $1 AND capability = $2 AND revoked_at IS NULL${lockGrant ? ' FOR SHARE' : ''}`,
    [reviewerAssistantId, CONFIGURE_CAPABILITY])
  if (!grant.rows.length) return { ok: false, reason: 'reviewer_lacks_configure' }
  const clearance = (assistant.clearance in RANK ? assistant.clearance : 'internal') as Rank
  if (RANK[clearance] < RANK[source.sensitivity]) return { ok: false, reason: 'reviewer_not_admitted' }
  for (const projectId of source.projectIds) {
    const shared = (await db.query<{ shared: boolean; member: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM project_shared_scopes WHERE project_id = $1) AS shared,
              public.project_member_live($1, 'assistant', $2) AS member`, [projectId, reviewerAssistantId])).rows[0]
    if (shared?.shared && !shared.member) return { ok: false, reason: 'reviewer_not_admitted' }
  }
  for (const key of source.compartments) {
    if (!key.startsWith('team:')) continue
    const edge = await db.query(
      `SELECT 1 FROM department_edges WHERE workspace_id = $1 AND department_id = $2::uuid AND principal_kind = 'assistant'
         AND assistant_id = $3 AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
      [workspaceId, key.slice(5), reviewerAssistantId])
    if (!edge.rows.length) return { ok: false, reason: 'reviewer_not_admitted' }
  }
  return { ok: true, clearance }
}

/** The source context of a non-request assignment scope (for admission at assignment time). */
export async function scopeSourceContext(
  workspaceId: string,
  scopeKind: 'workflow' | 'browser_skill' | 'task' | 'session',
  scopeId: string,
  db: Queryable = getPool(),
): Promise<{ projectIds: string[]; compartments: string[]; sensitivity: Rank } | null> {
  if (scopeKind === 'workflow') {
    const w = (await db.query<{ context_project_id: string | null }>(
      'SELECT context_project_id FROM workflows WHERE id = $1 AND workspace_id = $2', [scopeId, workspaceId])).rows[0]
    return w ? { projectIds: w.context_project_id ? [w.context_project_id] : [], compartments: [], sensitivity: 'internal' } : null
  }
  if (scopeKind === 'browser_skill') {
    const b = await db.query('SELECT 1 FROM browser_skills WHERE id = $1 AND workspace_id = $2', [scopeId, workspaceId])
    return b.rows.length ? { projectIds: [], compartments: [], sensitivity: 'internal' } : null
  }
  if (scopeKind === 'task') {
    const t = (await db.query<{ sensitivity: string; home_kind: string | null; home_id: string | null }>(
      'SELECT sensitivity, home_kind, home_id FROM tasks WHERE id = $1 AND workspace_id = $2', [scopeId, workspaceId])).rows[0]
    if (!t) return null
    return {
      projectIds: t.home_kind === 'project' && t.home_id ? [t.home_id] : [],
      compartments: t.home_kind === 'department' && t.home_id ? [`team:${t.home_id}`] : [],
      sensitivity: (t.sensitivity in RANK ? t.sensitivity : 'internal') as Rank,
    }
  }
  const s = (await db.query<{ context_project_id: string | null; context_compartments: string[] }>(
    'SELECT context_project_id, context_compartments FROM sessions WHERE id = $1 AND workspace_id = $2', [scopeId, workspaceId])).rows[0]
  return s ? { projectIds: s.context_project_id ? [s.context_project_id] : [], compartments: s.context_compartments ?? [], sensitivity: 'internal' } : null
}
