import express from 'express'
import request from 'supertest'
import { createHash } from 'node:crypto'
import { beforeEach,describe,it,expect,vi } from 'vitest'
import { externalApprovalRoutes } from '../routes.js'
import { ExternalApprovalService, ExternalApprovalError, type ExternalApprovalStore, type ExternalApprovalState } from '../service.js'
import type { ExternalApprovalSource } from '../contracts.js'
const token='synthetic-route-test-token'
const source:ExternalApprovalSource={id:'one',tokenSha256:createHash('sha256').update(token).digest('hex'),workspaceId:'00000000-0000-4000-8000-000000000001',assistantId:'00000000-0000-4000-8000-000000000002',approverUserId:'00000000-0000-4000-8000-000000000003',channelType:'web',channelId:'queue'}
const state:ExternalApprovalState={approvalId:'approval',externalRequestId:'external-1',status:'pending',expiresAt:'2030-01-01T00:00:00.000Z',payloadHash:'a'.repeat(64)}
const store:ExternalApprovalStore={create:vi.fn(async()=>({state,created:true})),read:vi.fn(async()=>state),ack:vi.fn(async()=>state),cancel:vi.fn(async()=>({...state,status:'superseded' as const})),decide:vi.fn(async()=>state),sourceForApproval:vi.fn(async()=>null)}
const service=new ExternalApprovalService([source],store)
const app=express().use(express.json()).use('/internal/external-approvals',externalApprovalRoutes(service))
const input={externalRequestId:'external-1',taskId:'task',sessionId:'session',request:{method:'confirm',title:'Allow this?'},expiresAt:'2030-01-01T00:00:00Z'}
beforeEach(()=>vi.clearAllMocks())
describe('source authenticated external approval routes',()=>{
 it('authenticates all verbs before store access',async()=>{
   for(const path of ['/','/external-1/ack','/external-1/cancel']) expect((await request(app).post('/internal/external-approvals'+path).send({})).status).toBe(401)
   expect((await request(app).get('/internal/external-approvals/external-1').set('Authorization','Bearer foreign-test-token')).status).toBe(401)
   expect(store.create).not.toHaveBeenCalled();expect(store.read).not.toHaveBeenCalled();expect(store.ack).not.toHaveBeenCalled();expect(store.cancel).not.toHaveBeenCalled()
 })
 it('fixes source authority and returns only public lifecycle state',async()=>{
   const res=await request(app).post('/internal/external-approvals').set('Authorization',`Bearer ${token}`).send(input)
   expect(res.status).toBe(200);expect(res.body).toEqual(state)
   expect(store.create).toHaveBeenCalledWith(source,{...input,expiresAt:'2030-01-01T00:00:00.000Z'},expect.stringMatching(/^[a-f0-9]{64}$/))
   expect(JSON.stringify(res.body)).not.toContain(token)
   const spoof=await request(app).post('/internal/external-approvals').set('Authorization',`Bearer ${token}`).send({...input,approverUserId:source.approverUserId})
   expect(spoof.status).toBe(400)
 })
 it('validates polling IDs, cancel empty body and ack exact enums',async()=>{
   expect((await request(app).get('/internal/external-approvals/bad%20id').set('Authorization',`Bearer ${token}`)).status).toBe(400)
   expect((await request(app).post('/internal/external-approvals/external-1/ack').set('Authorization',`Bearer ${token}`).send({status:'approved'})).status).toBe(400)
   expect((await request(app).post('/internal/external-approvals/external-1/cancel').set('Authorization',`Bearer ${token}`).send({permission:true})).status).toBe(400)
   expect((await request(app).post('/internal/external-approvals/external-1/cancel').set('Authorization',`Bearer ${token}`).send({})).body.status).toBe('superseded')
   expect(store.read).not.toHaveBeenCalled();expect(store.ack).not.toHaveBeenCalled()
 })
 it('maps conflict and unavailable without leaking private store details',async()=>{
   vi.mocked(store.create).mockRejectedValueOnce(new ExternalApprovalError(409,'Immutable request conflict'))
   expect((await request(app).post('/internal/external-approvals').set('Authorization',`Bearer ${token}`).send(input)).status).toBe(409)
   vi.mocked(store.read).mockResolvedValueOnce(null)
   expect((await request(app).get('/internal/external-approvals/foreign').set('Authorization',`Bearer ${token}`)).status).toBe(404)
 })
})
