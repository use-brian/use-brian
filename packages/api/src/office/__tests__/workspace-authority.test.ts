import { describe,expect,it,vi } from 'vitest'
import { createExecutionContext,executionToolContext,bindWorkspaceCredentialDelegation,ContextScopeAccumulator } from '@use-brian/core'
import { captureOfficeWorkspaceAuthority,withOfficeWorkspaceAuthority } from '../workspace-authority.js'
const mocked=vi.hoisted(()=>({restore:vi.fn(),input:vi.fn(),output:vi.fn()}))
vi.mock('../../workspace-mcp/delegation.js',()=>({restoreWorkspaceMcpDelegation:mocked.restore}))
vi.mock('../../db/capability-store.js',()=>({createDbCapabilityStore:()=>({})}))
vi.mock('../../db/session-context-revisions.js',()=>({bindWorkspaceMcpPublication:()=>{}}))
vi.mock('../../application-platform/model-source-authority.js',()=>({assertSourceModelInputAuthority:mocked.input,assertSourceModelOutputAuthority:mocked.output}))
const uid=(n:number)=>`77000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function fixture(){
 let active=true
 const parent={kind:'brain_key' as const,credentialId:uid(1),revision:'a'.repeat(64),userId:uid(2),workspaceId:uid(3),assistantId:uid(4),sessionId:uid(5)}
 const execution=createExecutionContext({identity:{kind:'programmatic',principal:{kind:'brain_key',credentialId:parent.credentialId,actorUserId:parent.userId},credentialOwnerUserId:parent.userId},
 ownership:{kind:'workspace',workspaceId:parent.workspaceId},access:{...parent,assistantKind:'primary',clearance:'internal',compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[]},
 writeDefaults:{compartments:[],projectIds:[]},authority:{assertCurrent:async()=>{if(!active)throw new Error('revoked')},execute:async work=>work()},
 lifecycle:{sessionId:parent.sessionId,channelType:'programmatic',channelId:parent.credentialId,abortSignal:new AbortController().signal}})
 bindWorkspaceCredentialDelegation(execution,parent)
 const context={...executionToolContext(execution,{appId:'fixture'}),scopeAccumulator:new ContextScopeAccumulator()}
 mocked.restore.mockImplementation(async()=>{await execution.security.authority.assertCurrent();return {context,consent:{}}})
 return {parent,context,revoke:()=>{active=false}}
}
describe('[COMP:api/office-generation] workspace job origin',()=>{
 it('captures only the host-bound credential and checks it before model work',async()=>{
  const f=fixture(),origin=await captureOfficeWorkspaceAuthority(f.context),run=vi.fn(async()=> 'made')
  const job={initiatedByUserId:f.parent.userId,workspaceId:f.parent.workspaceId,authorityProjection:origin} as never
  expect(origin.workspaceDelegation).toEqual(f.parent)
  expect(await withOfficeWorkspaceAuthority(job,run)).toBe('made')
  f.revoke()
  await expect(withOfficeWorkspaceAuthority(job,run)).rejects.toThrow('revoked')
  expect(run).toHaveBeenCalledTimes(1)
 })
 it('checks revocation again before releasing results',async()=>{
  const f=fixture(),origin=await captureOfficeWorkspaceAuthority(f.context)
  const job={initiatedByUserId:f.parent.userId,workspaceId:f.parent.workspaceId,authorityProjection:origin} as never
  await expect(withOfficeWorkspaceAuthority(job,async()=>{f.revoke();return 'private result'})).rejects.toThrow('revoked')
 })
 it('does not let copied execution JSON claim a credential origin',async()=>{
  const f=fixture()
  expect(await captureOfficeWorkspaceAuthority({...f.context,executionContext:{...f.context.executionContext!}})).toEqual({})
 })
})
