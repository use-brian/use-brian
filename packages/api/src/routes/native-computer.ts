import { requireAuth, requireAuthWithoutTouch } from '../auth/middleware.js'
import type { AuthSessionStore } from '../db/auth-session-store.js'
import type { RequestHandler } from 'express'
import { nativeReadiness, ReadinessContextSchema, type ReadinessOptions } from '../computer-use/readiness.js'
import type { Tool } from '@use-brian/core'
import { Router } from 'express'
import { z } from 'zod'
import { ExecutionCheckSchema, type NativeComputerService } from '../computer-use/service.js'
const Create = z.object({ workspaceId:z.string().uuid(),assistantId:z.string().uuid(),conversationId:z.string().uuid(),taskId:z.string().uuid(),deviceId:z.string().min(1).max(256),challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
const Exchange = z.object({ verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),grant:z.unknown() }).strict()
/** Mount on /api/native-computer INSTEAD OF an outer requireAuth. The Express
 * router accepts case-insensitive paths/trailing slash; only its readiness POST
 * gets no-touch auth. Headers/body/query cannot select this authentication mode. */
export function nativeComputerAuth(jwtSecret: string, sessions?: Pick<AuthSessionStore, 'validateAccess'>): RequestHandler {
  const normal = requireAuth(jwtSecret, sessions)
  const readOnly = requireAuthWithoutTouch(jwtSecret, sessions)
  return (req, res, next) => (req.method === 'POST' && /^\/readiness\/?$/i.test(req.path)
    ? readOnly : normal)(req, res, next)
}

/** PKCE verifier must be generated/retained in Electron main, never exposed via preload.
 * Origin absence is defense in depth, not a main-process identity assertion. */
export function nativeComputerRoutes(service: NativeComputerService | null, tool?: Tool, readiness?: ReadinessOptions): Router {
  const router=Router()
  router.post('/readiness', async (req,res) => {
    res.setHeader('Cache-Control','no-store')
    if (!req.userId || !req.authSessionId) { res.sendStatus(403); return }
    const parsed = ReadinessContextSchema.safeParse(req.body)
    if (!parsed.success) { res.sendStatus(400); return }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const report = await Promise.race([
        nativeReadiness(service, { ...parsed.data, userId: req.userId }, req.authSessionId, parsed.data.deviceId, readiness),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Readiness timeout')), 8000) }),
      ])
      res.json(report)
    } catch { res.status(503).json({ error: 'Native readiness unavailable' }) }
    finally { clearTimeout(timer) }
  })
  router.use((_req,res,next)=>{ res.setHeader('Cache-Control','no-store'); if(!service){res.sendStatus(404);return} next() })
  router.post('/sessions',async(req,res)=>{
    if (!req.authSessionId) { res.sendStatus(403); return }
    const parsed=Create.safeParse(req.body); if(!parsed.success){res.sendStatus(400);return}
    try { res.status(201).json(await service!.create({...parsed.data,userId:req.userId!,authSessionId:req.authSessionId})) } catch {res.status(403).json({error:'Native scope denied or device busy'})}
  })
  router.post('/sessions/:id/exchange',async(req,res)=>{
    const parsed=Exchange.safeParse(req.body)
    if(req.headers.origin || req.headers['sec-fetch-site'] || !parsed.success || !z.string().uuid().safeParse(req.params.id).success){res.sendStatus(403);return}
    try {res.json(await service!.exchange(req.params.id as string,req.userId!,parsed.data.verifier,parsed.data.grant))} catch {res.status(403).json({error:'Native pairing denied'})}
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
    try {await service!.revoke(req.params.id as string,req.userId!);res.sendStatus(204)} catch {res.sendStatus(503)}
  })
  return router
}
