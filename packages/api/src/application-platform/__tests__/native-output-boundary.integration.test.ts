import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest'
import type {QueryEvent} from '@use-brian/agent-runtime/engine/query-loop.js'
import {NOOP_TURN_LEDGER} from '@use-brian/agent-runtime/engine/turn-ledger.js'
import type {LLMProvider} from '@use-brian/agent-runtime/providers/types.js'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import {executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import type {ToolContext} from '@use-brian/agent-runtime/tools/types.js'
import {admitModelInput} from '../../context-scope/admission.js'
import {createAttendedDeliveryAudienceAuthorizer} from '../../context-scope/attended-audience.js'
import {DeliveryAudienceUnverifiedError} from '../../context-scope/delivery-authority.js'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createPersonalWebSession} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {listWorkspaceFilesIndexRanked} from '../../db/workspace-files.js'
import {resolveSessionTitleAuthority} from '../../routes/session-title-authority.js'
import { runPersistedFixtureTurn as runAssistantTurn } from '../../turn/__tests__/fixtures/owned-turn.js'
import {openAssistantTurn} from '../../turn/kernel.js'
import {publishNativeSessionMessageBatch} from '../../db/conversation-store.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
let f:Awaited<ReturnType<typeof persistentContextFixture>>
let claims:{userId:string;sessionId:string;authVersion:number}
let session:Awaited<ReturnType<typeof createPersonalWebSession>>
let fileId:string
async function setup(inherited=false){
 let authority=await resolveSessionTitleAuthority({claims,sessionId:session.id,readOnly:false})
 const memory=await createDbMemoryStore().getIndex(authority.execution.security.access,false,authority)
 const files=await listWorkspaceFilesIndexRanked(authority.execution.security.access,10)
 authority.accumulator.note({sources:[...boundScopeSources(memory),...files.flatMap(file=>boundScopeSources(file))]})
 if(inherited){
  const sources=authority.accumulator.evidence.sources??[]
  authority={execution:{...authority.execution,security:{...authority.execution.security,
   provenance:{sources:sources.filter(source=>source.resourceKind==='workspace_file')}}},
   accumulator:new ContextScopeAccumulator({sources:sources.filter(source=>source.resourceKind!=='workspace_file')})}
 }
 const context={...executionToolContext(authority.execution,{appId:'fictional-output'}),scopeAccumulator:authority.accumulator}
 const authorize=createAttendedDeliveryAudienceAuthorizer(authority.execution)
 const boundary={admitOutput:async(current:ToolContext)=>{
  if(!current.scopeAccumulator)throw new Error('Fixture accumulator missing')
  const before=JSON.stringify(current.scopeAccumulator.evidence)
  const decision=await authorize({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.ownerId,
   sessionId:session.id,channelType:'web',channelId:session.channelId,recipientType:'individual',scopeEvidence:current.scopeAccumulator.evidence})
  if(JSON.stringify(current.scopeAccumulator.evidence)!==before)throw Object.assign(new Error('Fixture evidence changed during complete admission'),{reason:'authority_changed',retrySafe:false})
  if(!decision.allowed)throw new DeliveryAudienceUnverifiedError(decision.detail,decision.diagnostic)
  current.scopeAccumulator.note(decision.evidence)
 }}
 return{authority,context,boundary}
}
async function trace<T>(run:()=>Promise<T>){
 const sql:string[]=[],query=pg.Client.prototype.query
 const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:Parameters<typeof query>){
  sql.push(typeof args[0]==='string'?args[0]:String((args[0]as{text?:string})?.text??''));return query.apply(this,args)
 }as typeof query)
 try{return{value:await run(),sql}}finally{spy.mockRestore()}
}
function nativeProofs(sql:string[]){return sql.filter(value=>value.includes('SELECT capture_conversation_evidence(')||value.includes('SELECT read_native_file_session_evidence(')).length}
async function hold(){await f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
 SELECT workspace_id,'workspace_file',id,scope_version::text,'held',1,'Fictional output hold' FROM workspace_files WHERE id=$1`,[fileId])}
async function unhold(){await f.pool.query("DELETE FROM scope_resource_states WHERE workspace_id=$1 AND resource_kind='workspace_file' AND resource_id=$2",[f.workspaceId,fileId])}
const provider:LLMProvider={name:'fictional-output',models:['fixture'],createSession:()=>({send:()=> (async function*(){
 yield{type:'message_start' as const,model:'fixture'}
 yield{type:'text_delta' as const,text:'Fictional current answer'}
 yield{type:'message_end' as const,stopReason:'end_turn' as const,usage:{inputTokens:1,outputTokens:1}}
})()}),stream(){throw new Error('Unexpected stateless fixture request')}}
async function run(options:{inherited?:boolean;custom?:boolean;revoke?:boolean;revokeTerminal?:boolean;terminalMutation?:'loop'|'sink'|'during-proof'|'lease'|'microtask';observerMutation?:boolean;abort?:boolean;throwSink?:boolean}={}){
 const c=await setup(options.inherited),seen:QueryEvent[]=[]
 const custom=vi.fn(async()=>{}),afterLoop=vi.fn(async()=>{}),abortController=new AbortController()
 const admissions=vi.fn()
 let terminalSeen=false,terminalLeaseChecks=0
 const refuseLate=async()=>{throw Object.assign(new Error('Fictional late callback refusal'),{reason:'authority_changed',retrySafe:false})}
 if(options.terminalMutation==='lease'){
  const lease=c.authority.execution.security.authority,check=lease.assertCurrent.bind(lease)
  vi.spyOn(lease,'assertCurrent').mockImplementation(async()=>{await check();if(terminalSeen&&++terminalLeaseChecks===2){c.authority.accumulator.note({projectIds:[randomUUID()]})}})
 }
 const params:Parameters<typeof runAssistantTurn>[0]={sessionId:session.id,policy:{admission:'personal'},abortController,
  model:{provider,model:'fixture',configuredProviders:undefined,customLlm:null},
  loop:{ledger:NOOP_TURN_LEDGER,context:{...c.context,...(options.custom?{admitModelOutput:custom}:{})},systemPrompt:'Fictional current sources',
   messages:[{role:'user',content:'Reply briefly.'}],tools:new Map(),maxTurns:1},
  sink:{kind:'sse',admitOutput:c.boundary.admitOutput,
   onOutputAuthorityTiming:()=>{
    admissions()
    if(options.observerMutation)c.authority.accumulator.note({projectIds:[randomUUID()]})
    if(terminalSeen&&options.terminalMutation==='during-proof')params.sink.admitOutput=refuseLate
    if(terminalSeen&&options.terminalMutation==='microtask')queueMicrotask(()=>c.authority.accumulator.note({projectIds:[randomUUID()]}))
   },
   afterLoop,
   onEvent:async event=>{
    seen.push(event)
    if(options.revoke&&seen.length===1||options.revokeTerminal&&event.type==='turn_complete')await hold()
    if(event.type==='turn_complete'){
     terminalSeen=true
     if(options.terminalMutation==='loop')params.loop.context.admitModelOutput=refuseLate
     if(options.terminalMutation==='sink')params.sink.admitOutput=refuseLate
    }
    if(options.abort)abortController.abort();if(options.throwSink)throw new Error('Fictional sink failure')
   }},
 }
 return{...c,seen,custom,admissions,afterLoop,execute:()=>runAssistantTurn(params)}
}
describe.sequential('[COMP:api/turn-kernel] native attended output boundary',()=>{
 beforeAll(async()=>{
  f=await persistentContextFixture()
  const auth=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional output browser',userAgent:null,ipAddress:null}))!
  claims={userId:f.ownerId,sessionId:auth.id,authVersion:auth.authVersion}
  session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:auth.id,authVersion:auth.authVersion})
  fileId=(await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
   VALUES($1,'/fictional/output.txt','Fictional output file','fixture://output',$2,'user','internal') RETURNING id`,[f.workspaceId,f.ownerId])).rows[0].id
 })
 afterEach(async()=>{vi.restoreAllMocks();await unhold()})
 afterAll(async()=>{try{await f?.cleanup()}finally{await getAppPool().end();await getPool().end()}})
 it('admits assembly and independently refuses a later source hold before provider dispatch',async()=>{
  const c=await setup(),full=vi.fn(()=>c.boundary.admitOutput(c.context))
  const createSession=vi.fn(provider.createSession),guardedProvider={...provider,createSession},onEvent=vi.fn(async()=>{})
  // The actual original owner: its prepareRun performs the complete host admission.
  const owner=await openAssistantTurn({sessionId:session.id,assistantId:f.assistantId,policy:{admission:'personal'},abortController:new AbortController()})
  try{
   owner.bindModelPreparation({kind:'execution',toolProfile:'web',execution:c.authority.execution,assertCurrent:full},
    {provider:guardedProvider,configuredProviders:undefined,resolveWorkspaceCustomLlm:null,resolveLegacyByoKey:null,buildLegacyByoProvider:null})
   await owner.prepareMainModel({kind:'web',requestedModel:'pro',plan:'max_5x',budgetStatus:'ok',researchMode:false,metered:null,hasImage:false})
   full.mockClear()
   const prepared=await trace(()=>owner.prepareRun({systemPrompt:'Fictional current sources',
    messages:[{role:'user',content:'Reply briefly.'}],candidateTools:new Map()}))
   expect(full).toHaveBeenCalledOnce();expect(nativeProofs(prepared.sql)).toBeGreaterThan(0)
   await hold()
   await expect(owner.run({loop:{ledger:NOOP_TURN_LEDGER,context:c.context,maxTurns:1},
    sink:{kind:'sse',admitOutput:c.boundary.admitOutput,onEvent}})).rejects.toMatchObject({reason:'authority_changed'})
   expect(createSession).not.toHaveBeenCalled();expect(onEvent).not.toHaveBeenCalled()
  }finally{await owner.finish('failed')}
 })
 async function publishPrepared(c:Awaited<ReturnType<typeof setup>>){
  return publishNativeSessionMessageBatch({sessionId:session.id,authority:c.authority,
   derivation:{producer:'fixture:prepared-publication',sources:c.authority.accumulator.evidence.sources??[]},
   derivationTarget:{workspaceId:f.workspaceId,userId:f.ownerId,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[]},
   messages:[{role:'assistant',content:[{type:'text',text:'Fictional saved answer'}],senderAssistantId:f.assistantId}]})
 }
 it('refuses a source held after local buffer assembly at the actual publication boundary',async()=>{
  const c=await setup()
  await c.boundary.admitOutput(c.context)
  const before=(await f.pool.query('SELECT count(*)::int count FROM session_messages WHERE session_id=$1',[session.id])).rows[0].count
  await hold()
  await expect(publishPrepared(c)).rejects.toThrow()
  expect((await f.pool.query('SELECT count(*)::int count FROM session_messages WHERE session_id=$1',[session.id])).rows[0].count).toBe(before)
 })
 it('derives the current publication floor independently of preliminary admission',async()=>{
  const c=await setup()
  await c.boundary.admitOutput(c.context)
  try{
   await f.pool.query("UPDATE workspace_files SET sensitivity='confidential' WHERE id=$1",[fileId])
   const [saved]=await publishPrepared(c)
   expect(boundScopeSources(saved)[0].sensitivity).toBe('confidential')
   expect((await f.pool.query('SELECT sensitivity FROM session_messages WHERE id=$1',[saved.id])).rows[0].sensitivity).toBe('confidential')
  }finally{await f.pool.query("UPDATE workspace_files SET sensitivity='internal' WHERE id=$1",[fileId])}
 })
 it('reauthorizes the recipient after durable publication before any saved delivery',async()=>{
  const c=await setup()
  await c.boundary.admitOutput(c.context)
  const [saved]=await publishPrepared(c),deliver=vi.fn()
  await hold()
  await expect((async()=>{await c.boundary.admitOutput(c.context);deliver(saved.id)})()).rejects.toMatchObject({reason:'delivery_audience_unverified'})
  expect(deliver).not.toHaveBeenCalled()
  expect((await f.pool.query('SELECT id FROM session_messages WHERE id=$1',[saved.id])).rows).toEqual([{id:saved.id}])
 })
 it('refuses a changed destination binding before publication',async()=>{
  const c=await setup()
  try{
   await f.pool.query('UPDATE sessions SET channel_id=$1 WHERE id=$2',[randomUUID(),session.id])
   await expect(c.boundary.admitOutput(c.context)).rejects.toMatchObject({reason:'delivery_audience_unverified'})
  }finally{await f.pool.query('UPDATE sessions SET channel_id=$1 WHERE id=$2',[session.channelId,session.id])}
 })
 it('does not treat an accumulated scalar floor as source-free permission',async()=>{
  const c=await setup()
  c.authority.accumulator.note({projectIds:[randomUUID()]})
  const execution=c.authority.execution
  await expect(admitModelInput({...c.context,executionContext:{...execution,security:{...execution.security,
   ceiling:{...execution.security.ceiling,projectIds:[]}}}})).rejects.toMatchObject({reason:'authority_changed'})
 })
 it('admits each physical event and final completion exactly once',async()=>{
  const current=await run()
  await current.execute()
  expect(current.seen.length).toBeGreaterThan(0)
  expect(current.admissions).toHaveBeenCalledTimes(current.seen.length+1)
 })
 it('retains the custom model-output constraint at every handoff',async()=>{
  const current=await run({custom:true})
  await current.execute()
  expect(current.custom).toHaveBeenCalledTimes(current.seen.length+1)
  expect(current.admissions).toHaveBeenCalledTimes(current.seen.length+1)
 })
 it('stops dispatching when the sink aborts',async()=>{
  const current=await run({abort:true})
  await expect(current.execute()).resolves.toMatchObject({aborted:true})
  expect(current.seen).toHaveLength(1)
 })
 it('does not forward later events after a sink failure',async()=>{
  const current=await run({throwSink:true})
  await expect(current.execute()).rejects.toThrow('Fictional sink failure')
  expect(current.seen).toHaveLength(1)
 })
 it('refuses an observational timing callback that mutates evidence after the proof',async()=>{
  const current=await run({observerMutation:true})
  await expect(current.execute()).rejects.toMatchObject({reason:'authority_changed'})
  expect(current.seen).toEqual([])
 })
 it('refuses the next real event after a source is held',async()=>{
  const current=await run({revoke:true})
  await expect(current.execute()).rejects.toMatchObject({reason:'delivery_audience_unverified',retrySafe:false})
  expect(current.seen).toHaveLength(1)
 })
 it('rechecks a source held by the terminal event callback before final host handling',async()=>{
  const current=await run({revokeTerminal:true})
  await expect(current.execute()).rejects.toMatchObject({reason:'delivery_audience_unverified',retrySafe:false})
  expect(current.seen.at(-1)?.type).toBe('turn_complete')
  expect(current.afterLoop).not.toHaveBeenCalled()
 })
 it.each(['loop','sink','during-proof','lease','microtask'] as const)('refuses terminal %s authority mutation before final host handling',async terminalMutation=>{
  const current=await run({terminalMutation})
  await expect(current.execute()).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(current.seen.at(-1)?.type).toBe('turn_complete')
  expect(current.afterLoop).not.toHaveBeenCalled()
 })
 it.each([false,true])('preserves inherited file provenance outside the initial accumulator (held=%s)',async held=>{
  const current=await run({inherited:true})
  expect(current.authority.execution.security.provenance.sources?.some(source=>source.resourceKind==='workspace_file')).toBe(true)
  if(held){
   await hold()
   await expect(current.execute()).rejects.toMatchObject({reason:'authority_changed'})
   expect(current.seen).toEqual([])
  }else{
   await current.execute()
   expect(current.seen.length).toBeGreaterThan(0)
   expect(current.authority.accumulator.evidence.sources?.some(source=>source.resourceKind==='workspace_file')).toBe(true)
  }
 })
 it('refuses an unsupported missing source instead of treating it as admitted',async()=>{
  const c=await setup();c.authority.accumulator.note({sources:[{workspaceId:f.workspaceId,userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[],resourceKind:'workflow_run',resourceId:randomUUID(),version:'1'}]})
  await expect(c.boundary.admitOutput(c.context)).rejects.toMatchObject({reason:'delivery_audience_unverified'})
 })
})
