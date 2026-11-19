/**
 * Independent web chat process for the approval-card restore boundary
 * (`approval-card-restore.integration.test.ts`). It runs one real web turn
 * through `chatRoutes` that suspends on a confirmation-required tool, reports
 * once the Path B checkpoint (`session_resume_points`) has committed, then
 * waits holding the turn until the parent kills it with SIGKILL. It owns no
 * fixture; the parent disposes the database.
 */
import {readFile} from 'node:fs/promises'
import {once} from 'node:events'
import type {AddressInfo} from 'node:net'
import express from 'express'
import pg from 'pg'
import {z} from 'zod'
import type {LLMProvider, StreamChunk} from '@use-brian/agent-runtime/providers/types.js'
import {buildTool} from '@use-brian/agent-runtime/tools/types.js'
import {requireAuth} from '../../../auth/middleware.js'
import {chatRoutes} from '../../chat.js'
import {getPool} from '../../../db/client.js'
import {createDbMemoryStore} from '../../../db/memory-store.js'
import {createDbCapabilityStore} from '../../../db/capability-store.js'
import {createPendingApprovalsStore} from '../../../db/pending-approvals-store.js'
import {createDbSessionResumeStore} from '../../../db/session-resume-store.js'

const {assertLocalFixture}=await import(new URL('../../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const command=z.object({sessionId:z.string().uuid(),assistantId:z.string().uuid(),workspaceId:z.string().uuid(),
 token:z.string(),secret:z.string(),counter:z.string().regex(/^approval_counter_[a-f0-9]+$/)}).strict()
 .parse(JSON.parse(await readFile(process.argv[2],'utf8')))
const emit=(value:unknown)=>new Promise<void>((resolve,reject)=>{
 if(!process.send){reject(new Error('Approval worker requires its parent IPC channel'));return}
 process.send(value,error=>error?reject(error):resolve())
})
// Report after the checkpoint INSERT has returned (autocommit), never before.
const originalQuery=pg.Client.prototype.query
let reported=false
pg.Client.prototype.query=function(this:pg.Client,...args:unknown[]){
 const sql=typeof args[0]==='string'?args[0]:(args[0] as {text?:string})?.text??''
 if(/pending_approvals|session_resume_points/.test(sql)&&/INSERT/.test(sql))process.stdout.write(`[worker sql] ${sql.replace(/\s+/g,' ').slice(0,120)}\n`)
 const checkpoint=!reported&&sql.includes('INSERT INTO session_resume_points')
 const report=()=>{if(reported)return;reported=true;void emit({event:'suspended',pid:process.pid})}
 // The pool calls `client.query(text, values, callback)`; direct callers get a promise.
 const callback=args.at(-1)
 if(checkpoint&&typeof callback==='function'){
  args[args.length-1]=(error:unknown,value:unknown)=>{(callback as (e:unknown,v:unknown)=>void)(error,value);if(!error)report()}
 }
 const result=Reflect.apply(originalQuery,this,args)
 if(checkpoint&&typeof callback!=='function'&&result&&typeof (result as Promise<unknown>).then==='function'){
  return (result as Promise<unknown>).then(value=>{report();return value})
 }
 return result
} as typeof originalQuery
const usage={inputTokens:2,outputTokens:2}
const chunks:StreamChunk[]=[{type:'message_start',model:'fixture'},
 {type:'tool_use_start',id:'fictional-approval-call',name:'fictionalApprovalEffect'},
 {type:'tool_use_delta',id:'fictional-approval-call',input:'{"note":"fictional"}'},
 {type:'tool_use_end',id:'fictional-approval-call'},{type:'message_end',stopReason:'tool_use',usage}]
const provider:LLMProvider={name:'fictional-approval',models:['fixture'],
 async *stream(){yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional approval conversation'};yield{type:'message_end',stopReason:'end_turn',usage}},
 createSession(){return{send(){return(async function*(){yield* chunks})()}}}}
// The effect must never run in this process: the turn is killed while it waits.
const tool=buildTool({name:'fictionalApprovalEffect',description:'Record one fictional approved effect',
 inputSchema:z.object({note:z.string()}).strict(),isReadOnly:false,isConcurrencySafe:false,requiresConfirmation:true,
 async execute(){await getPool().query(`UPDATE ${command.counter} SET calls=calls+1`);return{data:{recorded:true}}}})
const app=express();app.use(express.json());app.use(requireAuth(command.secret))
app.use('/chat',chatRoutes({provider,systemPrompt:'Call fictionalApprovalEffect once, then answer.',tools:new Map([[tool.name,tool]]),
 memoryStore:createDbMemoryStore(),capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore(),
 sessionResumeStore:createDbSessionResumeStore()}))
const server=app.listen(0,'127.0.0.1');await once(server,'listening')
const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
// The direct stream stays open while the turn waits for the decision; the
// parent kills this process mid-wait.
void fetch(`${url}/chat`,{method:'POST',headers:{Authorization:`Bearer ${command.token}`,'Content-Type':'application/json'},
 body:JSON.stringify({sessionId:command.sessionId,assistantId:command.assistantId,workspaceId:command.workspaceId,
  message:'Record the fictional effect once after I approve it.',mode:'default',model:'pro'})})
 .then(async response=>{
  // Echo the direct stream to stdout: the parent prints it only on failure.
  const reader=response.body!.getReader(),decoder=new TextDecoder();let body=''
  for(;;){const {done,value}=await reader.read();if(done)break;const text=decoder.decode(value);body+=text;process.stdout.write(text)}
  await emit({event:'response',pid:process.pid,status:response.status,body})
 })
 .catch(async error=>{await emit({event:'error',message:error instanceof Error?error.message:String(error)})})
await new Promise(()=>{})
