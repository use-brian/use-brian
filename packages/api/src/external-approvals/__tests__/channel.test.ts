import { describe, it, expect, vi } from 'vitest'
import { ExternalApprovalService, type ExternalApprovalStore } from '../service.js'
import { sourceBinding, type ExternalApprovalSource } from '../contracts.js'
import { testSources } from './test-sources.js'

const source: ExternalApprovalSource = { id:'channel', tokenSha256:'a'.repeat(64), workspaceId:'00000000-0000-4000-8000-000000000001', assistantId:'00000000-0000-4000-8000-000000000002', approverUserId:'00000000-0000-4000-8000-000000000003', channelType:'telegram', channelId:'fixed-dm', channelIntegrationId:'00000000-0000-4000-8000-000000000004' }
function fixture(s = source) {
  const store: ExternalApprovalStore = { create:vi.fn(), read:vi.fn(), ack:vi.fn(), cancel:vi.fn(), sourceForApproval:vi.fn(async()=>({sourceId:s.id,binding:sourceBinding(s)})), decide:vi.fn(async()=>({approvalId:'approval',externalRequestId:'request',status:'approved' as const,expiresAt:'2030-01-01T00:00:00.000Z',payloadHash:'a'.repeat(64)})) }
  const sources=testSources(s)
  return {store,sources,service:new ExternalApprovalService(sources,store)}
}
const actor = { userId:source.approverUserId, human:true, origin:'channel' as const, channelId:source.channelId, channelIntegrationId:source.channelIntegrationId }
describe('external approval channel authority',()=>{
  it('requires the exact configured channel and integration, not just the same human',async()=>{
    const {store,service}=fixture()
    for(const invalid of [{...actor,channelId:'other'}, {...actor,channelIntegrationId:'other'}, {...actor,channelId:undefined}, {...actor,channelIntegrationId:undefined}]) {
      await expect(service.resolve('approval','approved',invalid)).rejects.toMatchObject({status:404})
    }
    expect(store.decide).not.toHaveBeenCalled()
    await expect(service.resolve('approval','approved',actor)).resolves.toMatchObject({status:'approved'})
    expect(store.decide).toHaveBeenCalledOnce()
  })
  it('does not allow a channel reply after the workspace registration is revoked',async()=>{
    const {store,sources,service}=fixture()
    sources.entries.delete(source.id)
    await expect(service.resolve('approval','approved',actor)).rejects.toMatchObject({status:404})
    expect(store.decide).not.toHaveBeenCalled()
  })
  it('fails closed without a pinned integration or for a web-only source',async()=>{
    for(const s of [{...source,channelIntegrationId:undefined},{...source,channelType:'web' as const}]) {
      const {store,service}=fixture(s)
      await expect(service.resolve('approval','approved',actor)).rejects.toMatchObject({status:404})
      expect(store.decide).not.toHaveBeenCalled()
      await expect(service.resolve('approval','approved',{userId:source.approverUserId,human:true,origin:'ui'})).resolves.toMatchObject({status:'approved'})
    }
  })
})
