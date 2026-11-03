import { describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator, type SessionContextAuthority, type LLMProvider, type SessionStateStore } from '@use-brian/core'
import { createAuthorityLease } from '../../context-scope/authority-lease.js'
import { backgroundSessionStateStore, createSessionStateWorker, restrictStateJobAuthority } from '../session-state-worker.js'
import type { SessionStateJob } from '../../db/session-state-jobs.js'

const uid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const ceiling = { workspaceId:uid(1),userId:uid(2),clearance:'internal' as const,compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[uid(3)] }
const job: SessionStateJob = {sessionId:uid(4),workspaceId:uid(1),actorUserId:uid(2),assistantId:uid(3),userMessageId:uid(5),assistantMessageId:uid(8),
 firstSequence:1,throughSequence:2,claims:{userId:uid(2),sessionId:uid(6),authVersion:0},authoring:{version:1,assistantId:uid(3),ceiling},generation:'1',claimedGeneration:'1',leaseToken:uid(7),attempts:1}
const provider: LLMProvider = {name:'fixture',models:['fixture'],stream:async function*(){},createSession:()=>{throw new Error('unused')}}
function authority(): SessionContextAuthority {
 return {accumulator:new ContextScopeAccumulator(),execution:{
  assistant:{id:uid(3)},lifecycle:{sessionId:uid(4)},security:{access:{workspaceId:uid(1),userId:uid(2)},ceiling,authority:createAuthorityLease(ceiling,async()=>ceiling)},
 } as unknown as SessionContextAuthority['execution']}
}
function fixture() {
 const fresh=authority(),deps={claim:vi.fn(async()=>job),finish:vi.fn(async()=>{}),current:vi.fn(async()=>true),
  resolveAuthority:vi.fn(async()=>fresh),analyze:vi.fn(async(_input: unknown)=>({upserts:1,resolves:0,model:'fixture',usage:{inputTokens:3,outputTokens:2}}))}
 const resolveRuntime=vi.fn(async()=>({provider,model:'fixture',providerKeySource:'user' as const})),recordResult=vi.fn(async()=>{})
 return {deps,resolveRuntime,recordResult,worker:createSessionStateWorker({deps,resolveRuntime,recordResult})}
}
describe('[COMP:api/session-state-jobs] background inference lifecycle',()=>{
 it('reacquires native authority and current runtime without any captured request or turn lease',async()=>{
  const f=fixture();await f.worker.tick()
  expect(f.deps.resolveAuthority).toHaveBeenCalledWith({claims:job.claims,sessionId:job.sessionId,readOnly:false})
  expect(f.resolveRuntime).toHaveBeenCalledWith(job.workspaceId)
  expect(f.recordResult).toHaveBeenCalledWith(job,expect.objectContaining({upserts:1}),expect.objectContaining({providerKeySource:'user'}))
  expect(f.deps.finish).toHaveBeenCalledWith(job)
 })
 it('refuses late writes after another turn starts and retains work for reanalysis',async()=>{
  const f=fixture()
  f.deps.analyze.mockImplementation(async(input:any)=>{
   f.deps.current.mockResolvedValue(false)
   await input.authority.execution.security.authority.assertCurrent()
   throw new Error('must never reach a write')
  })
  await f.worker.tick()
  expect(f.recordResult).not.toHaveBeenCalled()
  expect(f.deps.finish).toHaveBeenCalledWith(job,{terminal:false,code:'state_analysis_unavailable'})
 })
 it('refuses revoked or expanded authority before model dispatch',async()=>{
  const f=fixture();f.deps.resolveAuthority.mockRejectedValue(Object.assign(new Error('revoked'),{reason:'authority_changed'}))
  await f.worker.tick();expect(f.deps.analyze).not.toHaveBeenCalled()
  const original=authority();const fresh={...original,execution:{...original.execution,security:{...original.execution.security,ceiling:{...ceiling,compartments:null}}}}
  expect(()=>restrictStateJobAuthority(fresh,job,async()=>true,new AbortController().signal)).toThrow('state_job_changed')
 })
 it('terminates malformed claims and records provider failures without reporting successful processing',async()=>{
  const f=fixture();f.deps.claim.mockResolvedValue({...job,claims:{userId:'invalid'}})
  await f.worker.tick();expect(f.deps.finish).toHaveBeenCalledWith(expect.anything(),{terminal:true,code:'invalid_authority'})
  expect(f.deps.resolveAuthority).not.toHaveBeenCalled()
  f.deps.claim.mockResolvedValue(job)
  f.deps.analyze.mockResolvedValue({upserts:0,resolves:0,usage:null,model:null,errorMessage:'private provider error'} as never)
  await f.worker.tick();expect(f.recordResult).toHaveBeenCalledOnce()
  expect(f.deps.finish).toHaveBeenLastCalledWith(job,{terminal:false,code:'state_analysis_unavailable'})
 })
 it('limits concurrent ticks and cancels a running model when stopping',async()=>{
  const f=fixture();let started=false
  f.deps.analyze.mockImplementation(async(input:any)=>{
   started=true
   const signal=input.authority.execution.lifecycle.abortSignal as AbortSignal
   await new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
   throw new Error('unreachable')
  })
  const first=f.worker.tick(),second=f.worker.tick()
  await vi.waitFor(()=>expect(started).toBe(true))
  await f.worker.stop();await Promise.all([first,second])
  expect(f.deps.claim).toHaveBeenCalledOnce();expect(f.recordResult).not.toHaveBeenCalled()
 })
 it('passes the pre-inference generation to SQL and advances only after its own successful writes',async()=>{
  const row={id:uid(9)} as never
  const deps={base:{} as SessionStateStore,upsert:vi.fn(async(_p:any)=>row),resolve:vi.fn(async(_p:any)=>null as any)}
  const store=backgroundSessionStateStore('41',deps)
  await store.upsert({sessionId:job.sessionId,key:'fixture:a',summary:'A',userId:job.actorUserId,assistantId:job.assistantId,source:'diff-pass'})
  await store.resolve({sessionId:job.sessionId,key:'fixture:absent',source:'diff-pass'})
  await store.upsert({sessionId:job.sessionId,key:'fixture:b',summary:'B',userId:job.actorUserId,assistantId:job.assistantId,source:'diff-pass'})
  expect(deps.upsert.mock.calls.map(([p])=>p.expectedGeneration)).toEqual(['41','42'])
  expect(deps.resolve.mock.calls[0][0].expectedGeneration).toBe('42')
  deps.upsert.mockRejectedValue(new Error('stale generation'))
  await expect(store.upsert({} as never)).rejects.toMatchObject({reason:'authority_changed'})
 })
})
