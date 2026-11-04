import { Router } from 'express'
import { z } from 'zod'
import { authenticateSource, ackSchema, externalRequestIdSchema } from './contracts.js'
import { ExternalApprovalError, type ExternalApprovalService } from './service.js'
export function externalApprovalRoutes(service: ExternalApprovalService): Router {
  const router = Router()
  router.use(async (req,res,next) => {
    const source = authenticateSource(service.sources,req.headers.authorization)
    if (!source) { res.status(401).json({ error: 'Unauthorized' }); return }
    res.locals.externalSource = source
    next()
  })
  router.post('/', async (req,res) => { res.json(await service.create(res.locals.externalSource,req.body)) })
  router.param('externalRequestId', (req,_res,next,value) => {
    const parsed = externalRequestIdSchema.safeParse(value)
    if (!parsed.success) { next(parsed.error); return }
    next()
  })
  router.get('/:externalRequestId', async (req,res) => {
    const state = await service.store.read(res.locals.externalSource,req.params.externalRequestId)
    if (!state) { res.status(404).json({ error: 'Approval unavailable' }); return }
    res.json(state)
  })
  router.post('/:externalRequestId/ack', async (req,res) => {
    const body = ackSchema.parse(req.body)
    const state = await service.store.ack(res.locals.externalSource,req.params.externalRequestId,body.status)
    if (!state) { res.status(404).json({ error: 'Approval unavailable' }); return }
    res.json(state)
  })
  router.post('/:externalRequestId/cancel', async (req,res) => {
    z.object({}).strict().parse(req.body)
    const state = await service.store.cancel(res.locals.externalSource,req.params.externalRequestId)
    if (!state) { res.status(404).json({ error: 'Approval unavailable' }); return }
    res.json(state)
  })
  router.use((error: unknown, _req: import('express').Request,res: import('express').Response,next: import('express').NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid external approval request' }); return }
    if (error instanceof ExternalApprovalError) { res.status(error.status).json({ error: error.message }); return }
    next(error)
  })
  return router
}
