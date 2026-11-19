import {describe,expect,it,vi} from 'vitest'
import {queryLoop,type QueryLoopOptions,type QueryUsageSnapshot,type QueryEvent} from '../query-loop.js'
import {NOOP_TURN_LEDGER} from '../turn-ledger.js'
import type {LLMProvider,StreamChunk} from '../../providers/types.js'

function fixture(scripts:StreamChunk[][]){
 let calls=0
 const send=()=> (async function*(){yield* scripts[calls++]??[]})()
 const provider:LLMProvider={name:'fixture',models:['fixture'],stream:send,createSession:()=>({send})}
 const options:QueryLoopOptions={provider,model:'fixture',systemPrompt:'Fictional fixture',messages:[{role:'user',content:'Fictional request'}],tools:new Map(),ledger:NOOP_TURN_LEDGER,maxTurns:3,
  context:{userId:'fictional-user',assistantId:'fictional-assistant',sessionId:'fictional-session',appId:'fixture',channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal}}
 return{options,calls:()=>calls}
}
const response=(stopReason:'max_tokens'|'end_turn'='end_turn'):StreamChunk[]=>[
 {type:'message_start',model:'fixture'}, {type:'text_delta',text:'Fictional answer'},
 {type:'message_end',stopReason,usage:{inputTokens:3,outputTokens:2,cacheReadTokens:1}}]

describe('[COMP:engine/query-loop] original producer usage independent of output',()=>{
 it('reports cumulative original completions once with detached snapshots',async()=>{
  const f=fixture([response('max_tokens'),response()]),snapshots:QueryUsageSnapshot[]=[],events:QueryEvent[]=[]
  for await(const event of queryLoop({...f.options,observeUsage:snapshot=>{snapshots.push(structuredClone(snapshot));snapshot.totalUsage.inputTokens=999}}))events.push(event)
  expect(snapshots.map(s=>s.totalUsage.inputTokens)).toEqual([3,6]);expect(f.calls()).toBe(2)
  expect(events.find(e=>e.type==='turn_complete')).toMatchObject({totalUsage:{inputTokens:6,outputTokens:4,cacheReadTokens:2}})
  expect(Object.keys(snapshots[0]).sort()).toEqual(['model','totalUsage'])
  expect(JSON.stringify(snapshots)).not.toContain('Fictional answer')
 })
 it.each(['refuse','stop','loss'] as const)('retains provider-reported spend when %s suppresses output',async mode=>{
  const f=fixture([response()]),snapshots:QueryUsageSnapshot[]=[],controller=new AbortController(),failure=new Error(mode),delivered:QueryEvent[]=[]
  const run=async()=>{for await(const _event of queryLoop({...f.options,context:{...f.options.context,abortSignal:controller.signal},observeUsage:s=>snapshots.push(s),dispatchOutput:async(_context,event)=>{
   await new Promise<void>(resolve=>setImmediate(resolve))
   if(mode==='refuse')throw failure
   controller.abort(failure)
   // Downstream authority/cancellation intentionally accepts no transcript.
   if(!controller.signal.aborted)delivered.push(event!)
  }}))throw new Error('Unexpected output')}
  if(mode==='refuse')await expect(run()).rejects.toBe(failure);else await run()
  expect(snapshots).toHaveLength(1);expect(snapshots[0]).toMatchObject({model:'fixture',totalUsage:{inputTokens:3,outputTokens:2}})
  expect(delivered).toEqual([]);expect(f.calls()).toBe(1)
 })
 it('does not invent unknown spend and cannot turn a failing observer into output authority',async()=>{
  const f=fixture([[{type:'message_start',model:'fixture'},{type:'text_delta',text:'Partial report with unknown usage'}]]),observer=vi.fn()
  for await(const _ of queryLoop({...f.options,maxTurns:1,observeUsage:observer})){}
  expect(observer).not.toHaveBeenCalled()
  const g=fixture([response()]),observe=vi.fn(()=>{throw new Error('Accounting unavailable')});let completed=false
  for await(const event of queryLoop({...g.options,observeUsage:observe}))if(event.type==='turn_complete')completed=true
  expect(observe).toHaveBeenCalledOnce();expect(completed).toBe(true);expect(g.calls()).toBe(1)
 })
})
