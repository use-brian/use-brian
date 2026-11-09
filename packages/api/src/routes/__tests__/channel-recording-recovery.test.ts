/** [COMP:api/channel-recording] Authenticated recovery is mounted on Channels. */
import { randomUUID } from 'node:crypto'
import type { ErrorRequestHandler } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from './helpers.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'

vi.mock('../../channel-recording-recovery.js', () => ({
  previewTelegramRecordingRecovery: vi.fn(), applyTelegramRecordingRecovery: vi.fn(),
}))
vi.mock('../../db/channels-store.js', async original => ({
  ...await original<typeof import('../../db/channels-store.js')>(), getChannelForUser: vi.fn(),
}))
import { channelsRoutes } from '../channels.js'
import { getChannelForUser, type Channel } from '../../db/channels-store.js'
import { previewTelegramRecordingRecovery, applyTelegramRecordingRecovery } from '../../channel-recording-recovery.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'

const actorId=randomUUID(),workspaceId=randomUUID(),channelId=randomUUID(),sessionId=randomUUID()
const path=`/api/workspaces/${workspaceId}/channels/${channelId}/recordings/legacy-recovery`
const snapshotToken='a'.repeat(64)
const body={sessionId,snapshotToken,confirmConnectedByMe:true,confirmHistoryReview:true}
const makeApp=(authenticated=true)=>{
  const app=createTestApp('/api',channelsRoutes({workspaceStore:{} as WorkspaceStore}),authenticated?{userId:actorId}:undefined)
  const errors:ErrorRequestHandler=(_error,_req,res,_next)=>{res.status(500).json({error:'internal'})}
  app.use(errors)
  return app
}
describe('[COMP:api/channel-recording] Channels legacy recovery HTTP boundary',()=>{
  beforeEach(()=>{
    vi.clearAllMocks()
    vi.mocked(getChannelForUser).mockResolvedValue({id:channelId,workspaceId,channelType:'telegram'} as Channel)
    vi.mocked(previewTelegramRecordingRecovery).mockResolvedValue({candidates:[]})
    vi.mocked(applyTelegramRecordingRecovery).mockResolvedValue({sessionId:randomUUID(),policyId:randomUUID(),revision:1})
  })
  it('requires authentication before preview or apply',async()=>{
    expect((await request(makeApp(false)).get(path)).status).toBe(401)
    expect((await request(makeApp(false)).post(path).send(body)).status).toBe(401)
    expect(getChannelForUser).not.toHaveBeenCalled()
    expect(previewTelegramRecordingRecovery).not.toHaveBeenCalled()
    expect(applyTelegramRecordingRecovery).not.toHaveBeenCalled()
  })
  it.each(['foreign workspace','not visible to member'])('keeps %s channel metadata unavailable',async reason=>{
    vi.mocked(getChannelForUser).mockResolvedValue(reason==='foreign workspace'?{id:channelId,workspaceId:randomUUID()} as Channel:null)
    expect((await request(makeApp()).get(path)).status).toBe(404)
    expect((await request(makeApp()).post(path).send(body)).status).toBe(404)
    expect(previewTelegramRecordingRecovery).not.toHaveBeenCalled()
    expect(applyTelegramRecordingRecovery).not.toHaveBeenCalled()
  })
  it('passes the authenticated actor and exact URL channel to metadata preview',async()=>{
    const result=await request(makeApp()).get(path)
    expect(result.status).toBe(200)
    expect(result.body).toEqual({candidates:[]})
    expect(previewTelegramRecordingRecovery).toHaveBeenCalledWith({actorId,workspaceId,channelId})
  })
  it.each([
    {sessionId,snapshotToken},
    {...body,confirmConnectedByMe:false}, {...body,confirmHistoryReview:false},
    {...body,snapshotToken:'invalid'}, {...body,sessionId:'invalid'}, {...body,actorId:randomUUID()},
  ])('requires both explicit confirmations and the exact bounded request schema %#',async input=>{
    expect((await request(makeApp()).post(path).send(input)).status).toBe(400)
    expect(applyTelegramRecordingRecovery).not.toHaveBeenCalled()
  })
  it('binds the exact reviewed source/token to the authenticated actor',async()=>{
    const result=await request(makeApp()).post(path).send(body)
    expect(result.status).toBe(200)
    expect(applyTelegramRecordingRecovery).toHaveBeenCalledWith({actorId,workspaceId,channelId,...body})
  })
  it.each([Object.assign(new Error('denied'),{code:'42501'}),new WorkspaceAccessError('recording_recovery_unavailable',409)])('returns a conflict for a rejected recovery without claiming success',async error=>{
    vi.mocked(applyTelegramRecordingRecovery).mockRejectedValue(error)
    const result=await request(makeApp()).post(path).send(body)
    expect(result.status).toBe(409)
    expect(result.body).toEqual({error:'recording_recovery_unavailable'})
  })
  it('propagates unexpected database failures rather than claiming a stale review or empty preview',async()=>{
    vi.mocked(applyTelegramRecordingRecovery).mockRejectedValue(new Error('database unavailable'))
    expect((await request(makeApp()).post(path).send(body)).status).toBe(500)
    vi.mocked(previewTelegramRecordingRecovery).mockRejectedValue(new Error('database unavailable'))
    const result=await request(makeApp()).get(path)
    expect(result.status).toBe(500)
    expect(result.body).not.toHaveProperty('candidates')
  })
})
