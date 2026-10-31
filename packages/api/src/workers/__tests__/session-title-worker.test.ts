import { describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator, type SessionContextAuthority, type LLMProvider } from '@use-brian/core'
import { createAuthorityLease } from '../../context-scope/authority-lease.js'
import { createSessionTitleWorker, restrictTitleJobAuthority } from '../session-title-worker.js'
import type { SessionTitleJob } from '../../db/session-title-jobs.js'

const uid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const ceiling = { workspaceId:uid(1),userId:uid(2),clearance:'internal' as const,compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[uid(3)] }
const job: SessionTitleJob = {sessionId:uid(4),workspaceId:uid(1),actorUserId:uid(2),assistantId:uid(3),userMessageId:uid(5),
 claims:{userId:uid(2),sessionId:uid(6),authVersion:0},authoring:{version:1,assistantId:uid(3),ceiling},generation:'1',claimedGeneration:'1',leaseToken:uid(7),attempts:1}
const provider: LLMProvider = {name:'fixture',models:['fixture'],stream:async function*(){},createSession:()=>{throw new Error('unused')}}
function authority(current = async () => ceiling): SessionContextAuthority {
 return {accumulator:new ContextScopeAccumulator(),execution:{
  assistant:{id:uid(3)},lifecycle:{sessionId:uid(4)},security:{access:{workspaceId:uid(1),userId:uid(2)},ceiling,authority:createAuthorityLease(ceiling,current)},
 } as unknown as SessionContextAuthority['execution']}
}
function fixture() {
 const fresh = authority(), resolveAuthority = vi.fn(async()=>fresh), finish = vi.fn(async()=>{}), generate = vi.fn(async(_input: unknown)=>({title:'Fictional project notes',written:true,model:'fixture',usage:{inputTokens:3,outputTokens:2}}))
 const deps = {claim:vi.fn(async()=>job),finish,current:vi.fn(async()=>true),resolveAuthority,
  readTitle:vi.fn(async()=>null as {title:string;manual:boolean;revisionId:string}|null),
  readHistory:vi.fn(async()=>[]),countTurns:vi.fn(async()=>10),generate,notify:vi.fn()}
 const resolveRuntime = vi.fn(async()=>({provider,model:'fixture',providerKeySource:'user' as const})),recordUsage=vi.fn(async()=>{})
 return {deps,resolveRuntime,recordUsage,worker:createSessionTitleWorker({deps,resolveRuntime,recordUsage})}
}
describe('[COMP:api/session-title-jobs] current-authority background titles',()=>{
 it('reacquires the originating claims, uses the current runtime and invalidates viewers only after successful publication',async()=>{
  const f=fixture();await f.worker.tick()
  expect(f.deps.resolveAuthority).toHaveBeenCalledWith({claims:job.claims,sessionId:job.sessionId,readOnly:false})
  expect(f.resolveRuntime).toHaveBeenCalledWith(job.workspaceId)
  expect(f.deps.generate.mock.calls[0][0]).toMatchObject({model:'fixture'})
  expect(f.recordUsage).toHaveBeenCalledWith(job,expect.objectContaining({written:true}),expect.objectContaining({providerKeySource:'user'}))
  expect(f.deps.notify).toHaveBeenCalledWith(job.workspaceId,job.sessionId)
  expect(f.deps.finish).toHaveBeenCalledWith(job)
 })
 it('never generates or overwrites a manual title',async()=>{
  const f=fixture();f.deps.readTitle.mockResolvedValue({title:'My chosen title',manual:true,revisionId:uid(8)})
  await f.worker.tick();expect(f.deps.generate).not.toHaveBeenCalled();expect(f.resolveRuntime).not.toHaveBeenCalled()
 })
 it('retains the existing every-ten-human-turn cadence and ignores a lost title CAS',async()=>{
  const f=fixture();f.deps.readTitle.mockResolvedValue({title:'Earlier generated title',manual:false,revisionId:uid(8)})
  f.deps.countTurns.mockResolvedValue(9);await f.worker.tick();expect(f.deps.generate).not.toHaveBeenCalled()
  f.deps.countTurns.mockResolvedValue(10);f.deps.generate.mockResolvedValue({title:null,written:false,model:'fixture',usage:{inputTokens:3,outputTokens:2}} as never)
  await f.worker.tick();expect(f.deps.generate).toHaveBeenCalledOnce();expect(f.deps.notify).not.toHaveBeenCalled()
 })
 it('replaces host placeholders with the same title prefix policy',async()=>{
  const f=fixture();f.deps.readTitle.mockResolvedValue({title:'[Channel] Draft',manual:false,revisionId:uid(8)})
  const prefix=()=> '[Channel]'
  const worker=createSessionTitleWorker({deps:f.deps,resolveRuntime:f.resolveRuntime,recordUsage:f.recordUsage,isPlaceholderTitle:()=>true,getTitleChannelPrefix:prefix})
  await worker.tick();expect(f.deps.countTurns).not.toHaveBeenCalled();expect(f.deps.generate.mock.calls[0][0]).toMatchObject({channelPrefix:prefix})
 })
 it('terminates malformed persisted authentication claims',async()=>{
  const f=fixture();f.deps.claim.mockResolvedValue({...job,claims:{userId:'invalid'}})
  await f.worker.tick();expect(f.deps.resolveAuthority).not.toHaveBeenCalled();expect(f.deps.finish).toHaveBeenCalledWith(expect.anything(),{terminal:true,code:'authority_or_claim_changed'})
 })
 it('does not promote persisted claims into authority after revocation',async()=>{
  const f=fixture();f.deps.resolveAuthority.mockRejectedValue(Object.assign(new Error('revoked'),{reason:'authority_changed'}))
  await f.worker.tick();expect(f.deps.generate).not.toHaveBeenCalled()
  expect(f.deps.finish).toHaveBeenCalledWith(job,{terminal:true,code:'authority_or_claim_changed'})
 })
 it('rejects a wider fresh ceiling and checks live authority and job ownership repeatedly',async()=>{
  const expanded={...authority(),execution:{...authority().execution,security:{...authority().execution.security,ceiling:{...ceiling,compartments:null}}}}
  expect(()=>restrictTitleJobAuthority(expanded,job,async()=>true,new AbortController().signal)).toThrow('title_job_changed')
  let valid=true;const a=restrictTitleJobAuthority(authority(),job,async()=>valid,new AbortController().signal)
  await a.execution.security.authority.assertCurrent();valid=false
  await expect(a.execution.security.authority.assertCurrent()).rejects.toThrow('title_job_changed')
 })
 it('terminates a superseded job and retries a transient provider failure without exposing raw errors',async()=>{
  const f=fixture();f.deps.current.mockResolvedValue(false);await f.worker.tick()
  expect(f.deps.generate).not.toHaveBeenCalled();expect(f.deps.finish).toHaveBeenLastCalledWith(job,{terminal:true,code:'authority_or_claim_changed'})
  f.deps.current.mockResolvedValue(true);f.deps.generate.mockRejectedValue(new Error('private provider detail'))
  await f.worker.tick();expect(f.deps.finish).toHaveBeenLastCalledWith(job,{terminal:false,code:'title_generation_failed'})
 })
 it('serializes concurrent ticks',async()=>{
  const f=fixture();let release!:()=>void
  f.deps.generate.mockImplementation(async()=>{await new Promise<void>(resolve=>{release=resolve});return{title:null,written:false,model:null,usage:null} as never})
  const first=f.worker.tick(),second=f.worker.tick()
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
  release();await Promise.all([first,second]);expect(f.deps.claim).toHaveBeenCalledOnce()
 })
})
