import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {bindScopeSources,boundScopeSources,classifyTopic,executionToolContext,type ExecutionContext,type LLMProvider,type ScopeSource,type TopicClassifierOptions} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,runWithAgentAccess,rollbackAndRelease} from '../../db/client.js'
import {addSessionMessage} from '../../db/sessions.js'
import {bindSessionContextRetainedAuthority,writeSessionContextRevision} from '../../db/session-context-revisions.js'
import {persistentSourceFixture} from './fixtures/persistent-source.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {writeSessionMessageAnnotation} from '../../db/session-message-annotations.js'
import {assertSourceModelInputAuthority} from '../model-source-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Projection={row:Record<string,unknown>|null;sources:ScopeSource[]}

describe.sequential('[COMP:api/application-persistence] [COMP:api/application-field-evidence] canonical session query domains',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 let independent:Awaited<ReturnType<typeof persistentSourceFixture>>|undefined
 afterEach(async()=>{await independent?.cleanup();independent=undefined;await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function frame<T>(execution:ExecutionContext,run:(client:import('pg').PoolClient)=>Promise<T>):Promise<T>{
  return runWithAgentAccess(execution.security.access,async()=>{
   const client=await getAppPool().connect()
   try{
    await client.query('BEGIN');await applyRLSGucs(client,execution.security.access.userId)
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[execution.security.access.workspaceId])
    const result=await run(client);await client.query('COMMIT');return result
   }finally{await rollbackAndRelease(client)}
  })
 }
 async function read(execution:ExecutionContext,kind:'history'|'topics',through:number){
  const sql=kind==='history'?'SELECT value FROM read_native_application_session_history($1,$2,$3)':'SELECT value FROM read_native_application_session_topics($1,$2,$3)'
  return frame(execution,async client=>(await client.query<{value:Projection}>(sql,[fixture!.workspaceId,fixture!.session.id,through])).rows.map(row=>row.value))
 }
 async function current(execution:ExecutionContext,source:ScopeSource){
  return frame(execution,async client=>(await client.query<{source:ScopeSource&{held:boolean}}>(
   'SELECT read_admitted_application_field_snapshot($1,$2,$3) AS source',[source.workspaceId,source.resourceId,source.version])).rows[0].source)
 }
 function domain(rows:Projection[]){
  expect(rows[0]?.row).toBeNull();expect(rows[0]?.sources.length).toBeGreaterThan(0)
  expect(rows[0].sources[0].resourceKind).toBe('application_field');return rows[0].sources[0]
 }
 async function annotate(){
  const f=fixture!,history=await f.history(),authority=await f.modelContext(),message=history.at(-1)!
  const context={...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator}
  const provider:LLMProvider={name:'fictional-session-topic',models:['fixture'],stream:async function*(){yield{type:'text_delta',text:'{"topic_label":"fictional current request","state":"continue","confidence":0.9}'}},createSession(){throw new Error('Unused background provider session')}}
  const options=bindScopeSources<TopicClassifierOptions>({provider,model:'fixture',currentMessage:'Fictional current request',recentUserTurns:[],knownTopicsThisSession:[],replyToText:null,
   authority,assertInputAuthority:()=>assertSourceModelInputAuthority(context)},history.flatMap(boundScopeSources))
  const classification=await classifyTopic(options)
  return writeSessionMessageAnnotation({sessionId:f.session.id,messageId:message.id,classification,replyToText:null,authority})
 }
 it('captures actual admitted history and its complete original query range',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),execution=await f.execution(f.firstId)
  const result=await read(execution,'history',history.at(-1)!.sequenceNum),source=domain(result)
  expect(result.slice(1).map(row=>row.row?.id)).toEqual(history.map(row=>row.id))
  expect(result.slice(1).map(row=>row.row?.content)).toEqual(history.map(row=>row.content))
  expect(await current(execution,source)).toMatchObject({held:false,version:source.version})
 })
 it('retains an actual empty domain and keeps future appends outside its original range',async()=>{
  fixture=await persistentContextFixture();const f=fixture,execution=await f.execution(),before=await read(execution,'history',0),source=domain(before)
  expect(before).toHaveLength(1)
  await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional later input'}],scope:f.envelope})
  const after=await read(execution,'history',0)
  expect(domain(after)).toEqual(source);expect(after).toHaveLength(1)
  expect(await current(execution,source)).toMatchObject({held:false,version:source.version})
 })
 it('rejects stale reader grants while another current reader uses unchanged immutable evidence',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),first=await f.execution(f.firstId),second=await f.execution(f.secondId)
  const source=domain(await read(first,'history',history.at(-1)!.sequenceNum))
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  expect((await current(first,source))?.held).not.toBe(false)
  expect(await current(second,source)).toMatchObject({held:false,version:source.version})
  expect((await f.pool.query('SELECT version FROM application_field_observations WHERE workspace_id=$1 AND resource_id=$2',[f.workspaceId,source.resourceId])).rows).toContainEqual({version:source.version})
 })
 it('holds original inside-range contraction before predicates while preserving the remaining admitted history',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),execution=await f.execution(f.firstId)
  const source=domain(await read(execution,'history',history.at(-1)!.sequenceNum))
  await f.pool.query("UPDATE session_messages SET sensitivity='confidential' WHERE id=$1",[history[0].id])
  expect((await current(execution,source))?.held).not.toBe(false)
  expect((await read(execution,'history',history.at(-1)!.sequenceNum)).slice(1).map(row=>row.row?.id)).toEqual(history.slice(1).map(row=>row.id))
 })
 it('captures topic absence and stops before the target message so annotation publication cannot depend on itself',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),execution=await f.execution(),last=history.at(-1)!
  const before=await read(execution,'topics',last.sequenceNum-1),source=domain(before)
  expect(before).toHaveLength(1)
  expect(await annotate()).toBeTruthy()
  expect(domain(await read(execution,'topics',last.sequenceNum-1))).toEqual(source)
  expect(await current(execution,source)).toMatchObject({held:false,version:source.version})
  const topics=await read(execution,'topics',last.sequenceNum)
  expect(topics.slice(1).map(row=>row.row?.topicLabel)).toEqual(['fictional current request'])
 })
 it('retains typed collection absence and keeps authored attachments while holding legacy scalar annotations',async()=>{
  fixture=await persistentContextFixture();const f=fixture,authority=await f.modelContext(),empty=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:0,authority})
  expect(empty.history).toEqual([]);expect(empty.annotations).toEqual([])
  expect(boundScopeSources(empty.history).length).toBeGreaterThan(0);expect(boundScopeSources(empty.annotations).length).toBeGreaterThan(0)
  const history=await f.history(),last=history.at(-1)!,attachment={fileId:crypto.randomUUID(),workspaceId:f.workspaceId,path:'fictional/input.txt',name:'Fictional input',mime:'text/plain',sizeBytes:12}
  await f.pool.query("UPDATE session_messages SET attachments=$2,topic_label='unproved legacy label',topic_confidence=0.99,reply_to_text='unproved legacy quote' WHERE id=$1",[last.id,JSON.stringify([attachment])])
  const result=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:last.sequenceNum,authority})
  expect(result.history.at(-1)).toMatchObject({id:last.id,attachments:[attachment],topicLabel:null,topicConfidence:null,replyToText:null})
  expect(result.annotations).toEqual([]);expect(boundScopeSources(result.history.at(-1)!).every(source=>source.resourceKind==='application_field')).toBe(true)
 })
 it('classifies real query captures and publishes a current annotation without a self-dependent query',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),last=history.at(-1)!,authority=await f.modelContext()
  const admitted=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:last.sequenceNum,topicThroughSequence:last.sequenceNum-1,authority})
  let dispatches=0
  const provider:LLMProvider={name:'fictional-query-classifier',models:['fixture'],stream:async function*(){dispatches++;yield{type:'text_delta',text:'{"topic_label":"fictional query topic","state":"continue","confidence":0.9}'}},createSession(){throw new Error('Unused synthetic session')}}
  const context={...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator}
  const classified=await classifyTopic(bindScopeSources<TopicClassifierOptions>({provider,model:'fixture',currentMessage:'Fictional current request',recentUserTurns:[],knownTopicsThisSession:[],replyToText:null,
   authority,assertInputAuthority:()=>assertSourceModelInputAuthority(context)},boundScopeSources(admitted)))
  expect(dispatches).toBe(1);expect(boundScopeSources(classified)).toEqual(boundScopeSources(admitted))
  const stored=await writeSessionMessageAnnotation({sessionId:f.session.id,messageId:last.id,classification:classified,replyToText:null,authority})
  expect(stored).toMatchObject({messageId:last.id,topicLabel:'fictional query topic'})
  const current=await f.modelContext(),readBack=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:last.sequenceNum,authority:current})
  expect(readBack.annotations).toMatchObject([{id:last.id,topicLabel:'fictional query topic'}]);expect(readBack.history.at(-1)?.topicLabel).toBeNull()
 })
 it('holds a source-denied history point before payload while an independent authorized reader remains usable',async()=>{
  fixture=await persistentContextFixture();const f=fixture,plain=await f.history()
  independent=await persistentSourceFixture(f);const derived=await independent.writeTranscript()
  const original=(await f.pool.query('SELECT id,version,observation FROM external_source_observations WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows
  const first=await f.modelContext();bindSessionContextRetainedAuthority(first.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  const before=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:derived.sequenceNum,authority:first})
  expect(before.history.map(row=>row.id)).toEqual([...plain.map(row=>row.id),derived.id]);expect(boundScopeSources(before).some(source=>source.resourceKind==='external_source')).toBe(true)
  await independent.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.ownerId])
  const current=await f.modelContext();bindSessionContextRetainedAuthority(current.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  const held=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:derived.sequenceNum,authority:current})
  expect(held.history.map(row=>row.id)).toEqual(plain.map(row=>row.id));expect(JSON.stringify(held)).not.toContain('Fictional independently sourced reply')
  const second=await f.modelContext(f.secondId);bindSessionContextRetainedAuthority(second.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  expect((await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:derived.sequenceNum,authority:second})).history.map(row=>row.id)).toContain(derived.id)
  expect((await f.pool.query('SELECT id,version,observation FROM external_source_observations WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows).toEqual(original)
 })
 it('keeps original field and topic obligations usable through five actual sequential publications',async()=>{
  fixture=await persistentContextFixture();const f=fixture
  for(let turn=0;turn<5;turn++){
   const message=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:`Fictional sequential request ${turn}`}],scope:f.envelope})
   const authority=await f.modelContext(),admitted=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:message.sequenceNum,topicThroughSequence:message.sequenceNum-1,authority})
   expect(admitted.annotations).toHaveLength(turn)
   const context={...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator}
   const provider:LLMProvider={name:'fictional-sequential-query',models:['fixture'],stream:async function*(){yield{type:'text_delta',text:'{"topic_label":"fictional sequential topic","state":"continue","confidence":0.9}'}},createSession(){throw new Error('Unused synthetic session')}}
   const classification=await classifyTopic(bindScopeSources<TopicClassifierOptions>({provider,model:'fixture',currentMessage:`Fictional sequential request ${turn}`,
    recentUserTurns:[],knownTopicsThisSession:admitted.annotations.map(row=>row.topicLabel),replyToText:null,authority,assertInputAuthority:()=>assertSourceModelInputAuthority(context)},boundScopeSources(admitted)))
   expect(await writeSessionMessageAnnotation({sessionId:f.session.id,messageId:message.id,classification,replyToText:null,authority})).toBeTruthy()
  }
 })
 it('rejects the owner connection at the native publication RPC independently of the host writer',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),last=history.at(-1)!
  await expect(f.pool.query('SELECT publish_native_session_context_revision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
   [f.workspaceId,f.session.id,'message_annotation',last.id,crypto.randomUUID(),{topicLabel:'fictional denied owner',topicConfidence:0.9,replyToText:null},
    'fixture:untrusted-owner-publication',JSON.stringify(history.flatMap(boundScopeSources)),null,null,null])).rejects.toThrow('scope_operation_denied')
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
 })
 it.each([false,true])('requires a fresh source decision after actual acquisition receipt expiry (withdrawn=%s)',async withdrawn=>{
  fixture=await persistentContextFixture();const f=fixture;await f.history();independent=await persistentSourceFixture(f)
  const derived=await independent.writeTranscript(),authority=await f.modelContext();let preparations=0
  bindSessionContextRetainedAuthority(authority.execution,async(execution,sources,action)=>{
   preparations++
   if(preparations===3){
    // The independent source issues context receipts for 4500ms. Let the real
    // acquisition proof expire; do not fake time or extend any freshness bound.
    await new Promise<void>(resolve=>setTimeout(resolve,4600))
    if(withdrawn)await independent!.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.ownerId])
   }
   return independent!.coordinator.prepare(execution,sources,action)
  })
  const result=readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:derived.sequenceNum,authority})
  if(withdrawn)await expect(result).rejects.toMatchObject({code:'source_access_denied'})
  else expect((await result).history.map(row=>row.id)).toContain(derived.id)
  expect(preparations).toBe(3)
  expect((await f.pool.query('SELECT id FROM session_context_scope_revisions WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
 })
 it('keeps private visitor state inaccessible and does not accept a fabricated worklist',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),execution=await f.execution(),through=history.at(-1)!.sequenceNum
  const source=domain(await read(execution,'history',through))
  const privateNames=['application_session_eval_sources_current','application_session_eval_scope','application_session_eval_point_state','application_session_eval_scan','application_session_eval_domain','application_session_eval_envelope','application_session_eval_field']
  const permissions=await frame(execution,async client=>(await client.query<{name:string;allowed:boolean;configuration:string[]}>(`SELECT proname AS name,has_function_privilege(current_user,oid,'EXECUTE') AS allowed,proconfig AS configuration
   FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`,[privateNames])).rows)
  expect(permissions).toHaveLength(privateNames.length)
  for(const permission of permissions){expect(permission.allowed,permission.name).toBe(false);expect(permission.configuration).toContain('search_path=pg_catalog, public, pg_temp')}
  await expect(frame(execution,client=>client.query('SELECT application_session_eval_field($1,$2,$3,$4)',[f.workspaceId,source.resourceId,source.version,
   {[`field:${source.resourceId}:${source.version}`]:{value:{...source,held:false},external:[]}}]))).rejects.toThrow('permission denied')
  expect(await current(execution,source)).toMatchObject({held:false,version:source.version})
 })
 it('keeps current batch admission separate for revoked and independently authorized readers and rejects fabricated versions',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),first=await f.execution(f.firstId),second=await f.execution(f.secondId)
  const source=domain(await read(first,'history',history.at(-1)!.sequenceNum))
  const batch=(execution:ExecutionContext)=>frame(execution,async client=>(await client.query<{ord:number;snapshot:ScopeSource&{held?:boolean}|null}>(
   'SELECT ord,snapshot FROM read_native_session_field_snapshots($1,$2,$3)',[f.workspaceId,[source.resourceId,source.resourceId],[source.version,'fictional-invalid-observation-version']])).rows)
  expect((await batch(first))[0].snapshot).toMatchObject({held:false,version:source.version})
  expect((await batch(first))[1].snapshot?.held).not.toBe(false)
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  expect((await batch(first))[0].snapshot?.held).not.toBe(false)
  expect((await batch(second))[0].snapshot).toMatchObject({held:false,version:source.version})
  expect((await batch(second))[1].snapshot?.held).not.toBe(false)
  expect((await f.pool.query('SELECT version FROM application_field_observations WHERE workspace_id=$1 AND resource_id=$2',[f.workspaceId,source.resourceId])).rows).toContainEqual({version:source.version})
 })
 it('retains actual revision-source ancestry on a field-backed annotation and holds it after independent source withdrawal',async()=>{
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),target=history.at(-1)!
  independent=await persistentSourceFixture(f);const derived=await independent.writeTranscript(),authority=await f.modelContext()
  bindSessionContextRetainedAuthority(authority.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  const admitted=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:derived.sequenceNum,topicThroughSequence:target.sequenceNum-1,authority})
  const annotation=await writeSessionContextRevision({sessionId:f.session.id,parentId:target.id,kind:'message_annotation',
   content:{topicLabel:'fictional governed annotation',topicConfidence:0.9,replyToText:null},authority,
   derivation:{producer:'fixture:governed-annotation-writer',sources:boundScopeSources(admitted)}})
  expect(annotation).toBeTruthy()
  const initial=(await f.pool.query('SELECT id,version,observation FROM external_source_observations WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows
  async function readFor(userId:typeof f.ownerId){
   const current=await f.modelContext(userId);bindSessionContextRetainedAuthority(current.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
   return readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:derived.sequenceNum,authority:current})
  }
  const before=await readFor(f.ownerId)
  expect(before.annotations).toMatchObject([{id:target.id,topicLabel:'fictional governed annotation'}])
  expect(boundScopeSources(before.annotations).some(source=>source.resourceKind==='external_source')).toBe(true)
  const observations=(await f.pool.query<{source_id:string}>(`SELECT observation.source_id FROM application_field_observations observation
   JOIN application_field_resources resource ON resource.workspace_id=observation.workspace_id AND resource.id=observation.resource_id
   WHERE observation.workspace_id=$1 AND resource.type_key='session_message_annotation' AND resource.resource_id=$2`,[f.workspaceId,target.id])).rows
  expect(observations.length).toBeGreaterThan(0);expect(observations.every(row=>row.source_id===annotation!.id)).toBe(true)
  await independent.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.ownerId])
  expect((await readFor(f.ownerId)).annotations).toEqual([])
  expect((await readFor(f.secondId)).annotations).toMatchObject([{id:target.id,topicLabel:'fictional governed annotation'}])
  expect((await f.pool.query('SELECT id,version,observation FROM external_source_observations WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows).toEqual(initial)
 })
 it('refuses owner-bypass payload capture instead of treating the system connection as a reader',async()=>{
  fixture=await persistentContextFixture();const f=fixture
  await expect(f.pool.query('SELECT value FROM read_native_application_session_history($1,$2,$3)',[f.workspaceId,f.session.id,0])).rejects.toThrow('access_unavailable')
 })
})
