/**
 * Task execution control: one typed command service for REST, Brian and brain
 * MCP. Inspect, pause, steer, continue.
 *
 * Authorization (tasks.md -> "Execution control", project-shared-spaces.md ->
 * "Execution control (G18)"):
 *   1. a normal read of the execution as the actor (source-aware RLS through
 *      the task), so private, protected or out-of-scope work is `not_found`;
 *   2. Project work: current admission to every shared Project the task is
 *      scoped to, as a roster member or the workspace owner (oversight), on an
 *      active scope. Non-Project work: the read above (the same membership the
 *      Goals board's controls use).
 * Admission is rechecked inside the state lock when the command applies.
 *
 * Actor, origin and human intent are server-derived. Only a human can renew
 * (steer / continue); an assistant, credential or worker may inspect and pause.
 *
 * [COMP:api/task-execution-control]
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '@use-brian/core'
import { query } from '../db/client.js'
import {
  applyControlSystem,
  getExecutionSystem,
  readExecutionForViewer,
  type ExecutionActor,
  type ExecutionReceipt,
  type ExecutionState,
  type ExecutionViewerProjection,
} from '../db/task-execution-store.js'

export type ExecutionControlErrorCode = 'execution_not_found' | 'execution_control_denied' | 'execution_request_invalid'

export class ExecutionControlError extends Error {
  readonly status: number
  constructor(readonly code: ExecutionControlErrorCode) {
    super(code)
    this.status = code === 'execution_not_found' ? 404 : code === 'execution_control_denied' ? 403 : 400
  }
}

/** Server-derived controller identity. `human` is never client-declared. */
export type ControlActor = {
  userId: string
  kind: 'user' | 'assistant' | 'credential'
  id: string
  origin: 'ui' | 'chat' | 'mcp'
  human: boolean
}

export const controlBodySchema = z.object({
  action: z.enum(['pause', 'steer', 'continue']),
  expectedRevision: z.number().int().positive(),
  interventionId: z.string().min(8).max(200),
  instruction: z.string().trim().min(1).max(4000).optional(),
}).strict()
export type ControlBody = z.infer<typeof controlBodySchema>

const FRESH_MS = 30 * 60 * 1000
const DISCONNECTED_MS = 24 * 60 * 60 * 1000

export type ExternalFreshness = 'live' | 'stale' | 'disconnected' | 'never_reported'

export function externalFreshness(lastReportedAt: Date | null, now: Date = new Date()): ExternalFreshness {
  if (!lastReportedAt) return 'never_reported'
  const age = now.getTime() - lastReportedAt.getTime()
  return age <= FRESH_MS ? 'live' : age <= DISCONNECTED_MS ? 'stale' : 'disconnected'
}

/** The Projects a target is scoped to: the task's Project home and its
 *  Project scope labels, or a standalone Goal's saved Project binding. */
async function targetProjects(state: ExecutionState): Promise<string[]> {
  if (state.taskId) {
    const r = await query<{ ids: string[] }>(
      `SELECT array_remove(array_cat(coalesce(project_ids, '{}'::uuid[]),
                CASE WHEN home_kind = 'project' THEN ARRAY[home_id] ELSE '{}'::uuid[] END), NULL) AS ids
         FROM tasks WHERE id = $1`, [state.taskId])
    return [...new Set(r.rows[0]?.ids ?? [])]
  }
  const g = await query<{ id: string | null }>('SELECT context_project_id AS id FROM goals WHERE id = $1', [state.goalId])
  return g.rows[0]?.id ? [g.rows[0].id] : []
}

/**
 * G18 control admission for one actor and target. Shared Projects require
 * live roster membership or workspace-owner oversight on an ACTIVE scope; a
 * legacy Project (no shared scope row) keeps its existing workspace authority.
 */
export async function controlAdmitted(actorUserId: string, state: ExecutionState): Promise<boolean> {
  const projects = await targetProjects(state)
  if (projects.length === 0) return true
  const r = await query<{ shared: boolean; active: boolean; member: boolean; owner: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM project_shared_scopes s WHERE s.project_id = p.id) AS shared,
            EXISTS (SELECT 1 FROM project_shared_scopes s JOIN workspaces w ON w.id = s.workspace_id
                     WHERE s.project_id = p.id AND s.workspace_id = $2 AND s.status = 'active'
                       AND w.project_shared_spaces AND w.department_read_v2) AS active,
            public.project_member_live(p.id, 'user', $3) AS member,
            EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = $2 AND m.user_id = $3 AND m.role = 'owner') AS owner
       FROM unnest($1::uuid[]) AS p(id)`, [projects, state.workspaceId, actorUserId])
  return r.rows.every(row => !row.shared || (row.active && (row.member || row.owner)))
}

export type ExecutionView = ExecutionViewerProjection & {
  canControl: boolean
  external: Array<{ id: string; externalExecutionId: string; harness: string | null; phase: string; freshness: ExternalFreshness; lastReportedAt: string | null }>
}

/** Inspect an execution the actor can read (by execution id or by task). */
export async function inspectExecution(actor: Pick<ControlActor, 'userId'>, workspaceId: string, target: { executionId: string } | { taskId: string }): Promise<ExecutionView> {
  const view = await readExecutionForViewer(actor.userId, target)
  if (!view || view.state.workspaceId !== workspaceId) throw new ExecutionControlError('execution_not_found')
  const now = new Date()
  return {
    ...view,
    canControl: view.state.lane === 'native' && await controlAdmitted(actor.userId, view.state),
    external: view.externalLanes.map(l => ({ id: l.id, externalExecutionId: l.externalExecutionId!, harness: l.harness, phase: l.phase,
      freshness: externalFreshness(l.lastReportedAt, now), lastReportedAt: l.lastReportedAt?.toISOString() ?? null })),
  }
}

export type ControlEffects = {
  /** Applied pause / steer / continue reaches the goal driver (boot). */
  afterControl?: (state: ExecutionState, kind: ControlBody['action']) => Promise<void>
}

export type ControlOutcome = {
  outcome: ExecutionReceipt['outcome']
  receipt: ExecutionReceipt
  state: ExecutionState
  renewedSegment: number | null
}

export async function controlExecution(actor: ControlActor, workspaceId: string, executionId: string, body: ControlBody, effects: ControlEffects = {}): Promise<ControlOutcome> {
  const parsed = controlBodySchema.safeParse(body)
  if (!parsed.success) throw new ExecutionControlError('execution_request_invalid')
  if (parsed.data.action === 'steer' && !parsed.data.instruction) throw new ExecutionControlError('execution_request_invalid')
  const state = await getExecutionSystem(executionId)
  if (!state || state.workspaceId !== workspaceId) throw new ExecutionControlError('execution_not_found')
  if (!(await readExecutionForViewer(actor.userId, { executionId }))) throw new ExecutionControlError('execution_not_found')
  if (!(await controlAdmitted(actor.userId, state))) throw new ExecutionControlError('execution_control_denied')

  const execActor: ExecutionActor = { kind: actor.kind, id: actor.id, origin: actor.origin, humanOrigin: actor.kind === 'user' && actor.human }
  const result = await applyControlSystem(state.id, {
    kind: parsed.data.action, interventionId: parsed.data.interventionId, expectedRevision: parsed.data.expectedRevision,
    instruction: parsed.data.instruction, actor: execActor,
  }, async (locked) => (await controlAdmitted(actor.userId, locked)) ? null : 'execution_control_denied')
  if (!result) throw new ExecutionControlError('execution_not_found')
  const outcome = result.replayed ? 'duplicate' as const : result.receipt.outcome
  if (outcome === 'applied') await effects.afterControl?.(result.state, parsed.data.action)
  return { outcome, receipt: result.receipt, state: result.state, renewedSegment: result.replayed ? null : result.receipt.renewedSegment }
}

// --- Brian tools ---------------------------------------------------------------

/** A Brian turn conveys human intent only when an attended person sent it. */
export function controlActorFromTool(context: ToolContext): ControlActor {
  if (context.programmaticPrincipal) {
    return { userId: context.userId, kind: 'credential', id: context.programmaticPrincipal.credentialId, origin: 'mcp', human: false }
  }
  const human = context.attended === true && !!context.workspaceActorUserId
  return human
    ? { userId: context.workspaceActorUserId!, kind: 'user', id: context.workspaceActorUserId!, origin: 'chat', human: true }
    : { userId: context.userId, kind: 'assistant', id: context.assistantId, origin: 'chat', human: false }
}

function summarize(view: ExecutionView): string {
  const s = view.state
  const seg = view.pool.segments.find(x => x.segmentNo === view.pool.activeSegment)
  const remaining = [
    view.pool.maxIterations !== null && seg ? `${view.pool.maxIterations - seg.iterations - seg.reservedIterations} iterations` : null,
    view.pool.maxSpend !== null && seg ? `$${(view.pool.maxSpend - seg.spent - seg.reservedSpend).toFixed(2)}` : null,
  ].filter(Boolean).join(', ')
  const lines = [
    `Execution ${s.id} (revision ${s.controlRevision}): ${s.phase}${s.blocker ? ` (${s.blocker.reason})` : ''}.`,
    `Executor: ${s.executor ? `${s.executor.kind} ${s.executor.id}` : 'unassigned'}.`,
    s.plan.readiness ? `Readiness: ${s.plan.readiness.state}${s.plan.readiness.reasons.length ? ` - ${s.plan.readiness.reasons.map(r => `${r.kind}: ${r.subject}`).join('; ')}` : ''}.` : '',
    s.checkpoint?.nextStep ? `Next step: ${s.checkpoint.nextStep}.` : s.plan.nextStep ? `Next step: ${s.plan.nextStep}.` : '',
    `Allowance left in this segment: ${remaining || 'unbounded'}; lifetime use ${view.pool.lifetime.iterations} iterations, $${view.pool.lifetime.spent.toFixed(2)}.`,
    view.children.length ? `Branches: ${view.children.map(c => `${c.childKey ?? c.id}=${c.phase}`).join(', ')}.` : '',
    view.external.length ? `External sessions (reported, not controlled by Brian): ${view.external.map(e => `${e.externalExecutionId} ${e.phase} (${e.freshness})`).join(', ')}.` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

const failure = (error: unknown): { data: string; isError: true } => {
  if (error instanceof ExecutionControlError) {
    const why = error.code === 'execution_not_found'
      ? 'No execution you can see matches that id or task. Nothing was changed. Check the task id with getTask; executions exist only for assistant-executed tasks that were assigned.'
      : error.code === 'execution_control_denied'
        ? 'You are not admitted to control this work (Project roster membership or workspace-owner oversight is required). Nothing was changed; retrying will be refused the same way.'
        : 'The control request was invalid (steer needs an instruction; pass the expected_revision from getTaskExecution). Nothing was changed.'
    return { data: why, isError: true }
  }
  throw error
}

export function createTaskExecutionTools(effects: ControlEffects = {}): { getTaskExecution: Tool; controlTaskExecution: Tool } {
  const getTaskExecution = buildTool({
    name: 'getTaskExecution',
    requiresCapability: 'goals',
    description: 'Read the live execution of an assistant-executed task: phase, readiness and the smallest missing thing, next step, branches, remaining allowance and lifetime use, the control revision, and any external coding sessions reporting on it. Pass task_id (or execution_id). Read only.',
    inputSchema: z.object({ task_id: z.string().uuid().optional(), execution_id: z.string().uuid().optional() }),
    async execute(input, context) {
      if (!context.workspaceId) return { data: 'Task execution needs a workspace-scoped conversation. Nothing was read.', isError: true }
      if (Boolean(input.task_id) === Boolean(input.execution_id)) return { data: 'Pass exactly one of task_id or execution_id. Nothing was read.', isError: true }
      try {
        const view = await inspectExecution(controlActorFromTool(context), context.workspaceId,
          input.execution_id ? { executionId: input.execution_id } : { taskId: input.task_id! })
        return { data: summarize(view) }
      } catch (error) { return failure(error) }
    },
  })

  const controlTaskExecution = buildTool({
    name: 'controlTaskExecution',
    requiresCapability: 'goals',
    description: 'Pause, steer or continue an assistant-executed task on behalf of the person in this conversation. pause stops the next action (it does not undo anything already done). steer adds an instruction to that branch and continue resumes it; both renew the shared allowance once and only work when a person sent the message you are acting on. Pass execution_id and expected_revision from getTaskExecution.',
    inputSchema: z.object({
      execution_id: z.string().uuid(),
      action: z.enum(['pause', 'steer', 'continue']),
      expected_revision: z.number().int().positive(),
      instruction: z.string().trim().min(1).max(4000).optional(),
    }),
    async execute(input, context) {
      if (!context.workspaceId) return { data: 'Task execution needs a workspace-scoped conversation. Nothing was changed.', isError: true }
      const actor = controlActorFromTool(context)
      // Retrying the same call in the same conversation replays, never renews twice.
      const interventionId = createHash('sha256')
        .update([context.sessionId, input.execution_id, input.action, input.expected_revision, input.instruction ?? ''].join('\u0000'))
        .digest('hex').slice(0, 40)
      try {
        const r = await controlExecution(actor, context.workspaceId, input.execution_id, {
          action: input.action, expectedRevision: input.expected_revision, interventionId, instruction: input.instruction,
        }, effects)
        if (r.outcome === 'stale') return { data: `Not applied: the execution changed (now revision ${r.receipt.resultRevision}). Read it again with getTaskExecution before deciding.`, isError: true }
        if (r.outcome === 'blocked') return { data: `Not applied: ${String(r.receipt.payload.reason ?? 'refused')}. Nothing was renewed.`, isError: true }
        const renewal = r.renewedSegment ? ` The shared allowance was renewed (segment ${r.renewedSegment}).` : ''
        return { data: `${input.action} ${r.outcome === 'duplicate' ? 'was already applied' : 'applied'}; execution is ${r.state.phase} at revision ${r.state.controlRevision}.${renewal}` }
      } catch (error) { return failure(error) }
    },
  })

  return { getTaskExecution, controlTaskExecution }
}
