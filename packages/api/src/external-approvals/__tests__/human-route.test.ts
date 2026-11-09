import express from 'express'
import request from 'supertest'
import { describe, it, expect, vi } from 'vitest'
vi.mock('../../workflow/approval.js',()=>({resumeFromApproval:vi.fn(),enqueueToolInvocationResume:vi.fn()}))
import { approvalsRoutes } from '../../routes/approvals.js'
import { resumeFromApproval, enqueueToolInvocationResume } from '../../workflow/approval.js'
import { sourceBinding, type ExternalApprovalSource } from '../contracts.js'
import { configureExternalApprovals, ExternalApprovalService, type ExternalApprovalStore } from '../service.js'
import { testSources } from './test-sources.js'

const source:ExternalApprovalSource={id:'human',tokenSha256:'a'.repeat(64),workspaceId:'00000000-0000-4000-8000-000000000001',assistantId:'00000000-0000-4000-8000-000000000002',approverUserId:'00000000-0000-4000-8000-000000000003',channelType:'web',channelId:'queue'}
function fixture() {
 const store:ExternalApprovalStore={create:vi.fn(),read:vi.fn(),ack:vi.fn(),cancel:vi.fn(),sourceForApproval:vi.fn(async()=>({sourceId:source.id,binding:sourceBinding(source)})),decide:vi.fn<ExternalApprovalStore['decide']>(async(_source,_id,_user,decision)=>({approvalId:'approval',externalRequestId:'external',status:decision,expiresAt:'2030-01-01T00:00:00.000Z',payloadHash:'b'.repeat(64)}))}
 const sources=testSources(source)
 configureExternalApprovals(new ExternalApprovalService(sources,store))
 const respond=vi.fn()
 const app=express().use(express.json()).use((req,_res,next)=>{Object.assign(req,{userId:source.approverUserId,authSessionId:'authenticated-human-session'});next()})
 app.use('/api/approvals',approvalsRoutes({approvalsStore:{getById:vi.fn(async()=>({id:'approval',kind:'external_action',approverUserId:source.approverUserId,status:'pending'})),respond} as never,workspaceStore:{} as never,bridgeDeps:{} as never,emailReviewContext:vi.fn() as never}))
 return {app,store,respond,sources}
}
describe('[COMP:api/external-approvals] human respond boundary',()=>{
 it.each(['approved','rejected'] as const)('records %s only through external service, not a Brian executor or generic response',async decision=>{
   const {app,store,respond}=fixture()
   const res=await request(app).post('/api/approvals/approval/respond').send({decision}).expect(200)
   expect(res.body).toMatchObject({kind:'external_action',status:decision})
   expect(store.decide).toHaveBeenCalledWith(source,'approval',source.approverUserId,decision)
   expect(respond).not.toHaveBeenCalled();expect(resumeFromApproval).not.toHaveBeenCalled();expect(enqueueToolInvocationResume).not.toHaveBeenCalled();expect(store.ack).not.toHaveBeenCalled()
 })
 it('rejects a revoked source even when the queue card was already loaded',async()=>{
   const {app,store,sources}=fixture()
   sources.entries.delete(source.id)
   await request(app).post('/api/approvals/approval/respond').send({decision:'approved'}).expect(404)
   expect(store.decide).not.toHaveBeenCalled()
 })
 it('rejects permanent approval and changed source authority even if a stale queue row was read',async()=>{
   const {app,store,respond}=fixture()
   await request(app).post('/api/approvals/approval/respond').send({decision:'approved',grantAlways:true}).expect(403)
   vi.mocked(store.sourceForApproval).mockResolvedValue({sourceId:source.id,binding:'changed'})
   await request(app).post('/api/approvals/approval/respond').send({decision:'approved'}).expect(404)
   expect(store.decide).not.toHaveBeenCalled();expect(respond).not.toHaveBeenCalled()
 })
})


it('fails unavailable answer stores closed and requires live actor evidence on legacy sources',async()=>{
  const {store,sources}=fixture()
  const service=new ExternalApprovalService(sources,store)
  const actor={userId:source.approverUserId!,human:true,origin:'ui' as const,authSessionId:'human-session'}
  await expect(service.answer('approval','literal',actor)).rejects.toMatchObject({status:503})
  await expect(service.answer('approval','literal',{...actor,authSessionId:undefined})).rejects.toMatchObject({status:403})
  sources.entries.delete(source.id)
  await expect(service.answer('approval','literal',actor)).rejects.toMatchObject({status:404})
})
