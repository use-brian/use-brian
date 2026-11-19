/** Independent real HTTP publisher/receiver for the disposable recovery boundary. */
import {readFile} from 'node:fs/promises'
import {once} from 'node:events'
import type {AddressInfo} from 'node:net'
import express from 'express'
import pg from 'pg'
import {z} from 'zod'
import type {LLMProvider, StreamChunk} from '@use-brian/agent-runtime/providers/types.js'
import {buildTool} from '@use-brian/agent-runtime/tools/types.js'
import {requireAuth} from '../../../auth/middleware.js'
import {chatRoutes} from '../../../routes/chat.js'
import {sessionRoutes} from '../../../routes/sessions.js'
import {getAppPool,getPool} from '../../../db/client.js'
import {createOssUsageStore} from '../../../db/oss-usage-store.js'
import {createStuckSessionSweeper} from '../../../scheduling/stuck-session-sweeper.js'
import type {SessionEvent} from '../../../session-event-port.js'
import {createDbMemoryStore} from '../../../db/memory-store.js'
import {createDbCapabilityStore} from '../../../db/capability-store.js'
import {createPendingApprovalsStore} from '../../../db/pending-approvals-store.js'

const {assertLocalFixture}=await import(new URL('../../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const command=z.object({mode:z.enum(['publish','kill_after_commit','receive','recover_sweep','follow_up','stop','stop_before_publication','kill_stopped_after_commit','kill_wait_after_commit']),sessionId:z.string().uuid(),assistantId:z.string().uuid(),
 workspaceId:z.string().uuid(),token:z.string(),secret:z.string(),staleAfterMs:z.number().int().positive().optional(),turnId:z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),counter:z.string().regex(/^publication_counter_[a-f0-9]+$/)}).strict().parse(JSON.parse(await readFile(process.argv[2],'utf8')))
const emit=(value:unknown)=>new Promise<void>((resolve,reject)=>{
 if(!process.send){reject(new Error('Publication worker requires its parent IPC channel'));return}
 process.send(value,error=>error?reject(error):resolve())
})
const originalQuery=pg.Client.prototype.query,publishing=new WeakSet<object>()
let discoveries=0,sends=0,toolCalls=0,modelCalls=0,paused=false,sawPriorReply=false
let providerSignal:AbortSignal|undefined
let submittedPublication:unknown[]|undefined
const lifecycle:SessionEvent[]=[],publishSessionEvent=(event:SessionEvent)=>{lifecycle.push(event)}
pg.Client.prototype.query=function(this:pg.Client,...args:unknown[]){
 const sql=typeof args[0]==='string'?args[0]:(args[0] as {text?:string})?.text??''
 if(sql.includes('SELECT publish_native_session_message_batch(')&&sql.includes('$7')){publishing.add(this);submittedPublication=structuredClone(args[1] as unknown[])}
 if(sql.startsWith('SELECT read_native_conversation_publications('))discoveries++
 if(!paused&&sends>=2&&['stop_before_publication','kill_stopped_after_commit','kill_wait_after_commit'].includes(command.mode)
  &&sql.includes('SELECT lock_native_session_context_publication(')){
  paused=true
  return(async()=>{await emit({event:'before_publication_lock',pid:process.pid});await once(process,'message');return Reflect.apply(originalQuery,this,args)})()
 }
 if(sql==='COMMIT'&&publishing.has(this)&&command.mode==='kill_wait_after_commit'){
  return(async()=>{await emit({event:'before_publication_commit',pid:process.pid,backendPid:(this as pg.Client & {processID:number}).processID});await once(process,'message');
   await Reflect.apply(originalQuery,this,args);await emit({event:'publication_committed',pid:process.pid});await new Promise(()=>{})})()
 }
 const result=Reflect.apply(originalQuery,this,args)
 if(sql==='COMMIT'&&publishing.has(this)&&['kill_after_commit','kill_stopped_after_commit'].includes(command.mode)){
  return result.then(async()=>{await emit({event:'publication_committed',pid:process.pid});await new Promise(()=>{})})
 }
 return result
} as typeof originalQuery
const usage={inputTokens:2,outputTokens:2}
const scripts:StreamChunk[][]=[[
 {type:'message_start',model:'fixture'},{type:'tool_use_start',id:'fictional-publication-effect',name:'fictionalPublicationEffect'},
 {type:'tool_use_delta',id:'fictional-publication-effect',input:'{}'},{type:'tool_use_end',id:'fictional-publication-effect'},
 {type:'message_end',stopReason:'tool_use',usage},
],[{type:'message_start',model:'fixture'},{type:'text_delta',text:'Fictional durable tool answer: current price is $42.'},
 {type:'message_end',stopReason:'end_turn',usage}]]
const provider:LLMProvider={name:'fictional-publication',models:['fixture'],
 async *stream(){modelCalls++;yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional publication conversation'};yield{type:'message_end',stopReason:'end_turn',usage}},
 createSession(options){providerSignal=options.signal;return{send(messages){modelCalls++;sawPriorReply||=JSON.stringify(messages).includes('Fictional durable tool answer');
  return(async function*(){const index=sends++;yield* command.mode==='follow_up'?
   [{type:'message_start' as const,model:'fixture'},{type:'text_delta' as const,text:'We previously recorded the fictional effect and its durable answer.'},{type:'message_end' as const,stopReason:'end_turn',usage}]:scripts[index]??[]})()}}}}
const tool=buildTool({name:'fictionalPublicationEffect',description:'Record one fictional durable effect',inputSchema:z.object({}).strict(),
 isReadOnly:false,isConcurrencySafe:false,requiresConfirmation:false,
 async execute(){await getPool().query(`UPDATE ${command.counter} SET calls=calls+1`);toolCalls++;return{data:{recorded:true}}}})
const app=express();app.use(express.json());app.use(requireAuth(command.secret))
app.use('/chat',chatRoutes({provider,systemPrompt:'Call fictionalPublicationEffect once, then answer.',tools:new Map([[tool.name,tool]]),
 publishSessionEvent,usageStore:createOssUsageStore(),memoryStore:createDbMemoryStore(),capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore()}))
app.use('/sessions',sessionRoutes({publishSessionEvent}))
const server=app.listen(0,'127.0.0.1');await once(server,'listening')
try{
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
 const receiving=command.mode==='receive'||command.mode==='recover_sweep'
 if(command.mode==='recover_sweep')await createStuckSessionSweeper({staleAfterMs:command.staleAfterMs,publishDraftTurnCompleted:(sessionId,outcome)=>publishSessionEvent({kind:'turn_completed',sessionId,payload:{senderUserId:null,turnId:outcome.turnId,reason:outcome.reason}})}).tick()
 const response=await fetch(receiving?`${url}/sessions/${command.sessionId}/messages`:command.mode==='stop'?`${url}/chat/stop`:`${url}/chat`,{
  method:receiving?'GET':'POST',headers:{Authorization:`Bearer ${command.token}`,'Content-Type':'application/json'},
  ...(receiving?{}:{body:JSON.stringify(command.mode==='stop'?{sessionId:command.sessionId,...command.turnId!==undefined?{turnId:command.turnId}:{}}:{sessionId:command.sessionId,assistantId:command.assistantId,workspaceId:command.workspaceId,
   message:command.mode==='follow_up'?'What did we previously record?':'Record the fictional effect once and tell me the current price.',mode:'default',model:'pro'})}),
 })
 const text=await response.text()
 await emit({event:'response',pid:process.pid,status:response.status,body:receiving||command.mode==='stop'?JSON.parse(text):text,discoveries,modelCalls,toolCalls,providerSends:sends,sawPriorReply,providerAborted:providerSignal?.aborted??false,lifecycle,submittedPublication,
  ...(receiving?{statusBody:await(await fetch(`${url}/sessions/${command.sessionId}`,{headers:{Authorization:`Bearer ${command.token}`}})).json()}:{} )})
}catch(error){await emit({event:'error',message:error instanceof Error?error.message:String(error)});process.exitCode=1}
finally{
 pg.Client.prototype.query=originalQuery
 await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
 await getAppPool().end();await getPool().end()
 // The production turn-input listener intentionally outlives requests. This
 // isolated worker owns no fixture; the parent disposes its database.
 process.disconnect?.();process.exit(process.exitCode??0)
}
