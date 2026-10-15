/** Exact native workflow-refinement proposals and human configuration apply.
 * This is the configuration lane; operational learned approvals cannot use it.
 * Spec: docs/architecture/features/routine-work-intake.md
 * [COMP:api/routine-proposals]
 */
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ContextScopeAccumulator, WorkflowDefinitionSchema, WorkflowTriggerSchema, parseAuthoringAuthority, pinAccessCeiling, routineConfigurationIssues,
  routineConfigurationShape, type AuthoringAuthority, type ScopeEvidence,
} from '@use-brian/core'
import { applyRLSGucs, getPool, queryWithRLS, rollbackAndRelease } from '../db/client.js'
import { requireRoutineSchema, routineConfigurationDigest, type RoutineConfiguration } from '../db/routine-intake-store.js'
import { admitOperationalAuthoring, lockOperationalPolicy } from '../workspace-access/operational-admission.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowAuthoringScope } from '../context-scope/workflow-authority.js'
import { validateCallerScopeEvidence } from '../context-scope/caller-evidence.js'
import { validateTaskResponsibility } from './responsibility.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import type { PoolClient } from 'pg'
import { createWorkflowInTransaction } from '../db/workflow-store.js'
import { findSessionById } from '../db/sessions.js'
import { gateSessionRead } from '../session-read-authority.js'
import { createPendingApprovalsStore } from '../db/pending-approvals-store.js'

export class RoutineConfigurationError extends Error {
  constructor(readonly code: string, readonly status: number = 409) { super(code) }
}
function fail(code: string, status = 409): never { throw new RoutineConfigurationError(code, status) }

// The same optional dependency ports as native Workflow authoring. Production
// installs its actual definition/source/tool/account preflight before serving.
export type RoutinePreflightInput = {userId:string;workspaceId:string;configuration:RoutineConfiguration;authority:AuthoringAuthority;sourceEvidence:ScopeEvidence}
type RoutinePreflight = (input:RoutinePreflightInput)=>Promise<void>
let routinePreflight:RoutinePreflight|undefined
export function setRoutineConfigurationPreflight(preflight:RoutinePreflight):()=>void {
  const previous=routinePreflight
  routinePreflight=preflight
  return ()=>{routinePreflight=previous}
}

/** Supplied ONLY by a trusted authenticated route or durable tool executor. */
export type RoutineApplyActor =
  | { kind: 'ui'; userId: string; authSessionId: string }
  | { kind: 'tool'; userId: string; approvalId: string }
  | { kind: 'staged'; userId: string; approvalId: string; authSessionId: string }

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
export const newRoutineProposalCommandSchema = routineProposalCommandSchema.extend({
  name: z.string().trim().min(1).max(120),
  authoringAssistantId: z.string().uuid(),
}).strict()
export const routineDecisionCommandSchema = z.object({
  expectedRevision:z.number().int().nonnegative(),idempotencyKey:z.string().min(8).max(200),
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
  id: string; workspaceId: string; status: string; originSessionId?: string | null;
  arguments: {
    operation: 'routine_intake'; workflowId: string; expectedRevision: number; idempotencyKey: string;
    before: ReturnType<typeof routineConfigurationShape> | null; after: ReturnType<typeof routineConfigurationShape>;
    digest: string; rationale: string; uncertainties: string[]; sourceEvidence: ScopeEvidence;
    mode?: 'create'; creation?: { name: string; authoringAssistantId: string };
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
  evidence: ScopeEvidence, newAuthoringAssistantId?: string): Promise<AuthoringAuthority> {
  const old = parseAuthoringAuthority(row.authoring_authority)
  const authoringAssistantId = newAuthoringAssistantId ?? old?.assistantId
  if (!authoringAssistantId || row.managed_by) fail('routine_authoring_unavailable')
  const issues = routineConfigurationIssues(after)
  if (issues.length) fail(issues[0])
  const authority = await captureAuthoringAuthoritySystem({ userId, workspaceId: row.workspace_id, assistantId: authoringAssistantId,
    contextGroupId: after.contextGroupId, contextProjectId: after.contextProjectId }, client)
  await admitOperationalAuthoring(client, { userId, workspaceId: row.workspace_id, authoringAuthority: authority,
    contextGroupId: after.contextGroupId, contextProjectId: after.contextProjectId }, { userId, assistantId: authoringAssistantId })
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
  await routinePreflight?.({userId,workspaceId:row.workspace_id,configuration:after,authority,sourceEvidence:evidence})
  return authority
}

/** Draft is inert. Supporting source bodies never live in proposal arguments. */
export async function prepareRoutineProposal(userId: string, workflowId: string,
  command: z.input<typeof routineProposalCommandSchema>, sourceEvidence: ScopeEvidence = {}, originSessionId?:string): Promise<RoutineProposal> {
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
    // Drafting validates the current caller's preview and accepts no mandate.
    // A departed previous author must not strand an otherwise visible public
    // configuration; only the exact human apply can replace its consent.
    const retained = parseAuthoringAuthority(row.authoring_authority)
    if (!retained) fail('routine_authoring_unavailable')
    const preview = await captureAuthoringAuthoritySystem({ userId, workspaceId: row.workspace_id, assistantId: retained.assistantId,
      contextGroupId: parsed.data.configuration.contextGroupId, contextProjectId: parsed.data.configuration.contextProjectId }, client)
    const scope = await resolveWorkflowAuthoringScope({ userId, workspaceId: row.workspace_id,
      assistantId: preview.assistantId, authoringAuthority: preview,
      contextGroupId: parsed.data.configuration.contextGroupId, contextProjectId: parsed.data.configuration.contextProjectId }, client)
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
      approval_payload,delivery_channel_type,originating_assistant_id,blocking_session_id,source_session_required)
      VALUES($1,'workflow_refinement',$2,'routine_intake_configuration',$3::jsonb,$4::jsonb,'web',$5,$6,$6::uuid IS NOT NULL)
      RETURNING id,workspace_id AS "workspaceId",status,arguments`, [row.workspace_id, userId, JSON.stringify(payload),
      JSON.stringify({ kind: 'workflow_refinement', operation: 'routine_intake', workflowId,
        sensitivity: sourceEvidence.sensitivity ?? 'internal', compartments: sourceEvidence.compartments ?? [],
        projectIds: sourceEvidence.projectIds ?? [] }), retained.assistantId,await admittedRoutineSession(userId,row.workspace_id,originSessionId)])).rows[0] as RoutineProposal
    await client.query('COMMIT')
    notifyWorkspaceChange(row.workspace_id, 'approval', 'create', saved.id)
    return saved
  } finally { await rollbackAndRelease(client) }
}

export async function inspectRoutineProposal(userId: string, proposalId: string): Promise<RoutineProposal> {
  await requireRoutineSchema()
  const approval = await createPendingApprovalsStore().getById(userId,proposalId)
  if (!approval || approval.kind!=='workflow_refinement' || approval.arguments?.operation!=='routine_intake' || approval.arguments.mode==='toggle') fail('routine_not_found',404)
  const p = { id:approval.id,workspaceId:approval.workspaceId,status:approval.status,arguments:approval.arguments,originSessionId:approval.blockingSessionId } as RoutineProposal
  if (p.arguments.mode !== 'create' || p.status === 'approved') await visibleWorkflow(userId, p.arguments.workflowId)
  return p
}

/** New drafts live only in the native refinement queue. No workflow exists yet. */
export async function prepareNewRoutineProposal(userId: string, workspaceId: string,
  command: z.input<typeof newRoutineProposalCommandSchema>, sourceEvidence: ScopeEvidence = {}, originSessionId?:string): Promise<RoutineProposal> {
  const parsed = newRoutineProposalCommandSchema.safeParse(command)
  if (!parsed.success || parsed.data.expectedRevision !== 0) fail('routine_configuration_invalid', 400)
  sourceEvidence = new ContextScopeAccumulator(sourceEvidence).evidence
  await requireRoutineSchema()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    const policy = await lockOperationalPolicy(client, workspaceId)
    if (policy && policy.setupState !== 'legacy' && policy.setupState !== 'ready') fail('routine_authoring_unavailable')
    const after = routineConfigurationShape(parsed.data.configuration)
    const previewAuthority = await captureAuthoringAuthoritySystem({ userId, workspaceId, assistantId: parsed.data.authoringAssistantId,
      contextGroupId: after.contextGroupId, contextProjectId: after.contextProjectId }, client)
    const scope = await resolveWorkflowAuthoringScope({ userId, workspaceId, assistantId: previewAuthority.assistantId,
      contextGroupId: after.contextGroupId, contextProjectId: after.contextProjectId, authoringAuthority: previewAuthority }, client)
    await validateCallerScopeEvidence(sourceEvidence, pinAccessCeiling(scope.access), client)
    if (!(await client.query('SELECT routine_configuration_shape_visible($1,$2::jsonb) AS ok', [workspaceId, JSON.stringify(after)])).rows[0]?.ok) fail('routine_not_found',404)
    const existing = (await client.query(`SELECT id,workspace_id AS "workspaceId",status,arguments FROM pending_approvals
      WHERE workspace_id=$1 AND kind='workflow_refinement' AND arguments->>'operation'='routine_intake'
       AND arguments->>'mode'='create' AND arguments->>'idempotencyKey'=$2 AND approver_user_id=$3 FOR UPDATE`,
      [workspaceId, parsed.data.idempotencyKey, userId])).rows[0] as RoutineProposal | undefined
    const payload: RoutineProposal['arguments'] = { operation: 'routine_intake', mode: 'create',
      workflowId: existing?.arguments.workflowId ?? randomUUID(), expectedRevision: 0, idempotencyKey: parsed.data.idempotencyKey,
      before: null, after, digest: routineConfigurationDigest(after), rationale: parsed.data.rationale,
      uncertainties: parsed.data.uncertainties, sourceEvidence: structuredClone(sourceEvidence),
      creation: { name: parsed.data.name, authoringAssistantId: previewAuthority.assistantId } }
    if (existing) {
      if (!isDeepStrictEqual(existing.arguments, payload)) fail('routine_idempotency_conflict')
      await client.query('COMMIT')
      return existing
    }
    const saved = (await client.query(`INSERT INTO pending_approvals(workspace_id,kind,approver_user_id,tool_name,arguments,
      approval_payload,delivery_channel_type,originating_assistant_id,blocking_session_id,source_session_required)
      VALUES($1,'workflow_refinement',$2,'routine_intake_configuration',$3::jsonb,$4::jsonb,'web',$5,$6,$6::uuid IS NOT NULL)
      RETURNING id,workspace_id AS "workspaceId",status,arguments`, [workspaceId, userId, JSON.stringify(payload),
      JSON.stringify({ kind:'workflow_refinement', operation:'routine_intake', workflowId:payload.workflowId }), previewAuthority.assistantId,await admittedRoutineSession(userId,workspaceId,originSessionId)])).rows[0] as RoutineProposal
    await client.query('COMMIT')
    notifyWorkspaceChange(workspaceId,'approval','create',saved.id)
    return saved
  } finally { await rollbackAndRelease(client) }
}

async function requireHumanDecision(client: PoolClient, actor: RoutineApplyActor, workspaceId: string,
  toolName: string, args: Record<string, unknown>): Promise<void> {
  if (actor.kind === 'ui' || actor.kind === 'staged') {
    const live = await client.query(`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
      JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=$3
      WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND s.auth_version=u.auth_version FOR SHARE OF s,u,m`, [actor.authSessionId, actor.userId, workspaceId])
    if (!live.rows.length) fail('routine_human_apply_required',403)
    if (actor.kind==='ui') return
  }
  const proof = (await client.query('SELECT * FROM pending_approvals WHERE id=$1 FOR SHARE',[actor.approvalId])).rows[0]
  const human = actor.kind==='staged'
    ? proof?.kind==='staged_write' && proof.status==='pending' && proof.resolution_origin!=='delegated_assistant'
    : proof?.kind==='tool_invocation' && proof.status==='approved' && proof.resolution_origin==='human' && proof.responded_by===actor.userId
  if (!proof || !human || proof.tool_name!==toolName || proof.workspace_id!==workspaceId
    || proof.approver_user_id!==actor.userId
    || !isDeepStrictEqual(proof.arguments,args)) fail('routine_human_apply_required',403)
}

/** Exact guarded native configuration operation. Definition SQL is still
 * fenced by the database's receipt/version trigger, including owner writers. */
export async function applyRoutineProposal(actor: RoutineApplyActor, proposalId: string,
  command: { expectedRevision: number; idempotencyKey: string }): Promise<{ revision: number; replayed: boolean }> {
  if (!routineDecisionCommandSchema.safeParse(command).success) fail('routine_configuration_invalid',400)
  const visible = await inspectRoutineProposal(actor.userId, proposalId)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, actor.userId)
    await lockOperationalPolicy(client, visible.workspaceId)
    let row = (await client.query<WorkflowRow>('SELECT * FROM workflows WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
      [visible.arguments.workflowId, visible.workspaceId])).rows[0]
    const p = (await client.query(`SELECT * FROM pending_approvals WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [proposalId, visible.workspaceId])).rows[0]
    if (!p || p.approver_user_id !== actor.userId || p.arguments?.operation !== 'routine_intake') fail('routine_not_found', 404)
    await requireHumanDecision(client, actor, visible.workspaceId, 'applyRoutineIntake', {
      proposal_id: proposalId, expected_revision: command.expectedRevision, idempotency_key: command.idempotencyKey })
    if (p.arguments.expectedRevision !== command.expectedRevision) fail('routine_revision_conflict')
    const applied = p.approval_payload?.routineApply
    if (applied) {
      if (applied.idempotencyKey !== command.idempotencyKey) fail('routine_idempotency_conflict')
      await client.query('COMMIT')
      return { revision: applied.revision, replayed: true }
    }
    const creating = p.arguments.mode === 'create'
    if (p.status !== 'pending') fail('routine_revision_conflict')
    if (creating) {
      if (row || p.arguments.before !== null || command.expectedRevision !== 0 || !p.arguments.creation?.authoringAssistantId
        || !(await client.query("SELECT to_regprocedure('public.stamp_new_routine_configuration()') IS NOT NULL AS ready")).rows[0]?.ready) fail('routine_revision_conflict')
      row = { id: p.arguments.workflowId, workspace_id: visible.workspaceId, definition: p.arguments.after.definition,
        trigger: p.arguments.after.trigger, context_group_id: p.arguments.after.contextGroupId,
        context_project_id: p.arguments.after.contextProjectId, task_intake_revision:'0',
        authoring_authority:null, enabled:false, managed_by:null, task_intake_source_evidence:null }
    } else if (!row || Number(row.task_intake_revision) !== command.expectedRevision
      || !isDeepStrictEqual(p.arguments.before,routineConfigurationShape(configurationOf(row)))) fail('routine_revision_conflict')
    const parsed = configurationSchema.safeParse(p.arguments.after)
    if (!parsed.success || routineConfigurationDigest(parsed.data) !== p.arguments.digest
      || creating && !parsed.data.definition.taskIntake) fail('routine_configuration_invalid', 400)
    const authority = await admitConfiguration(client, actor.userId, row!, parsed.data, p.arguments.sourceEvidence, creating ? p.arguments.creation.authoringAssistantId : undefined)
    // No second generic confirmation: this command itself is the person's
    // exact authenticated application of the frozen proposal.
    const revision = Number(row!.task_intake_revision) + 1
    await client.query(`UPDATE pending_approvals SET status='approved',responded_at=now(),responded_by=$3,resolution_origin='human',
      approval_payload=approval_payload||jsonb_build_object('routineApply',$2::jsonb) WHERE id=$1`,
      [proposalId, JSON.stringify({ revision, idempotencyKey: command.idempotencyKey, userId: actor.userId, origin: actor.kind }), actor.userId])
    await client.query("SELECT set_config('app.routine_intake_apply_receipt',$1,true)", [proposalId])
    const after = parsed.data
    if (creating) {
      await createWorkflowInTransaction(client,row!.id,{ userId:actor.userId,workspaceId:visible.workspaceId,
        name:p.arguments.creation.name,definition:after.definition,trigger:after.trigger,
        contextGroupId:after.contextGroupId,contextProjectId:after.contextProjectId,authoringAuthority:authority },
      {authoring:{kind:'internal-human',userId:actor.userId,assistantId:authority.assistantId}})
    } else {
    await client.query(`UPDATE workflows SET definition=$2::jsonb,trigger=$3::jsonb,context_group_id=$4,context_project_id=$5,
      authoring_authority=$6::jsonb,task_intake_revision=$7,task_intake_digest=$8,task_intake_applied_by=$9,
      task_intake_applied_at=now(),task_intake_apply_receipt=$10,task_intake_source_evidence=$11::jsonb,updated_at=now() WHERE id=$1`, [row!.id,
      JSON.stringify({ ...after.definition, ...(row!.definition.layout ? { layout: row!.definition.layout } : {}) }), JSON.stringify(after.trigger),
      after.contextGroupId, after.contextProjectId, JSON.stringify(authority), revision, p.arguments.digest, actor.userId, proposalId,
      JSON.stringify(p.arguments.sourceEvidence)])
    }
    await client.query('COMMIT')
    notifyWorkspaceChange(visible.workspaceId, 'workflow', creating ? 'create' : 'update', row!.id)
    notifyWorkspaceChange(visible.workspaceId, 'approval', 'update', proposalId)
    return { revision, replayed: false }
  } finally { await rollbackAndRelease(client) }
}

export async function rejectRoutineProposal(actor: RoutineApplyActor, proposalId: string,
  command: { expectedRevision: number; idempotencyKey: string }): Promise<{ replayed: boolean }> {
  if (!routineDecisionCommandSchema.safeParse(command).success) fail('routine_configuration_invalid',400)
  const visible = await inspectRoutineProposal(actor.userId,proposalId)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client,actor.userId)
    await lockOperationalPolicy(client,visible.workspaceId)
    const p = (await client.query('SELECT * FROM pending_approvals WHERE id=$1 FOR UPDATE',[proposalId])).rows[0]
    if (!p || p.approver_user_id!==actor.userId) fail('routine_not_found',404)
    await requireHumanDecision(client,actor,visible.workspaceId,'rejectRoutineIntake',{
      proposal_id:proposalId,expected_revision:command.expectedRevision,idempotency_key:command.idempotencyKey })
    if (p.arguments.expectedRevision!==command.expectedRevision) fail('routine_revision_conflict')
    const decision = p.approval_payload?.routineReject
    if (decision) {
      if (decision.idempotencyKey!==command.idempotencyKey) fail('routine_idempotency_conflict')
      await client.query('COMMIT'); return {replayed:true}
    }
    if (p.status!=='pending') fail('routine_revision_conflict')
    await client.query(`UPDATE pending_approvals SET status='rejected',responded_at=now(),responded_by=$2,resolution_origin='human',
      approval_payload=approval_payload||jsonb_build_object('routineReject',$3::jsonb) WHERE id=$1`,
    [proposalId,actor.userId,JSON.stringify({idempotencyKey:command.idempotencyKey,userId:actor.userId})])
    await client.query('COMMIT')
    notifyWorkspaceChange(visible.workspaceId,'approval','update',proposalId)
    return {replayed:false}
  } finally { await rollbackAndRelease(client) }
}

export async function inspectRoutineConfiguration(userId: string, workflowId: string) {
  await requireRoutineSchema()
  const row = await visibleWorkflow(userId,workflowId)
  return { workflowId:row.id,workspaceId:row.workspace_id,revision:Number(row.task_intake_revision),enabled:row.enabled,
    configuration:configurationOf(row),sourceEvidence:row.task_intake_source_evidence ?? {},
    configured:!!row.definition.taskIntake && Number(row.task_intake_revision)>0 }
}

/** Exact human toggle over the native workflow flag. Never edits existing Tasks. */
export async function setRoutineIntakeEnabled(actor: RoutineApplyActor, workflowId: string,
  command: {enabled:boolean;expectedRevision:number;idempotencyKey:string}) {
  if (!routineDecisionCommandSchema.extend({enabled:z.boolean()}).safeParse(command).success) fail('routine_configuration_invalid',400)
  const visible=await visibleWorkflow(actor.userId,workflowId)
  await requireRoutineSchema()
  const client=await getPool().connect()
  try {
    await client.query('BEGIN'); await applyRLSGucs(client,actor.userId)
    await lockOperationalPolicy(client,visible.workspace_id)
    const row=(await client.query<WorkflowRow>('SELECT * FROM workflows WHERE id=$1 FOR UPDATE',[workflowId])).rows[0]
    if (!row?.definition.taskIntake || Number(row.task_intake_revision)!==command.expectedRevision) fail('routine_revision_conflict')
    await requireHumanDecision(client,actor,row.workspace_id,'setRoutineIntakeEnabled',{
      workflow_id:workflowId,enabled:command.enabled,expected_revision:command.expectedRevision,idempotency_key:command.idempotencyKey})
    const old=(await client.query(`SELECT arguments FROM pending_approvals WHERE workspace_id=$1 AND approver_user_id=$2
      AND kind='workflow_refinement' AND arguments->>'operation'='routine_intake' AND arguments->>'mode'='toggle'
      AND arguments->>'workflowId'=$3 AND arguments->>'idempotencyKey'=$4 FOR UPDATE`,
      [row.workspace_id,actor.userId,workflowId,command.idempotencyKey])).rows[0]
    if (old) {
      if (old.arguments.enabled!==command.enabled || old.arguments.expectedRevision!==command.expectedRevision) fail('routine_idempotency_conflict')
      await client.query('COMMIT'); return {enabled:row.enabled,revision:Number(row.task_intake_revision),replayed:true}
    }
    await admitConfiguration(client,actor.userId,row,configurationOf(row),row.task_intake_source_evidence ?? {})
    const shape=routineConfigurationShape(configurationOf(row))
    const args={operation:'routine_intake',mode:'toggle',workflowId,expectedRevision:command.expectedRevision,
      idempotencyKey:command.idempotencyKey,before:shape,after:shape,beforeEnabled:row.enabled,enabled:command.enabled,
      sourceEvidence:row.task_intake_source_evidence ?? {}}
    const receipt=(await client.query(`INSERT INTO pending_approvals(workspace_id,kind,approver_user_id,tool_name,arguments,
      approval_payload,delivery_channel_type,status,responded_at,responded_by,resolution_origin)
      VALUES($1,'workflow_refinement',$2,'routine_intake_configuration',$3::jsonb,'{}','web','approved',now(),$2,'human') RETURNING id`,
      [row.workspace_id,actor.userId,JSON.stringify(args)])).rows[0]
    await client.query("SELECT set_config('app.routine_intake_toggle_receipt',$1,true)",[receipt.id])
    await client.query(`UPDATE workflows SET enabled=$2,paused_reason=CASE WHEN $2 THEN NULL ELSE paused_reason END,
      updated_at=now() WHERE id=$1`,[workflowId,command.enabled])
    await client.query('COMMIT')
    notifyWorkspaceChange(row.workspace_id,'workflow','update',workflowId)
    return {enabled:command.enabled,revision:Number(row.task_intake_revision),replayed:false}
  } finally {await rollbackAndRelease(client)}
}

export async function listRoutineProposals(userId: string, workspaceId: string, workflowId?: string, originSessionId?:string): Promise<RoutineProposal[]> {
  await requireRoutineSchema()
  if (originSessionId && !await admittedRoutineSession(userId,workspaceId,originSessionId)) fail('routine_not_found',404)
  const approvals = await createPendingApprovalsStore().listPendingForWorkspace(userId,workspaceId)
  return approvals.filter(p=>p.kind==='workflow_refinement' && p.arguments?.operation==='routine_intake'
    && (!workflowId || p.arguments.workflowId===workflowId) && (!originSessionId || p.blockingSessionId===originSessionId)).slice(0,100)
    .map(p=>({id:p.id,workspaceId:p.workspaceId,status:p.status,arguments:p.arguments,originSessionId:p.blockingSessionId} as RoutineProposal))
}

async function admittedRoutineSession(userId:string,workspaceId:string,sessionId?:string):Promise<string|null> {
  if (!sessionId) return null;
  const session=await findSessionById(sessionId);
  if (!session || await gateSessionRead(userId,session)) return null;
  const assistant=(await getPool().query('SELECT workspace_id FROM assistants WHERE id=$1',[session.assistantId])).rows[0];
  return assistant?.workspace_id===workspaceId ? sessionId : null;
}
