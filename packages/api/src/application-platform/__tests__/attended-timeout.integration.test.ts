import {ContextScopeAccumulator} from '@use-brian/core'
import {findAssistantById} from '../../db/users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {publishSessionTitle} from '../../db/session-title-store.js'
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
import {updateSelfEntityAttributes} from '../../db/entities-store.js'
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
 async function setup(options:{title?:'proved'|'none'|'legacy';onProviderSession?:(options:unknown)=>void}={}){
  const onProviderSession=options.onProviderSession
  const recoveryCalls=vi.spyOn(recovery,'composeRecoveryMessage'),synthesisCalls=vi.spyOn(emptyTurn,'composeEmptyTurnSynthesis'),diagnostics=vi.spyOn(console,'info')
  fixture=await persistentContextFixture();const f=fixture
  // A real synthetic Pro account supplies the existing twenty-round budget.
  // Standard intentionally stops after eight tools; no runtime limit changes.
  await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[f.workspaceId])
  const auth=await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional timeout fixture',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!auth)throw new Error('Missing actual authentication session')
  const session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:auth.id,authVersion:auth.authVersion})
  if(options.title==='legacy')await f.pool.query("UPDATE sessions SET title='Fictional existing title' WHERE id=$1",[session.id])
  else if(options.title!=='none'){
   const execution=(await resolveExecutionContextSystem({userId:f.ownerId,workspaceId:f.workspaceId,assistant:(await findAssistantById(f.assistantId))!,
    sharedAudience:false,session,sessionAuthority:session,memberMode:'member',identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.ownerId,authenticationKind:'native_session'}},
    ownership:{kind:'workspace',workspaceId:f.workspaceId},lifecycle:{sessionId:session.id,sessionPersisted:true,channelType:'web',channelId:session.channelId,abortSignal:new AbortController().signal},
    credentialCurrent:()=>authSessionStore.validateAccess({userId:f.ownerId,sessionId:auth.id,authVersion:auth.authVersion})})).executionContext
   const authority={execution,accumulator:new ContextScopeAccumulator()},input=await readAdmittedSessionQuery({sessionId:session.id,throughSequence:0,authority})
   expect(await publishSessionTitle({sessionId:session.id,title:'Fictional existing title',manual:false,expectedRevision:null,authority,
    derivation:{producer:'fixture:existing-admitted-title',sources:boundScopeSources(input)}})).not.toBeNull()
  }
  const extraTools=new Map<string,Tool>()
  const scripts:Script[]=[];let calls=0,sessions=0,signal:AbortSignal|undefined,background:LLMProvider['stream']|undefined
  const bus:Publication[]=[],committedObservations:Promise<boolean>[]=[],memoryIds:string[]=[]
  const provider:LLMProvider={name:'fictional-timeout',models:['fixture'],
   stream:async function*(input){if(background)yield* background(input);else yield* textChunks('Fictional generated title')},
   createSession(options){onProviderSession?.(options);signal=options.signal;sessions++;const providerSession:ProviderSession={send(_messages:Message[],_options?:Parameters<ProviderSession['send']>[1]){
    const script=scripts[calls++]??{error:new Error('Stream idle 30000ms')}
    return(async function*(){await script.before?.();for(const chunk of script.chunks??[])yield chunk;await script.after?.();if(script.error)throw script.error})()
   }};return providerSession},
  }
  let activeRequest:express.Request|undefined
  const app=express();app.use(express.json());app.use((req,_res,next)=>{activeRequest=req;req.userId=f.ownerId;req.authSessionId=auth.id;req.authVersion=auth.authVersion;next()})
  app.use('/chat',chatRoutes({provider,systemPrompt:'Fictional local timeout fixture',tools:extraTools,memoryStore:createDbMemoryStore(),
   capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore(),publishSessionEvent:event=>{
    bus.push(event)
    if(event.kind==='assistant_message_saved')committedObservations.push(f.pool.query('SELECT id FROM session_messages WHERE id=$1',[event.payload.id]).then(result=>result.rows.length===1))
   }}))
  const send=(input:{adaptive?:boolean;message?:string;mode?:'research'|'default';sessionId?:string}={})=>request(app).post('/chat').send({sessionId:input.sessionId??session.id,assistantId:f.assistantId,workspaceId:f.workspaceId,message:input.message??'Fictional timeout input',mode:input.mode??(input.adaptive?undefined:'default'),model:'pro'})
  const stop=()=>request(app).post('/chat/stop').send({sessionId:session.id})
  const rows=async()=>(await f.pool.query<{id:string;role:string;content:ContentBlock[];senderAssistantId:string|null}>(
   'SELECT id,role,content,sender_assistant_id AS "senderAssistantId" FROM session_messages WHERE session_id=$1 ORDER BY sequence_num',[session.id])).rows
  async function tools(count:number){
   for(let index=0;index<count;index++){
    const memory=await f.memory(`Fictional tool evidence ${index}`,f.ownerId)
    memoryIds.push(memory.id);scripts.push({chunks:toolChunks(index,memory.id)})
   }
  }
  return{f,session,auth,getRequest:()=>activeRequest,setAuth:(value:{id:string;authVersion:number})=>{auth.id=value.id;auth.authVersion=value.authVersion},scripts,bus,extraTools,send,stop,rows,tools,committedObservations,memoryIds,recoveryCalls,synthesisCalls,diagnostics,calls:()=>calls,sessions:()=>sessions,signal:()=>signal,setBackground:(stream:LLMProvider['stream'])=>{background=stream}}
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
 it.each(['profile.role','profile.extra'] as const)('admits known self identity into actual chat model and retained ancestry then refuses current %s contraction',async(profileField)=>{
  const prompts:string[]=[],current=await setup({onProviderSession:input=>prompts.push(JSON.stringify(input))}),f=current.f
  const self=await updateSelfEntityAttributes({workspaceId:f.workspaceId,userId:f.ownerId,displayName:'Fictional self identity',attributes:{name:'Fictional self identity',role:'Fictional planning lead',pronouns:'they/them',sources:['https://identity.example/source'],licenses:['Fictional qualification']}})
  let registered=false
  try{
   await f.pool.query(`CREATE FUNCTION identity_profile_field_catalog(w uuid,o jsonb,t text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1',
     'fieldKeys',application_native_field_keys(t),'fields',(SELECT jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN key='${profileField}' THEN '[["profile_reader"]]'::jsonb ELSE '[]'::jsonb END,
      'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) FROM unnest(application_native_field_keys(t)) key),
     'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) $$;
    CREATE FUNCTION identity_profile_field_reader(w uuid,o jsonb,t text,i text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT (identity_profile_field_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',e.scope_version::text,'source',read_scope_source(w,'entity',e.id))
     FROM entities e WHERE e.workspace_id=w AND e.id=i::uuid $$;
    REVOKE ALL ON FUNCTION identity_profile_field_catalog(uuid,jsonb,text),identity_profile_field_reader(uuid,jsonb,text,text) FROM PUBLIC;
    INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
     VALUES('native','1',ARRAY['profile_reader'],'identity_profile_field_reader(uuid,jsonb,text,text)'::regprocedure,'identity_profile_field_catalog(uuid,jsonb,text)'::regprocedure)`)
   registered=true
   await f.pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}','person','native')`,[f.workspaceId])
   await f.pool.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'profile_reader',$2)`,[f.workspaceId,f.ownerId])
   current.scripts.push({chunks:textChunks('Fictional identity admitted response')})
   const response=await current.send()
   expect(frames(response.text).filter(frame=>frame.event==='error'),response.text).toEqual([])
   expect(prompts).toHaveLength(1);expect(prompts[0]).toContain("User's role: Fictional planning lead");expect(prompts[0]).toContain("User's name is Fictional self identity")
   const message=(await current.rows()).find(row=>row.role==='assistant')!;expect(message).toBeTruthy()
   const fields=(await f.pool.query(`SELECT resources.fields FROM scope_derivations d
    JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id AND edge.source_kind='application_field'
    JOIN application_field_resources resources ON resources.workspace_id=edge.workspace_id AND resources.id=edge.source_id
    WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2`,[f.workspaceId,message.id])).rows
   expect(fields.some(row=>row.fields.includes(profileField))).toBe(true)
   expect(JSON.parse(prompts[0]).systemPrompt).toContain('Licenses: ["Fictional qualification"]')
   expect((await f.pool.query(`SELECT edge.source_id FROM scope_derivations d JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id
    WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2 AND edge.source_kind='entity'`,[f.workspaceId,message.id])).rows).toContainEqual({source_id:self.id})
   const observations=(await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows
   await f.pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND module_key='native'",[f.workspaceId])
   const fresh=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
    {actorUserId:f.ownerId,authSessionId:current.auth.id,authVersion:current.auth.authVersion})
   const denied=await current.send({sessionId:fresh.id})
   expect(frames(denied.text).filter(frame=>frame.event==='error')).toHaveLength(1);expect(prompts).toHaveLength(1);expect(current.calls()).toBe(1)
   expect((await f.pool.query("SELECT id FROM session_messages WHERE session_id=$1 AND role='assistant'",[fresh.id])).rows).toEqual([])
   expect((await current.rows()).filter(row=>row.role==='assistant')).toHaveLength(1)
   // Existing observations are immutable even if the new request adds history metadata.
   const after=(await f.pool.query('SELECT resource_id,version,source_scope FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[f.workspaceId])).rows
   for(const original of observations)expect(after).toContainEqual(original)
  }finally{
   await f.pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[f.workspaceId])
   await f.pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[f.workspaceId])
   if(registered)await f.pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
   await f.pool.query('DROP FUNCTION IF EXISTS identity_profile_field_reader(uuid,jsonb,text,text);DROP FUNCTION IF EXISTS identity_profile_field_catalog(uuid,jsonb,text)')
  }
 })
 it('assesses actual web input only after authored storage and current history admission',async()=>{
  const current=await setup(),authored:boolean[]=[],inputs:string[]=[]
  current.setBackground(async function*(input){
   const serialized=JSON.stringify(input.messages)
   if(input.maxTokens===128&&serialized.includes('recentConversation')){
    inputs.push(serialized);authored.push((await current.rows()).some(row=>row.role==='user'))
    yield* textChunks('{"research":false}');return
   }
   yield* textChunks('{"topic_label":"fictional assessment","state":"continue","confidence":0.9}')
  })
  current.scripts.push({chunks:textChunks('Fictional admitted assessment response')})
  const response=await current.send({adaptive:true,message:'Compare the fictional options using several independent sources and explain their current differences.'})
  expect(frames(response.text).filter(frame=>frame.event==='error'),response.text).toEqual([])
  expect(inputs).toHaveLength(1);expect(authored).toEqual([true]);expect(current.sessions()).toBe(1)
  expect(response.text).toContain('Fictional admitted assessment response')
 })
 it('does not enter the main web provider after assessment authority is withdrawn',async()=>{
  const current=await setup();let assessments=0
  current.setBackground(async function*(input){
   if(input.maxTokens===128&&JSON.stringify(input.messages).includes('recentConversation')){
    assessments++;expect((await current.rows()).some(row=>row.role==='user')).toBe(true)
    await current.f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[current.f.workspaceId,current.f.ownerId])
    yield* textChunks('{"research":false}');return
   }
   yield* textChunks('{"topic_label":"fictional assessment","state":"continue","confidence":0.9}')
  })
  const response=await current.send({adaptive:true,message:'Compare the fictional options using several independent sources and explain their current differences.'})
  expect(assessments).toBe(1);expect(current.sessions()).toBe(0);expect(current.calls()).toBe(0)
  expect(frames(response.text).filter(frame=>frame.event==='error')).toHaveLength(1)
  expect(current.bus.filter(event=>event.kind==='assistant_message_saved')).toEqual([])
 })
 it('preserves explicit quota denial before creating a new web thread',async()=>{
  const current=await setup()
  await current.f.pool.query("UPDATE workspaces SET plan='free',research_used_count=5 WHERE id=$1",[current.f.workspaceId])
  const before=(await current.f.pool.query('SELECT id FROM sessions WHERE workspace_id=$1',[current.f.workspaceId])).rows
  const response=await current.send({mode:'research',sessionId:crypto.randomUUID()})
  expect(frames(response.text).some(frame=>frame.event==='research_quota_exhausted')).toBe(true)
  expect((await current.f.pool.query('SELECT id FROM sessions WHERE workspace_id=$1',[current.f.workspaceId])).rows).toEqual(before)
  expect(current.sessions()).toBe(0);expect(await current.rows()).toEqual([])
 })
 it('admits one automatic research slot after current web assessment',async()=>{
  const current=await setup();let assessments=0
  current.setBackground(async function*(input){
   if(input.maxTokens===128&&JSON.stringify(input.messages).includes('recentConversation')){assessments++;yield* textChunks('{"research":true}');return}
   yield* textChunks('{"topic_label":"fictional assessment","state":"continue","confidence":0.9}')
  })
  current.scripts.push({chunks:textChunks('Fictional admitted research response')})
  const response=await current.send({adaptive:true,message:'Compare the fictional options using several independent sources and explain their current differences.'})
  expect(frames(response.text).filter(frame=>frame.event==='error'),response.text).toEqual([])
  expect(assessments).toBe(1);expect(current.sessions()).toBe(1)
  expect(frames(response.text).filter(frame=>frame.event==='research_quota')).toHaveLength(1)
  expect((await current.f.pool.query('SELECT research_used_count FROM workspaces WHERE id=$1',[current.f.workspaceId])).rows[0].research_used_count).toBe(1)
 })
 it('keeps an authored web request when automatic assessment loses its quota race',async()=>{
  const current=await setup()
  await current.f.pool.query("UPDATE workspaces SET plan='free',research_used_count=4 WHERE id=$1",[current.f.workspaceId])
  current.setBackground(async function*(input){
   if(input.maxTokens===128&&JSON.stringify(input.messages).includes('recentConversation')){
    await current.f.pool.query('UPDATE workspaces SET research_used_count=5 WHERE id=$1',[current.f.workspaceId])
    yield* textChunks('{"research":true}');return
   }
   yield* textChunks('{"topic_label":"fictional assessment","state":"continue","confidence":0.9}')
  })
  const response=await current.send({adaptive:true,message:'Compare the fictional options using several independent sources and explain their current differences.'})
  expect(frames(response.text).some(frame=>frame.event==='research_quota_exhausted'),response.text).toBe(true)
  expect(current.sessions()).toBe(0);expect((await current.rows()).filter(row=>row.role==='user')).toHaveLength(1)
  expect((await current.f.pool.query('SELECT research_used_count FROM workspaces WHERE id=$1',[current.f.workspaceId])).rows[0].research_used_count).toBe(5)
 })
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
  const current=await setup({title:'none'});let paused:Socket|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,titleCalls=0
  let ready!:()=>void,failed!:(error:Error)=>void
  const socketReady=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject})
  const pause=(client:PoolClient)=>{
   const connection=Reflect.get(client,'connection'),socket=connection&&Reflect.get(connection,'stream')
   if(!(socket instanceof Socket)){failed(new Error('Expected actual disposable PostgreSQL TCP socket'));return}
   paused=socket;socket.pause();ready()
  }
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
 it('publishes a real browser title event only after the immutable current title commits',async()=>{
  const current=await setup({title:'none'});let titleCalls=0
  current.setBackground(async function*(input){
   if(input.maxTokens===32){titleCalls++;yield* textChunks('Fictional scoped browser title');return}
   yield* textChunks('{"topic_label":"fictional title input","state":"continue","confidence":0.9}')
  })
  current.scripts.push({chunks:textChunks('Fictional admitted browser response')})
  const response=await current.send(),events=frames(response.text)
  expect(events.filter(event=>event.event==='error'),response.text).toEqual([])
  expect(events.filter(event=>event.event==='title_update')).toMatchObject([{data:{sessionId:current.session.id,title:'Fictional scoped browser title'}}])
  expect(titleCalls).toBe(1)
  const title=(await current.f.pool.query(`SELECT h.scope_revision_id,c.content FROM session_title_heads h
   JOIN session_context_revision_contents c ON c.workspace_id=h.workspace_id AND c.revision_id=h.scope_revision_id WHERE h.session_id=$1`,[current.session.id])).rows[0]
  expect(title.content).toEqual({title:'Fictional scoped browser title',manual:false})
  expect((await current.f.pool.query('SELECT title FROM sessions WHERE id=$1',[current.session.id])).rows).toEqual([{title:null}])
  const edges=(await current.f.pool.query(`SELECT edge.source_kind FROM scope_derivations d JOIN scope_derivation_sources edge
   ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_id=$2`,[current.f.workspaceId,title.scope_revision_id])).rows
  expect(edges.some(edge=>edge.source_kind==='application_field')).toBe(true)
 })
 it('holds generated title output after original device revocation and accepts a separate current device',async()=>{
  const current=await setup({title:'none'}),oldId=current.auth.id,other=await authSessionStore.create(current.f.ownerId,{deviceLabel:'Fictional independent device',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!other)throw new Error('Missing actual independent authentication session')
  let titleCalls=0
  current.setBackground(async function*(input){
   if(input.maxTokens===32){
    titleCalls++;expect(await authSessionStore.revokeForUser(current.f.ownerId,oldId)).toBe(true)
    // Mutation of the request carrier cannot retarget the original native
    // invocation's already pinned, verified credential claims.
    const active=current.getRequest();if(!active)throw new Error('Missing actual request carrier')
    active.authSessionId=other.id;active.authVersion=other.authVersion
    yield* textChunks('Fictional revoked device title');return
   }
   yield* textChunks('{"topic_label":"fictional device input","state":"continue","confidence":0.9}')
  })
  current.scripts.push({chunks:textChunks('Fictional response before device revocation')})
  const denied=await current.send()
  expect(titleCalls).toBe(1);expect(frames(denied.text).filter(event=>event.event==='title_update')).toEqual([])
  expect((await current.f.pool.query('SELECT scope_revision_id FROM session_title_heads WHERE session_id=$1',[current.session.id])).rows).toEqual([])
  current.setAuth(other)
  current.setBackground(async function*(input){
   if(input.maxTokens===32){yield* textChunks('Fictional independent browser title');return}
   yield* textChunks('{"topic_label":"fictional current device","state":"continue","confidence":0.9}')
  })
  current.scripts.push({chunks:textChunks('Fictional current independent response')})
  const allowed=await current.send()
  expect(frames(allowed.text).filter(event=>event.event==='error'),allowed.text).toEqual([])
  expect(frames(allowed.text).filter(event=>event.event==='title_update')).toMatchObject([{data:{title:'Fictional independent browser title'}}])
 })
 it('does not turn title-provider tool narration into a real browser title event or persisted fallback',async()=>{
  const current=await setup({title:'none'})
  current.setBackground(async function*(input){
   if(input.maxTokens===32){
    yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional private title narration'}
    yield{type:'tool_use_start',id:'fictional-title-plan',name:'fictionalTool'};yield{type:'tool_use_delta',id:'fictional-title-plan',input:'{}'};yield{type:'tool_use_end',id:'fictional-title-plan'}
    yield{type:'message_end',stopReason:'tool_use',usage};return
   }
   yield* textChunks('{"topic_label":"fictional title narration","state":"continue","confidence":0.9}')
  })
  current.scripts.push({chunks:textChunks('Fictional ordinary browser response')})
  const response=await current.send()
  expect(frames(response.text).filter(event=>event.event==='error'),response.text).toEqual([])
  expect(frames(response.text).filter(event=>event.event==='title_update')).toEqual([])
  expect((await current.f.pool.query('SELECT scope_revision_id FROM session_title_heads WHERE session_id=$1',[current.session.id])).rows).toEqual([])
  expect(response.text).not.toContain('Fictional private title narration')
 })
 it('completes first-title publication after seventeen actual tool pairs at the original deadline',async()=>{
  const current=await setup({title:'none'});await current.tools(17)
  current.scripts.push({chunks:[{type:'text_delta',text:'Fictional first-title partial'}],error:new Error('Stream idle 30000ms')})
  const response=await current.send();await closed(current,response.text,17)
  expect(frames(response.text).filter(event=>event.event==='title_update')).toHaveLength(1)
 })
})
