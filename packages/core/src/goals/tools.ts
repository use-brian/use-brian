/**
 * Goal chat tools — the kickoff surface. `setGoal` mints a goal the assistant
 * pursues to a verifiable end; `listGoals` reads them. Constructed at API boot
 * with the injected `GoalStore` (the boot wiring into the global tool map is
 * the api half). Every tool requires `ctx.workspaceId`.
 *
 * Per the tool-awareness rule, no tool name appears in Layer 1; the model
 * learns about `setGoal` only when it is injected.
 *
 * [COMP:goals/tools]
 */
import { z } from 'zod'
import { isoDateOrDateTime } from '../entities/index.js'
import { buildTool, type Tool } from '../tools/types.js'
import { doneWhenSchema } from './done-when.js'
import { GOAL_HOST_TYPES, GOAL_STATUSES, type GoalHostType, type GoalStatus, type GoalStore } from './types.js'

export type GoalToolEvent =
  | { type: 'goal_created'; goalId: string }
  | { type: 'goal_listed'; resultCount: number }

export type GoalToolEventContext = {
  userId: string
  assistantId: string
  sessionId: string
  channelType: string
}

export type GoalToolOptions = {
  /** Receives every primitive event with the originating tool context. Wire to analytics at boot. */
  onEvent?: (event: GoalToolEvent, ctx: GoalToolEventContext) => void
}

const idShape = z.string().uuid()
const hostTypeEnum = z.enum([...GOAL_HOST_TYPES] as [GoalHostType, ...GoalHostType[]])
const statusEnum = z.enum([...GOAL_STATUSES] as [GoalStatus, ...GoalStatus[]])

function eventCtx(c: GoalToolEventContext): GoalToolEventContext {
  return { userId: c.userId, assistantId: c.assistantId, sessionId: c.sessionId, channelType: c.channelType }
}

function workspaceGate(workspaceId: string | null | undefined): { data: string; isError: true } | null {
  if (!workspaceId) {
    return { data: 'Goals require a workspace. Switch to a workspace-scoped chat to set goals.', isError: true }
  }
  return null
}

export function createGoalTools(store: GoalStore, opts?: GoalToolOptions): { setGoal: Tool; listGoals: Tool } {
  const setGoal = buildTool({
    name: 'setGoal',
    requiresCapability: 'goals',
    description:
      'Set a goal the assistant pursues until a VERIFIABLE end, then stops on its own. The goal drives a host object (a task/page/entity/workflow) or itself, re-running a workflow each iteration until `done_when` holds. Use this for "keep working on X until it is done", NOT for a one-off action or a passive reminder. ' +
      '`done_when` must be checkable — sub-tasks closed, or a brain/DB query — never a vague description, or the goal can never confirm completion. Returns the new goal id in `[brackets]`.',
    inputSchema: z.object({
      outcome: z.string().min(1).max(2000).describe('The end-state in one line (e.g. "Close the Acme deal").'),
      done_when: doneWhenSchema.describe(
        'The verifiable completion predicate. {"kind":"subtasks"} = all sub-tasks/sub-goals of the host are closed; {"kind":"query","query":{"predicate":{...}}} = a brain/DB condition; combine with {"all":[...]} / {"any":[...]} / {"not":...}. Must be checkable, never prose. ' +
          'Evaluated query predicates: {"hostTaskDone":true} (the bound task is done) and {"entityCount":{"kind":"company","min":20,"attributeEquals":{"key":"prospect","value":"true"}}} (at least `min` saved entities of that kind exist, optionally filtered by ONE attribute equality) — for "until N records exist" goals, have each iteration save entities with a marker attribute and this counts them. Any other query predicate is not evaluated yet and will NEVER complete the goal.',
      ),
      host_type: hostTypeEnum.optional().describe('Bind the goal to drive an existing object. Omit for a self-hosted goal measured over its own sub-goals.'),
      host_id: idShape.optional().describe('UUID of the host object — required when host_type is set.'),
      workflow_id: idShape.optional().describe('The workflow each iteration runs to make progress. Omit for a monitor goal that only watches done_when without acting.'),
      max_iterations: z.number().int().positive().max(1000).optional().describe('Hard cap on iterations before the goal blocks.'),
      max_spend: z.number().positive().optional().describe('Hard dollar cap on total spend; the goal stops on its own once it has spent this much. The primary budget for an acting goal.'),
      deadline: isoDateOrDateTime.optional().describe('Hard deadline; the goal blocks if not done by then.'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      if (Boolean(input.host_type) !== Boolean(input.host_id)) {
        return {
          data: 'host_type and host_id must be set together (or both omitted for a self-hosted goal).',
          isError: true,
        }
      }
      const goal = await store.create({
        workspaceId: context.workspaceId!,
        outcome: input.outcome,
        doneWhen: input.done_when,
        host: input.host_type ? { type: input.host_type, id: input.host_id! } : null,
        means: input.workflow_id ? { workflowId: input.workflow_id } : {},
        budget: { maxIterations: input.max_iterations, maxSpend: input.max_spend, deadline: input.deadline ?? null },
        createdByUserId: context.userId,
      })
      opts?.onEvent?.({ type: 'goal_created', goalId: goal.id }, eventCtx(context))
      return { data: `Set goal [${goal.id}]: ${goal.outcome}` }
    },
  })

  const listGoals = buildTool({
    name: 'listGoals',
    requiresCapability: 'goals',
    description: 'List goals in the current workspace, most-recently-updated first. Excludes done/abandoned goals unless include_terminal is set.',
    inputSchema: z.object({
      status: statusEnum.optional().describe('Filter to one status.'),
      host_type: hostTypeEnum.optional(),
      include_terminal: z.boolean().optional().describe('Include done/abandoned goals.'),
      limit: z.number().int().positive().max(200).optional(),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      const goals = await store.list(context.userId, context.workspaceId!, {
        status: input.status,
        hostType: input.host_type,
        includeTerminal: input.include_terminal,
        limit: input.limit,
      })
      opts?.onEvent?.({ type: 'goal_listed', resultCount: goals.length }, eventCtx(context))
      const rows = goals.map((g) => ({
        id: g.id,
        outcome: g.outcome,
        status: g.status,
        host: g.host,
        blocker: g.blockerReason,
      }))
      return { data: JSON.stringify(rows, null, 2) }
    },
  })

  return { setGoal, listGoals }
}
