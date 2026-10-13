/**
 * Task execution REST: inspect and control a task's execution, and bind /
 * report external coding sessions. Thin calls into the same services Brian and
 * brain MCP reach (`tasks/execution-control.ts`, `tasks/external-progress.ts`).
 *
 * Every route authenticates per route (`deps.auth`), never through a bare
 * `/api` guard. A REST caller is an authenticated person, so its controls carry
 * human intent; actor and origin are server-derived, never read from the body.
 *
 * Spec: docs/architecture/features/tasks.md -> "Execution control";
 * docs/architecture/features/programmatic-access.md -> "Task progress reporting".
 * [COMP:api/task-execution-control] [COMP:api/task-external-progress]
 */
import { Router, type Request, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import { notifyBrainInboxChange } from '../brain-stream/notify.js'
import { controlExecution, ExecutionControlError, inspectExecution, type ControlEffects, type ExecutionView } from '../tasks/execution-control.js'
import { bindExternalExecution, ExternalProgressError, reportExternalProgress } from '../tasks/external-progress.js'

const UUID = z.string().uuid()

/** JSON projection: no internal ledger fields, dates as ISO strings. */
export function projectExecution(view: ExecutionView) {
  const s = view.state
  const seg = view.pool.segments.find(x => x.segmentNo === view.pool.activeSegment)
  return {
    id: s.id, taskId: s.taskId, goalId: s.goalId, phase: s.phase, controlRevision: s.controlRevision,
    executor: s.executor, plan: s.plan, sourceRefs: s.sourceRefs, blocker: s.blocker, wait: s.wait,
    pause: s.pause, checkpoint: s.checkpoint ? { ...s.checkpoint, runLedger: undefined } : null, steering: s.steering,
    canControl: view.canControl,
    allowance: {
      maxSpend: view.pool.maxSpend, maxIterations: view.pool.maxIterations, activeSegment: view.pool.activeSegment,
      segment: seg ? { spent: seg.spent, iterations: seg.iterations, reservedSpend: seg.reservedSpend, reservedIterations: seg.reservedIterations } : null,
      lifetime: view.pool.lifetime,
    },
    children: view.children.map(c => ({ id: c.id, childKey: c.childKey, taskId: c.taskId, phase: c.phase, executor: c.executor,
      blocker: c.blocker, nextStep: c.checkpoint?.nextStep ?? c.plan.nextStep ?? null, questions: c.checkpoint?.questions ?? [] })),
    external: view.external,
    lastControl: view.receipts.find(r => ['pause', 'steer', 'continue'].includes(r.kind) && r.outcome === 'applied')
      ? (({ kind, actorId, resultRevision, createdAt }) => ({ kind, actorId, revision: resultRevision, at: createdAt.toISOString() }))(
        view.receipts.find(r => ['pause', 'steer', 'continue'].includes(r.kind) && r.outcome === 'applied')!)
      : null,
  }
}

export function taskExecutionRoutes(deps: { auth: RequestHandler; effects?: ControlEffects }): Router {
  const router = Router({ mergeParams: true })

  function handle(work: (userId: string, workspaceId: string, req: Request) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
      const userId = req.userId
      const workspaceId = String(req.params.workspaceId ?? '')
      if (!userId) return void res.status(401).json({ error: 'unauthorized' })
      if (!UUID.safeParse(workspaceId).success) return void res.status(404).json({ error: 'execution_not_found' })
      try {
        res.status(200).json(await work(userId, workspaceId, req))
      } catch (error) {
        if (error instanceof ExecutionControlError || error instanceof ExternalProgressError) {
          return void res.status(error.status).json({ error: error.code })
        }
        throw error
      }
    }
  }

  const id = (value: unknown, code: 'execution_not_found' | 'task_not_found') => {
    const parsed = UUID.safeParse(value)
    if (!parsed.success) throw code === 'task_not_found' ? new ExternalProgressError('task_not_found') : new ExecutionControlError('execution_not_found')
    return parsed.data
  }

  router.get('/workspaces/:workspaceId/work/executions/:executionId', deps.auth, handle(async (userId, workspaceId, req) =>
    ({ execution: projectExecution(await inspectExecution({ userId }, workspaceId, { executionId: id(req.params.executionId, 'execution_not_found') })) })))

  router.get('/workspaces/:workspaceId/tasks/:taskId/execution', deps.auth, handle(async (userId, workspaceId, req) =>
    ({ execution: projectExecution(await inspectExecution({ userId }, workspaceId, { taskId: id(req.params.taskId, 'execution_not_found') })) })))

  router.post('/workspaces/:workspaceId/work/executions/:executionId/control', deps.auth, handle(async (userId, workspaceId, req) => {
    const executionId = id(req.params.executionId, 'execution_not_found')
    const r = await controlExecution({ userId, kind: 'user', id: userId, origin: 'ui', human: true }, workspaceId, executionId, req.body ?? {}, deps.effects)
    if (r.outcome === 'applied' && r.state.taskId) notifyBrainInboxChange(workspaceId, 'task', r.state.taskId, 'update')
    return {
      outcome: r.outcome,
      receipt: { id: r.receipt.id, kind: r.receipt.kind, outcome: r.receipt.outcome, reason: r.receipt.payload.reason ?? null,
        expectedRevision: r.receipt.expectedRevision, resultRevision: r.receipt.resultRevision, renewedSegment: r.renewedSegment },
      execution: projectExecution(await inspectExecution({ userId }, workspaceId, { executionId })),
    }
  }))

  router.post('/workspaces/:workspaceId/tasks/:taskId/external-executions', deps.auth, handle(async (userId, workspaceId, req) => {
    const r = await bindExternalExecution({ userId, actor: { kind: 'user', id: userId, origin: 'ui', humanOrigin: false } },
      workspaceId, id(req.params.taskId, 'task_not_found'), req.body ?? {})
    notifyBrainInboxChange(workspaceId, 'task', r.lane.taskId, 'update')
    return r
  }))

  router.post('/workspaces/:workspaceId/tasks/:taskId/external-executions/:externalExecutionId/events', deps.auth, handle(async (userId, workspaceId, req) => {
    const externalExecutionId = z.string().min(1).max(200).safeParse(req.params.externalExecutionId)
    if (!externalExecutionId.success) throw new ExternalProgressError('external_execution_not_found')
    const r = await reportExternalProgress({ userId, actor: { kind: 'user', id: userId, origin: 'ui', humanOrigin: false } },
      workspaceId, id(req.params.taskId, 'task_not_found'), externalExecutionId.data, req.body ?? {})
    if (r.advanced) notifyBrainInboxChange(workspaceId, 'task', r.lane.taskId, 'update')
    return r
  }))

  return router
}
