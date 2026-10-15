/**
 * Authenticated research routes under /api/workspaces/:workspaceId/research
 * (docs/architecture/features/research.md -> "Commands"). Each route
 * authenticates through `deps.auth`, never a bare `/api` guard. The actor is
 * the authenticated user acting directly (human, origin `ui`); every
 * read/write goes through the same command service Brian and the brain MCP
 * use, so errors and authority are identical on every surface.
 *
 * [COMP:api/research-commands]
 */
import { Router, type Request, type RequestHandler, type Response } from 'express'
import * as research from '../research/commands.js'

export function researchRoutes(deps: { auth: RequestHandler }): Router {
  const router = Router({ mergeParams: true })
  const base = '/workspaces/:workspaceId/research'

  function handle(work: (actor: research.ResearchActor, workspaceId: string, req: Request) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
      const userId = req.userId
      if (!userId) return void res.status(401).json({ error: 'unauthorized' })
      const actor: research.ResearchActor = { userId, kind: 'user', human: true, origin: 'ui' }
      try {
        res.status(200).json(await work(actor, String(req.params.workspaceId ?? ''), req))
      } catch (error) {
        if (error instanceof research.ResearchCommandError) {
          return void res.status(error.status).json({ error: error.code, ...(error.detail && error.code === 'research_invalid' ? { detail: error.detail } : {}) })
        }
        throw error
      }
    }
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

  router.get(`${base}/activities`, deps.auth, handle((actor, ws, req) => research.listActivities(actor, ws, {
    sessionId: str(req.query.sessionId), projectId: str(req.query.projectId), limit: Number(req.query.limit) || undefined,
  })))
  router.get(`${base}/activities/:activityId`, deps.auth, handle((actor, ws, req) => research.getActivity(actor, ws, String(req.params.activityId))))
  router.get(`${base}/lessons`, deps.auth, handle((actor, ws, req) => research.listLessons(actor, ws, { projectId: str(req.query.projectId) })))
  router.post(`${base}/feedback/:feedbackId/corrections`, deps.auth, handle((actor, ws, req) => research.correctFeedback(actor, ws, String(req.params.feedbackId), req.body)))
  router.post(`${base}/lessons/:lessonId/decisions`, deps.auth, handle((actor, ws, req) => research.decideLesson(actor, ws, String(req.params.lessonId), req.body)))
  router.get(`${base}/improvements`, deps.auth, handle((actor, ws) => research.listImprovements(actor, ws)))
  router.get(`${base}/improvements/:improvementId`, deps.auth, handle((actor, ws, req) => research.getImprovement(actor, ws, String(req.params.improvementId))))
  router.post(`${base}/improvements`, deps.auth, handle((actor, ws, req) => research.nominateImprovement(actor, ws, req.body)))
  router.post(`${base}/improvements/:improvementId/comparisons`, deps.auth, handle((actor, ws, req) => research.recordComparison(actor, ws, String(req.params.improvementId), req.body)))
  router.get(`${base}/improvements/:improvementId/comparisons/:comparisonId`, deps.auth, handle((actor, ws, req) =>
    research.getComparison(actor, ws, String(req.params.improvementId), String(req.params.comparisonId))))
  return router
}
