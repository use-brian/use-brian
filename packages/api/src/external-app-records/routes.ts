import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../auth/middleware.js'
import type { AuthSessionStore } from '../db/auth-session-store.js'
import { AccessInput, ObserveInput, PublishInput, ReconcileInput, RecordsError } from './contracts.js'
import type { ExternalAppRecordsStore } from './store.js'

export function externalAppRecordsRoutes(options: { jwtSecret: string; store: ExternalAppRecordsStore; sessions?: Pick<AuthSessionStore,'validateAccess'> }) {
  const router=Router()
  const params=z.object({workspaceId:z.string().uuid(),sourceId:z.string().regex(/^[a-zA-Z0-9._:-]{1,200}$/)})
  for(const operation of ['publish','reconcile','observe','access','access-reconcile'] as const) {
    router.post(`/workspaces/:workspaceId/records/:sourceId/${operation}`,requireAuth(options.jwtSecret,options.sessions),async(req,res)=>{
      res.set('Cache-Control','private, no-store')
      const p=params.safeParse(req.params), correlation=z.string().regex(/^[a-zA-Z0-9._:-]{1,200}$/).safeParse(req.get('X-Correlation-ID'))
      if(!p.success || !correlation.success || !req.userId) {res.status(400).json({error:'invalid_request'});return}
      const c={...p.data,userId:req.userId,correlationId:correlation.data}
      try {
        options.store.verifySource(c,operation,req.get('Authorization')??'',req.body,req.get('X-Source-Signature'))
        const result=operation==='publish' ? await options.store.publish(c,PublishInput.parse(req.body))
          : operation==='observe' ? await options.store.observe(c,ObserveInput.parse(req.body))
          : operation==='access' ? await options.store.access(c,AccessInput.parse(req.body))
          : operation==='access-reconcile' ? await options.store.reconcileAccess(c,ReconcileInput.parse(req.body).externalId)
          : await options.store.reconcile(c,ReconcileInput.parse(req.body).externalId)
        res.json(result)
      } catch(error) {
        const failure=error instanceof RecordsError ? error : error instanceof z.ZodError ? new RecordsError('invalid_request',400)
          : (error as {code?:string})?.code==='scope_operation_denied' ? new RecordsError('record_unavailable',403) : new RecordsError('publication_dependency_unavailable',503)
        res.status(failure.status).json({error:failure.code,correlationId:c.correlationId})
      }
    })
  }
  return router
}
