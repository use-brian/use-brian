import { createAuthSessionStore } from '../../db/auth-session-store.js'
import { createTokens } from '../../auth/jwt.js'
import { it,expect,vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { nativeComputerAuth, nativeComputerRoutes } from '../native-computer.js'
import type { NativeComputerService } from '../../computer-use/service.js'
function app(service:NativeComputerService|null){const a=express();a.use(express.json());a.use((req,_res,next)=>{req.userId='authenticated';req.authSessionId='auth-session';next()});a.use(nativeComputerRoutes(service));return a}
it('default disabled',async()=>{expect((await request(app(null)).post('/sessions').send({})).status).toBe(404)})
it('binds user from auth rather than body and rejects malformed scope',async()=>{const create=vi.fn().mockResolvedValue({});const a=app({create} as unknown as NativeComputerService);expect((await request(a).post('/sessions').send({userId:'attacker'})).status).toBe(400);expect(create).not.toHaveBeenCalled()})
it('blocks renderer-origin credential exchange',async()=>{const exchange=vi.fn();const a=app({exchange} as unknown as NativeComputerService);expect((await request(a).post('/sessions/00000000-0000-4000-8000-000000000000/exchange').set('Origin','https://app').send({verifier:'x'.repeat(43),grant:{}})).status).toBe(403);expect(exchange).not.toHaveBeenCalled()})
it('main-only run accepts no model goal and uses the authenticated owner',async()=>{
 const run=vi.fn().mockResolvedValue({sessionId:'s',data:{outcome:'completed',reason:'done',actions:1},isError:false})
 const tool={execute:vi.fn()} as never
 const a=express();a.use(express.json());a.use((req,_res,next)=>{req.userId='owner';req.authSessionId='current-auth';next()});a.use(nativeComputerRoutes({run} as unknown as NativeComputerService,tool))
 const path='/sessions/00000000-0000-4000-8000-000000000000/run'
 expect((await request(a).post(path).set('Origin','https://app').send({})).status).toBe(403)
 expect((await request(a).post(path).send({goal:'forged'})).status).toBe(403)
 expect(run).not.toHaveBeenCalled()
 expect((await request(a).post(path).send({})).body.data.outcome).toBe('completed')
 expect(run).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000000','owner','current-auth',tool,expect.any(AbortSignal))
})
it('revalidation is authenticated metadata-only and rejects renderer requests and raw actions',async()=>{
 const revalidate=vi.fn().mockResolvedValue({authorized:true})
 const a=app({revalidate} as unknown as NativeComputerService)
 const path='/sessions/00000000-0000-4000-8000-000000000000/revalidate'
 const check={commandId:'command',grantId:'grant',epoch:1,deadlineAt:Date.now()+10000,digest:'a'.repeat(64)}
 expect((await request(a).post(path).set('Origin','https://app').send(check)).status).toBe(403)
 expect((await request(a).post(path).send({...check,action:{kind:'observe'}})).status).toBe(403)
 expect(revalidate).not.toHaveBeenCalled()
 expect((await request(a).post(path).send(check)).body).toEqual({authorized:true})
 expect(revalidate).toHaveBeenCalledWith(path.split('/')[2],'authenticated','auth-session',check)
 revalidate.mockRejectedValue(new Error('revoked'))
 expect((await request(a).post(path).send(check)).status).toBe(403)
})
it('readiness validates scope, binds auth, and reports unwired runtime without creating authority',async()=>{
 const readiness=vi.fn().mockResolvedValue([])
 const a=app({readiness} as unknown as NativeComputerService)
 const id='00000000-0000-4000-8000-000000000000'
 const context={workspaceId:id,assistantId:id,conversationId:id,taskId:id,deviceId:'test-device'}
 expect((await request(a).post('/readiness').send({...context,userId:'forged'})).status).toBe(400)
 expect(readiness).not.toHaveBeenCalled()
 const result=await request(a).post('/readiness').send(context)
 expect(result.headers['cache-control']).toBe('no-store')
 expect(result.body.ready).toBe(false)
 expect(result.body.blockers).toEqual(['accounting_unavailable','runtime_not_checked'])
 expect(readiness).toHaveBeenCalledWith({...context,userId:'authenticated'},'auth-session','test-device')
 expect((await request(app(null)).post('/readiness').send(context)).body.blockers).toContain('native_disabled')
})
it('readiness denies missing session auth before consulting service',async()=>{
 const readiness=vi.fn();const a=express();a.use(express.json());a.use(nativeComputerRoutes({readiness,contextTasks:vi.fn().mockResolvedValue([])} as unknown as NativeComputerService))
 expect((await request(a).post('/readiness').send({})).status).toBe(403)
 expect(readiness).not.toHaveBeenCalled()
})
it('bounds a stalled readiness response and suppresses late/raw errors',async()=>{
 vi.useFakeTimers()
 try {
  const router=nativeComputerRoutes({readiness:vi.fn().mockReturnValue(new Promise(()=>{}))} as unknown as NativeComputerService)
  const handler=router.stack.find(layer=>layer.route?.path==='/readiness')!.route!.stack[0]!.handle
  const id='00000000-0000-4000-8000-000000000000'
  const res={setHeader:vi.fn(),status:vi.fn().mockReturnThis(),json:vi.fn()}
  const pending=handler({userId:'owner',authSessionId:'session',body:{workspaceId:id,assistantId:id,conversationId:id,taskId:id,deviceId:'device'}} as never,res as never,vi.fn())
  await vi.advanceTimersByTimeAsync(8000);await pending
  expect(res.status).toHaveBeenCalledWith(503)
  expect(res.json).toHaveBeenCalledWith({error:'Native readiness unavailable'})
 } finally { vi.useRealTimers() }
})

it('read-only native authentication never touches aged sessions; ordinary native routes still do',async()=>{
 const id='00000000-0000-4000-8000-000000000000',secret='synthetic-auth-test'
 const token=createTokens(id,secret,{id,authVersion:2}).accessToken
 const dbQuery=vi.fn(async(_sql:string,_params?:unknown[])=>({rows:[{authVersion:2,sessionId:id,sessionVersion:2,lastSeenAt:new Date(Date.now()-6*60_000)}]}))
 const sessions=createAuthSessionStore({query:dbQuery} as never)
 const readiness=vi.fn().mockResolvedValue([]),a=express();a.use(express.json())
 a.use('/api/native-computer',nativeComputerAuth(secret,sessions),nativeComputerRoutes({readiness,contextTasks:vi.fn().mockResolvedValue([])} as unknown as NativeComputerService))
 const context={workspaceId:id,assistantId:id,conversationId:id,taskId:id,deviceId:'device'}
 for(const path of ['/readiness','/READINESS/','/readiness?touchLastSeen=true']) {
  dbQuery.mockClear()
  expect((await request(a).post('/api/native-computer'+path).set('Authorization',`Bearer ${token}`).send(context)).status).toBe(200)
  expect(dbQuery).toHaveBeenCalledOnce()
  expect(dbQuery.mock.calls[0]?.[0].trim()).toMatch(/^SELECT /)
 }
 for(const path of ['/context-tasks','/CONTEXT-TASKS/']) {
  dbQuery.mockClear()
  const result=await request(a).get('/api/native-computer'+path).query({workspaceId:id,assistantId:id,conversationId:id}).set('Authorization',`Bearer ${token}`)
  expect(result.status).toBe(200)
  expect(result.body).toEqual({tasks:[]})
  expect(dbQuery).toHaveBeenCalledOnce()
  expect(dbQuery.mock.calls[0]?.[0].trim()).toMatch(/^SELECT /)
 }
 expect((await request(a).get('/api/native-computer/context-tasks')).status).toBe(401)
 expect((await request(a).post('/api/native-computer/context-tasks').send({})).status).toBe(401)
 dbQuery.mockClear()
 expect((await request(a).post('/api/native-computer/context-tasks').set('Authorization',`Bearer ${token}`).send({})).status).toBe(400)
 expect(dbQuery).toHaveBeenCalledTimes(2)
 expect(dbQuery.mock.calls[1]?.[0]).toContain('UPDATE auth_sessions')
 dbQuery.mockClear()
 expect((await request(a).post('/api/native-computer/sessions?readOnly=true').set('Authorization',`Bearer ${token}`).set('X-Read-Only','true').send({})).status).toBe(400)
 expect(dbQuery).toHaveBeenCalledTimes(2)
 expect(dbQuery.mock.calls[1]?.[0]).toContain('UPDATE auth_sessions')
 dbQuery.mockClear()
 expect((await request(a).get('/api/native-computer/readiness').set('Authorization',`Bearer ${token}`)).status).toBe(404)
 expect(dbQuery).toHaveBeenCalledTimes(2)
})
