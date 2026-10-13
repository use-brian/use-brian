/** Exact native workflow-refinement proposals and human configuration apply.
 * This is the configuration lane; operational learned approvals cannot use it.
 * Spec: docs/architecture/features/routine-work-intake.md
 * [COMP:api/routine-proposals]
 */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  ContextScopeAccumulator, WorkflowDefinitionSchema, WorkflowTriggerSchema, parseAuthoringAuthority, pinAccessCeiling, routineConfigurationIssues,
  routineConfigurationShape, type AuthoringAuthority, type ScopeEvidence,
} from '@use-brian/core'
import { applyRLSGucs, getPool, queryWithRLS, rollbackAndRelease } from '../db/client.js'
import { requireRoutineSchema, routineConfigurationDigest, type RoutineConfiguration } from '../db/routine-intake-store.js'
import { lockOperationalPolicy } from '../workspace-access/operational-admission.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowAuthoringScope } from '../context-scope/workflow-authority.js'
import { validateCallerScopeEvidence } from '../context-scope/caller-evidence.js'
import { validateTaskResponsibility } from './responsibility.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import type { PoolClient } from 'pg'

export class RoutineConfigurationError extends Error {
  constructor(readonly code: string, readonly status: number = 409) { super(code) }
}
function fail(code: string, status = 409): never { throw new RoutineConfigurationError(code, status) }

/** Supplied ONLY by a trusted authenticated route or durable tool executor. */
export type RoutineApplyActor =
  | { kind: 'ui'; userId: string; authSessionId: string }
  | { kind: 'tool'; userId: string; approvalId: string }

const configurationSchema = z.object({
  definition: WorkflowDefinitionSchema,
  trigger: WorkflowTriggerSchema,
  contextGroupId: z.string().uuid().nullable(),
  contextProjectId: z.string().uuid().nullable(),
}).strict()
export const routineProposalCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(200),
  configuration: configurationSchema,
  rationale: z.string().trim().min(1).max(4000),
  uncertainties: z.array(z.string().trim().min(1).max(500)).max(40).default([]),
}).strict()

type WorkflowRow = {
  id: string; workspace_id: string; definition: RoutineConfiguration['definition']; trigger: RoutineConfiguration['trigger'];
  context_group_id: string | null; context_project_id: string | null; task_intake_revision: string;
  authoring_authority: unknown; enabled: boolean; managed_by: string | null;
  task_intake_source_evidence: ScopeEvidence | null;
}
const configurationOf = (row: WorkflowRow): RoutineConfiguration => ({ definition: row.definition, trigger: row.trigger,
  contextGroupId: row.context_group_id, contextProjectId: row.context_project_id })

export type RoutineProposal = {
  id: string; workspaceId: string; status: string;
  arguments: {
    operation: 'routine_intake'; workflowId: string; expectedRevision: number; idempotencyKey: string;
    before: ReturnType<typeof routineConfigurationShape>; after: ReturnType<typeof routineConfigurationShape>;
    digest: string; rationale: string; uncertainties: string[]; sourceEvidence: ScopeEvidence;
  }
}

async function visibleWorkflow(userId: string, workflowId: string): Promise<WorkflowRow> {
  const row = (await queryWithRLS<WorkflowRow>(userId, 'SELECT * FROM workflows WHERE id=$1', [workflowId])).rows[0]
  if (!row) fail('routine_not_found', 404)
  return row
}

/** Native configuration rights: member-visible workflow plus current authoring
 * admission for its exact home. Capturing new consent happens only on apply. */
async function admitConfiguration(client: PoolClient, userId: string, row: WorkflowRow, after: RoutineConfiguration,
  evidence: ScopeEvidence): Promise<AuthoringAuthority> {
  const old = parseAuthoringAuthority(row.authoring_authority)
  if (!old || row.managed_by) fail('routine_authoring_unavailable')
  const issues = routineConfigurationIssues(after)
  if (issues.length) fail(issues[0])
  const authority = await captureAuthoringAuthoritySystem({ userId, workspaceId: row.workspace_id, assistantId: old.assistantId,
    contextGroupId: after.contextGroupId, contextProjectId: after.contextProjectId }, client)
  const scope = await resolveWorkflowAuthoringScope({ userId, workspaceId: row.workspace_id, assistantId: authority.assistantId,
    authoringAuthority: authority, contextGroupId: after.contextGroupId, contextProjectId: after.contextProjectId }, client)
  await validateCallerScopeEvidence(evidence, pinAccessCeiling(scope.access), client)
  const config = after.definition.taskIntake
  if (config) {
    const executor = after.definition.defaultExecutor!
    await validateTaskResponsibility(client, userId, { workspaceId: row.workspace_id,
      sensitivity: evidence.sensitivity ?? 'internal', compartments: scope.writeCompartments,
      projectIds: scope.writeProjectIds, privateUserId: null, privateAssistantId: null }, null, {
      assigneeId: executor.kind === 'person' ? executor.memberId : null,
      executorAssistantId: executor.kind === 'assistant' ? executor.assistantId : null,
      followUpMemberId: null, home: config.home!,
    })
    if (executor.kind === 'person') {
      const ok = (await client.query<{ ok: boolean }>(`SELECT public.task_follow_up_eligible($1,$2,$3,$4::text[],NULL,$5,$6) AS ok`,
        [row.workspace_id, executor.memberId, evidence.sensitivity ?? 'internal', scope.writeCompartments, config.home!.kind, config.home!.id])).rows[0]?.ok
      if (!ok) fail('routine_executor_unavailable')
    }
    // A saved subscription is not a source receipt. Until the native source
    // authoring/receipt contract is integrated, do not admit unsupported kinds.
    if (after.trigger.kind === 'event' && after.trigger.event.sources.some(s => !['task', 'knowledge', 'crm'].includes(s.source.type))) {
      fail('routine_source_authoring_not_ready')
    }
  }
  return authority
}

/** Draft is inert. Supporting source bodies never live in proposal arguments. */
export async function prepareRoutineProposal(userId: string, workflowId: string,
  command: z.input<typeof routineProposalCommandSchema>, sourceEvidence: ScopeEvidence = {}): Promise<RoutineProposal> {
  const parsed = routineProposalCommandSchema.safeParse(command)
  if (!parsed.success) fail('routine_configuration_invalid', 400)
  await requireRoutineSchema()
  const observed = await visibleWorkflow(userId, workflowId)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    await lockOperationalPolicy(client, observed.workspace_id)
    const row = (await client.query<WorkflowRow>('SELECT * FROM workflows WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
      [workflowId, observed.workspace_id])).rows[0]
    if (!row || Number(row.task_intake_revision) !== parsed.data.expectedRevision) fail('routine_revision_conflict')
    const combined = new ContextScopeAccumulator(row.task_intake_source_evidence)
    combined.note(sourceEvidence)
    sourceEvidence = combined.evidence
    const readable = (await client.query<{ ok: boolean }>(`SELECT routine_configuration_shape_visible($1,$2::jsonb)
      AND workflow_scope_evidence_visible($1,$3::jsonb) AS ok`,
      [row.workspace_id, JSON.stringify(routineConfigurationShape(configurationOf(row))), JSON.stringify(sourceEvidence)])).rows[0]?.ok
    if (!readable) fail('routine_not_found', 404)
    // Drafting confers no fresh consent. Only validate support against the
    // original retained native authoring envelope.
    const retained = parseAuthoringAuthority(row.authoring_authority)
    if (!retained) fail('routine_authoring_unavailable')
    const scope = await resolveWorkflowAuthoringScope({ userId: retained.ceiling.userId!, workspaceId: row.workspace_id,
      assistantId: retained.assistantId, authoringAuthority: retained,
      contextGroupId: row.context_group_id, contextProjectId: row.context_project_id }, client)
    await validateCallerScopeEvidence(sourceEvidence, pinAccessCeiling(scope.access), client)
    const after = routineConfigurationShape(parsed.data.configuration)
    const payload: RoutineProposal['arguments'] = { operation: 'routine_intake', workflowId,
      expectedRevision: parsed.data.expectedRevision, idempotencyKey: parsed.data.idempotencyKey,
      before: routineConfigurationShape(configurationOf(row)), after,
      digest: routineConfigurationDigest(after), rationale: parsed.data.rationale,
      uncertainties: parsed.data.uncertainties, sourceEvidence: structuredClone(sourceEvidence) }
    const existing = (await client.query(`SELECT id,workspace_id AS "workspaceId",status,arguments FROM pending_approvals
      WHERE workspace_id=$1 AND kind='workflow_refinement' AND arguments->>'operation'='routine_intake'
        AND arguments->>'workflowId'=$2 AND arguments->>'idempotencyKey'=$3 FOR UPDATE`,
      [row.workspace_id, workflowId, payload.idempotencyKey])).rows[0] as RoutineProposal | undefined
    if (existing) {
      if (!isDeepStrictEqual(existing.arguments, payload)) fail('routine_idempotency_conflict')
      await client.query('COMMIT')
      return existing
    }
    const saved = (await client.query(`INSERT INTO pending_approvals(workspace_id,kind,approver_user_id,tool_name,arguments,
      approval_payload,delivery_channel_type,originating_assistant_id)
      VALUES($1,'workflow_refinement',$2,'routine_intake_configuration',$3::jsonb,$4::jsonb,'web',$5)
      RETURNING id,workspace_id AS "workspaceId",status,arguments`, [row.workspace_id, userId, JSON.stringify(payload),
      JSON.stringify({ kind: 'workflow_refinement', operation: 'routine_intake', workflowId,
        sensitivity: sourceEvidence.sensitivity ?? 'internal', compartments: sourceEvidence.compartments ?? [],
        projectIds: sourceEvidence.projectIds ?? [] }), retained.assistantId])).rows[0] as RoutineProposal
    await client.query('COMMIT')
    notifyWorkspaceChange(row.workspace_id, 'approval', 'create', saved.id)
    return saved
  } finally { await rollbackAndRelease(client) }
}

export async function inspectRoutineProposal(userId: string, proposalId: string): Promise<RoutineProposal> {
  const p = (await queryWithRLS<RoutineProposal>(userId, `SELECT id,workspace_id AS "workspaceId",status,arguments
    FROM pending_approvals WHERE id=$1 AND kind='workflow_refinement' AND arguments->>'operation'='routine_intake'`, [proposalId])).rows[0]
  if (!p) fail('routine_not_found', 404)
  await visibleWorkflow(userId, p.arguments.workflowId)
  return p
}

/** Exact guarded native configuration operation. Definition SQL is still
 * fenced by the database's receipt/version trigger, including owner writers. */
export async function applyRoutineProposal(actor: RoutineApplyActor, proposalId: string,
  command: { expectedRevision: number; idempotencyKey: string }): Promise<{ revision: number; replayed: boolean }> {
  const visible = await inspectRoutineProposal(actor.userId, proposalId)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, actor.userId)
    await lockOperationalPolicy(client, visible.workspaceId)
    const row = (await client.query<WorkflowRow>('SELECT * FROM workflows WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
      [visible.arguments.workflowId, visible.workspaceId])).rows[0]
    const p = (await client.query(`SELECT * FROM pending_approvals WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [proposalId, visible.workspaceId])).rows[0]
    if (!row || !p || p.approver_user_id !== actor.userId || p.arguments?.operation !== 'routine_intake') fail('routine_not_found', 404)
    if (actor.kind === 'ui') {
      const live = await client.query(`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
        JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=$3
        WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND s.auth_version=u.auth_version FOR SHARE OF s,u,m`, [actor.authSessionId, actor.userId, row.workspace_id])
      if (!live.rows.length) fail('routine_human_apply_required', 403)
    } else {
      const proof = (await client.query(`SELECT * FROM pending_approvals WHERE id=$1 FOR SHARE`, [actor.approvalId])).rows[0]
      if (!proof || proof.kind !== 'tool_invocation' || proof.tool_name !== 'applyRoutineIntake'
        || proof.workspace_id !== row.workspace_id || proof.approver_user_id !== actor.userId
        || proof.status !== 'approved' || proof.resolution_origin !== 'human'
        || !isDeepStrictEqual(proof.arguments, { proposal_id: proposalId, expected_revision: command.expectedRevision, idempotency_key: command.idempotencyKey })) {
        fail('routine_human_apply_required', 403)
      }
    }
    if (p.arguments.expectedRevision !== command.expectedRevision) fail('routine_revision_conflict')
    const applied = p.approval_payload?.routineApply
    if (applied) {
      if (applied.idempotencyKey !== command.idempotencyKey) fail('routine_idempotency_conflict')
      await client.query('COMMIT')
      return { revision: applied.revision, replayed: true }
    }
    if (p.status !== 'pending' || Number(row.task_intake_revision) !== command.expectedRevision
      || !isDeepStrictEqual(p.arguments.before, routineConfigurationShape(configurationOf(row)))) fail('routine_revision_conflict')
    const parsed = configurationSchema.safeParse(p.arguments.after)
    if (!parsed.success || routineConfigurationDigest(parsed.data) !== p.arguments.digest) fail('routine_configuration_invalid', 400)
    const authority = await admitConfiguration(client, actor.userId, row, parsed.data, p.arguments.sourceEvidence)
    // No second generic confirmation: this command itself is the person's
    // exact authenticated application of the frozen proposal.
    const revision = Number(row.task_intake_revision) + 1
    await client.query(`UPDATE pending_approvals SET status='approved',responded_at=now(),resolution_origin='human',
      approval_payload=approval_payload||jsonb_build_object('routineApply',$2::jsonb) WHERE id=$1`,
      [proposalId, JSON.stringify({ revision, idempotencyKey: command.idempotencyKey, userId: actor.userId, origin: actor.kind })])
    await client.query("SELECT set_config('app.routine_intake_apply_receipt',$1,true)", [proposalId])
    const after = parsed.data
    await client.query(`UPDATE workflows SET definition=$2::jsonb,trigger=$3::jsonb,context_group_id=$4,context_project_id=$5,
      authoring_authority=$6::jsonb,task_intake_revision=$7,task_intake_digest=$8,task_intake_applied_by=$9,
      task_intake_applied_at=now(),task_intake_apply_receipt=$10,task_intake_source_evidence=$11::jsonb,updated_at=now() WHERE id=$1`, [row.id,
      JSON.stringify({ ...after.definition, ...(row.definition.layout ? { layout: row.definition.layout } : {}) }), JSON.stringify(after.trigger),
      after.contextGroupId, after.contextProjectId, JSON.stringify(authority), revision, p.arguments.digest, actor.userId, proposalId,
      JSON.stringify(p.arguments.sourceEvidence)])
    await client.query('COMMIT')
    notifyWorkspaceChange(row.workspace_id, 'workflow', 'update', row.id)
    notifyWorkspaceChange(row.workspace_id, 'approval', 'update', proposalId)
    return { revision, replayed: false }
  } finally { await rollbackAndRelease(client) }
}
