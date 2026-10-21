import {Socket} from 'node:net'
import {z} from 'zod'
import {buildTool,boundScopeSources,type Tool} from '@use-brian/core'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import type {PoolClient} from 'pg'
import express from 'express'
import request from 'supertest'
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import type {ContentBlock,LLMProvider,Message,ProviderSession,StreamChunk} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbCapabilityStore} from '../../db/capability-store.js'
import {createPendingApprovalsStore} from '../../db/pending-approvals-store.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createPersonalWebSession,requestTurnCancel,startTurnLease,TURN_HEARTBEAT_INTERVAL_MS} from '../../db/sessions.js'
import {chatRoutes} from '../../routes/chat.js'
import * as recovery from '../../routes/_recovery-message.js'
import * as emptyTurn from '../../routes/_empty-turn-synthesis.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
type Publication=Parameters<NonNullable<Parameters<typeof chatRoutes>[0]['publishSessionEvent']>>[0]
type Script={chunks?:StreamChunk[];before?:()=>Promise<void>;after?:()=>Promise<void>;error?:Error}
const usage={inputTokens:5,outputTokens:3}
function textChunks(text:string):StreamChunk[]{return[{type:'message_start',model:'fixture'},{type:'text_delta',text},{type:'message_end',stopReason:'end_turn',usage}]}
function toolChunks(index:number,id:string):StreamChunk[]{return[
 {type:'message_start',model:'fixture'},{type:'tool_use_start',id:`fictional-call-${index}`,name:'getMemory'},
 {type:'tool_use_delta',id:`fictional-call-${index}`,input:JSON.stringify({id})},{type:'tool_use_end',id:`fictional-call-${index}`},
 {type:'message_end',stopReason:'tool_use',usage},
]}
function frames(text:string){return text.split('\n\n').filter(frame=>frame.startsWith('event:')).map(frame=>{
 const[event,data]=frame.split('\n');return{event:event.slice(7),data:JSON.parse(data.slice(6)) as Record<string,unknown>}
})}

describe.sequential('[COMP:api/application-persistence] [COMP:api/turn-lease] actual attended timeout persistence',()=>{
 let fixture:Fixture|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined;vi.restoreAllMocks()})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  const recoveryCalls=vi.spyOn(recovery,'composeRecoveryMessage'),synthesisCalls=vi.spyOn(emptyTurn,'composeEmptyTurnSynthesis'),diagnostics=vi.spyOn(console,'info')
  fixture=await persistentContextFixture();const f=fixture
  // A real synthetic Pro account supplies the existing twenty-round budget.
  // Standard intentionally stops after eight tools; no runtime limit changes.
  await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[f.workspaceId])
  const auth=await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional timeout fixture',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!auth)throw new Error('Missing actual authentication session')
  const session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:auth.id,authVersion:auth.authVersion})
  await f.pool.query("UPDATE sessions SET title='Fictional existing title' WHERE id=$1",[session.id])
  const extraTools=new Map<string,Tool>()
  const scripts:Script[]=[];let calls=0,sessions=0,signal:AbortSignal|undefined,background:LLMProvider['stream']|undefined
  const bus:Publication[]=[],committedObservations:Promise<boolean>[]=[],memoryIds:string[]=[]
  const provider:LLMProvider={name:'fictional-timeout',models:['fixture'],
   stream:async function*(input){if(background)yield* background(input);else yield* textChunks('Fictional generated title')},
   createSession(options){signal=options.signal;sessions++;const providerSession:ProviderSession={send(_messages:Message[],_options?:Parameters<ProviderSession['send']>[1]){
    const script=scripts[calls++]??{error:new Error('Stream idle 30000ms')}
    return(async function*(){await script.before?.();for(const chunk of script.chunks??[])yield chunk;await script.after?.();if(script.error)throw script.error})()
   }};return providerSession},
  }
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=f.ownerId;req.authSessionId=auth.id;req.authVersion=auth.authVersion;next()})
  app.use('/chat',chatRoutes({provider,systemPrompt:'Fictional local timeout fixture',tools:extraTools,memoryStore:createDbMemoryStore(),
   capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore(),publishSessionEvent:event=>{
    bus.push(event)
    if(event.kind==='assistant_message_saved')committedObservations.push(f.pool.query('SELECT id FROM session_messages WHERE id=$1',[event.payload.id]).then(result=>result.rows.length===1))
   }}))
  const send=()=>request(app).post('/chat').send({sessionId:session.id,assistantId:f.assistantId,workspaceId:f.workspaceId,message:'Fictional timeout input',mode:'default',model:'pro'})
  const stop=()=>request(app).post('/chat/stop').send({sessionId:session.id})
  const rows=async()=>(await f.pool.query<{id:string;role:string;content:ContentBlock[];senderAssistantId:string|null}>(
   'SELECT id,role,content,sender_assistant_id AS "senderAssistantId" FROM session_messages WHERE session_id=$1 ORDER BY sequence_num',[session.id])).rows
  async function tools(count:number){
   for(let index=0;index<count;index++){
    const memory=await f.memory(`Fictional tool evidence ${index}`,f.ownerId)
    memoryIds.push(memory.id);scripts.push({chunks:toolChunks(index,memory.id)})
   }
  }
  return{f,session,scripts,bus,extraTools,send,stop,rows,tools,committedObservations,memoryIds,recoveryCalls,synthesisCalls,diagnostics,calls:()=>calls,sessions:()=>sessions,signal:()=>signal,setBackground:(stream:LLMProvider['stream'])=>{background=stream}}
 }
 type Current=Awaited<ReturnType<typeof setup>>
 async function closed(current:Current,text:string,toolTurns=0){
  const events=frames(text),rows=await current.rows(),closures=rows.filter(row=>row.role==='assistant'&&JSON.stringify(row.content).includes('timed out'))
  expect(current.sessions(),text).toBe(1)
  expect(current.recoveryCalls).not.toHaveBeenCalled();expect(current.synthesisCalls).not.toHaveBeenCalled()
  expect(events.at(-1)?.event,text).toBe('done')
  expect(events.filter(event=>event.event==='error'),text).toEqual([])
  expect(closures).toHaveLength(1)
  expect(closures[0].senderAssistantId).toBe(current.f.assistantId)
  expect(events.filter(event=>event.event==='text_delta'&&String(event.data.text).includes('timed out'))).toHaveLength(1)
  expect(rows.filter(row=>row.role==='assistant')).toHaveLength(toolTurns+1)
  const ancestry=(await current.f.pool.query<{source_id:string}>("SELECT edge.source_id FROM scope_derivations d JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2 AND edge.source_kind='memory'",[current.f.workspaceId,closures[0].id])).rows.map(row=>row.source_id)
  for(const memoryId of current.memoryIds)expect(ancestry).toContain(memoryId)
  expect(await Promise.all(current.committedObservations)).not.toContain(false)
  const lease=(await current.f.pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[current.session.id])).rows[0]
  expect(lease).toMatchObject({status:'idle',turn_lease_token:null})
 }
 it('preserves actual query-tool field ancestry on every committed web transcript pair',async()=>{
  const current=await setup();let originalSources:ReturnType<typeof boundScopeSources>=[]
  current.extraTools.set('fixtureReadSession',buildTool({name:'fixtureReadSession',description:'Read current fixture history',inputSchema:z.object({read:z.literal(true)}),isReadOnly:true,isConcurrencySafe:true,
   async execute(_input,context){
    if(!context.executionContext||!context.scopeAccumulator)throw new Error('Missing actual turn authority')
    const high=(await current.f.pool.query<{sequence:number}>('SELECT coalesce(max(sequence_num),0)::int AS sequence FROM session_messages WHERE session_id=$1',[context.sessionId])).rows[0].sequence
    const result=await readAdmittedSessionQuery({sessionId:context.sessionId,throughSequence:high,authority:{execution:context.executionContext,accumulator:context.scopeAccumulator}})
    originalSources=boundScopeSources(result)
    return {ok:true,data:{history:result.history.map(row=>({id:row.id,content:row.content}))}}
   }}))
  current.scripts.push({chunks:[{type:'message_start',model:'fixture'},{type:'tool_use_start',id:'fictional-query-call',name:'fixtureReadSession'},
   {type:'tool_use_delta',id:'fictional-query-call',input:'{"read":true}'},{type:'tool_use_end',id:'fictional-query-call'},{type:'message_end',stopReason:'tool_use',usage}]},
   {chunks:textChunks('Fictional current query answer')})
  const response=await current.send(),rows=await current.rows()
  expect(frames(response.text).filter(frame=>frame.event==='error'),response.text).toEqual([])
  expect(originalSources.some(source=>source.resourceKind==='application_field'),JSON.stringify(rows)).toBe(true)
  const pair=rows.filter(row=>row.content.some(block=>block.type==='tool_use'||block.type==='tool_result'))
  expect(pair).toHaveLength(2)
  for(const row of pair){
   const sources=(await current.f.pool.query<{source_id:string;source_version:string}>(`SELECT edge.source_id,edge.source_version FROM scope_derivations d JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2 AND edge.source_kind='application_field'`,[current.f.workspaceId,row.id])).rows
   for(const original of originalSources.filter(source=>source.resourceKind==='application_field'))expect(sources).toContainEqual({source_id:original.resourceId,source_version:original.version})
  }
  expect(await Promise.all(current.committedObservations)).not.toContain(false)
 })
 it('persists and streams one explicit closure for an actual zero-turn provider failure',async()=>{
  const current=await setup(),response=await current.send();expect(response.status,response.text).toBe(200);await closed(current,response.text)
 })
 it.each([0,17])('closes after %i actual paired tool turns and unbuffered partial text',async count=>{
  const current=await setup();await current.tools(count)
  current.scripts.push({chunks:[{type:'text_delta',text:'Fictional partial answer'}],error:new Error('Stream idle 30000ms')})
  const response=await current.send();await closed(current,response.text,count)
  const text=frames(response.text).filter(event=>event.event==='text_delta').map(event=>event.data.text).join('')
  expect(text).toContain('Fictional partial answer\n\nThe model timed out')
  const diagnostics=JSON.stringify(current.diagnostics.mock.calls);expect(diagnostics).not.toContain('Fictional partial answer');expect(diagnostics).toContain('\"hadStreamedText\":true')
  expect((await current.rows()).filter(row=>row.content.some(block=>block.type==='tool_result'))).toHaveLength(count)
 })
 it('preserves seventeen actual paired tool rows when repeated provider failures terminate the loop',async()=>{
  const current=await setup();await current.tools(17)
  current.scripts.push({error:new Error('Stream idle 30000ms')},{error:new Error('Stream idle 30000ms')})
  const original=structuredClone(current.scripts.map(script=>script.chunks))
  const response=await current.send();await closed(current,response.text,17)
  expect(current.scripts.map(script=>script.chunks)).toEqual(original)
  const rows=await current.rows()
  for(let index=0;index<17;index++){
   expect(rows[1+index*2].role).toBe('assistant');expect(rows[1+index*2].content).toContainEqual(expect.objectContaining({type:'tool_use',id:`fictional-call-${index}`,name:'getMemory'}))
   expect(rows[2+index*2].role).toBe('user');expect(rows[2+index*2].content).toContainEqual(expect.objectContaining({type:'tool_result',toolUseId:`fictional-call-${index}`,name:'getMemory'}))
  }
 })
 it.each(['empty','partial'] as const)('keeps explicit closure after a buffered %s provider response',async kind=>{
  const current=await setup(),chunks=kind==='empty'?[]:textChunks('Fictional buffered partial')
  current.scripts.push({chunks:kind==='empty'?[{type:'message_start',model:'fixture'},{type:'message_end',stopReason:'end_turn',usage}]:
   [...chunks.slice(0,-1),{type:'message_end',stopReason:'incomplete',usage}]})
  const response=await current.send();await closed(current,response.text,kind==='partial'?1:0)
  if(kind==='partial')expect((await current.rows()).filter(row=>JSON.stringify(row.content).includes('Fictional buffered partial'))).toHaveLength(1)
 })
 it('reports a real closure write failure without streaming an unsaved closure',async()=>{
  const current=await setup()
  await current.f.pool.query(`ALTER TABLE session_messages ADD CONSTRAINT fixture_timeout_closure_failure CHECK(session_id<>'${current.session.id}'::uuid OR content::text NOT LIKE '%timed out%') NOT VALID`)
  try{
   const response=await current.send()
   expect(current.sessions(),response.text).toBe(1);expect((await current.rows()).filter(row=>row.role==='assistant')).toEqual([])
   expect(response.text).not.toContain('timed out');expect(frames(response.text).filter(event=>event.event==='error')).toHaveLength(1)
  }finally{await current.f.pool.query('ALTER TABLE session_messages DROP CONSTRAINT fixture_timeout_closure_failure')}
 })
 it('rolls every buffered pair back and announces no saved assistant row when an actual later insert fails',async()=>{
  const current=await setup();await current.tools(3)
  await current.f.pool.query(`ALTER TABLE session_messages ADD CONSTRAINT fixture_timeout_pair_failure CHECK(session_id<>'${current.session.id}'::uuid OR NOT content @> '[{"type":"tool_result"}]'::jsonb) NOT VALID`)
  try{
   const response=await current.send();expect(current.sessions(),response.text).toBe(1)
   expect((await current.rows()).filter(row=>row.role==='assistant')).toEqual([])
   expect(current.bus.filter(event=>event.kind==='assistant_message_saved')).toEqual([])
   expect(frames(response.text).filter(event=>event.event==='assistant_message_saved')).toEqual([])
   expect(frames(response.text).filter(event=>event.event==='error')).toHaveLength(1)
  }finally{await current.f.pool.query('ALTER TABLE session_messages DROP CONSTRAINT fixture_timeout_pair_failure')}
 })
 it('commits actual paired rows before announcing them to another database connection',async()=>{
  const current=await setup();await current.tools(2)
  const response=await current.send();await closed(current,response.text,2)
  expect(current.committedObservations).toHaveLength(3)
 })
 it('ignores an in-flight real heartbeat response after release and stops the timer before auto-title',async()=>{
  const interval=vi.spyOn(globalThis,'setInterval'),clear=vi.spyOn(globalThis,'clearInterval')
  const current=await setup();let paused:Socket|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,titleCalls=0
  let ready!:()=>void,failed!:(error:Error)=>void
  const socketReady=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject})
  const pause=(client:PoolClient)=>{
   const connection=Reflect.get(client,'connection'),socket=connection&&Reflect.get(connection,'stream')
   if(!(socket instanceof Socket)){failed(new Error('Expected actual disposable PostgreSQL TCP socket'));return}
   paused=socket;socket.pause();ready()
  }
  await current.f.pool.query("UPDATE sessions SET title='' WHERE id=$1",[current.session.id])
  current.scripts.push({before:async()=>{
   const before=(await current.f.pool.query<{epoch:string}>('SELECT extract(epoch FROM turn_heartbeat_at)::text AS epoch FROM sessions WHERE id=$1',[current.session.id])).rows[0].epoch
   const index=interval.mock.calls.findIndex(([,ms])=>ms===TURN_HEARTBEAT_INTERVAL_MS)
   expect(index).toBeGreaterThanOrEqual(0);heartbeat=interval.mock.results[index].value
   const callback=interval.mock.calls[index][0];if(typeof callback!=='function')throw new Error('Missing actual heartbeat callback')
   current.f.pool.once('acquire',pause);callback();await socketReady
   // Pause only TCP response consumption. The real UPDATE commits, and a
   // separate connection proves its current result before the turn releases.
   await expect.poll(async()=>(await current.f.pool.query<{advanced:boolean}>(
    'SELECT extract(epoch FROM turn_heartbeat_at)>$2::numeric AS advanced FROM sessions WHERE id=$1',[current.session.id,before])).rows[0].advanced,
    {timeout:2000}).toBe(true)
  },error:new Error('Stream idle 30000ms')})
  current.setBackground(async function*(){
   if(paused?.isPaused()){
    titleCalls++
    expect(clear).toHaveBeenCalledWith(heartbeat)
    expect((await current.f.pool.query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[current.session.id])).rows[0])
     .toMatchObject({status:'idle',turn_lease_token:null})
    expect(current.signal()?.aborted).toBe(false)
    paused.resume();await new Promise<void>(resolve=>setImmediate(resolve))
    expect(current.signal()?.aborted).toBe(false)
   }
   yield* textChunks('Fictional current title')
  })
  try{
   const response=await current.send();await closed(current,response.text)
   expect(titleCalls).toBe(1);expect(current.signal()?.aborted).toBe(false)
  }finally{
   current.f.pool.off('acquire',pause);paused?.resume();interval.mockRestore();clear.mockRestore()
  }
 })
 it.each([false,true])('keeps stopped partial publication bounded by actual successor lease: %s',async successor=>{
  const current=await setup()
  current.scripts.push({chunks:[...textChunks('Fictional stopped partial').slice(0,-1),{type:'message_end',stopReason:'incomplete',usage}]})
  current.scripts.push({before:async()=>{
   expect((await current.stop()).status).toBe(200)
   if(successor)await startTurnLease(current.session.id)
  },error:new Error('Stream idle 30000ms')})
  const response=await current.send()
  expect(current.sessions(),response.text).toBe(1)
  expect(frames(response.text).filter(event=>event.event==='error'),response.text).toEqual([])
  const assistantRows=(await current.rows()).filter(row=>row.role==='assistant')
  expect(assistantRows).toHaveLength(successor?0:1)
  if(!successor)expect(JSON.stringify(assistantRows)).toContain('Fictional stopped partial')
 })
 it.each(['remote-stop','lease-lost','local-stop'] as const)('does not publish a timeout closure after actual %s',async kind=>{
  const current=await setup()
  current.scripts.push({before:async()=>{
   if(kind==='remote-stop')expect(await requestTurnCancel(current.session.id)).toBe(true)
   if(kind==='lease-lost')await startTurnLease(current.session.id)
   if(kind==='local-stop')expect((await current.stop()).status).toBe(200)
  },error:new Error('Stream idle 30000ms')})
  const response=await current.send()
  expect(current.sessions(),response.text).toBe(1)
  expect((await current.rows()).filter(row=>row.role==='assistant')).toEqual([])
  expect(response.text).not.toContain('timed out')
  expect(current.recoveryCalls).not.toHaveBeenCalled();expect(current.synthesisCalls).not.toHaveBeenCalled()
 })
})
