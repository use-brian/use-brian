/**
 * Delegated approval review REST surface, mounted at `/api` behind per-route
 * `requireAuth` (docs/architecture/features/approval-review.md → "Surfaces").
 * Every route is a thin adapter over the shared services: the authenticated
 * user is the actor (`origin: 'ui'`, human), never a body field. The normal
 * human response stays on `/api/approvals/:id/respond`.
 *
 * [COMP:api/approval-review-assignment]
 */
import { Router, type RequestHandler, type Response } from 'express'
import { assignReviewer, changeAssignment, revokeAssignment } from '../approval-review/assignment.js'
import { inspectRequest, listAttention, markSeen } from '../approval-review/attention.js'
import { getPattern, listPatterns, revokePattern } from '../approval-review/patterns.js'
import { reviewApprovalRequest } from '../approval-review/resolution.js'
import { getRouteBinding, setRouteBinding } from '../approval-review/route-recovery.js'
import { ApprovalReviewError } from '../approval-review/errors.js'
import type { ReviewActor } from '../approval-review/common.js'
import { approvalReviewSchemaReady, listAssignmentsForViewer } from '../db/approval-review-store.js'

const BASE = '/workspaces/:workspaceId/approval-review'

function actorOf(req: { userId?: string }): ReviewActor | null {
  return req.userId ? { userId: req.userId, origin: 'ui', human: true } : null
}

function fail(res: Response, error: unknown) {
  if (error instanceof ApprovalReviewError) {
    res.status(error.status).json({ error: error.code, message: error.message })
    return
  }
  throw error
}

export function approvalReviewRoutes(opts: { auth: RequestHandler }): Router {
  const router = Router()
  let ready: boolean | null = null
  const handle = (fn: (actor: ReviewActor, req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler[] => [opts.auth, async (req, res) => {
    const actor = actorOf(req as { userId?: string })
    if (!actor) { res.status(401).json({ error: 'unauthorized' }); return }
    ready ??= await approvalReviewSchemaReady().catch(() => false)
    if (!ready) { ready = null; res.status(503).json({ error: 'approval_review_unavailable' }); return }
    try {
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(await fn(actor, req))
    } catch (error) {
      fail(res, error)
    }
  }]
  const ws = (req: Parameters<RequestHandler>[0]) => String(req.params.workspaceId)

  router.get(`${BASE}/assignments`, ...handle(async (actor, req) => ({
    assignments: await listAssignmentsForViewer(actor.userId, ws(req), { status: req.query.status === 'revoked' ? 'revoked' : req.query.status === 'all' ? undefined : 'active' }),
  })))
  router.post(`${BASE}/assignments`, ...handle((actor, req) => assignReviewer({ ...actor, receipt: { selection: 'web' } }, ws(req), req.body)))
  router.patch(`${BASE}/assignments/:assignmentId`, ...handle((actor, req) => changeAssignment(actor, ws(req), String(req.params.assignmentId), req.body)))
  router.post(`${BASE}/assignments/:assignmentId/revoke`, ...handle((actor, req) => revokeAssignment(actor, ws(req), String(req.params.assignmentId), {
    expectedRevision: typeof req.body?.expectedRevision === 'number' ? req.body.expectedRevision : undefined,
    reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : undefined,
  })))
  router.get(`${BASE}/requests/:approvalId`, ...handle((actor, req) => inspectRequest(actor, ws(req), String(req.params.approvalId))))
  router.post(`${BASE}/requests/:approvalId/review`, ...handle((actor, req) => reviewApprovalRequest({
    workspaceId: ws(req), approvalId: String(req.params.approvalId), trigger: 'requested', requester: { kind: 'human', userId: actor.userId },
    idempotencyKey: typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.slice(0, 200) : undefined,
  })))
  router.get(`${BASE}/patterns`, ...handle(async (actor, req) => ({
    patterns: await listPatterns(actor, ws(req), {
      procedureId: typeof req.query.procedureId === 'string' ? req.query.procedureId : undefined,
      status: ['proposed', 'active', 'suspended', 'revoked'].includes(String(req.query.status)) ? req.query.status as 'active' : undefined,
    }),
  })))
  router.get(`${BASE}/patterns/:patternId`, ...handle((actor, req) => getPattern(actor, ws(req), String(req.params.patternId))))
  router.post(`${BASE}/patterns/:patternId/revoke`, ...handle((actor, req) => revokePattern(actor, ws(req), String(req.params.patternId), {
    expectedRevision: typeof req.body?.expectedRevision === 'number' ? req.body.expectedRevision : undefined,
    reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : undefined,
  })))
  router.get(`${BASE}/attention`, ...handle((actor, req) => listAttention(actor, ws(req), {
    sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : null,
    projectId: typeof req.query.projectId === 'string' ? req.query.projectId : null,
  })))
  router.post(`${BASE}/attention/seen`, ...handle((actor, req) => markSeen(actor, ws(req), Array.isArray(req.body?.keys) ? req.body.keys.filter((k: unknown): k is string => typeof k === 'string') : [])))
  router.get(`${BASE}/routes/:workflowId`, ...handle(async (actor, req) => ({ binding: await getRouteBinding(actor, ws(req), String(req.params.workflowId)) })))
  router.put(`${BASE}/routes/:workflowId`, ...handle(async (actor, req) => ({ binding: await setRouteBinding(actor, ws(req), String(req.params.workflowId), req.body) })))
  return router
}
