import { describe,it,expect } from 'vitest'
import { createHash } from 'node:crypto'
import { normalizeExternalInput,sourceBinding,type ExternalApprovalSource } from '../contracts.js'
const source:ExternalApprovalSource = { id:'pi',tokenSha256:createHash('sha256').update('unit-test-bearer-only').digest('hex'),workspaceId:'00000000-0000-4000-8000-000000000001',assistantId:'00000000-0000-4000-8000-000000000002',approverUserId:'00000000-0000-4000-8000-000000000003',channelType:'web',channelId:'queue' }
const input = { externalRequestId:'request-1',taskId:'task-1',sessionId:'session-1',request:{method:'confirm',title:'Allow this?'},expiresAt:'2030-01-01T00:00:00Z' }
describe('external approvals display protocol',()=>{
  it('permits token rotation without changing the immutable authority binding',()=>{
    expect(sourceBinding(source)).toBe(sourceBinding({...source,tokenSha256:'f'.repeat(64)}))
    expect(sourceBinding(source)).not.toBe(sourceBinding({...source,channelId:'elsewhere'}))
    expect(sourceBinding(source)).not.toBe(sourceBinding({...source,approverUserId:source.assistantId}))
    expect(sourceBinding(source)).not.toBe(sourceBinding({...source,workspaceId:source.assistantId}))
  })
  it('canonicalizes exact relay field order and equivalent ISO expiry',()=>{
    const result=normalizeExternalInput(input)
    expect(result.payloadHash).toBe(createHash('sha256').update(JSON.stringify({...input,expiresAt:'2030-01-01T00:00:00.000Z'})).digest('hex'))
    expect(normalizeExternalInput({...input,expiresAt:'2030-01-01T01:00:00+01:00'}).payloadHash).toBe(result.payloadHash)
    expect(normalizeExternalInput({...input,request:{...input.request,message:'new'}}).payloadHash).not.toBe(result.payloadHash)
  })
  it('rejects authority injection, executable fields, unbounded and unsupported display requests',()=>{
    for(const bad of [{...input,workspaceId:source.workspaceId},{...input,callback:'evil'},{...input,request:{...input.request,toolName:'bash'}},{...input,taskId:''},{...input,request:{method:'select',title:'Choose',options:['Allow always','Deny']}},{...input,request:{method:'confirm',title:'x'.repeat(16385)}},{...input,request:{method:'confirm',title:'a\u0000b'}}]) expect(()=>normalizeExternalInput(bad)).toThrow()
    expect(()=>normalizeExternalInput({...input,request:{method:'select',title:'Choose',options:['Allow once','Deny']}})).not.toThrow()
  })
})
