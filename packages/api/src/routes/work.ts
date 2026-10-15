/**
 * Work entry REST: the viewer-bound work projection (personal and per
 * Project/Department Brief) and the guarded claim behind an owner-queue card.
 * Every route is a thin call into the same services Brian and MCP reach
 * (`briefs/work.ts`, `tasks/responsibility.ts`), so errors are typed and
 * identical across surfaces.
 *
 * Spec: docs/architecture/features/project-briefs.md -> "Work";
 * docs/architecture/features/tasks.md -> "Responsibility".
 * [COMP:api/brief-work]
 */
import { Router, type Request, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import { TaskResponsibilityError, type TaskStore } from '@use-brian/core'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { readWorkProjection, WorkUnavailableError } from '../briefs/work.js'
import { claimTask } from '../tasks/responsibility.js'
import { notifyBrainInboxChange } from '../brain-stream/notify.js'

const UUID = z.string().uuid()
const claimBody = z.object({
  executor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('person') }).strict(),
    z.object({ kind: z.literal('assistant'), assistantId: UUID }).strict(),
  ]),
}).strict()

/**
 * Auth is per route (`deps.auth`), not a bare `/api` guard: a blanket guard
 * mounted here would 401 any public `/api` route registered after it.
 */
export function workRoutes(deps: { taskStore: Pick<TaskStore, 'update'>; auth: RequestHandler }): Router {
  const router = Router({ mergeParams: true })

  function handle(work: (userId: string, workspaceId: string, req: Request) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
      const userId = req.userId
      const workspaceId = String(req.params.workspaceId ?? '')
      if (!userId) return void res.status(401).json({ error: 'unauthorized' })
      if (!UUID.safeParse(workspaceId).success) return void res.status(404).json({ error: 'brief_not_found' })
      try {
        res.status(200).json(await work(userId, workspaceId, req))
      } catch (error) {
        if (error instanceof WorkspaceAccessError) return void res.status(error.status).json({ error: error.code })
        if (error instanceof TaskResponsibilityError) return void res.status(error.status).json({ error: error.code })
        if (error instanceof WorkUnavailableError) {
          console.error('[work] projection source failed:', error.cause)
          return void res.status(503).json({ error: error.code })
        }
        if (error instanceof z.ZodError) return void res.status(400).json({ error: 'work_request_invalid' })
        throw error
      }
    }
  }

  router.get('/workspaces/:workspaceId/work', deps.auth, handle(async (userId, workspaceId) =>
    ({ work: await readWorkProjection(userId, workspaceId, { kind: 'personal' }) })))

  router.get('/workspaces/:workspaceId/briefs/by-owner/:ownerKind/:ownerId/work', deps.auth, handle(async (userId, workspaceId, req) => {
    const kind = z.enum(['project', 'department']).safeParse(req.params.ownerKind)
    const id = UUID.safeParse(req.params.ownerId)
    if (!kind.success || !id.success) throw new WorkspaceAccessError('brief_not_found', 404)
    return { work: await readWorkProjection(userId, workspaceId, { kind: kind.data, id: id.data }) }
  }))

  router.post('/workspaces/:workspaceId/tasks/:taskId/claim', deps.auth, handle(async (userId, workspaceId, req) => {
    const taskId = UUID.safeParse(req.params.taskId)
    if (!taskId.success) throw new TaskResponsibilityError('task_not_found')
    const body = claimBody.parse(req.body)
    const task = await claimTask(deps.taskStore, userId, workspaceId, taskId.data, body.executor)
    // A direct REST write bypasses the tool-loop notifier: tell every other
    // tab and device so their work lists and Tasks surface repaint.
    notifyBrainInboxChange(workspaceId, 'task', task.id, 'update')
    return { task: { id: task.id, assigneeId: task.assigneeId, executorAssistantId: task.executorAssistantId ?? null } }
  }))

  return router
}
