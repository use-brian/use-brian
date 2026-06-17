import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { PlanStepStatus, PlanStore } from './plan-types.js'

/**
 * Auto-seed (Phase 3): turn an existing decomposition signal — the worker
 * splitter's ≤3 parallel sub-task prompts — into a plan, so the completeness
 * gate has something to enforce even when a (weaker) model forgets to call
 * `setPlan`. Reuses the splitter signal only; no new per-turn LLM call
 * (locked decision C). Writes `source='auto-seed'`.
 *
 * No-ops (returns false) when `tasks` is empty or the session already has an
 * active attempt — auto-seed never clobbers a model-authored plan. See
 * `docs/architecture/context-engine/execution-plan.md` → "Auto-seed".
 */
export async function seedPlanFromTasks(
  store: PlanStore,
  ctx: { sessionId: string; userId: string; assistantId: string },
  tasks: string[],
  newAttemptId: () => string = randomUUID,
): Promise<boolean> {
  if (tasks.length === 0) return false
  const existing = await store.activeAttemptId(ctx.sessionId).catch(() => null)
  if (existing) return false
  const attemptId = newAttemptId()
  let i = 0
  for (const task of tasks) {
    await store.upsertStep({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      assistantId: ctx.assistantId,
      attemptId,
      key: `seed:${i + 1}`,
      description: task.trim().slice(0, 400),
      position: i,
      source: 'auto-seed',
    })
    i++
  }
  return true
}

/**
 * Analytics callbacks for the execution-plan write tools. Wired into the
 * analytics logger in the chat route.
 */
export type PlanToolEvent =
  | { type: 'plan_set'; attemptId: string; steps: number; revised: boolean }
  | { type: 'plan_step_update'; key: string; status: PlanStepStatus; hit: boolean }
  | { type: 'plan_abandon'; attemptId: string }

export type CreatePlanToolsOptions = {
  onEvent?: (event: PlanToolEvent) => void
  /** Override the attempt-id generator (tests). Defaults to randomUUID. */
  newAttemptId?: () => string
}

/**
 * The three execution-plan tools backed by a `PlanStore`. All write with
 * `source='tool'`. The pre-turn auto-seed writes `source='auto-seed'` and
 * lives in the chat route.
 *
 * Domain-agnostic by construction: step content comes from the model, so any
 * multi-step task is an instance (gather-then-write-up, multi-part edits,
 * batch saves, onboarding flows).
 *
 * See `docs/architecture/context-engine/execution-plan.md`.
 */
export function createPlanTools(
  store: PlanStore,
  opts?: CreatePlanToolsOptions,
): { setPlan: Tool; updatePlanStep: Tool; abandonPlan: Tool } {
  const mkAttemptId = opts?.newAttemptId ?? randomUUID

  const setPlan = buildTool({
    name: 'setPlan',
    description:
      'Lay out a multi-step task as a checklist so you (and the user) can track completeness across turns. Use it the moment a request has several parts (gather then summarize; edit several sections; save many records). Each step has a stable `kind:slug` key and a one-line description. Re-call to revise: existing steps keep their status, new keys are added, and keys you drop are marked skipped. As you work, call `updatePlanStep` to mark each `done` or `blocked`. Do not end your turn while steps are pending or in_progress unless every remaining step is blocked with a reason. Skip this for simple one-step requests.',
    inputSchema: z.object({
      steps: z
        .array(
          z.object({
            key: z
              .string()
              .min(1)
              .max(200)
              .describe('Stable step id, `kind:slug` shape, e.g. `step:gather-pricing`.'),
            description: z
              .string()
              .min(1)
              .max(400)
              .describe('One line: what finishing this step accomplishes.'),
            position: z
              .number()
              .int()
              .optional()
              .describe('Work order. Defaults to array index.'),
          }),
        )
        .min(1)
        .max(50)
        .describe('The steps, in the order you intend to work them.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      const activeId = await store
        .activeAttemptId(context.sessionId)
        .catch(() => null)
      const attemptId = activeId ?? mkAttemptId()
      const existing = activeId
        ? await store.listByAttempt(activeId).catch(() => [])
        : []
      const incoming = new Set(input.steps.map((s) => s.key))

      let i = 0
      for (const step of input.steps) {
        await store.upsertStep({
          sessionId: context.sessionId,
          userId: context.userId,
          assistantId: context.assistantId,
          attemptId,
          key: step.key,
          description: step.description,
          position: step.position ?? i,
          source: 'tool',
        })
        i++
      }

      // Reconciliation: keys dropped from a revised plan are marked skipped
      // (never silently deleted), unless already done/skipped.
      for (const row of existing) {
        if (
          !incoming.has(row.key) &&
          row.status !== 'done' &&
          row.status !== 'skipped'
        ) {
          await store.updateStepStatus({
            attemptId,
            key: row.key,
            status: 'skipped',
            note: 'Dropped on plan revision.',
          })
        }
      }

      opts?.onEvent?.({
        type: 'plan_set',
        attemptId,
        steps: input.steps.length,
        revised: activeId != null,
      })

      const verb = activeId ? 'Revised plan' : 'Started plan'
      return {
        data: `${verb} (${input.steps.length} steps): ${input.steps
          .map((s) => s.key)
          .join(', ')}`,
      }
    },
  })

  const updatePlanStep = buildTool({
    name: 'updatePlanStep',
    description:
      'Update one plan step. Set `in_progress` when you start it, `done` when finished (put the outcome in `note`), `blocked` when you genuinely cannot finish it (a `note` saying why is REQUIRED — this is the escape hatch that lets the turn end honestly), or `skipped` if it is no longer needed. Use the exact key from `setPlan` or the `# Active plan` block.',
    inputSchema: z.object({
      key: z.string().min(1).max(200).describe('The step key to update.'),
      status: z
        .enum(['pending', 'in_progress', 'done', 'blocked', 'skipped'])
        .describe('New status for the step.'),
      note: z
        .string()
        .max(2000)
        .optional()
        .describe('Result summary when done; reason when blocked (required) or skipped.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      if (input.status === 'blocked' && !input.note?.trim()) {
        return {
          data: 'Cannot mark a step blocked without a note explaining why. Re-call updatePlanStep with a note, or pick another status.',
        }
      }

      const attemptId = await store
        .activeAttemptId(context.sessionId)
        .catch(() => null)
      if (!attemptId) {
        opts?.onEvent?.({
          type: 'plan_step_update',
          key: input.key,
          status: input.status,
          hit: false,
        })
        return { data: 'No active plan in this session. Call setPlan first.' }
      }

      const row = await store.updateStepStatus({
        attemptId,
        key: input.key,
        status: input.status,
        note: input.note ?? null,
      })
      if (!row) {
        opts?.onEvent?.({
          type: 'plan_step_update',
          key: input.key,
          status: input.status,
          hit: false,
        })
        return { data: `No plan step with key "${input.key}".` }
      }

      opts?.onEvent?.({
        type: 'plan_step_update',
        key: row.key,
        status: row.status,
        hit: true,
      })
      return { data: `Step [${row.key}] -> ${row.status}` }
    },
  })

  const abandonPlan = buildTool({
    name: 'abandonPlan',
    description:
      'Archive the current plan when the user drops the task or it is no longer relevant. Stops the `# Active plan` block from appearing on later turns.',
    inputSchema: z.object({
      reason: z.string().max(400).optional().describe('Optional reason, for the audit trail.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(_input, context) {
      const attemptId = await store
        .activeAttemptId(context.sessionId)
        .catch(() => null)
      if (!attemptId) return { data: 'No active plan to abandon.' }
      await store.setAttemptState({
        sessionId: context.sessionId,
        attemptId,
        state: 'archived',
      })
      opts?.onEvent?.({ type: 'plan_abandon', attemptId })
      return { data: 'Plan abandoned.' }
    },
  })

  return { setPlan, updatePlanStep, abandonPlan }
}
