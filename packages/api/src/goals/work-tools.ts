/**
 * Task-autopilot chat tools — the confirm + spin-up surface (the api half;
 * these need the workflow builder + the acting-loop kickoff, so they live here,
 * not in core's `createGoalTools`). See `docs/plans/task-goal-autopilot.md`.
 *
 *   confirmGoal — arm a DRAFT goal (auto-created for a task), refining its
 *                 outcome. A goal cannot work the task until confirmed (slop
 *                 gate, §4).
 *   workTask    — spin up the assistant to work the task to done: set the goal's
 *                 means (a chosen workflow, or the simple default "complete this
 *                 task" workflow) and kick off the acting loop.
 *
 * Per the tool-awareness rule, no tool name appears in Layer 1; the model learns
 * `confirmGoal` / `workTask` only when they are injected (goals capability).
 *
 * [COMP:goals/work-tools]
 */
import { z } from 'zod'
import { buildTool, type GoalClarityAssessor, type GoalRecord, type GoalVerifier, type Tool } from '@sidanclaw/core'
import { getGoalByIdSystem, stampGoalCompletionSystem, updateGoalSystem } from '../db/goals.js'

export type GoalWorkToolsDeps = {
  /** Build the simple default "complete this task" workflow for a goal's host
   *  task, returning its id. Wired in boot to `buildOneStepReminderWorkflow`. */
  createCompletionWorkflow: (goal: GoalRecord, userId: string) => Promise<string>
  /** Arm the acting loop for a (now-confirmed, now-has-means) goal. */
  kickoffGoal: (goalId: string) => Promise<void>
  /** Confirmation clarity gate (§12). When wired, `confirmGoal` blocks a goal
   *  whose definition of done is too vague and returns a clarifying question
   *  instead of arming it. Absent (OSS / no provider) → the gate is skipped. */
  assessClarity?: GoalClarityAssessor
  /** Agentic completion verifier (§12 Phase 3). When wired, `markGoalComplete`
   *  runs it inline: a pass stamps the verified-done marker (the goal closes on
   *  the next tick); a refutation is returned to the agent, which keeps working.
   *  Absent → the tool cannot verify and refuses to stamp (fail-safe). */
  verify?: GoalVerifier
}

function workspaceGate(workspaceId: string | null | undefined): { data: string; isError: true } | null {
  if (!workspaceId) {
    return { data: 'Goals require a workspace. Switch to a workspace-scoped chat.', isError: true }
  }
  return null
}

export function createGoalWorkTools(
  deps: GoalWorkToolsDeps,
): { confirmGoal: Tool; workTask: Tool; markGoalComplete: Tool } {
  const confirmGoal = buildTool({
    name: 'confirmGoal',
    requiresCapability: 'goals',
    description:
      'Confirm (arm) a DRAFT goal that was auto-created for a task, optionally refining its outcome. A goal stays a draft and CANNOT work its task until confirmed. Use this after reviewing the drafted goal with the user (find drafts with listGoals).',
    inputSchema: z.object({
      goal_id: z.string().uuid(),
      outcome: z.string().min(1).max(2000).optional().describe('Refine the goal outcome before confirming.'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      // Clarity gate (§12) — don't arm a goal an agent couldn't recognise as
      // done. Assess the would-be outcome (the refinement, or the current one).
      if (deps.assessClarity) {
        const existing = await getGoalByIdSystem(input.goal_id)
        if (!existing) return { data: 'Goal not found.', isError: true }
        const outcome = input.outcome?.trim() || existing.outcome
        const verdict = await deps.assessClarity({ outcome, userId: context.userId })
        if (!verdict.clear) {
          return {
            data:
              `This goal isn't clear enough to work autonomously yet. ${verdict.clarifyingQuestion} ` +
              `Refine the outcome with the user, then call confirmGoal again with a clearer outcome.`,
            isError: true,
          }
        }
      }
      const goal = await updateGoalSystem(input.goal_id, { confirm: true, outcome: input.outcome })
      if (!goal) return { data: 'Goal not found.', isError: true }
      return {
        data: `Confirmed goal [${goal.id}]: ${goal.outcome}. Spin it up with workTask to have me work the task to done.`,
      }
    },
  })

  const workTask = buildTool({
    name: 'workTask',
    requiresCapability: 'goals',
    description:
      "Spin up the assistant to work a task to completion: the goal re-runs a workflow each iteration until the task is done, on its own. Requires a CONFIRMED goal (see confirmGoal). Omit workflow_id to use the simple default 'complete this task' workflow; pass one to run a specific workflow you authored.",
    inputSchema: z.object({
      goal_id: z.string().uuid(),
      workflow_id: z
        .string()
        .uuid()
        .optional()
        .describe('A specific workflow to run each iteration; omit for the default completion workflow.'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      const goal = await getGoalByIdSystem(input.goal_id)
      if (!goal) return { data: 'Goal not found.', isError: true }
      if (!goal.confirmedAt) {
        // Do NOT start autonomous work on an unconfirmed goal — clarify with the
        // user first (autopilot enforcement).
        return {
          data:
            `This task's goal is not confirmed yet, so I won't start working it autonomously. ` +
            `Clarify with the user: confirm the outcome "${goal.outcome}" is what they want (call confirmGoal), then workTask.`,
          isError: true,
        }
      }
      const workflowId = input.workflow_id ?? (await deps.createCompletionWorkflow(goal, context.userId))
      const updated = await updateGoalSystem(input.goal_id, { means: { ...goal.means, workflowId } })
      if (!updated) return { data: 'Goal not found.', isError: true }
      await deps.kickoffGoal(updated.id)
      return { data: `Working the task via goal [${updated.id}] — I'll keep running the workflow until it's done.` }
    },
  })

  // markGoalComplete — the agentic-termination signal (§12 Phase 3). The agent
  // working a `verify` goal calls this when it believes the outcome is achieved;
  // an adversarial verifier judges the claim against the goal's OUTCOME before
  // the goal closes. Pass → stamp the verified-done marker (the driver's `verify`
  // resolver reads it next tick and finishes the goal). Refuted → return the
  // refutation so the agent keeps working in-session. Never stamps without a
  // verifier pass (the §12 fail-safe invariant).
  const markGoalComplete = buildTool({
    name: 'markGoalComplete',
    requiresCapability: 'goals',
    description:
      "Declare that you believe a goal's outcome is now ACHIEVED. An independent verifier checks your reason against the goal's outcome before the goal closes, so state concretely WHAT you did that satisfies the outcome (specifics a verifier can check). If it isn't convinced, it returns what's still missing and the goal keeps working. Only call this once you have actually done the work.",
    inputSchema: z.object({
      goal_id: z.string().uuid(),
      because: z
        .string()
        .min(1)
        .max(2000)
        .describe('Concretely why the outcome is achieved — what you did, with checkable specifics.'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      if (!deps.verify) {
        // No verifier wired → cannot verify → do NOT stamp (fail-safe: a goal
        // reaches done only via a verifier pass).
        return {
          data: 'Completion verification is unavailable here; keep working toward the outcome.',
          isError: true,
        }
      }
      const goal = await getGoalByIdSystem(input.goal_id)
      if (!goal) return { data: 'Goal not found.', isError: true }
      const verdict = await deps.verify({
        outcome: goal.outcome,
        because: input.because,
        userId: context.userId,
      })
      if (!verdict.verified) {
        // Refuted → feed the refutation back; do NOT stamp. The agent continues.
        return {
          data: `Not verified as complete yet. ${verdict.refutation ?? ''} Keep working, then call markGoalComplete again once that is addressed.`,
          isError: true,
        }
      }
      const stamped = await stampGoalCompletionSystem(input.goal_id, input.because)
      if (!stamped) return { data: 'Goal not found.', isError: true }
      return { data: `Verified complete: ${goal.outcome}. The goal will close.` }
    },
  })

  return { confirmGoal, workTask, markGoalComplete }
}
