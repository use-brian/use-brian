/** Native Task execution for committed routine receipts.
 * Spec: docs/architecture/features/routine-work-intake.md
 * [COMP:api/routine-intake-execution]
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  accessCeilingContains, parseAuthoringAuthority, pinAccessCeiling, pinAuthoringAuthority, WORKFLOW_SCOPE_EVIDENCE_VAR,
  type AuthoringAuthority, type ExecutionPlanDraft, type ExecutionProvenance,
} from '@use-brian/core'
import { applyRLSGucs, getPool, queryWithRLS, rollbackAndRelease } from '../db/client.js'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import { getTaskByIdSystem } from '../db/tasks.js'
import { beginIterationSystem, findActiveNativeExecutionSystem, getExecutionSystem, setExecutionPhaseSystem,
  settleIterationSystem, type ExecutionState } from '../db/task-execution-store.js'
import { resolveWorkflowAuthoringScope } from '../context-scope/workflow-authority.js'
import { validateCallerScopeEvidence } from '../context-scope/caller-evidence.js'
import { lockOperationalPolicy } from '../workspace-access/operational-admission.js'
import { validateTaskResponsibility } from './responsibility.js'
import { admitRoutineRun } from './routine-intake.js'
import { enterAssignedExecution, type EntryDeps, type QualifyTask } from '../goals/execution-qualification.js'
import { gateSessionRead } from '../session-read-authority.js'
import { findSessionById } from '../db/sessions.js'
import type { PendingApproval, PendingApprovalsStore } from '../db/pending-approvals-store.js'
import { controlExecution, type ControlEffects } from './execution-control.js'

type Receipt = { id: string; task_id: string; workspace_id: string; source_evidence: object;
  basis: { authorUserId?: string; authoringAuthority?: unknown; contextGroupId?: string; contextProjectId?: string;
    permittedActions?: string[]; requiredAccounts?: string[]; missingInputs?: { key: string; label: string }[] };
  executor: { kind: string; assistantId?: string }; run_id: string | null }

async function readReceipt(actor: string, task: QualifyTask): Promise<Receipt | null> {
  return (await queryWithRLS<Receipt>(actor,
    'SELECT * FROM task_routine_intake_receipts WHERE task_id=$1 AND workspace_id=$2', [task.id, task.workspaceId])).rows[0] ?? null
}

/** Original accepted mandate, narrowed by current source/home/executor rights.
 * Deliberately independent of the originating workflow's enabled state or existence. */
export async function verifyRoutineExecution(task: QualifyTask,
  provenance: Extract<ExecutionProvenance, { kind: 'routine_assignment' }>): Promise<AuthoringAuthority | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const policy = await lockOperationalPolicy(client, task.workspaceId)
    if (policy && policy.setupState !== 'legacy' && policy.setupState !== 'ready') return null
    const receipt = (await client.query<Receipt>('SELECT * FROM task_routine_intake_receipts WHERE id=$1 AND task_id=$2 AND workspace_id=$3 FOR SHARE',
      [provenance.receiptId, task.id, task.workspaceId])).rows[0]
    const saved = parseAuthoringAuthority(receipt?.basis.authoringAuthority)
    if (!receipt || !saved || receipt.basis.authorUserId !== provenance.actorUserId || saved.ceiling.userId !== provenance.actorUserId
      || receipt.executor.kind !== 'assistant' || receipt.executor.assistantId !== task.executorAssistantId) return null
    await applyRLSGucs(client, provenance.actorUserId)
    const current = (await client.query(`SELECT * FROM tasks WHERE id=$1 AND workspace_id=$2 AND valid_to IS NULL
      AND retracted_at IS NULL AND status NOT IN ('done','archived') FOR SHARE`, [task.id, task.workspaceId])).rows[0]
    if (!current || current.executor_assistant_id !== task.executorAssistantId) return null
    const scope = await resolveWorkflowAuthoringScope({ userId: provenance.actorUserId, workspaceId: task.workspaceId,
      assistantId: task.executorAssistantId!, authoringAuthority: saved,
      contextGroupId: receipt.basis.contextGroupId ?? null, contextProjectId: receipt.basis.contextProjectId ?? null }, client)
    await validateCallerScopeEvidence(receipt.source_evidence, pinAccessCeiling(scope.access), client)
    const taskVisible = await runWithAgentAccess(pinAccessCeiling(scope.access), () => queryWithRLS(provenance.actorUserId,
      'SELECT id FROM tasks WHERE id=$1 AND workspace_id=$2', [task.id, task.workspaceId]))
    if (!taskVisible.rows.length) return null
    const visible = (await client.query('SELECT public.routine_task_sources_visible($1) AS ok', [task.id])).rows[0]?.ok
    if (!visible) return null
    await validateTaskResponsibility(client, provenance.actorUserId, { workspaceId: task.workspaceId,
      sensitivity: current.sensitivity, compartments: current.compartments, projectIds: current.project_ids,
      privateUserId: current.user_id, privateAssistantId: current.assistant_id }, null,
    { assigneeId: current.assignee_id, executorAssistantId: current.executor_assistant_id,
      followUpMemberId: current.follow_up_member_id, home: task.home ?? null })
    // The native Task->Goal producer requires a finite source envelope. Narrow
    // the original consent to the canonical Task labels, never to defaults or
    // a broader grant learned during planning.
    const taskCeiling = { ...pinAccessCeiling(scope.access), clearance: current.sensitivity,
      compartments: current.compartments, mutationCompartments: current.compartments,
      projectIds: current.project_ids, visibilityAssistantIds: [task.executorAssistantId!] }
    if (!accessCeilingContains(pinAccessCeiling(scope.access), taskCeiling)) return null
    await client.query('COMMIT')
    return pinAuthoringAuthority({ ...scope.access, ...taskCeiling })
  } catch { return null } finally { await rollbackAndRelease(client) }
}

// Usage joins the native Task pool. This is a call-local meter, not persisted
// routine accounting. Unknown provider use keeps the native reservation.
const planningUsage = new AsyncLocalStorage<{ spend: number; metered: boolean }>()
export function noteRoutinePlanningUsage(actualCostUsd: number): void {
  const meter = planningUsage.getStore()
  if (meter) { meter.spend += actualCostUsd; meter.metered = true }
}

export function routineExecutionDeps(base: EntryDeps, workspaceBudgetOk: (workspaceId: string) => Promise<boolean>): EntryDeps {
  return { ...base, verifyRoutineProvenance: verifyRoutineExecution,
    readSources: async (actor, task) => {
      const grounded = await base.readSources(actor, task)
      const receipt = await readReceipt(actor, task)
      if (!receipt) return grounded
      const state = await findActiveNativeExecutionSystem({ taskId: task.id })
      grounded.context += `\nAccepted routine inputs: ${JSON.stringify(receipt.basis.missingInputs ?? [])}. `
        + 'For each missing input, retain its exact key in requiredInputs; mark provided=true only if the attributed answers supply it.'
      if (state?.steering.length) grounded.context += `\nAttributed human answers: ${JSON.stringify(state.steering.map(s => ({ instruction: s.instruction, byUserId: s.byUserId })))}`
      return grounded
    },
    manifest: async (assistantId, workspaceId, actor, task) => {
      const manifest = await base.manifest(assistantId, workspaceId, actor, task)
      const receipt = task ? await readReceipt(actor, task) : null
      if (!manifest || !receipt) return manifest
      const allowed = new Set(receipt.basis.permittedActions ?? [])
      return { ...manifest, tools: new Set([...manifest.tools].filter(t => allowed.has(t))) }
    },
    planner: async input => {
      const receipt = await readReceipt(input.actorUserId, input.task)
      if (!receipt) return base.planner(input)
      const state = await findActiveNativeExecutionSystem({ taskId: input.task.id })
      const missing = receipt.basis.missingInputs ?? []
      const initialWait = missing.length > 0 && !state?.steering.length
      const allowed = new Set(receipt.basis.permittedActions ?? [])
      const draft: ExecutionPlanDraft | null = initialWait ? {
        outcome: input.task.title, constraints: [], steps: [], completionEvidence: [String(input.task.attributes.completionCheck ?? '')].filter(Boolean),
        requiredOperations: [], requiredAccounts: [], requiredInputs: missing.map(m => ({ name: m.key, provided: false })),
        questions: missing.map(m => m.label),
      } : await base.planner({ ...input, manifestTools: input.manifestTools.filter(t => allowed.has(t)) })
      if (!draft) return null
      draft.requiredInputs = [...draft.requiredInputs, ...missing.filter(m => !draft.requiredInputs.some(r => r.name === m.key))
        .map(m => ({ name: m.key, provided: false }))]
      draft.requiredAccounts = [...new Set([...draft.requiredAccounts, ...(receipt.basis.requiredAccounts ?? [])])]
      // A plan naming an operation outside the accepted ceiling remains a
      // blocker even if the selected assistant happens to have that tool.
      const outside = draft.requiredOperations.filter(op => !allowed.has(op))
      if (outside.length) draft.questions.push(`Review the Task's permitted operations: ${outside.join(', ')}`)
      return draft
    },
    withRoutineQualification: async (state, operation) => {
      const task = state.taskId ? await getTaskByIdSystem(state.taskId) : null
      if (!task) return null
      const receipt = await readReceipt(String(state.authoringRef?.actorUserId), task)
      if (!receipt) return null
      const authority = await verifyRoutineExecution(task, state.authoringRef as Extract<ExecutionProvenance, { kind: 'routine_assignment' }>)
      if (!authority) return null
      const qualify = () => runWithAgentAccess(authority.ceiling, operation)
      if (receipt.basis.missingInputs?.length && !state.steering.length) return qualify()
      if (!await workspaceBudgetOk(state.workspaceId)) {
        await setExecutionPhaseSystem(state.id, 'blocked', { blocker: { reason: 'workspace_limit' }, expectedControlRevision: state.controlRevision })
        return null
      }
      // Continue can open a segment on a blocked Task; a current explicit
      // blocker is left for the human instead of retrying it in the background.
      const attempt = await beginIterationSystem(state.id)
      if (attempt.kind !== 'proceed') return null
      const meter = { spend: 0, metered: false }
      let qualification: Awaited<ReturnType<typeof operation>> | null = null
      try { qualification = await planningUsage.run(meter, qualify) }
      finally {
        const settled = await settleIterationSystem(state.id, { attemptId: attempt.inFlight.attemptId,
          actualSpend: meter.metered ? meter.spend : null, checkpoint: null,
          nextPhase: qualification?.kind === 'qualified' && qualification.plan.readiness.state === 'ready' ? 'ready' : 'waiting',
          streaks: state.streaks })
        if (settled?.kind !== 'applied') qualification = null
      }
      return qualification
    },
  }
}

/** Exact retained native preview scope for the selected executor's registry. */
export async function routineManifestScope(actor: string, task: QualifyTask) {
  const receipt = await readReceipt(actor, task)
  const authority = parseAuthoringAuthority(receipt?.basis.authoringAuthority)
  if (!receipt || !authority || !task.executorAssistantId) return null
  return resolveWorkflowAuthoringScope({ userId: actor, workspaceId: task.workspaceId, assistantId: task.executorAssistantId,
    authoringAuthority: authority, contextGroupId: receipt.basis.contextGroupId ?? null,
    contextProjectId: receipt.basis.contextProjectId ?? null })
}

/** Called by the existing workflow runner before any definition step. */
export async function advanceRoutineIntake(runId: string, deps: EntryDeps, approvals: PendingApprovalsStore) {
  // Legacy event runs can execute while this optional feature is not migrated.
  const snapshot = (await getPool().query(`SELECT to_jsonb(r)->'routine_intake_context' AS context FROM workflow_runs r WHERE id=$1`, [runId])).rows[0]?.context
  if (!snapshot) return null
  const admitted = await admitRoutineRun(runId)
  if (admitted.kind === 'not_routine') return null
  if (admitted.kind === 'refused') throw Object.assign(new Error(admitted.reason), { reason: admitted.reason })
  const task = admitted.kind === 'created' ? admitted.task : await getTaskByIdSystem(admitted.receipt.taskId)
  if (!task) throw new Error('routine_task_unavailable')
  if (task.executorAssistantId) {
    await enterAssignedExecution(task, { kind: 'routine_assignment', receiptId: admitted.receipt.id,
      actorUserId: String(admitted.receipt.basis.authorUserId), origin: 'routine', at: new Date().toISOString() }, deps)
  }
  const state = await findActiveNativeExecutionSystem({ taskId: task.id })
  if (state && !state.goalId) await ensureRoutineQuestion(state, approvals)
  return { taskId: task.id, receiptId: admitted.receipt.id, sourceEvidence: admitted.receipt.sourceEvidence,
    vars: { [WORKFLOW_SCOPE_EVIDENCE_VAR]: admitted.receipt.sourceEvidence } }
}

export async function ensureRoutineQuestion(state: ExecutionState, approvals: PendingApprovalsStore): Promise<void> {
  if (state.authoringRef?.kind !== 'routine_assignment' || state.phase !== 'waiting' || !state.taskId || state.goalId) return
  const task = await getTaskByIdSystem(state.taskId)
  const actor = String(state.authoringRef.actorUserId)
  if (!task || !await verifyRoutineExecution(task, state.authoringRef as Extract<ExecutionProvenance, { kind: 'routine_assignment' }>)) return
  const source = (await queryWithRLS<{ source_session_id: string | null }>(actor, 'SELECT source_session_id FROM tasks WHERE id=$1', [task.id])).rows[0]
  const session = source?.source_session_id ? await findSessionById(source.source_session_id) : null
  // Session-wide pickup must never widen the Task's audience. The SQL helper
  // checks the session's native audience against every retained source floor.
  const route = session && !await gateSessionRead(actor, session) && (await queryWithRLS<{ ok: boolean }>(actor,
    'SELECT public.routine_question_route_admitted($1,$2) AS ok', [task.id, session.id])).rows[0]?.ok
  if (!route) {
    await setExecutionPhaseSystem(state.id, 'waiting', { blocker: { reason: 'input_route_unavailable' }, expectedControlRevision: state.controlRevision })
    return
  }
  const question = state.plan.questions?.[0] ?? state.plan.readiness?.reasons.find(r => r.kind === 'missing_input')?.subject
  if (!question) return
  await approvals.createQuestion({ workspaceId: task.workspaceId, blockingSessionId: session!.id,
    originatingAssistantId: task.executorAssistantId!, approverUserId: actor, question,
    toolUseId: `routine_input:${state.id}:${state.controlRevision}`, deliveryChannelType: 'web', expiresAt: null,
    executionQuestion: { executionId: state.id, controlRevision: state.controlRevision, sourceTaskId: task.id } })
}

/** Native answer attribution followed by the native idempotent steer command. */
export async function answerRoutineQuestion(approval: PendingApproval, effects: ControlEffects): Promise<boolean> {
  if (approval.approvalPayload?.operation !== 'routine_input') return false
  if (!approval.respondedBy || !['approved','rejected'].includes(approval.status)) return true
  const executionId = String(approval.approvalPayload.executionId)
  const state = await getExecutionSystem(executionId)
  if (!state || state.phase === 'paused' || state.goalId) return true
  await controlExecution({ userId: approval.respondedBy, kind: 'user', id: approval.respondedBy, origin: 'ui', human: true },
    approval.workspaceId, executionId, { action: 'steer', expectedRevision: Number(approval.approvalPayload.controlRevision),
      interventionId: `routine-answer:${approval.id}`, instruction: approval.answerText ?? undefined,
      ...(approval.status === 'rejected' ? { action: 'pause' } : {}) }, effects)
  return true
}
