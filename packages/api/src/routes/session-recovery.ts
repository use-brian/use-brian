/** Native owner continuation endpoints. [COMP:api/session-recovery] */
import { Router } from 'express'
import { z } from 'zod'
import { inspectSessionRecovery, recoverSession, sessionRecoveryInput } from '../db/session-recovery.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

export function sessionRecoveryRoutes(): Router {
 const router = Router({mergeParams:true})
 const queryShape = z.object({workspaceId:z.string().uuid()}).strict()
 router.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store')
  if (!req.userId || !req.authSessionId || req.authVersion===undefined) {
   res.status(401).json({error:'authenticated_session_required'});return
  }
  if (!z.string().uuid().safeParse(req.params.id).success) {res.status(404).json({error:'session_recovery_unavailable'});return}
  next()
 })
 router.get<{id:string}>('/',async(req,res)=>{
  const parsed=queryShape.safeParse(req.query)
  if(!parsed.success){res.status(400).json({error:'invalid_session_recovery'});return}
  try {
   res.json(await inspectSessionRecovery({sessionId:String(req.params.id),workspaceId:parsed.data.workspaceId,
    claims:{userId:req.userId!,sessionId:req.authSessionId!,authVersion:req.authVersion!}}))
  }catch(error){
   if(error instanceof WorkspaceAccessError){res.status(error.status).json({error:error.code});return}
   console.error('Session recovery inspection error:',error)
   res.status(500).json({error:'session_recovery_failed'})
  }
 })
 router.post<{id:string}>('/',async(req,res)=>{
  const parsed=sessionRecoveryInput.safeParse(req.body)
  if(!parsed.success){res.status(400).json({error:'invalid_session_recovery'});return}
  try {
   res.json(await recoverSession({sessionId:String(req.params.id),...parsed.data,
    claims:{userId:req.userId!,sessionId:req.authSessionId!,authVersion:req.authVersion!}}))
  }catch(error){
   if(error instanceof WorkspaceAccessError){res.status(error.status).json({error:error.code});return}
   console.error('Session recovery apply error:',error)
   res.status(500).json({error:'session_recovery_failed'})
  }
 })
 return router
}
