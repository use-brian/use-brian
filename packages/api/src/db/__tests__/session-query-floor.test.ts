import {beforeEach,describe,expect,it,vi} from 'vitest'
import type {SessionContextAuthority} from '@use-brian/core/memory/session-state-types.js'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import {DerivedScopeError,type ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { ContextVerificationUnavailableError } from '../../context-scope/delivery-failure.js'

const fixture=vi.hoisted(()=>({scope:null as unknown,query:vi.fn(),rollback:vi.fn(),externalAncestors:vi.fn()}))
vi.mock('../client.js',async importOriginal=>({
 ...await importOriginal<typeof import('../client.js')>(),query:fixture.query,queryWithRLS:fixture.query,queryGated:fixture.query,
 getPool:()=>({}),getAppPool:()=>({connect:async()=>({query:fixture.query,release:vi.fn()})}),
 applyRLSGucs:vi.fn(),rollbackAndRelease:fixture.rollback,
 runWithAgentAccess:async(_access:unknown,run:()=>Promise<unknown>)=>run(),
}))
vi.mock('../../application-platform/external-source-ancestry.js',()=>({readExternalSourceAncestors:fixture.externalAncestors}))
vi.mock('../../application-platform/field-evidence.js',()=>({readApplicationFieldAncestors:async()=>[]}))
vi.mock('../../application-platform/source-runtime.js',()=>({getSharedRetainedSourceAuthority:()=>undefined}))
vi.mock('../../application-platform/execution-context.js',()=>({
 applyApplicationRLSContext:vi.fn(),releaseApplicationTransactionBinding:vi.fn(),getApplicationExecutionBinding:()=>undefined,
}))
vi.mock('../../context-scope/caller-evidence.js',()=>({
 validateCallerScopeEvidence:async()=>({}),scopeEvidenceFailureOf:()=>undefined,
}))
import {readRetainedQueryFrame,readSessionQueryFrame} from '../session-context-revisions.js'

// Unit boundary: SQL outcomes are synthetic. Actual reader/source authorization
// is covered by the disposable-database session title/history integration suites.
describe('[COMP:api/session-query-floor] absent SQL admission',()=>{
 beforeEach(()=>{
  vi.clearAllMocks()
  fixture.externalAncestors.mockReset().mockResolvedValue([])
  fixture.query.mockImplementation(async(sql:string)=>{
   if(sql.includes('read_native_session_query_floor'))return{rows:[{scope:fixture.scope}]}
   if(sql.includes('AS bypass'))return{rows:[{bypass:false}]}
   return{rows:[]}
  })
 })
 function authority(workspaceId='workspace'):SessionContextAuthority{
  return{accumulator:new ContextScopeAccumulator(),execution:{
   identity:{kind:'attended',principal:{kind:'workspace_member'}},assistant:{id:'assistant'},
   security:{access:{workspaceId,userId:'reader'},ceiling:{},authority:{assertCurrent:async()=>{}}},
   lifecycle:{sessionId:'session',abortSignal:new AbortController().signal},
  } as SessionContextAuthority['execution']}
 }
 it.each([null,undefined])('refuses a missing floor (%s) before reading any transcript',async scope=>{
  fixture.scope=scope
  const capture=vi.fn()
  await expect(readSessionQueryFrame(authority(),[],capture)).rejects.toBeInstanceOf(DerivedScopeError)
  expect(capture).not.toHaveBeenCalled()
  expect(fixture.rollback).toHaveBeenCalledOnce()
 })
 it('keeps malformed non-null metadata visible as a schema error',async()=>{
  fixture.scope={unexpected:'invalid SQL result'}
  const capture=vi.fn()
  await expect(readSessionQueryFrame(authority(),[],capture)).rejects.toMatchObject({name:'ZodError'})
  expect(capture).not.toHaveBeenCalled()
 })

 const memoryRoots:ScopeSource[]=['memory-1','memory-2'].map(resourceId=>({resourceId,resourceKind:'memory',version:'1',
  workspaceId:'workspace',userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[]}))
 it('stops retained Memory on an unavailable ancestry batch without opening a read frame',async()=>{
  const timeout=new ContextVerificationUnavailableError('statement_timeout',new Error('SQL canceled'),'ancestry')
  fixture.externalAncestors.mockRejectedValueOnce(timeout)
  const capture=vi.fn()
  await expect(readRetainedQueryFrame(authority(),memoryRoots,capture)).rejects.toBe(timeout)
  expect(fixture.externalAncestors).toHaveBeenCalledExactlyOnceWith('workspace',memoryRoots)
  expect(fixture.query).not.toHaveBeenCalled()
  expect(capture).not.toHaveBeenCalled()
 })
 it('keeps individual source checks when retained Memory ancestry cannot be resolved as a batch',async()=>{
  const refused=new SourceProtocolError('source_access_denied')
  fixture.externalAncestors.mockRejectedValueOnce(refused).mockRejectedValueOnce(refused)
  const capture=vi.fn()
  await expect(readRetainedQueryFrame(authority(),memoryRoots,capture)).rejects.toBe(refused)
  expect(fixture.externalAncestors.mock.calls).toEqual([['workspace',memoryRoots],['workspace',memoryRoots.slice(0,1)]])
  expect(capture).not.toHaveBeenCalled()
 })
 it.each([readRetainedQueryFrame,readSessionQueryFrame])('narrows a sparse mixed cohort and refuses the external input without a coordinator',async read=>{
  const workspaceId='00000000-0000-4000-8000-000000000001'
  fixture.scope={workspaceId,userId:null,assistantId:null,
   sensitivity:'internal',compartments:[],projectIds:[]}
  const roots=Array.from({length:257},(_,index)=>({...memoryRoots[0],workspaceId,resourceId:String(index)}))
  const last=roots.at(-1)!
  fixture.externalAncestors.mockImplementation(async(_workspace,part:ScopeSource[])=>
   part.some(root=>root.resourceId===last.resourceId)?[{...last,resourceKind:'external_source'}]:[])
  const capture=vi.fn()
  await expect(read(authority(workspaceId),roots,capture)).rejects.toBeInstanceOf(DerivedScopeError)
  const groups=fixture.externalAncestors.mock.calls.map(([,part])=>part as ScopeSource[])
  expect(groups.every(group=>group.length<=100)).toBe(true)
  expect(groups.some(group=>group.length===1&&group[0].resourceId===last.resourceId)).toBe(true)
  expect(groups.length).toBeLessThan(22)
  expect(capture).not.toHaveBeenCalled()
 })
})
