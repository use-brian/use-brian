import {describe,it,expect,vi} from 'vitest'
import type {PoolClient} from 'pg'
import type {AccessCeiling,ScopeSource} from '@use-brian/core'
import {readValidatedNativePrivateTitle} from '../context-scope/caller-evidence.js'
import {readNativePrivateTitleEvidence,readNativePrivateTitleAcquisition} from './native-private-title-evidence.js'
import {readNativeSessionEvidence} from './native-session-evidence.js'

const workspaceId='10000000-0000-4000-8000-000000000001'
const revisionId='10000000-0000-4000-8000-000000000002'
const sessionId='10000000-0000-4000-8000-000000000003'
const root:ScopeSource={workspaceId,userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[],
 resourceKind:'session_context_revision',resourceId:revisionId,version:'1'}
const head={sessionId,revisionId}
const privateLeaf:ScopeSource={...root,userId:sessionId,resourceKind:'private_transcript',resourceId:sessionId}
const allowed=()=>({admitted:true,immutable:[structuredClone(root),structuredClone(privateLeaf)],current:[structuredClone(root),structuredClone(privateLeaf)]})
function connection(values:unknown[]){
 const query=vi.fn(async(sql:string,args?:unknown[])=>{
  if(sql==='SELECT to_regprocedure($1) IS NOT NULL AS available'){
   expect(args).toEqual(['public.read_native_retained_scope_evidence(uuid,jsonb)'])
   return{rows:[{available:false}]}
  }
  return{rows:[values.shift()]}
 })
 return{query,client:{query} as unknown as Pick<PoolClient,'query'>}
}

describe('optional singleton private title proof',()=>{
 it('probes every operation without caching and sends identities only',async()=>{
  const {client,query}=connection([{available:true},{value:{title:{...head,content:{title:'Saved'}},proof:allowed()}},
   {available:true},{value:allowed()}])
  expect((await readNativePrivateTitleAcquisition(client,workspaceId,head,[root]))?.title.content).toEqual({title:'Saved'})
  expect((await readNativePrivateTitleEvidence(client,workspaceId,[root]))?.kind).toBe('complete')
  expect(query.mock.calls).toHaveLength(4)
  expect(query).toHaveBeenNthCalledWith(2,'SELECT read_native_private_title_acquisition($1,$2,$3) AS value',[workspaceId,sessionId,revisionId])
  expect(query).toHaveBeenNthCalledWith(4,'SELECT read_native_private_title_evidence($1,$2) AS value',[workspaceId,revisionId])
 })
 it('accepts the closed private transcript source profile',async()=>{
  const proof=allowed()
  const {client}=connection([{available:true},{value:proof}])
  expect((await readNativePrivateTitleEvidence(client,workspaceId,[root]))?.evidence.sources).toHaveLength(2)
 })
 it('does not probe unrelated roots or versions',async()=>{
  const {client,query}=connection([])
  for(const roots of [[],[root,root],[{...root,version:'2'}],[{...root,resourceKind:'memory' as const}]]){
   expect(await readNativePrivateTitleEvidence(client,workspaceId,roots)).toBeNull()
  }
  expect(query).not.toHaveBeenCalled()
 })
 it('returns unsupported on missing API or SQL NULL',async()=>{
  for(const values of [[{available:false}],[{available:true},{value:null}]]){
   expect(await readNativePrivateTitleEvidence(connection(values).client,workspaceId,[root])).toBeNull()
  }
 })
 it('tries the singleton proof before the original ladder and preserves NULL fallback',async()=>{
  const {client,query}=connection([{available:true},{value:null},{value:{admitted:true,immutable:[root],current:[root]}}])
  expect((await readNativeSessionEvidence(client,workspaceId,[root]))?.kind).toBe('complete')
  const reads=query.mock.calls.filter(([sql])=>!sql.includes('to_regprocedure'))
  expect(reads.map(([sql])=>sql)).toEqual([
   'SELECT read_native_private_title_evidence($1,$2) AS value','SELECT read_native_turn_scope_evidence($1,$2) AS value',
  ])
  expect(reads[1][1]).toEqual([workspaceId,JSON.stringify([{kind:root.resourceKind,id:revisionId,version:'1'}])])
 })
 it('rejects denial without falling through to another proof',async()=>{
  const {client,query}=connection([{available:true},{value:{admitted:false}}])
  await expect(readNativeSessionEvidence(client,workspaceId,[root])).rejects.toThrow()
  expect(query.mock.calls).toHaveLength(2)
  const denied=connection([{available:true},{value:{title:null,proof:{admitted:false}}}])
  await expect(readNativePrivateTitleAcquisition(denied.client,workspaceId,head,[root])).rejects.toThrow()
 })
 it('rejects mismatched or malformed complete packets',async()=>{
  for(const value of [
   {...allowed(),extra:true},
   {...allowed(),immutable:[]},
   {...allowed(),current:[]},
   {...allowed(),immutable:[root]},
   {...allowed(),current:[root]},
   {...allowed(),immutable:[root,{...privateLeaf,version:'2'}]},
   {...allowed(),immutable:[{...root,sensitivity:'public'}]},
   {...allowed(),immutable:[{...root,version:'2'}]},
   {...allowed(),current:[{...root,workspaceId:sessionId}]},
   {...allowed(),current:[{...root,resourceKind:'workspace_file'}]},
  ]){
   await expect(readNativePrivateTitleEvidence(connection([{available:true},{value}]).client,workspaceId,[root])).rejects.toThrow()
  }
 })
 it('rejects substituted payload identities and non-object content',async()=>{
  for(const title of [{...head,revisionId:sessionId,content:{}},{...head,sessionId:revisionId,content:{}},
   {...head,content:[]},{...head,content:null}]){
   const {client}=connection([{available:true},{value:{title,proof:allowed()}}])
   await expect(readNativePrivateTitleAcquisition(client,workspaceId,head,[root])).rejects.toThrow()
  }
 })
 it('checks the original scalar floor before invoking the payload operation',async()=>{
  const ceiling:AccessCeiling={workspaceId,userId:sessionId,clearance:'internal',compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[]}
  const {client,query}=connection([])
  await expect(readValidatedNativePrivateTitle(head,{sources:[root],sensitivity:'confidential'},ceiling,client)).rejects.toMatchObject({diagnostic:'clearance'})
  expect(query).not.toHaveBeenCalled()
 })
 it('preserves acquisition timeouts through the private caller validator',async()=>{
  const ceiling:AccessCeiling={workspaceId,userId:sessionId,clearance:'internal',compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[]}
  for(const code of ['57014','55P03']){
   const error=Object.assign(new Error('SQL timeout'),{code})
   const client={query:vi.fn().mockResolvedValueOnce({rows:[{available:true}]}).mockRejectedValueOnce(error)} as unknown as Pick<PoolClient,'query'>
   await expect(readValidatedNativePrivateTitle(head,{sources:[root]},ceiling,client)).rejects.toBe(error)
  }
 })
 it('propagates SQL cancellation unchanged',async()=>{
  const error=Object.assign(new Error('statement timeout'),{code:'57014'})
  const client={query:vi.fn().mockRejectedValue(error)} as unknown as Pick<PoolClient,'query'>
  await expect(readNativePrivateTitleEvidence(client,workspaceId,[root])).rejects.toBe(error)
  await expect(readNativePrivateTitleAcquisition(client,workspaceId,head,[root])).rejects.toBe(error)
 })
})
