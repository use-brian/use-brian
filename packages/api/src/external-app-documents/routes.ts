/** Narrow bearer-authenticated external document surface. [COMP:api/external-app-documents] */
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { requireAuth } from '../auth/middleware.js'
import type { AuthSessionStore } from '../db/auth-session-store.js'
import { getWorkspacePrimaryAssistant } from '../db/users.js'
import { resolveTurnScopeSystem } from '../context-scope/resolve-turn-scope.js'
import { Binding } from './render.js'
import { createDocumentService, DocumentError, type DocumentPrincipal } from './service.js'

/** Uses the existing human membership + selected context resolver; no system clearance. */
export async function authorizeDocumentHuman(p:DocumentPrincipal) {
  const assistant=await getWorkspacePrimaryAssistant(p.userId,p.workspaceId)
  if(!assistant)throw new DocumentError('document_membership_required',403)
  const scope=await resolveTurnScopeSystem({userId:p.userId,workspaceId:p.workspaceId,assistant,memberMode:'member'})
  return {workspaceId:p.workspaceId,userId:p.userId,assistantId:null,clearance:scope.access.clearance,compartments:scope.access.compartments,projectIds:scope.access.projectIds,mutationCompartments:scope.writeCompartments,writeSensitivity:scope.access.clearance,writeCompartments:scope.writeCompartments,writeProjectIds:scope.writeProjectIds}
}
export function externalAppDocumentRoutes(options:{jwtSecret:string;sessions?:Pick<AuthSessionStore,'validateAccess'>;service:ReturnType<typeof createDocumentService>}):Router {
  const router=Router(),s=options.service
  router.use(requireAuth(options.jwtSecret,options.sessions))
  const base='/workspaces/:workspaceId/documents'
  const handle=(operation:(p:DocumentPrincipal,req:import('express').Request,res:import('express').Response)=>Promise<void>)=>async(req:import('express').Request,res:import('express').Response)=>{
    res.set('Cache-Control','private, no-store')
    const supplied=req.get('X-Correlation-ID');const correlationId=supplied&&/^[A-Za-z0-9_.:-]{1,128}$/.test(supplied)?supplied:randomUUID();res.set('X-Correlation-ID',correlationId)
    const log=(outcome:string)=>console.info(JSON.stringify({component:'external-app-documents',operation:String(req.route.path),correlationId,outcome,userId:req.userId}))
    log('start')
    try {const workspaceId=z.string().uuid().parse(req.params.workspaceId);if(!req.userId)throw new DocumentError('document_unauthenticated',401);await operation({workspaceId,userId:req.userId},req,res);log('completed')}
    catch(error){log('failed');const status=error instanceof DocumentError?error.status:error instanceof z.ZodError?400:503;res.status(status).json({error:error instanceof DocumentError?error.code:error instanceof z.ZodError?'document_invalid_request':'document_dependency_unavailable'})}
  }
  router.get(`${base}/templates/:id/:version`,handle(async(p,req,res)=>{res.json(await s.template(p,String(req.params.id),z.coerce.number().int().positive().parse(req.params.version)))}))
  for(const op of ['render','export','upload','reconcile'] as const)router.post(`${base}/${op}`,handle(async(p,req,res)=>{res.json(await s[op](p,req.body))}))
  router.post(`${base}/files/:id/read`,handle(async(p,req,res)=>{const body=z.object({binding:Binding}).strict().parse(req.body);const {bytes,...receipt}=await s.read(p,String(req.params.id),body.binding);res.json({...receipt,base64:Buffer.from(bytes).toString('base64')})}))
  router.get(`${base}/files/:id`,handle(async(p,req,res)=>{const r=await s.download(p,String(req.params.id),req.query);res.set({'Content-Type':r.mimeType,'Content-Disposition':'attachment','X-Content-SHA256':r.sha256,'X-Brian-Document-Expires-At':r.expiresAt});res.send(Buffer.from(r.bytes))}))
  return router
}
