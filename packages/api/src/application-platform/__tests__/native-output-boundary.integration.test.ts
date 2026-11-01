import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest'
import {boundScopeSources,ContextScopeAccumulator,executionToolContext,NOOP_TURN_LEDGER,type LLMProvider,type QueryEvent} from '@use-brian/core'
import {createNativeAttendedOutputBoundary,tryAssertNativeCombinedOutput} from '../model-source-authority.js'
import {tryNativeCombinedOutputEvidence} from '../../context-scope/native-invocation-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createPersonalWebSession} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {listWorkspaceFilesIndexRanked} from '../../db/workspace-files.js'
import {resolveSessionTitleAuthority} from '../../routes/session-title-authority.js'
import {runAssistantTurn} from '../../turn/kernel.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
let f:Awaited<ReturnType<typeof persistentContextFixture>>
let claims:{userId:string;sessionId:string;authVersion:number}
let session:Awaited<ReturnType<typeof createPersonalWebSession>>
let fileId:string
async function setup(){
 const authority=await resolveSessionTitleAuthority({claims,sessionId:session.id,readOnly:false})
 const memory=await createDbMemoryStore().getIndex(authority.execution.security.access,false,authority)
 const files=await listWorkspaceFilesIndexRanked(authority.execution.security.access,10)
 authority.accumulator.note({sources:[...boundScopeSources(memory),...files.flatMap(file=>boundScopeSources(file))]})
 const context={...executionToolContext(authority.execution,{appId:'fictional-output'}),scopeAccumulator:authority.accumulator}
 const boundary=createNativeAttendedOutputBoundary(authority.execution,authority.accumulator,{
  workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.ownerId,sessionId:session.id,
  channelType:'web',channelId:session.channelId,recipientType:'individual',
 })
 return{authority,context,boundary}
}
async function trace<T>(run:()=>Promise<T>){
 const sql:string[]=[],query=pg.Client.prototype.query
 const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:Parameters<typeof query>){
  sql.push(typeof args[0]==='string'?args[0]:String((args[0]as{text?:string})?.text??''));return query.apply(this,args)
 }as typeof query)
 try{return{value:await run(),sql}}finally{spy.mockRestore()}
}
function nativeProofs(sql:string[]){return sql.filter(value=>value.includes('SELECT read_native_turn_scope_evidence(')||value.includes('SELECT read_native_file_session_evidence(')).length}
async function hold(){await f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
 SELECT workspace_id,'workspace_file',id,scope_version::text,'held',1,'Fictional output hold' FROM workspace_files WHERE id=$1`,[fileId])}
async function unhold(){await f.pool.query("DELETE FROM scope_resource_states WHERE workspace_id=$1 AND resource_kind='workspace_file' AND resource_id=$2",[f.workspaceId,fileId])}
const provider:LLMProvider={name:'fictional-output',models:['fixture'],createSession:()=>({send:()=> (async function*(){
 yield{type:'message_start' as const,model:'fixture'}
 yield{type:'text_delta' as const,text:'Fictional current answer'}
 yield{type:'message_end' as const,stopReason:'end_turn' as const,usage:{inputTokens:1,outputTokens:1}}
})()}),stream(){throw new Error('Unexpected stateless fixture request')}}
async function run(fused:boolean,options:{custom?:boolean;revoke?:boolean;observerMutation?:boolean;abort?:boolean;throwSink?:boolean}={}){
 const c=await setup(),seen:QueryEvent[]=[]
 const custom=vi.fn(async()=>{}),abortController=new AbortController()
 const execute=()=>runAssistantTurn({sessionId:session.id,policy:{admission:'personal'},lease:{mode:'none'},abortController,
  model:{provider,model:'fixture',configuredProviders:undefined,customLlm:null},
  loop:{ledger:NOOP_TURN_LEDGER,context:{...c.context,...(options.custom?{assertModelOutputAuthority:custom}:{})},systemPrompt:'Fictional current sources',
   messages:[{role:'user',content:'Reply briefly.'}],tools:new Map(),maxTurns:1},
  sink:{kind:'sse',assertOutputAuthority:c.boundary.assertOutputAuthority,...(fused?{nativeOutputBoundary:c.boundary}:{}),
   ...(options.observerMutation?{onOutputAuthorityTiming:()=>{c.authority.accumulator.note({projectIds:[randomUUID()]})}}:{}),
   onEvent:async event=>{seen.push(event);if(options.revoke&&seen.length===1)await hold();if(options.abort)abortController.abort();if(options.throwSink)throw new Error('Fictional sink failure')}},
 })
 return{...c,seen,custom,execute}
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
 it('uses one fresh proof per operation and reads again on the next operation',async()=>{
  const c=await setup()
  for(let n=0;n<2;n++){
   const result=await trace(()=>tryAssertNativeCombinedOutput(c.boundary,c.context,c.boundary.assertOutputAuthority))
   expect(result.value).toBe(true);expect(nativeProofs(result.sql)).toBe(1)
  }
 })
 it('removes exactly one duplicate proof per real outer event while preserving final checks',async()=>{
  const original=await run(false),baseline=await trace(original.execute)
  const current=await run(true),optimized=await trace(current.execute)
  expect(optimized.value).toEqual(baseline.value);expect(current.seen).toEqual(original.seen)
  expect(current.seen.length).toBeGreaterThan(0)
  expect(nativeProofs(baseline.sql)-nativeProofs(optimized.sql)).toBe(current.seen.length)
 })
 it('retains both boundaries for a custom loop output callback',async()=>{
  const original=await run(false,{custom:true}),baseline=await trace(original.execute)
  const current=await run(true,{custom:true}),optimized=await trace(current.execute)
  expect(current.custom).toHaveBeenCalled();expect(current.seen).toEqual(original.seen)
  expect(nativeProofs(optimized.sql)).toBe(nativeProofs(baseline.sql))
 })
 for(const denied of ['caller','recipient'] as const)it(`independently refuses the ${denied} ceiling`,async()=>{
  const c=await setup(),original=c.authority.execution
  const execution=denied==='caller'?{...original,security:{...original.security,ceiling:{...original.security.ceiling,clearance:'public' as const,departmentRead:undefined}}}:original
  const recipient=denied==='recipient'?{...original.security.ceiling,clearance:'public' as const,departmentRead:undefined}:original.security.ceiling
  await expect(tryNativeCombinedOutputEvidence(execution,c.authority.accumulator.evidence,recipient)).rejects.toMatchObject({
   reason:denied==='caller'?'caller_evidence_unavailable':'delivery_audience_unverified',diagnostic:'clearance',retrySafe:false,
  })
 })
 it('discards the event receipt when the sink aborts',async()=>{
  const current=await run(true,{abort:true})
  await expect(current.execute()).resolves.toMatchObject({aborted:true})
  expect(current.seen).toHaveLength(1)
 })
 it('does not forward later events after a sink failure',async()=>{
  const current=await run(true,{throwSink:true})
  await expect(current.execute()).rejects.toThrow('Fictional sink failure')
  expect(current.seen).toHaveLength(1)
 })
 it('refuses an observational timing callback that mutates evidence after the proof',async()=>{
  const current=await run(true,{observerMutation:true})
  await expect(current.execute()).rejects.toMatchObject({reason:'authority_changed'})
  expect(current.seen).toEqual([])
 })
 it('refuses the next real event after a source is held',async()=>{
  const current=await run(true,{revoke:true})
  await expect(current.execute()).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(current.seen).toHaveLength(1)
 })
 it('cannot revive a source-authority refusal after the hold is removed',async()=>{
  const c=await setup();await hold()
  await expect(tryAssertNativeCombinedOutput(c.boundary,c.context,c.boundary.assertOutputAuthority)).rejects.toMatchObject({reason:'authority_changed'})
  await unhold()
  const result=await trace(async()=>{await expect(tryAssertNativeCombinedOutput(c.boundary,c.context,c.boundary.assertOutputAuthority)).rejects.toMatchObject({reason:'authority_changed'})})
  expect(nativeProofs(result.sql)).toBe(0)
  const fresh=await setup();expect(await tryAssertNativeCombinedOutput(fresh.boundary,fresh.context,fresh.boundary.assertOutputAuthority)).toBe(true)
 })
 for(const held of [false,true])it(`preserves inherited provenance omitted from the initial accumulator (held=${held})`,async()=>{
  const c=await setup(),all=c.authority.accumulator.evidence.sources??[]
  const execution={...c.authority.execution,security:{...c.authority.execution.security,provenance:{sources:all.filter(source=>source.resourceKind==='workspace_file')}}}
  const accumulator=new ContextScopeAccumulator({sources:all.filter(source=>source.resourceKind!=='workspace_file')})
  const context={...executionToolContext(execution,{appId:'fictional-inherited-output'}),scopeAccumulator:accumulator}
  const boundary=createNativeAttendedOutputBoundary(execution,accumulator,{workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.ownerId,
   sessionId:session.id,channelType:'web',channelId:session.channelId,recipientType:'individual'})
  if(held){await hold();await expect(tryAssertNativeCombinedOutput(boundary,context,boundary.assertOutputAuthority)).rejects.toMatchObject({reason:'authority_changed'})}
  else{
   const result=await trace(()=>tryAssertNativeCombinedOutput(boundary,context,boundary.assertOutputAuthority))
   expect(result.value).toBe(true);expect(nativeProofs(result.sql)).toBe(1)
   expect(accumulator.evidence.sources).toEqual(expect.arrayContaining(all))
  }
 })
 it('refuses replacement of the bound live accumulator',async()=>{
  const c=await setup()
  await expect(tryAssertNativeCombinedOutput(c.boundary,{...c.context,scopeAccumulator:new ContextScopeAccumulator(c.authority.accumulator.evidence)},c.boundary.assertOutputAuthority))
   .rejects.toMatchObject({reason:'authority_changed'})
 })
 it('declines forged capabilities and replaced callbacks before any proof',async()=>{
  const c=await setup(),forged={...c.boundary}
  const result=await trace(async()=>{
   expect(await tryAssertNativeCombinedOutput(forged,c.context,forged.assertOutputAuthority)).toBe(false)
   expect(await tryAssertNativeCombinedOutput(c.boundary,c.context,async()=>{})).toBe(false)
  })
  expect(nativeProofs(result.sql)).toBe(0)
 })
 it('declines an unsupported family without treating it as admitted',async()=>{
  const c=await setup();c.authority.accumulator.note({sources:[{workspaceId:f.workspaceId,userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[],resourceKind:'workflow_run',resourceId:randomUUID(),version:'1'}]})
  expect(await tryAssertNativeCombinedOutput(c.boundary,c.context,c.boundary.assertOutputAuthority)).toBe(false)
  await expect(c.boundary.assertOutputAuthority(c.context)).rejects.toMatchObject({reason:'delivery_audience_unverified'})
 })
})
