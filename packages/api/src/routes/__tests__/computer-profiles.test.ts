import { it,expect,vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ComputerProfilesForbiddenError } from '../../db/computer-profile-store.js'
import { nativeComputerRoutes } from '../native-computer.js'
import type { NativeComputerService } from '../../computer-use/service.js'
const id='00000000-0000-4000-8000-000000000001', connectionId='00000000-0000-4000-8000-000000000002'
function fixture(auth=true) {
 const profiles={updateAssistant:vi.fn().mockResolvedValue({id}),list:vi.fn().mockResolvedValue([]),create:vi.fn().mockResolvedValue({id}),update:vi.fn().mockResolvedValue({id}),delete:vi.fn(),connect:vi.fn().mockResolvedValue({connectionId}),poll:vi.fn().mockResolvedValue({request:null}),disconnect:vi.fn(),deny:vi.fn()}
 const acceptProfile=vi.fn().mockResolvedValue({identity:{profileId:id},state:'awaiting_local_consent'})
 const app=express();app.use(express.json());if(auth)app.use((req,_res,next)=>{req.userId='owner';req.authSessionId='desktop-auth';next()})
 app.use(nativeComputerRoutes({profiles,acceptProfile} as unknown as NativeComputerService))
 return {app,profiles,acceptProfile}
}
it('profile CRUD is authenticated, strictly owner scoped, and contains no setup task',async()=>{
 const f=fixture()
 expect((await request(f.app).get(`/profiles?workspaceId=${id}`)).body).toEqual({profiles:[]})
 expect(f.profiles.list).toHaveBeenCalledWith('owner',id)
 expect((await request(f.app).post('/profiles').send({workspaceId:id,name:'Mac'})).status).toBe(201)
 expect(f.profiles.create).toHaveBeenCalledWith('owner',id,'Mac')
 for(const extra of [{ownerUserId:'forged'},{scope:'workspace'},{taskId:id},{goal:'do it'}])expect((await request(f.app).post('/profiles').send({workspaceId:id,name:'Mac',...extra})).status).toBe(400)
 expect((await request(f.app).patch(`/profiles/${id}`).send({enabledAssistantIds:[id],assistantRoutingNotes:{[id]:'Work Mac'}})).status).toBe(200)
 expect((await request(f.app).delete(`/profiles/${id}`)).body).toEqual({ok:true})
 expect(f.profiles.delete).toHaveBeenCalledWith('owner',id)
 expect((await request(fixture(false).app).get(`/profiles?workspaceId=${id}`)).status).toBe(403)
 f.profiles.update.mockRejectedValue(new ComputerProfilesForbiddenError('private profile name'))
 const denied=await request(f.app).patch(`/profiles/${id}`).send({name:'x'})
 expect(denied.status).toBe(403);expect(denied.text).not.toContain('private profile name')
})
it('connection metadata and requests use exact desktop auth, no renderer scope or authorization',async()=>{
 const f=fixture(),base=`/profiles/${id}`
 expect((await request(f.app).post(base+'/connect').send({workspaceId:id,deviceId:'device'})).body).toEqual({connectionId})
 expect(f.profiles.connect).toHaveBeenCalledWith('owner','desktop-auth',id,id,'device')
 for(const path of ['/connect','/poll','/disconnect',`/requests/${id}/accept`,`/requests/${id}/deny`]) {
  expect((await request(f.app).post(base+path).set('Origin','https://renderer').send({connectionId})).status).toBe(403)
  expect((await request(f.app).post(base+path).set('Sec-Fetch-Site','same-origin').send({connectionId})).status).toBe(403)
 }
 expect((await request(f.app).post(base+'/poll').send({connectionId})).body).toEqual({request:null})
 const accept=base+`/requests/${id}/accept`
 expect((await request(f.app).post(accept).send({connectionId,challenge:'x'.repeat(43),conversationId:id})).status).toBe(400)
 expect(f.acceptProfile).not.toHaveBeenCalled()
 expect((await request(f.app).post(accept).send({connectionId,challenge:'x'.repeat(43)})).status).toBe(200)
 expect(f.acceptProfile).toHaveBeenCalledWith('owner','desktop-auth',id,connectionId,id,'x'.repeat(43))
 expect((await request(f.app).post(base+`/requests/${id}/deny`).send({connectionId})).body).toEqual({ok:true})
 expect((await request(f.app).post(base+'/disconnect').send({connectionId})).body).toEqual({ok:true})
})

it('atomic assistant PATCH is strict, authenticated, bounded and binds only the path assistant',async()=>{
 const f=fixture(),path=`/profiles/${id}/assistants/${connectionId}`
 for(const body of [{},{enabled:'yes'},{routingNote:'x'.repeat(2001)},{enabled:true,enabledAssistantIds:[id]},{enabled:true,assistantId:id},{enabled:true,userId:'forged'},{nativeCapability:true}]) {
   expect((await request(f.app).patch(path).send(body)).status).toBe(400)
 }
 expect(f.profiles.updateAssistant).not.toHaveBeenCalled()
 expect((await request(f.app).patch(path).send({enabled:false})).body).toEqual({profile:{id}})
 expect(f.profiles.updateAssistant).toHaveBeenLastCalledWith('owner',id,connectionId,{enabled:false})
 expect((await request(f.app).patch(path).send({routingNote:'note'})).status).toBe(200)
 expect(f.profiles.updateAssistant).toHaveBeenLastCalledWith('owner',id,connectionId,{routingNote:'note'})
 expect((await request(f.app).patch(path).send({enabled:true,routingNote:''})).status).toBe(200)
 expect((await request(f.app).patch(`/profiles/${id}/assistants/not-a-uuid`).send({enabled:true})).status).toBe(400)
 expect((await request(fixture(false).app).patch(path).send({enabled:true})).status).toBe(403)
 f.profiles.updateAssistant.mockRejectedValue(new ComputerProfilesForbiddenError('private assistant name'))
 const denied=await request(f.app).patch(path).send({enabled:true})
 expect(denied.status).toBe(403);expect(denied.text).not.toContain('private assistant name')
})

it.each(['42P01','42703','08006',undefined])('all metadata handlers classify storage failure %s without private details',async code=>{
 const f=fixture()
 const error=Object.assign(new Error('private SQL connection details'),{code})
 for(const method of ['list','create','update','updateAssistant','delete'] as const) f.profiles[method].mockRejectedValue(error)
 const results=[
  await request(f.app).get('/profiles').query({workspaceId:id}),
  await request(f.app).post('/profiles').send({workspaceId:id,name:'Mac'}),
  await request(f.app).patch(`/profiles/${id}`).send({name:'Mac'}),
  await request(f.app).patch(`/profiles/${id}/assistants/${connectionId}`).send({enabled:true}),
  await request(f.app).delete(`/profiles/${id}`),
 ]
 for(const result of results) {
  expect(result.status).toBe(503)
  expect(result.headers['cache-control']).toBe('no-store')
  expect(result.body).toEqual(code==='42P01' || code==='42703'
   ? {code:'computer_profiles_schema_unavailable',error:'Computer profiles schema unavailable'}
   : {code:'computer_profiles_unavailable',error:'Profiles unavailable'})
 }
})
