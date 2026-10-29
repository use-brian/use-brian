import {beforeEach,describe,expect,it,vi} from 'vitest'
import {ContextScopeAccumulator,DerivedScopeError,type SessionContextAuthority} from '@use-brian/core'

const fixture=vi.hoisted(()=>({scope:null as unknown,query:vi.fn(),rollback:vi.fn()}))
vi.mock('../client.js',async importOriginal=>({
 ...await importOriginal<typeof import('../client.js')>(),query:fixture.query,queryWithRLS:fixture.query,queryGated:fixture.query,
 getPool:()=>({}),getAppPool:()=>({connect:async()=>({query:fixture.query})}),
 applyRLSGucs:vi.fn(),rollbackAndRelease:fixture.rollback,
 runWithAgentAccess:async(_access:unknown,run:()=>Promise<unknown>)=>run(),
}))
vi.mock('../../application-platform/external-source-ancestry.js',()=>({readExternalSourceAncestors:async()=>[]}))
vi.mock('../../application-platform/field-evidence.js',()=>({readApplicationFieldAncestors:async()=>[]}))
vi.mock('../../application-platform/source-runtime.js',()=>({getSharedRetainedSourceAuthority:()=>undefined}))
vi.mock('../../application-platform/execution-context.js',()=>({
 applyApplicationRLSContext:vi.fn(),releaseApplicationTransactionBinding:vi.fn(),getApplicationExecutionBinding:()=>undefined,
}))
vi.mock('../../context-scope/caller-evidence.js',()=>({
 validateCallerScopeEvidence:async()=>({}),scopeEvidenceFailureOf:()=>undefined,
}))
import {readSessionQueryFrame} from '../session-context-revisions.js'

// Unit boundary: SQL outcomes are synthetic. Actual reader/source authorization
// is covered by the disposable-database session title/history integration suites.
describe('[COMP:api/session-query-floor] absent SQL admission',()=>{
 beforeEach(()=>{
  vi.clearAllMocks()
  fixture.query.mockImplementation(async(sql:string)=>{
   if(sql.includes('read_native_session_query_floor'))return{rows:[{scope:fixture.scope}]}
   if(sql.includes('AS bypass'))return{rows:[{bypass:false}]}
   return{rows:[]}
  })
 })
 function authority():SessionContextAuthority{
  return{accumulator:new ContextScopeAccumulator(),execution:{
   identity:{kind:'attended',principal:{kind:'workspace_member'}},assistant:{id:'assistant'},
   security:{access:{workspaceId:'workspace',userId:'reader'},ceiling:{},authority:{assertCurrent:async()=>{}}},
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
})
