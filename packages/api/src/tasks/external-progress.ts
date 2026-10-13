/**
 * External task progress: an external coding session (any agent on a brain
 * key, OAuth grant or authenticated REST caller) binds to an admitted task and
 * appends progress reports. Reporting-only.
 *
 * A report never: enrolls the harness as an assistant, changes the task's
 * executor, arms or duplicates native pursuit, renews allowance, alters Brief
 * direction, or completes anything from prose. Checks in a report are stored
 * as claims. The reporter is the authenticated connection; a name in the
 * payload is text, never an actor.
 *
 * Spec: docs/architecture/features/programmatic-access.md -> "Task progress reporting".
 * [COMP:api/task-external-progress]
 */
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '@use-brian/core'
import { queryWithRLS } from '../db/client.js'
import {
  appendExternalReportSystem,
  bindExternalLaneSystem,
  findExternalLaneSystem,
  type ExecutionActor,
  type ExecutionState,
} from '../db/task-execution-store.js'
import { externalFreshness, type ExternalFreshness } from './execution-control.js'

export class ExternalProgressError extends Error {
  readonly status: number
  constructor(readonly code: 'task_not_found' | 'external_execution_not_found' | 'external_report_invalid') {
    super(code)
    this.status = code === 'external_report_invalid' ? 400 : 404
  }
}

/** The reporter: who authenticated, never who the payload names. */
export type Reporter = { userId: string; actor: ExecutionActor }

export const bindSchema = z.object({
  externalExecutionId: z.string().trim().min(1).max(200),
  harness: z.string().trim().min(1).max(80),
  label: z.string().trim().max(300).optional(),
}).strict()

export const reportSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  sequence: z.number().int().nonnegative(),
  milestone: z.string().trim().min(1).max(300),
  state: z.enum(['running', 'waiting', 'blocked', 'claimed_done']),
  summary: z.string().trim().max(4000).optional(),
  artifacts: z.array(z.object({ kind: z.string().min(1).max(60), ref: z.string().min(1).max(1000) }).strict()).max(50).optional(),
  blocker: z.string().trim().max(1000).optional(),
  checks: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  observedAt: z.string().datetime().optional(),
}).strict()

/** Resolve the live head of a task the reporter can read (RLS as its user). */
async function admittedTask(reporter: Reporter, workspaceId: string, taskId: string): Promise<{ id: string }> {
  const r = await queryWithRLS<{ id: string }>(reporter.userId,
    `WITH RECURSIVE chain AS (
       SELECT id, superseded_by, valid_to FROM tasks WHERE id = $1
       UNION ALL SELECT t.id, t.superseded_by, t.valid_to FROM tasks t JOIN chain c ON t.id = c.superseded_by)
     SELECT t.id FROM tasks t WHERE t.id = (SELECT id FROM chain WHERE valid_to IS NULL LIMIT 1)
        AND t.workspace_id = $2 AND t.retracted_at IS NULL AND NOT t.scope_held`, [taskId, workspaceId])
  if (!r.rows[0]) throw new ExternalProgressError('task_not_found')
  return r.rows[0]
}

export type ExternalLaneView = {
  id: string
  taskId: string
  externalExecutionId: string
  harness: string | null
  phase: string
  freshness: ExternalFreshness
  lastReportedAt: string | null
  lastSequence: number | null
  /** The latest reported milestone and claims. Claims are not checked results. */
  latest: Record<string, unknown> | null
  remoteControl: 'not_supported'
}

function laneView(lane: ExecutionState): ExternalLaneView {
  return {
    id: lane.id, taskId: lane.taskId!, externalExecutionId: lane.externalExecutionId!, harness: lane.harness, phase: lane.phase,
    freshness: externalFreshness(lane.lastReportedAt), lastReportedAt: lane.lastReportedAt?.toISOString() ?? null,
    lastSequence: lane.lastReportSequence, latest: (lane.checkpoint as unknown as Record<string, unknown>) ?? null,
    remoteControl: 'not_supported',
  }
}

export async function bindExternalExecution(reporter: Reporter, workspaceId: string, taskId: string, input: z.infer<typeof bindSchema>) {
  const parsed = bindSchema.safeParse(input)
  if (!parsed.success) throw new ExternalProgressError('external_report_invalid')
  const task = await admittedTask(reporter, workspaceId, taskId)
  const { state, created } = await bindExternalLaneSystem({ workspaceId, taskId: task.id, externalExecutionId: parsed.data.externalExecutionId,
    harness: parsed.data.harness, label: parsed.data.label ?? null, actor: reporter.actor })
  return { created, lane: laneView(state) }
}

export async function reportExternalProgress(reporter: Reporter, workspaceId: string, taskId: string, externalExecutionId: string, input: z.infer<typeof reportSchema>) {
  const parsed = reportSchema.safeParse(input)
  if (!parsed.success) throw new ExternalProgressError('external_report_invalid')
  const task = await admittedTask(reporter, workspaceId, taskId)
  const lane = await findExternalLaneSystem(task.id, externalExecutionId)
  if (!lane) throw new ExternalProgressError('external_execution_not_found')
  const r = await appendExternalReportSystem(lane.id, {
    eventId: parsed.data.eventId, sequence: parsed.data.sequence, milestone: parsed.data.milestone, state: parsed.data.state,
    summary: parsed.data.summary ?? null, artifacts: parsed.data.artifacts ?? [], blocker: parsed.data.blocker ?? null,
    claims: parsed.data.checks ?? [], observedAt: parsed.data.observedAt ? new Date(parsed.data.observedAt) : null,
  }, reporter.actor)
  if (!r) throw new ExternalProgressError('external_execution_not_found')
  return { duplicate: r.replayed, advanced: r.advanced, lane: laneView(r.state) }
}

// --- tools (Brian and brain MCP) ----------------------------------------------------

/** The reporting identity of a tool call: the authenticated credential on brain
 *  MCP, else the assistant acting for its user. Never anything in the input. */
export function reporterFromTool(context: ToolContext): Reporter {
  return context.programmaticPrincipal
    ? { userId: context.userId, actor: { kind: 'credential', id: context.programmaticPrincipal.credentialId, origin: 'mcp', humanOrigin: false } }
    : { userId: context.userId, actor: { kind: 'assistant', id: context.assistantId, origin: 'chat', humanOrigin: false } }
}

const progressFailure = (error: unknown): { data: string; isError: true } => {
  if (error instanceof ExternalProgressError) {
    return {
      data: error.code === 'task_not_found'
        ? 'No task you can see has that id. Nothing was recorded. Find it with listTasks or getTask.'
        : error.code === 'external_execution_not_found'
          ? 'That external session is not bound to this task. Call bindExternalTaskExecution first. Nothing was recorded.'
          : 'The report was invalid. Nothing was recorded.',
      isError: true,
    }
  }
  throw error
}

export function createExternalProgressTools(): { bindExternalTaskExecution: Tool; reportTaskProgress: Tool } {
  const bindExternalTaskExecution = buildTool({
    name: 'bindExternalTaskExecution',
    requiresCapability: 'tasks',
    description: 'Bind an external coding session (for example a Codex or Claude Code run) to a task so it can report progress. Pass task_id, a stable external_execution_id for the session, and harness. Binding does not make the session the task executor and gives Brian no control over it. Idempotent for the same id.',
    inputSchema: z.object({
      task_id: z.string().uuid(), external_execution_id: z.string().min(1).max(200), harness: z.string().min(1).max(80),
      label: z.string().max(300).optional(),
    }),
    async execute(input, context) {
      if (!context.workspaceId) return { data: 'Progress reporting needs a workspace. Nothing was recorded.', isError: true }
      try {
        const r = await bindExternalExecution(reporterFromTool(context), context.workspaceId, input.task_id,
          { externalExecutionId: input.external_execution_id, harness: input.harness, label: input.label })
        return { data: `${r.created ? 'Bound' : 'Already bound'}: session ${r.lane.externalExecutionId} reports on task ${r.lane.taskId}. Brian cannot start, stop or steer it.` }
      } catch (error) { return progressFailure(error) }
    },
  })

  const reportTaskProgress = buildTool({
    name: 'reportTaskProgress',
    requiresCapability: 'tasks',
    description: 'Report progress of a bound external coding session on a task: a unique event_id, an increasing sequence, the milestone, state (running, waiting, blocked, claimed_done), and optional summary, artifacts (kind + ref, e.g. a branch or PR URL), the smallest blocker, and checks you ran. Checks are recorded as claims, not verified results, and a claimed_done report does not complete the task.',
    inputSchema: z.object({
      task_id: z.string().uuid(), external_execution_id: z.string().min(1).max(200),
      event_id: z.string().min(1).max(200), sequence: z.number().int().nonnegative(), milestone: z.string().min(1).max(300),
      state: z.enum(['running', 'waiting', 'blocked', 'claimed_done']), summary: z.string().max(4000).optional(),
      artifacts: z.array(z.object({ kind: z.string().min(1).max(60), ref: z.string().min(1).max(1000) })).max(50).optional(),
      blocker: z.string().max(1000).optional(), checks: z.array(z.string().min(1).max(500)).max(50).optional(),
    }),
    async execute(input, context) {
      if (!context.workspaceId) return { data: 'Progress reporting needs a workspace. Nothing was recorded.', isError: true }
      try {
        const r = await reportExternalProgress(reporterFromTool(context), context.workspaceId, input.task_id, input.external_execution_id, {
          eventId: input.event_id, sequence: input.sequence, milestone: input.milestone, state: input.state, summary: input.summary,
          artifacts: input.artifacts, blocker: input.blocker, checks: input.checks,
        })
        return { data: r.duplicate ? 'Already recorded (same event_id).' : r.advanced ? `Recorded; session is ${r.lane.phase}.` : 'Recorded as history (an older sequence than the latest report).' }
      } catch (error) { return progressFailure(error) }
    },
  })

  return { bindExternalTaskExecution, reportTaskProgress }
}
