import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { ExternalApprovalError } from './service.js'
import { createExternalApprovalSourceRegistry, createExternalApprovalSourceSchema, type ExternalApprovalSourceManagementStore } from './source-registry.js'

/** Mount behind requireAuth at /api/workspaces/:workspaceId/external-approval-sources. */
export function externalApprovalSourceRoutes(options: {
  workspaceStore: Pick<WorkspaceStore,'getRole'>; store?: ExternalApprovalSourceManagementStore
}): Router {
  const router = Router({mergeParams:true})
  const store = options.store ?? createExternalApprovalSourceRegistry()
  router.use(async (req,res,next) => {
    res.set('Cache-Control','no-store')
    if (!req.userId) { res.status(401).json({error:'Unauthorized'}); return }
    const workspaceId = z.string().uuid().parse(req.params.workspaceId)
    const role = await options.workspaceStore.getRole(req.userId,workspaceId)
    if (role !== 'owner' && role !== 'admin') { res.status(403).json({error:'Workspace administrator required'}); return }
    if (req.method !== 'GET' && !req.authSessionId) { res.status(403).json({error:'Authenticated human session required'}); return }
    res.locals.sourceWorkspaceId = workspaceId
    next()
  })
  router.get('/',async (_req,res) => { res.json({sources:await store.list(res.locals.sourceWorkspaceId)}) })
  router.post('/',async (req,res) => {
    const input = createExternalApprovalSourceSchema.parse(req.body)
    const result = await store.create({userId:req.userId!,sessionId:req.authSessionId!},res.locals.sourceWorkspaceId,input)
    res.set('Cache-Control','no-store').status(201).json(result)
  })
  router.post('/:sourceId/rotate',async (req,res) => {
    z.object({}).strict().parse(req.body)
    const id = z.string().uuid().parse(req.params.sourceId)
    const result = await store.rotate({userId:req.userId!,sessionId:req.authSessionId!},res.locals.sourceWorkspaceId,id)
    res.set('Cache-Control','no-store').json(result)
  })
  router.delete('/:sourceId',async (req,res) => {
    if (req.body !== undefined) z.object({}).strict().parse(req.body)
    const id = z.string().uuid().parse(req.params.sourceId)
    await store.revoke({userId:req.userId!,sessionId:req.authSessionId!},res.locals.sourceWorkspaceId,id)
    res.status(204).end()
  })
  router.use((error:unknown,_req:Request,res:Response,_next:NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({error:'Invalid approval source request'}); return }
    if (error instanceof ExternalApprovalError) { res.status(error.status).json({error:error.message}); return }
    // Never pass database errors (which can include credential values) to request logging.
    res.status(500).json({error:'Approval source operation failed'})
  })
  return router
}
