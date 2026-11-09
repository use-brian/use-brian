import { describe,it,expect } from 'vitest'
import { createHash } from 'node:crypto'
import { externalAnswerSchema,normalizeExternalInput,sourceBinding,type ExternalApprovalSource } from '../contracts.js'
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

describe('question literal protocol',()=>{
  const raw=(request:unknown)=>({externalRequestId:'q',taskId:'t',sessionId:'s',request,expiresAt:'2099-01-01T00:00:00Z'})
  it('preserves literal options, title, message and explicit custom setting',()=>{
    const request={method:'question',title:' \nTitle\t',message:' \nMessage',options:[' A ','a'],allowCustom:false}
    expect(normalizeExternalInput(raw(request)).input.request).toEqual(request)
  })
  it('rejects empty or whitespace-only answers without trimming valid answers',()=>{
    for(const answer of ['', ' ', '\t\r\n', '\u0000', 'x'.repeat(32769)]) expect(externalAnswerSchema.safeParse(answer).success).toBe(false)
    expect(externalAnswerSchema.parse(' \tLiteral\n')).toBe(' \tLiteral\n')
  })
  it('rejects invalid shapes and literal/control/size violations without truncation',()=>{
    for(const extra of [{options:[]},{options:[' \t']},{options:['a','a']},{options:Array.from({length:21},(_,i)=>String(i))},{options:['x'.repeat(2049)]},{options:['bad\u0000']},{allowCustom:false},{allowCustom:'true'},{unknown:true},{title:'x'.repeat(16385)},{message:'x'.repeat(32769)}]) {
      expect(()=>normalizeExternalInput(raw({method:'question',title:'Question',...extra}))).toThrow()
    }
  })
})
