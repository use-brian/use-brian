/** Human history access is independent of capture administration. [COMP:api/engineering-history] */
import {Router,type Request,type Response} from 'express'
import {z} from 'zod'
import {EngineeringHistoryQuerySchema} from '@use-brian/shared'
import type {WorkspaceStore} from '../db/workspace-store.js'
import type {EngineeringHistoryService,HistoryActor} from '../engineering-history/service.js'
import {EngineeringHistoryError} from '../engineering-history/contracts.js'
const annotation=z.object({text:z.string().min(1).max(4000),expectedRevision:z.number().int().positive(),expectedFileVersion:z.string().regex(/^\d+$/),idempotencyKey:z.string().uuid()}).strict()
const deletion=annotation.omit({text:true})
export function engineeringHistoryRoutes(options:{service:EngineeringHistoryService;workspaceStore:WorkspaceStore}):Router{
 const router=Router({mergeParams:true})
 async function actor(req:Request,res:Response):Promise<HistoryActor|null>{
  res.setHeader('Cache-Control','no-store')
  if(!req.userId){res.status(401).json({error:'Unauthorized'});return null}
  const workspaceId=String(req.params.workspaceId??'')
  if(!z.string().uuid().safeParse(workspaceId).success){res.status(400).json({error:'history_input_invalid'});return null}
  if(!await options.workspaceStore.getRole(req.userId,workspaceId)){res.status(404).json({error:'history_not_available'});return null}
  return {workspaceId,userId:req.userId,assistantKind:'primary',clearance:'confidential',origin:'human'}
 }
 function fail(error:unknown,res:Response){
  if(error instanceof z.ZodError)return void res.status(400).json({error:'history_input_invalid'})
  res.status(error instanceof EngineeringHistoryError?error.status:503).json({error:error instanceof EngineeringHistoryError?error.code:'history_unavailable'})
 }
 router.get('/',async(req,res)=>{try{const ctx=await actor(req,res);if(ctx)res.json(await options.service.list(ctx,EngineeringHistoryQuerySchema.parse(req.query)))}catch(e){fail(e,res)}})
 // Static export is deliberately before the opaque event UUID route.
 router.get('/export',async(req,res)=>{try{const ctx=await actor(req,res);if(!ctx)return;const result=await options.service.exportPage(ctx,EngineeringHistoryQuerySchema.parse(req.query))
  res.setHeader('Content-Type','application/x-ndjson; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="engineering-history.jsonl"')
  res.setHeader('X-Brian-Export-Status',result.status);if(result.nextCursor)res.setHeader('X-Brian-Next-Cursor',result.nextCursor);if(result.failureCode)res.setHeader('X-Brian-Export-Error',result.failureCode)
  res.send(result.jsonl)
 }catch(e){fail(e,res)}})
 router.get('/:eventId',async(req,res)=>{try{const ctx=await actor(req,res);if(ctx)res.json(await options.service.read(ctx,z.string().uuid().parse(req.params.eventId)))}catch(e){fail(e,res)}})
 router.post('/:eventId/annotations',async(req,res)=>{try{const ctx=await actor(req,res);if(ctx)res.json(await options.service.execute(ctx,{action:'annotate',eventId:z.string().uuid().parse(req.params.eventId),...annotation.parse(req.body)}))}catch(e){fail(e,res)}})
 router.post('/:eventId/exclude',async(req,res)=>{try{const ctx=await actor(req,res);if(ctx)res.json(await options.service.execute(ctx,{action:'exclude',eventId:z.string().uuid().parse(req.params.eventId),...deletion.parse(req.body)}))}catch(e){fail(e,res)}})
 router.delete('/:eventId',async(req,res)=>{try{const ctx=await actor(req,res);if(ctx)res.json(await options.service.execute(ctx,{action:'delete',eventId:z.string().uuid().parse(req.params.eventId),...deletion.parse(req.body)}))}catch(e){fail(e,res)}})
 return router
}
