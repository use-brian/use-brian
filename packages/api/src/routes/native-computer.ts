import { ProfilePatchSchema, ProfileAssistantPatchSchema } from '../db/computer-profile-store.js'
import { requireAuth, requireAuthWithoutTouch } from '../auth/middleware.js'
import type { AuthSessionStore } from '../db/auth-session-store.js'
import type { RequestHandler } from 'express'
import { nativeReadiness, ReadinessContextSchema, type ReadinessOptions } from '../computer-use/readiness.js'
import type { TaskStore, Tool } from '@use-brian/core'
import { Router } from 'express'
import { z } from 'zod'
import { ExecutionCheckSchema, type NativeComputerService } from '../computer-use/service.js'
const Create = z.object({ workspaceId:z.string().uuid(),assistantId:z.string().uuid(),conversationId:z.string().uuid(),taskId:z.string().uuid(),deviceId:z.string().min(1).max(256),challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
const Context = Create.pick({ workspaceId: true, assistantId: true, conversationId: true })
const Exchange = z.object({ verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),grant:z.unknown() }).strict()
/** Mount on /api/native-computer INSTEAD OF an outer requireAuth. The Express
 * router accepts case-insensitive paths/trailing slash; its readiness POST and context-tasks GET
 * get no-touch auth. Headers/body/query cannot select this authentication mode. */
export function nativeComputerAuth(jwtSecret: string, sessions?: Pick<AuthSessionStore, 'validateAccess'>): RequestHandler {
  const normal = requireAuth(jwtSecret, sessions)
  const readOnly = requireAuthWithoutTouch(jwtSecret, sessions)
  return (req, res, next) => ((req.method === 'POST' && /^\/readiness\/?$/i.test(req.path) || req.method === 'GET' && /^\/context-tasks\/?$/i.test(req.path))
    ? readOnly : normal)(req, res, next)
}

/** PKCE verifier must be generated/retained in Electron main, never exposed via preload.
 * Origin absence is defense in depth, not a main-process identity assertion. */
export function nativeComputerRoutes(service: NativeComputerService | null, tool?: Tool, readiness?: ReadinessOptions, tasks?: Pick<TaskStore, 'create'>): Router {
  const router=Router()
  router.post('/readiness', async (req,res) => {
    res.setHeader('Cache-Control','no-store')
    if (!req.userId || !req.authSessionId) { res.sendStatus(403); return }
    const parsed = ReadinessContextSchema.safeParse(req.body)
    if (!parsed.success) { res.sendStatus(400); return }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const report = await Promise.race([
        nativeReadiness(service, { ...parsed.data, userId: req.userId }, req.authSessionId, 'deviceId' in parsed.data ? parsed.data.deviceId : undefined, readiness),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Readiness timeout')), 8000) }),
      ])
      res.json(report)
    } catch { res.status(503).json({ error: 'Native readiness unavailable' }) }
    finally { clearTimeout(timer) }
  })
  router.use((_req,res,next)=>{ res.setHeader('Cache-Control','no-store'); if(!service){res.sendStatus(404);return} next() })
  const uuid=z.string().uuid()
  const connection=z.object({connectionId:uuid}).strict()
  // Desktop metadata calls require authenticated main-process-style requests.
  // This is defense in depth, not a claim that absence of Origin identifies main.
  const desktop:RequestHandler=(req,res,next)=>{
    if(req.headers.origin || req.headers['sec-fetch-site'] || !req.authSessionId || !req.userId) {res.sendStatus(403);return}
    next()
  }
  router.use('/profiles', (req,res,next)=>{
    if(!req.userId || !req.authSessionId) {res.sendStatus(403);return}
    next()
  })
  router.get('/profiles',async(req,res)=>{
    const parsed=z.object({workspaceId:uuid}).strict().safeParse(req.query)
    if(!parsed.success){res.sendStatus(400);return}
    try {res.json({profiles:await service!.profiles.list(req.userId!,parsed.data.workspaceId)})}
    catch {res.status(503).json({error:'Profiles unavailable'})}
  })
  router.post('/profiles',async(req,res)=>{
    const parsed=z.object({workspaceId:uuid,name:z.string().trim().min(1).max(120)}).strict().safeParse(req.body)
    if(!parsed.success){res.sendStatus(400);return}
    try {res.status(201).json({profile:await service!.profiles.create(req.userId!,parsed.data.workspaceId,parsed.data.name)})}
    catch {res.status(403).json({error:'Profile unavailable'})}
  })
  router.patch('/profiles/:id',async(req,res)=>{
    const parsed=ProfilePatchSchema.safeParse(req.body)
    if(!parsed.success || !uuid.safeParse(req.params.id).success){res.sendStatus(400);return}
    try {res.json({profile:await service!.profiles.update(req.userId!,req.params.id as string,parsed.data)})}
    catch {res.status(403).json({error:'Profile unavailable'})}
  })
  router.patch('/profiles/:id/assistants/:assistantId',async(req,res)=>{
    const parsed=ProfileAssistantPatchSchema.safeParse(req.body)
    if(!parsed.success || !uuid.safeParse(req.params.id).success || !uuid.safeParse(req.params.assistantId).success){res.sendStatus(400);return}
    try {res.json({profile:await service!.profiles.updateAssistant(req.userId!,req.params.id as string,req.params.assistantId as string,parsed.data)})}
    catch {res.status(403).json({error:'Profile unavailable'})}
  })
  router.delete('/profiles/:id',async(req,res)=>{
    if(!uuid.safeParse(req.params.id).success){res.sendStatus(400);return}
    try {await service!.profiles.delete(req.userId!,req.params.id as string);res.json({ok:true})}
    catch {res.status(403).json({error:'Profile unavailable'})}
  })
  router.post('/profiles/:id/connect',desktop,async(req,res)=>{
    const parsed=z.object({workspaceId:uuid,deviceId:z.string().min(1).max(256)}).strict().safeParse(req.body)
    if(!parsed.success || !uuid.safeParse(req.params.id).success){res.sendStatus(400);return}
    try {res.json(await service!.profiles.connect(req.userId!,req.authSessionId!,req.params.id as string,parsed.data.workspaceId,parsed.data.deviceId))}
    catch {res.status(403).json({error:'Connection unavailable'})}
  })
  router.post('/profiles/:id/poll',desktop,async(req,res)=>{
    const parsed=connection.safeParse(req.body)
    if(!parsed.success || !uuid.safeParse(req.params.id).success){res.sendStatus(400);return}
    try {res.json(await service!.profiles.poll(req.userId!,req.authSessionId!,req.params.id as string,parsed.data.connectionId))}
    catch {res.status(403).json({error:'Connection unavailable'})}
  })
  router.post('/profiles/:id/disconnect',desktop,async(req,res)=>{
    const parsed=connection.safeParse(req.body)
    if(!parsed.success || !uuid.safeParse(req.params.id).success){res.sendStatus(400);return}
    try {await service!.profiles.disconnect(req.userId!,req.authSessionId!,req.params.id as string,parsed.data.connectionId);res.json({ok:true})}
    catch {res.status(403).json({error:'Connection unavailable'})}
  })
  router.post('/profiles/:id/requests/:requestId/accept',desktop,async(req,res)=>{
    const parsed=connection.extend({challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict().safeParse(req.body)
    if(!parsed.success || !uuid.safeParse(req.params.id).success || !uuid.safeParse(req.params.requestId).success){res.sendStatus(400);return}
    try {res.json(await service!.acceptProfile(req.userId!,req.authSessionId!,req.params.id as string,parsed.data.connectionId,req.params.requestId as string,parsed.data.challenge))}
    catch {res.status(403).json({error:'Consent request unavailable'})}
  })
  router.post('/profiles/:id/requests/:requestId/deny',desktop,async(req,res)=>{
    const parsed=connection.safeParse(req.body)
    if(!parsed.success || !uuid.safeParse(req.params.id).success || !uuid.safeParse(req.params.requestId).success){res.sendStatus(400);return}
    try {await service!.profiles.deny(req.userId!,req.authSessionId!,req.params.id as string,parsed.data.connectionId,req.params.requestId as string);res.json({ok:true})}
    catch {res.status(403).json({error:'Consent request unavailable'})}
  })
  router.get('/context-tasks', async (req,res) => {
    if (!req.userId || !req.authSessionId) { res.sendStatus(403); return }
    const parsed = Context.safeParse(req.query)
    if (!parsed.success) { res.sendStatus(400); return }
    try { res.json({ tasks: await service!.contextTasks({ ...parsed.data, userId: req.userId }) }) }
    catch { res.status(503).json({ error: 'Native context unavailable' }) }
  })
  router.post('/context-tasks', async (req,res) => {
    if (!req.userId || !req.authSessionId) { res.sendStatus(403); return }
    const parsed = Context.extend({ title: z.string().trim().min(1).max(512) }).strict().safeParse(req.body)
    if (!parsed.success) { res.sendStatus(400); return }
    if (!tasks) { res.sendStatus(503); return }
    try {
      const { title, ...context } = parsed.data
      res.status(201).json({ task: await service!.createContextTask({ ...context, userId: req.userId }, title, tasks) })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'native_context_denied' || code === 'scope_operation_denied') {
        res.status(403).json({ error: 'Native context denied' }); return
      }
      res.status(503).json({ error: 'Native task creation unavailable' })
    }
  })
  router.post('/sessions',async(req,res)=>{
    if (!req.authSessionId) { res.sendStatus(403); return }
    const parsed=Create.safeParse(req.body); if(!parsed.success){res.sendStatus(400);return}
    try { res.status(201).json(await service!.create({...parsed.data,userId:req.userId!,authSessionId:req.authSessionId})) } catch {res.status(403).json({error:'Native scope denied or device busy'})}
  })
  router.post('/sessions/:id/exchange',async(req,res)=>{
    const parsed=Exchange.safeParse(req.body)
    if(req.headers.origin || req.headers['sec-fetch-site'] || !parsed.success || !z.string().uuid().safeParse(req.params.id).success){res.sendStatus(403);return}
    try {res.json(await service!.exchange(req.params.id as string,req.userId!,parsed.data.verifier,parsed.data.grant,req.authSessionId))} catch {res.status(403).json({error:'Native pairing denied'})}
  })
  router.post('/sessions/:id/revalidate',async(req,res)=>{
    const parsed=ExecutionCheckSchema.safeParse(req.body)
    if(req.headers.origin || req.headers['sec-fetch-site'] || !req.authSessionId || !req.userId || !parsed.success || !z.string().uuid().safeParse(req.params.id).success) {res.sendStatus(403);return}
    try {res.json(await service!.revalidate(req.params.id as string,req.userId,req.authSessionId,parsed.data))}
    catch {res.status(403).json({error:'Native execution denied'})}
  })
  router.post('/sessions/:id/run',async(req,res)=>{
    if(req.headers.origin || req.headers['sec-fetch-site'] || !req.authSessionId || !req.userId || !tool || !z.string().uuid().safeParse(req.params.id).success || !z.object({}).strict().safeParse(req.body ?? {}).success) {res.sendStatus(403);return}
    const controller=new AbortController()
    const disconnect=()=>{if(!res.writableEnded) controller.abort()}
    res.on('close',disconnect)
    const timer=setTimeout(()=>{
      controller.abort()
      if(!res.destroyed) res.status(202).json({sessionId:req.params.id,runState:'running',timedOut:true})
    },120_000)
    try { const result=await service!.run(req.params.id as string,req.userId,req.authSessionId,tool,controller.signal); if(!res.destroyed && !res.writableEnded) res.json(result) }
    catch {if(!res.destroyed && !res.writableEnded) res.status(403).json({error:'Native execution unavailable'})}
    finally {clearTimeout(timer);res.off('close',disconnect)}
  })
  router.get('/sessions/:id',async(req,res)=>{
    if(!z.string().uuid().safeParse(req.params.id).success){res.sendStatus(400);return}
    try {res.json(await service!.status(req.params.id as string,req.userId!))} catch {res.sendStatus(404)}
  })
  router.delete('/sessions/:id',async(req,res)=>{
    if(!z.string().uuid().safeParse(req.params.id).success){res.sendStatus(400);return}
    try {await service!.stop(req.params.id as string,req.userId!);res.sendStatus(204)} catch {res.sendStatus(503)}
  })
  return router
}
