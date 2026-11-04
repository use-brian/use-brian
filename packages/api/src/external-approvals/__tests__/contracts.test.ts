import { describe,it,expect } from 'vitest'
import { createHash } from 'node:crypto'
import { parseExternalApprovalSources,authenticateSource,normalizeExternalInput,sourceBinding } from '../contracts.js'
const source = { id:'pi',tokenSha256:createHash('sha256').update('unit-test-bearer-only').digest('hex'),workspaceId:'00000000-0000-4000-8000-000000000001',assistantId:'00000000-0000-4000-8000-000000000002',approverUserId:'00000000-0000-4000-8000-000000000003',channelType:'web',channelId:'queue' }
const input = { externalRequestId:'request-1',taskId:'task-1',sessionId:'session-1',request:{method:'confirm',title:'Allow this?'},expiresAt:'2030-01-01T00:00:00Z' }
describe('external approvals display protocol',()=>{
  it('defaults disabled and fails closed without leaking malformed configuration',()=>{
    expect(parseExternalApprovalSources()).toEqual([])
    for(const raw of ['', '{}', JSON.stringify([{...source,token:'secret'}]), JSON.stringify([source,source]), JSON.stringify([{...source,tokenSha256:'bad'}])]) {
      expect(()=>parseExternalApprovalSources(raw)).toThrow('Invalid BRIAN_EXTERNAL_APPROVAL_SOURCES configuration')
    }
  })
  it('authenticates only hashed bearer sources and permits token rotation with unchanged binding',()=>{
    const sources = parseExternalApprovalSources(JSON.stringify([source]))
    expect(authenticateSource(sources,'Bearer unit-test-bearer-only')?.id).toBe('pi')
    for(const header of [undefined,'unit-test-bearer-only','Bearer wrong-test-bearer','bearer unit-test-bearer-only']) expect(authenticateSource(sources,header)).toBeNull()
    expect(sourceBinding(sources[0])).toBe(sourceBinding({...sources[0],tokenSha256:'f'.repeat(64)}))
    expect(sourceBinding(sources[0])).not.toBe(sourceBinding({...sources[0],channelId:'elsewhere'}))
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
