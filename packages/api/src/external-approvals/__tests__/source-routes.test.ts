import express from 'express'
import request from 'supertest'
import { describe,it,expect,vi } from 'vitest'
vi.mock('../../db/client.js',()=>({getPool:()=>{throw new Error('No live database')}}))
vi.mock('../../brain-stream/notify.js',()=>({notifyWorkspaceChange:vi.fn()}))
vi.mock('../../workflow/recent-approval-channel.js',()=>({resolveRecentApprovalChannel:vi.fn()}))
import { externalApprovalSourceRoutes } from '../source-routes.js'
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const body={name:'Source',assistantId:id(2),approverUserId:id(3)}
const source={id:id(5),name:'Source',workspaceId:id(1),assistantId:id(2),approverUserId:id(3),channelType:'web' as const,channelId:'queue',prefix:'eas_prefix',createdAt:new Date().toISOString(),revokedAt:null}
function fixture(role:string|null='admin',session:string|undefined=id(4),user:string|undefined=id(3)) {
  const store={destinations:vi.fn(async()=>({destinations:[],connections:[]})),list:vi.fn(async()=>[source]),create:vi.fn(async()=>({source,token:'one-time'})),rotate:vi.fn(async()=>({source,token:'rotated'})),revoke:vi.fn(async()=>{})}
  const getRole=vi.fn(async()=>role) as any
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=user;req.authSessionId=session;next()})
  app.use('/api/workspaces/:workspaceId/external-approval-sources',externalApprovalSourceRoutes({workspaceStore:{getRole},store}))
  return {app,store,getRole,path:`/api/workspaces/${id(1)}/external-approval-sources`}
}
describe('authenticated source management routes',()=>{
  it('admits owner/admin only, not nonmember/member/anonymous',async()=>{
    for(const role of ['member',null]) {const f=fixture(role);expect((await request(f.app).get(f.path)).status).toBe(403);expect(f.store.list).not.toHaveBeenCalled()}
    const f=fixture('owner');expect((await request(f.app).get(f.path)).status).toBe(200)
    const a=express();a.use('/api/workspaces/:workspaceId/external-approval-sources',externalApprovalSourceRoutes({workspaceStore:{getRole:vi.fn()}}))
    expect((await request(a).get(`/api/workspaces/${id(1)}/external-approval-sources`)).status).toBe(401)
  })
  it('requires human session for every mutation',async()=>{
    const f=fixture();f.app.use((_req,_res,next)=>next())
    const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=id(3);next()});app.use('/api/workspaces/:workspaceId/external-approval-sources',externalApprovalSourceRoutes({workspaceStore:{getRole:vi.fn(async()=> 'admin' as const)},store:f.store}))
    for(const r of [request(app).post(f.path).send(body),request(app).post(`${f.path}/${id(5)}/rotate`).send({}),request(app).delete(`${f.path}/${id(5)}`)]) expect((await r).status).toBe(403)
    expect(f.store.create).not.toHaveBeenCalled()
  })
  it('scopes operations and uses authenticated actor; tokens are no-store and never in GET',async()=>{
    const f=fixture();const a=await request(f.app).post(f.path).send(body)
    expect(a.status).toBe(201);expect(a.headers['cache-control']).toBe('no-store');expect(a.body.token).toBe('one-time')
    expect(f.store.create).toHaveBeenCalledWith({userId:id(3),sessionId:id(4)},id(1),{...body,notification:'web'})
    const b=await request(f.app).post(`${f.path}/${id(5)}/rotate`).send({});expect(b.status).toBe(200);expect(b.headers['cache-control']).toBe('no-store')
    const list=await request(f.app).get(f.path);expect(list.body).toEqual({sources:[source]});expect(JSON.stringify(list.body)).not.toContain('one-time')
    expect((await request(f.app).delete(`${f.path}/${id(5)}`)).status).toBe(204)
    expect(f.store.revoke).toHaveBeenCalledWith({userId:id(3),sessionId:id(4)},id(1),id(5))
  })
  it('accepts destination creation without a designated approver and discovers inventory without caching',async()=>{
    const f=fixture();const selected={name:'Conversation',assistantId:id(2),destinationId:id(8)}
    expect((await request(f.app).post(f.path).send(selected)).status).toBe(201)
    expect(f.store.create).toHaveBeenCalledWith({userId:id(3),sessionId:id(4)},id(1),selected)
    const inventory=await request(f.app).get(`${f.path}/destinations?assistantId=${id(2)}`)
    expect(inventory.status).toBe(200);expect(inventory.headers['cache-control']).toBe('no-store')
    expect(f.store.destinations).toHaveBeenCalledWith({userId:id(3),sessionId:id(4)},id(1),id(2))
    expect((await request(f.app).post(f.path).send({...selected,approverUserId:id(3)})).status).toBe(400)
    expect((await request(f.app).get(`${f.path}/destinations?assistantId=bad`)).status).toBe(400)
  })
  it('rejects arbitrary authority fields and rotation body, redacts unexpected errors',async()=>{
    const f=fixture()
    for(const field of ['workspaceId','userId','token','tokenSha256','channelId','channelType','channelIntegrationId','id']) expect((await request(f.app).post(f.path).send({...body,[field]:id(9)})).status).toBe(400)
    expect((await request(f.app).post(`${f.path}/${id(5)}/rotate`).send({assistantId:id(9)})).status).toBe(400)
    f.store.create.mockRejectedValueOnce(new Error('secret hash in database error'))
    const result=await request(f.app).post(f.path).send(body);expect(result.status).toBe(500);expect(JSON.stringify(result.body)).not.toContain('secret')
  })
})
