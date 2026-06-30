/**
 * Goals routes (`docs/architecture/features/goals.md` + task-goal-autopilot.md).
 * Mounted at `/api/goals` behind `requireAuth`; RLS-scoped reads
 * (`goals_workspace_member`).
 *
 *   GET  /                — list goals for a workspace (filterable by status /
 *                           hostType / hostId — the last backs the Brain task
 *                           panel finding a task's goal)
 *   POST /:id/confirm     — arm a DRAFT goal (autopilot); optional `outcome` edit
 *   POST /:id/work        — spin up the acting loop: set the means (a chosen
 *                           workflow, or the default completion workflow) + kick off
 *
 * [COMP:api/goals-route]
 */

import { Router } from 'express'
import {
  GOAL_HOST_TYPES,
  GOAL_STATUSES,
  type GoalClarityAssessor,
  type GoalHostType,
  type GoalRecord,
  type GoalStatus,
  type GoalStore,
} from '@sidanclaw/core'
import { getGoalById, updateGoalSystem } from '../db/goals.js'
import type { WorkspaceStore } from '../db/workspace-store.js'

export type GoalsRouteOptions = {
  goalStore: GoalStore
  workspaceStore: WorkspaceStore
  /** Autopilot spin-up — build the default completion workflow + kick off the
   *  acting loop. Wired in boot; when absent, `/work` returns 501 (OSS / no
   *  acting loop). */
  createCompletionWorkflow?: (goal: GoalRecord, userId: string) => Promise<string>
  kickoffGoal?: (goalId: string) => Promise<void>
  /** Confirmation clarity gate (§12). When wired, `/confirm` returns
   *  `{ ok: false, needsClarification, question }` for a goal too vague to
   *  verify, instead of arming it. Absent (OSS / no provider) → gate skipped. */
  assessClarity?: GoalClarityAssessor
}

// Derived from the core registries (single source of truth — no hand-listed
// status / host-type sets that could drift from the Noun definition).
const STATUS_SET: ReadonlySet<string> = new Set(GOAL_STATUSES)
const HOST_TYPE_SET: ReadonlySet<string> = new Set(GOAL_HOST_TYPES)

/** Board / panel projection — drops internal fields; surfaces `confirmedAt`
 *  (draft vs armed) + `hasWorkflow` (armed vs working) so the UI can pick the
 *  right action (Confirm / Work this). */
function projectGoal(g: GoalRecord) {
  return {
    id: g.id,
    outcome: g.outcome,
    status: g.status,
    host: g.host,
    parentGoalId: g.parentGoalId,
    recipeId: g.recipeId,
    blockerReason: g.blockerReason,
    confirmedAt: g.confirmedAt ? g.confirmedAt.toISOString() : null,
    hasWorkflow: Boolean(g.means.workflowId),
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  }
}

export function goalsRoutes(opts: GoalsRouteOptions): Router {
  const router = Router()

  // GET / — goals for the workspace (RLS-scoped read; board / panel projection).
  router.get('/', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    const status =
      typeof req.query.status === 'string' && STATUS_SET.has(req.query.status)
        ? (req.query.status as GoalStatus)
        : undefined
    const hostType =
      typeof req.query.hostType === 'string' && HOST_TYPE_SET.has(req.query.hostType)
        ? (req.query.hostType as GoalHostType)
        : undefined
    const hostId = typeof req.query.hostId === 'string' ? req.query.hostId : undefined
    const includeTerminal = req.query.includeTerminal === 'true'

    const goals = await opts.goalStore.list(userId, workspaceId, {
      status,
      hostType,
      hostId,
      includeTerminal,
    })
    res.json({ goals: goals.map(projectGoal) })
  })

  // POST /:id/confirm — arm a draft goal (the user confirms its detail).
  router.post('/:id/confirm', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    // RLS-scoped membership check — `getGoalById` returns null for a non-member.
    const existing = await getGoalById(userId, req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const body = (req.body ?? {}) as { outcome?: string }
    const outcome = typeof body.outcome === 'string' && body.outcome.trim() ? body.outcome.trim() : undefined
    // Clarity gate (§12) — block confirmation of a goal an agent couldn't
    // recognise as done; surface the clarifying question for the user to answer.
    if (opts.assessClarity) {
      const verdict = await opts.assessClarity({ outcome: outcome ?? existing.outcome, userId })
      if (!verdict.clear) {
        res.json({ ok: false, needsClarification: true, question: verdict.clarifyingQuestion ?? null })
        return
      }
    }
    const goal = await updateGoalSystem(req.params.id, { confirm: true, outcome })
    res.json({ ok: true, goal: goal ? projectGoal(goal) : null })
  })

  // POST /:id/work — spin up the acting loop to work the task to done.
  router.post('/:id/work', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    if (!opts.createCompletionWorkflow || !opts.kickoffGoal) {
      res.status(501).json({ error: 'The acting loop is not available in this deployment' })
      return
    }
    const goal = await getGoalById(userId, req.params.id)
    if (!goal) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    if (!goal.confirmedAt) {
      res.status(409).json({ error: 'Confirm the goal before working the task' })
      return
    }
    const body = (req.body ?? {}) as { workflowId?: string }
    const workflowId =
      typeof body.workflowId === 'string' ? body.workflowId : await opts.createCompletionWorkflow(goal, userId)
    const updated = await updateGoalSystem(req.params.id, { means: { ...goal.means, workflowId } })
    if (!updated) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    await opts.kickoffGoal(updated.id)
    res.json({ ok: true, goal: projectGoal(updated) })
  })

  return router
}
