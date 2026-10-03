import { it, expect, vi, beforeEach } from 'vitest'
const capture = vi.hoisted(() => ({ construct: vi.fn() }))
beforeEach(() => capture.construct.mockClear())
vi.mock('@use-brian/core',async()=>({
 ...(await import('../../../../core/src/computer-use/trace.js')),
 NativeComputerOrchestrator: class { constructor(deps: unknown) { capture.construct(deps) } },
 createNativeComputerTools: ()=>({nativeComputerTask:{execute:vi.fn().mockResolvedValue({data:{outcome:'completed',reason:'done',actions:1},isError:false})}}),
}))
import { composeNativeComputerTool, type NativeRunObserverFactory } from '../composition.js'
import type { NativeComputerService } from '../service.js'
import type { ToolContext, NativeRunTrace, NativeTraceEvent } from '@use-brian/core'
it('Start and chat share the durable claim and dispose wiring after completion',async()=>{
 let claimed=false
 const grant={goal:'approved',identity:{sessionId:'00000000-0000-4000-8000-000000000001'},epoch:1,targets:[{}]}
 const service={binding:vi.fn().mockResolvedValue({grant,scope:{}}),claimRun:vi.fn(async()=>{if(claimed)return false;claimed=true;return true}),finishRun:vi.fn()}
 const runtime=vi.fn().mockResolvedValue({})
 const tool=composeNativeComputerTool(service as unknown as NativeComputerService,runtime)
 const context: ToolContext={userId:'u',workspaceId:'w',assistantId:'a',sessionId:'c',appId:'test',channelType:'web',channelId:'c',activeCapabilities:new Set(['native_computer']),abortSignal:new AbortController().signal}
 const results=await Promise.all([tool.execute({goal:'approved'},context),tool.execute({goal:'approved'},context)])
 expect(runtime).toHaveBeenCalledTimes(1)
 expect(service.finishRun).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-000000000001','u',false)
 expect(results.some(r=>(r.data as {duplicate?:boolean}).duplicate)).toBe(true)
 await tool.execute({goal:'approved'},context)
 expect(runtime).toHaveBeenCalledTimes(1)
})
it('passes the exact context and task filter to service-owned binding; a denial never claims or resolves runtime',async()=>{
 const service={binding:vi.fn().mockResolvedValue(null),claimRun:vi.fn()}
 const runtime=vi.fn(),tool=composeNativeComputerTool(service as unknown as NativeComputerService,runtime)
 const context:ToolContext={userId:'u',workspaceId:'w',assistantId:'a',sessionId:'c',appId:'native-computer',channelType:'native-computer',channelId:'requested-session',activeCapabilities:new Set(['native_computer']),abortSignal:new AbortController().signal,
  taskAuthority:{kind:'realtime_thread_target',targetId:'target',channelType:'web',channelRef:'channel',threadRef:'thread',taskIds:['task-B'],expiresAt:new Date(Date.now()+60_000).toISOString()}}
 expect((await tool.execute({goal:'approved',sessionId:'other-session'},context)).isError).toBe(true)
 expect(service.binding).toHaveBeenCalledExactlyOnceWith({userId:'u',workspaceId:'w',assistantId:'a',conversationId:'c'},['task-B'],context)
 expect(service.binding.mock.calls[0][2]).toBe(context)
 expect(service.claimRun).not.toHaveBeenCalled();expect(runtime).not.toHaveBeenCalled()
 expect(capture.construct).not.toHaveBeenCalled()
})
it('model goal cannot substitute for the locally approved goal',async()=>{
 const service={binding:vi.fn().mockResolvedValue({grant:{goal:'approved'}}),claimRun:vi.fn()}
 const runtime=vi.fn()
 const tool=composeNativeComputerTool(service as unknown as NativeComputerService,runtime)
 const context: ToolContext={userId:'u',workspaceId:'w',assistantId:'a',sessionId:'c',appId:'test',channelType:'web',channelId:'c',activeCapabilities:new Set(['native_computer']),abortSignal:new AbortController().signal}
 expect((await tool.execute({goal:'attacker'},context)).isError).toBe(true)
 expect(service.claimRun).not.toHaveBeenCalled()
 expect(runtime).not.toHaveBeenCalled()
})

function observedFixture() {
 let claimed=false
 const order:string[]=[]
 const grant={goal:'private-goal',identity:{sessionId:'00000000-0000-4000-8000-000000000002'},epoch:7,targets:[{appId:'private-app'}]}
 const service={binding:vi.fn().mockResolvedValue({grant,scope:{}}),claimRun:vi.fn(async()=>{order.push('claim');if(claimed)return false;claimed=true;return true}),finishRun:vi.fn()}
 const context:ToolContext={userId:'private-user',workspaceId:'private-workspace',assistantId:'private-assistant',sessionId:'private-conversation',appId:'test',channelType:'web',channelId:'c',activeCapabilities:new Set(['native_computer']),abortSignal:new AbortController().signal}
 const events:NativeTraceEvent[]=[]
 const observerFactory=vi.fn((_binding: import('../composition.js').NativeObserverBinding)=>{order.push('observer-factory');return (event:NativeTraceEvent)=>{events.push(event)}})
 let trace:NativeRunTrace|undefined
 const runtime=vi.fn(async (_context:ToolContext,_grant:unknown,shared?:NativeRunTrace)=>{order.push('runtime');trace=shared;return {llm:{} as never}})
 const tool=(factory:NativeRunObserverFactory|undefined=observerFactory)=>composeNativeComputerTool(service as unknown as NativeComputerService,runtime,factory)
 return {service,context,events,observerFactory,runtime,tool,grant,order,trace:()=>trace}
}
it('creates the trusted observer only after one successful durable claim and shares one trace with runtime/orchestrator',async()=>{
 const f=observedFixture(),tool=f.tool()
 const results=await Promise.all([tool.execute({goal:f.grant.goal},f.context),tool.execute({goal:f.grant.goal},f.context)])
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(f.observerFactory).toHaveBeenCalledTimes(1)
 expect(f.observerFactory).toHaveBeenCalledWith({sessionId:f.grant.identity.sessionId,epoch:7})
 expect(Object.isFrozen(f.observerFactory.mock.calls[0]![0])).toBe(true)
 expect(f.runtime).toHaveBeenCalledTimes(1)
 expect(capture.construct).toHaveBeenCalledTimes(1)
 expect(capture.construct.mock.calls[0]![0].trace).toBe(f.trace())
 expect(f.order.indexOf('claim')).toBeLessThan(f.order.indexOf('observer-factory'))
 expect(f.order.indexOf('observer-factory')).toBeLessThan(f.order.indexOf('runtime'))
 expect(results.some(r=>(r.data as {duplicate?:boolean}).duplicate)).toBe(true)
 expect(f.events.map(e=>e.kind)).toEqual(['run-start','run-terminal'])
 expect(f.events.at(-1)).toMatchObject({outcome:'completed',drain:'not_observed'})
 expect(JSON.stringify(f.events)).not.toContain('private-')
 expect(f.service.finishRun).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-000000000002','private-user',false)
 await tool.execute({goal:f.grant.goal},f.context)
 expect(f.observerFactory).toHaveBeenCalledTimes(1)
 expect(f.runtime).toHaveBeenCalledTimes(1)
})
it('does not activate observation through model/UI data or by default',async()=>{
 const f=observedFixture()
 const tool=composeNativeComputerTool(f.service as unknown as NativeComputerService,f.runtime)
 await tool.execute({goal:f.grant.goal,trace:true,observer:true},f.context)
 expect(f.runtime.mock.calls[0]![2]).toBeUndefined()
 expect(capture.construct.mock.calls[0]![0].trace).toBeUndefined()
 expect(f.observerFactory).not.toHaveBeenCalled()
})
it.each(['goal','claim','capability','cancelled'] as const)('cannot create an observer for rejected %s admission',async denial=>{
 const f=observedFixture()
 if(denial==='claim') f.service.claimRun.mockResolvedValue(false)
 if(denial==='capability') f.context.activeCapabilities=new Set()
 if(denial==='cancelled') f.context.abortSignal=AbortSignal.abort()
 await f.tool().execute({goal:denial==='goal'?'different':f.grant.goal},f.context)
 expect(f.observerFactory).not.toHaveBeenCalled()
 expect(f.runtime).not.toHaveBeenCalled()
})
it.each(['callback-throws','callback-rejects','callback-hangs','factory-throws','factory-hangs'] as const)('does not let %s change task outcome or durable finish',async failure=>{
 const f=observedFixture()
 const factory=(()=>{
   if(failure==='factory-throws') throw new Error('private-factory-error')
   if(failure==='factory-hangs') return new Promise(()=>{})
   return ()=>{
     if(failure==='callback-throws') throw new Error('private-observer-error')
     if(failure==='callback-rejects') return Promise.reject(new Error('private-observer-error'))
     return new Promise<void>(()=>{})
   }
 }) as NativeRunObserverFactory
 expect((await f.tool(factory).execute({goal:f.grant.goal},f.context)).data).toMatchObject({outcome:'completed'})
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(f.service.finishRun).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-000000000002','private-user',false)
 expect(f.trace()!.snapshot().logicalTerminal).toBe(true)
 expect(JSON.stringify(f.trace()!.snapshot())).not.toContain('private-')
 if(failure!=='callback-hangs') expect(f.trace()!.snapshot().evidence).toBe('poisoned')
})
it('closes logical trace when runtime is unavailable without claiming any provider/helper drain',async()=>{
 const f=observedFixture()
 f.runtime.mockImplementationOnce(async (_context,_grant,trace)=>{
   expect(trace).toBeDefined()
   return null as never
 })
 expect((await f.tool().execute({goal:f.grant.goal},f.context)).isError).toBe(true)
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(f.events.at(-1)).toMatchObject({kind:'run-terminal',outcome:'unavailable',drain:'not_observed'})
 expect(f.service.finishRun).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-000000000002','private-user',false)
 expect(capture.construct).not.toHaveBeenCalled()
})


it.each(['session', 'epoch'] as const)('rejects invalid trusted %s observer binding without exporting arbitrary strings or changing task execution', async invalid => {
 const f=observedFixture()
 if(invalid==='session') f.grant.identity.sessionId='private-session-goal'
 else f.grant.epoch=Infinity
 expect((await f.tool().execute({goal:f.grant.goal},f.context)).data).toMatchObject({outcome:'completed'})
 expect(f.observerFactory).not.toHaveBeenCalled()
 expect(f.trace()!.snapshot()).toMatchObject({evidence:'poisoned',poisonReasons:['invalid_metadata']})
 expect(JSON.stringify(f.trace()!.snapshot())).not.toContain('private-')
})

it('an unavailable task runtime claims nothing and constructs no effectful orchestrator', async () => {
 const service={binding:vi.fn(),claimRun:vi.fn(),finishRun:vi.fn()}
 const context:ToolContext={userId:'u',workspaceId:'w',assistantId:'a',sessionId:'c',appId:'test',channelType:'web',channelId:'c',activeCapabilities:new Set(['native_computer']),abortSignal:new AbortController().signal}
 const tool=composeNativeComputerTool(service as unknown as NativeComputerService,undefined)
 expect((await tool.execute({goal:'approved'},context)).isError).toBe(true)
 expect(service.binding).not.toHaveBeenCalled()
 expect(service.claimRun).not.toHaveBeenCalled()
 expect(capture.construct).not.toHaveBeenCalled()
})

it('does not label an accounting denial as semantic uncertainty or successful task completion', async () => {
 const f=observedFixture()
 const runtime=vi.fn(async()=>({llm:{} as never,accountingStatus:()=> 'unavailable' as const}))
 const result=await composeNativeComputerTool(f.service as unknown as NativeComputerService,runtime).execute({goal:f.grant.goal},f.context)
 expect(result).toMatchObject({isError:true,data:{outcome:'paused',reason:'Native accounting unavailable'}})
 expect(f.service.finishRun).toHaveBeenCalledExactlyOnceWith(f.grant.identity.sessionId,f.context.userId,false)
})

it('passive owner stays inert before claim, is unmatched/default-off, and consumes once after actual composition claim', async () => {
 const { PassiveNativeObserverHost } = await import('../observer-host.js')
 const host = new PassiveNativeObserverHost()
 try {
  const f=observedFixture(), sink=vi.fn(), factory=vi.fn(()=>sink)
  await host.attachObserver({sessionId:f.grant.identity.sessionId,epoch:f.grant.epoch},factory)
  const tool=f.tool(host.nativeComputerObserverFactory)
  await tool.execute({goal:'wrong'},f.context)
  expect(factory).not.toHaveBeenCalled()
  expect(f.service.claimRun).not.toHaveBeenCalled()
  await Promise.all([tool.execute({goal:f.grant.goal},f.context),tool.execute({goal:f.grant.goal},f.context)])
  expect(f.trace()).toBeDefined()
  expect(factory).not.toHaveBeenCalled()
  await new Promise(resolve=>setTimeout(resolve,30))
  expect(factory).toHaveBeenCalledTimes(1)
  expect(sink.mock.calls.map(c=>c[0].kind)).toEqual(['run-start','run-terminal'])
  await tool.execute({goal:f.grant.goal},f.context)
  expect(factory).toHaveBeenCalledTimes(1)
  const unmatched=observedFixture()
  unmatched.grant.epoch++
  await unmatched.tool(host.nativeComputerObserverFactory).execute({goal:unmatched.grant.goal},unmatched.context)
  expect(unmatched.trace()).toBeUndefined()
  await expect(host.attachObserver({sessionId:unmatched.grant.identity.sessionId,epoch:unmatched.grant.epoch},factory)).rejects.toThrow()
 } finally { host.dispose() }
})

it('passive hung factory is detached from task completion and finishRun', async () => {
 const { PassiveNativeObserverHost } = await import('../observer-host.js')
 const host=new PassiveNativeObserverHost(),f=observedFixture()
 try {
  await host.attachObserver({sessionId:f.grant.identity.sessionId,epoch:f.grant.epoch},()=>new Promise(()=>{}))
  const result=await f.tool(host.nativeComputerObserverFactory).execute({goal:f.grant.goal},f.context)
  expect(result.data).toMatchObject({outcome:'completed'})
  expect(f.service.finishRun).toHaveBeenCalledTimes(1)
 } finally { host.dispose() }
})
