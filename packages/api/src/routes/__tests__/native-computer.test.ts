import { it,expect,vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { nativeComputerRoutes } from '../native-computer.js'
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
