/**
 * Goals routes (`docs/architecture/features/goals.md` + task-goal-autopilot.md).
 * Mounted at `/api/goals` behind `requireAuth`; RLS-scoped reads
 * (`goals_workspace_member`).
 *
 *   GET  /                — list goals for a workspace (filterable by status /
 *                           hostType / hostId — the last backs the Brain task
 *                           panel finding a task's goal — and `confirmed`, the
 *                           §8 draft-vs-armed split; rows carry `hostTitle`)
 *   GET  /:id             — one goal's richer detail (the board drill-down):
 *                           the acceptance contract (doneWhen / budget / policy /
 *                           means) + the verified completion claim + the triage
 *                           brief (§8)
 *   POST /:id/confirm     — arm a DRAFT goal (autopilot); optional `outcome` /
 *                           `verification` / `approach` edits (§8)
 *   POST /:id/outcome     — edit the goal's outcome text (draft or armed); a
 *                           completed goal is refused (409)
 *   PUT  /:id/context     — bind an unset Team/Project axis; existing bindings
 *                           are immutable and can never be widened or switched
 *   POST /:id/work        — spin up the acting loop: set the means (a chosen
 *                           workflow, or the default completion workflow) + kick off
 *   POST /:id/abandon     — discard a goal (drafts / active goals the user no
 *                           longer wants); reversible — sets status='abandoned'
 *
 * [COMP:api/goals-route]
 */

import { Router } from 'express'
import { z } from 'zod'
import {
  GOAL_HOST_TYPES,
  GOAL_STATUSES,
  scopeGrantContains,
  type GoalBrief,
  type GoalClarityAssessor,
  type GoalHostType,
  type GoalListRow,
  type GoalRecord,
  type GoalStatus,
  type GoalStore,
} from '@use-brian/core'
import {
  getGoalById,
  narrowGoalContextSystem,
  setGoalStatusSystem,
  updateGoalSystem,
} from '../db/goals.js'
import {
  createDbContextScopeStore,
  type ContextScopeStore,
} from '../db/context-scope-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import {
  assertContextActivationReady,
  ContextActivationBlockedError,
  type ContextReadiness,
} from '../context-scope/context-readiness.js'
import type { GoalActivityFrame } from '../goals/activity.js'

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
  resolveAssistantId?: (userId: string, workspaceId: string) => Promise<string | undefined>
  contextStore?: Pick<
    ContextScopeStore,
    'getTeamSystem' | 'getProjectSystem' | 'resolveMemberTeamPrincipalSystem'
  >
  getReadiness?: (workspaceId: string) => Promise<ContextReadiness>
  /** Goal-scoped live activity bus. Optional keeps route unit tests/embedders inert. */
  subscribeActivity?: (params: {
    goalId: string
    callback: (frame: GoalActivityFrame) => void
  }) => () => void
}

// Derived from the core registries (single source of truth — no hand-listed
// status / host-type sets that could drift from the Noun definition).
const STATUS_SET: ReadonlySet<string> = new Set(GOAL_STATUSES)
const HOST_TYPE_SET: ReadonlySet<string> = new Set(GOAL_HOST_TYPES)
const goalContextBody = z.object({
  contextGroupId: z.string().uuid().nullable(),
  contextProjectId: z.string().uuid().nullable(),
}).strict()

/** Board / panel projection — drops internal fields; surfaces `confirmedAt`
 *  (draft vs armed) + `hasWorkflow` (armed vs working) so the UI can pick the
 *  right action (Confirm / Work this), plus `hostTitle` on list rows (the
 *  triage surface labels drafts by their task). */
function projectGoal(g: GoalRecord | GoalListRow) {
  return {
    id: g.id,
    outcome: g.outcome,
    status: g.status,
    host: g.host,
    hostTitle: 'hostTitle' in g ? (g.hostTitle ?? null) : null,
    parentGoalId: g.parentGoalId,
    recipeId: g.recipeId,
    blockerReason: g.blockerReason,
    contextGroupId: g.contextGroupId,
    contextProjectId: g.contextProjectId,
    confirmedAt: g.confirmedAt ? g.confirmedAt.toISOString() : null,
    hasWorkflow: Boolean(g.means.workflowId),
    /** The chat session the goal originated from (in-chat pursuit anchor). */
    originSessionId: g.originSessionId,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  }
}

/** Drill-down projection — the board projection plus the full acceptance
 *  contract (`doneWhen` / `budget` / `policy` / `means`), the verified
 *  completion claim (`completionClaim`, already ISO-stamped), and the triage
 *  brief (§8 — the editable verification/approach on the triage pane). Backs
 *  the goal-detail page. */
function projectGoalDetail(g: GoalRecord) {
  return {
    ...projectGoal(g),
    doneWhen: g.doneWhen,
    means: g.means,
    budget: g.budget,
    policy: g.policy,
    completionClaim: g.completionClaim,
    brief: g.brief,
  }
}

export function goalsRoutes(opts: GoalsRouteOptions): Router {
  const router = Router()
  const contextStore = opts.contextStore ?? createDbContextScopeStore()

  // GET /:id/stream — authenticated live activity for one acting goal.
  // The RLS read is the authority gate; activity itself is ephemeral and
  // best-effort. A status poll closes the stream even if a terminal NOTIFY is
  // missed across instances.
  router.get('/:id/stream', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const goal = await getGoalById(userId, req.params.id)
    if (!goal) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    let closed = false
    let unsubscribe = () => {}
    let poll: NodeJS.Timeout | null = null
    let heartbeat: NodeJS.Timeout | null = null
    let lastStatus = goal.status
    const terminal = (status: GoalStatus) =>
      status === 'done' || status === 'blocked' || status === 'abandoned'
    const send = (event: string, data: unknown) => {
      if (closed || res.writableEnded) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const close = () => {
      if (closed) return
      closed = true
      if (poll) clearInterval(poll)
      if (heartbeat) clearInterval(heartbeat)
      unsubscribe()
      if (!res.writableEnded) res.end()
    }

    send('status', { status: goal.status })
    if (terminal(goal.status)) {
      send('done', { status: goal.status, reason: goal.blockerReason })
      close()
      return
    }

    const subscribed = opts.subscribeActivity?.({
      goalId: goal.id,
      callback: (frame) => {
        send(frame.event, frame.data)
        if (frame.event === 'done') close()
      },
    }) ?? (() => {})
    unsubscribe = subscribed
    if (closed) unsubscribe()

    poll = setInterval(() => {
      void getGoalById(userId, goal.id).then((current) => {
        if (!current) {
          close()
          return
        }
        if (current.status !== lastStatus) {
          lastStatus = current.status
          send('status', { status: current.status })
        }
        if (terminal(current.status)) {
          send('done', { status: current.status, reason: current.blockerReason })
          close()
        }
      }).catch(() => {
        // The next poll retries. Activity delivery never changes goal state.
      })
    }, 5_000)
    poll.unref?.()
    heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(': ping\n\n')
    }, 25_000)
    heartbeat.unref?.()
    req.on('close', close)
  })

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
    // Draft-vs-armed split (§8): the triage surface lists confirmed=false,
    // the Autopilot board lists confirmed=true. Omitted = both (back-compat).
    const confirmed =
      req.query.confirmed === 'true' ? true : req.query.confirmed === 'false' ? false : undefined
    // In-chat pursuit: the transcript lists the goals born in its session.
    const originSessionId =
      typeof req.query.originSessionId === 'string' && req.query.originSessionId.length > 0
        ? req.query.originSessionId
        : undefined

    const goals = await opts.goalStore.list(userId, workspaceId, {
      status,
      hostType,
      hostId,
      includeTerminal,
      confirmed,
      originSessionId,
    })
    res.json({ goals: goals.map(projectGoal) })
  })

  // GET /:id — one goal's richer detail (the board drill-down). RLS-scoped:
  // `getGoalById` returns null for a non-member, so a stranger gets a 404 (not
  // a leak that the id exists).
  router.get('/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const goal = await getGoalById(userId, req.params.id)
    if (!goal) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    res.json({ goal: projectGoalDetail(goal) })
  })

  // PUT /:id/context — a goal may narrow an unset inherited axis before its
  // acting workflow starts. Clearing or switching an existing binding would
  // rewrite the audit boundary, so both are rejected. The final write is also
  // guarded atomically in narrowGoalContextSystem.
  router.put('/:id/context', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const parsed = goalContextBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues })
      return
    }
    const existing = await getGoalById(userId, req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    if (
      existing.means.workflowId
      || ['running', 'awaiting_approval', 'done', 'abandoned'].includes(existing.status)
    ) {
      res.status(409).json({ error: 'goal_context_locked' })
      return
    }

    const nextGroupId = parsed.data.contextGroupId
    const nextProjectId = parsed.data.contextProjectId
    if (
      (existing.contextGroupId !== null && nextGroupId !== existing.contextGroupId)
      || (existing.contextProjectId !== null && nextProjectId !== existing.contextProjectId)
    ) {
      res.status(409).json({ error: 'goal_context_cannot_widen' })
      return
    }

    const [team, project, principal] = await Promise.all([
      nextGroupId ? contextStore.getTeamSystem(existing.workspaceId, nextGroupId) : null,
      nextProjectId ? contextStore.getProjectSystem(existing.workspaceId, nextProjectId) : null,
      contextStore.resolveMemberTeamPrincipalSystem(userId, existing.workspaceId),
    ])
    if (!principal) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    if (
      (nextGroupId && (!team || team.status !== 'active'
        || !scopeGrantContains(principal.grant, [team.compartmentKey])))
      || (nextProjectId && (!project || project.status !== 'active'))
    ) {
      res.status(404).json({ error: 'context_not_available' })
      return
    }

    try {
      if (nextGroupId || nextProjectId) {
        await assertContextActivationReady(existing.workspaceId, opts.getReadiness)
      }
      const goal = await narrowGoalContextSystem(
        existing.id,
        nextGroupId,
        nextProjectId,
      )
      if (!goal) {
        res.status(409).json({ error: 'goal_context_cannot_widen' })
        return
      }
      res.json({ ok: true, goal: projectGoal(goal) })
    } catch (error) {
      if (error instanceof ContextActivationBlockedError) {
        res.status(409).json({ error: error.code, failedChecks: error.failedChecks })
        return
      }
      throw error
    }
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
    const body = (req.body ?? {}) as { outcome?: string; verification?: string; approach?: string }
    const outcome = typeof body.outcome === 'string' && body.outcome.trim() ? body.outcome.trim() : undefined
    // Triage-brief edits (§8): the triage pane lets the user amend the judge's
    // verification / approach before arming. Merge onto the existing brief;
    // an edit with no existing brief still persists one (judgeReason empty).
    const verification =
      typeof body.verification === 'string' && body.verification.trim() ? body.verification.trim() : undefined
    const approach = typeof body.approach === 'string' && body.approach.trim() ? body.approach.trim() : undefined
    const brief: GoalBrief | undefined =
      verification !== undefined || approach !== undefined
        ? {
            verification: verification ?? existing.brief?.verification ?? '',
            approach: approach ?? existing.brief?.approach ?? '',
            judgeReason: existing.brief?.judgeReason ?? '',
          }
        : undefined
    // Clarity gate (§12, widened §8) — block confirmation of a configuration an
    // agent couldn't work; surface the clarifying question for the user.
    if (opts.assessClarity) {
      const effectiveBrief = brief ?? existing.brief ?? undefined
      const assistantId = await opts.resolveAssistantId?.(userId, existing.workspaceId)
      const verdict = await opts.assessClarity({
        outcome: outcome ?? existing.outcome,
        verification: effectiveBrief?.verification,
        approach: effectiveBrief?.approach,
        userId,
        workspaceId: existing.workspaceId,
        assistantId,
      })
      if (!verdict.clear) {
        res.json({ ok: false, needsClarification: true, question: verdict.clarifyingQuestion ?? null })
        return
      }
    }
    const goal = await updateGoalSystem(req.params.id, { confirm: true, outcome, brief })
    res.json({ ok: true, goal: goal ? projectGoal(goal) : null })
  })

  // POST /:id/outcome — edit the goal's outcome text (the Brain task panel's
  // inline goal edit). Works on a draft or an armed goal; editing never
  // confirms — a draft stays a draft, and the clarity gate (§12) still runs
  // on the new text at confirm time. A completed goal is refused (409):
  // rewriting a verified success would falsify the record.
  router.post('/:id/outcome', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const existing = await getGoalById(userId, req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    if (existing.status === 'done') {
      res.status(409).json({ error: 'A completed goal cannot be edited' })
      return
    }
    const body = (req.body ?? {}) as { outcome?: unknown }
    const outcome = typeof body.outcome === 'string' ? body.outcome.trim() : ''
    if (outcome.length === 0) {
      res.status(400).json({ error: 'outcome must be a non-empty string' })
      return
    }
    const goal = await updateGoalSystem(req.params.id, { outcome })
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

  // POST /:id/abandon — discard a goal the user no longer wants (a draft they
  // won't confirm, or an active goal to stand down). Reversible: sets
  // status='abandoned' so the record survives and stays retrievable via the
  // status filter (never a hard delete). A completed goal is refused (409) —
  // discarding it would misrepresent a verified success. `setGoalStatusSystem`
  // is a system write; the RLS membership check above is the authz gate.
  router.post('/:id/abandon', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const existing = await getGoalById(userId, req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    if (existing.status === 'done') {
      res.status(409).json({ error: 'A completed goal cannot be discarded' })
      return
    }
    const goal = await setGoalStatusSystem(req.params.id, 'abandoned')
    res.json({ ok: true, goal: goal ? projectGoal(goal) : null })
  })

  return router
}
