/** [COMP:api/native-chat-read-cost] Sparse annotation absence is not reusable authority. */
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import type {PoolClient} from 'pg'
import {boundScopeSources,ContextScopeAccumulator,executionToolContext,type SessionContextAuthority} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../db/client.js'
import {captureSessionTopics,sessionQueryRootMetadata,readAdmittedSessionQuery,type SessionQueryAnnotation} from '../db/session-query-reader.js'
import {readSessionQueryFrame,writeSessionContextRevision} from '../db/session-context-revisions.js'
import {assertSourceModelInputAuthority} from '../application-platform/model-source-authority.js'
import {persistentContextFixture} from '../application-platform/__tests__/fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),port=`annotation_scan_fixture_${randomUUID().replaceAll('-','')}`
type Fixture=Awaited<ReturnType<typeof setup>>
async function setup(count=6,clearance:'internal'|'confidential'='internal'){
 const f=await persistentContextFixture(clearance)
 await f.pool.query(`INSERT INTO session_messages(session_id,workspace_id,role,content,sequence_num,sensitivity,compartments,project_ids,scope_version,scope_held)
  SELECT $1,$2,'user',jsonb_build_array(jsonb_build_object('type','text','text','Fictional retained annotation row '||n)),n,'internal','{}','{}',1,false
  FROM generate_series(1,$3::integer)n`,[f.session.id,f.workspaceId,count])
 const messages=(await pool.query<{id:string;sequence_num:number}>('SELECT id,sequence_num FROM session_messages WHERE session_id=$1 ORDER BY sequence_num',[f.session.id])).rows
 const authority=async(user:typeof f.ownerId=f.ownerId):Promise<SessionContextAuthority>=>({execution:await f.execution(user),accumulator:new ContextScopeAccumulator()})
 return{f,messages,count,authority}
}
async function topics(c:Fixture,authority:SessionContextAuthority){
 const roots=await sessionQueryRootMetadata(c.f.workspaceId,c.f.session.id,c.count,c.count)
 const value=await readSessionQueryFrame(authority,roots,async client=>{
  expect((await client.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
   .toEqual({current_user:'app_user',rolsuper:false,rolbypassrls:false})
  const value=await captureSessionTopics(client,c.f.workspaceId,c.f.session.id,c.count)
  return{value,sources:boundScopeSources(value)}
 })
 authority.accumulator.note({sources:boundScopeSources(value)})
 return value
}
async function publish(c:Fixture,index:number,label='Fictional newly available topic'){
 const authority=await c.authority()
 const row=await writeSessionContextRevision({sessionId:c.f.session.id,parentId:c.messages[index].id,kind:'message_annotation',
  content:{topicLabel:label,topicConfidence:0.9,replyToText:null},authority,derivation:{producer:'fixture:sparse-annotation',sources:[]}})
 expect(row).not.toBeNull();return row!
}
async function snapshot(c:Fixture){
 return{history:(await pool.query(`SELECT id,role,content,sequence_num,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held
  FROM session_messages WHERE session_id=$1 ORDER BY sequence_num`,[c.f.session.id])).rows,
  observations:(await pool.query('SELECT * FROM application_field_observations WHERE workspace_id=$1 ORDER BY resource_id,version',[c.f.workspaceId])).rows}
}
async function retains(c:Fixture,before:Awaited<ReturnType<typeof snapshot>>){
 const after=await snapshot(c);expect(after.history).toEqual(before.history)
 for(const row of before.observations)expect(after.observations).toContainEqual(row)
}
async function appFrame<T>(authority:SessionContextAuthority,run:(client:PoolClient)=>Promise<T>){
 const client=await getAppPool().connect()
 try{return await runWithAgentAccess(authority.execution.security.access,async()=>{
  await client.query('BEGIN');await applyRLSGucs(client,authority.execution.security.access.userId)
  await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[authority.execution.assistant.id])
  return run(client)
 })}finally{await rollbackAndRelease(client)}
}
async function domainCurrent(c:Fixture,rows:SessionQueryAnnotation[]){
 const roots=boundScopeSources(rows),domain=(await pool.query<{resource_id:string}>(`SELECT resource_id FROM application_field_resources
  WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND type_key='session_message_annotation' AND selection='query_domain'`,[c.f.workspaceId,roots.map(root=>root.resourceId)])).rows
 expect(domain).toHaveLength(1)
 return appFrame(await c.authority(),async client=>(await client.query<{value:{value?:{sourceKind?:string}}}>(
  `SELECT public.${port}($1,$2,'domain',$3,0) value`,[c.f.workspaceId,c.f.session.id,domain[0].resource_id])).rows[0].value)
}

beforeAll(async()=>{
 expect((await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
  .toEqual({rolsuper:false,rolbypassrls:false})
 // Fixture-only private evaluator port. It leaves every canonical helper and
 // fingerprint untouched; the no-race control must prove actual admission.
 await pool.query(`CREATE FUNCTION public.${port}(w uuid,s uuid,action text,i uuid,through integer) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
  DECLARE parent jsonb;bounds jsonb;visibility jsonb;fields text[];
  BEGIN
   fields:=ARRAY(SELECT field FROM unnest(application_session_field_keys('session_message_annotation'))field ORDER BY field);
   IF action='domain' THEN RETURN application_session_eval_domain(w,'session_message_annotation',i,fields,'{}');END IF;
   IF action='scan' THEN
    parent:=application_session_query_parent(w,s);bounds:=application_session_query_bounds(w,parent);
    visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE nullif(current_setting('app.current_user_id',true),'')::uuid END,
     'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
    RETURN application_session_eval_scan(w,s,'session_message_annotation',through,fields,bounds,visibility,'{}');
   END IF;
   RAISE EXCEPTION 'Unknown annotation fixture operation';
  END $fixture$;
  REVOKE ALL ON FUNCTION public.${port}(uuid,uuid,text,uuid,integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.${port}(uuid,uuid,text,uuid,integer) TO app_user`)
})
afterAll(async()=>{try{await pool.query(`DROP FUNCTION IF EXISTS public.${port}(uuid,uuid,text,uuid,integer)`)}finally{await getAppPool().end();await pool.end()}})

describe.sequential('[COMP:api/native-chat-read-cost] sparse annotation scans',()=>{
 it('admits a genuine empty annotation domain and keeps original bodies and retained observations',async()=>{
  const c=await setup(),before=await snapshot(c),authority=await c.authority()
  const empty=await topics(c,authority);expect(empty).toEqual([]);expect(boundScopeSources(empty).length).toBeGreaterThan(0)
  expect((await domainCurrent(c,empty)).value?.sourceKind).toBe('application_query_domain')
  await expect(assertSourceModelInputAuthority({...executionToolContext(authority.execution,{appId:'fixture:annotation-control'}),scopeAccumulator:authority.accumulator})).resolves.toBeUndefined()
  const body=await readAdmittedSessionQuery({sessionId:c.f.session.id,throughSequence:c.count,topicThroughSequence:0,authority:await c.authority()})
  expect(body.history.map(row=>row.id)).toEqual(c.messages.map(row=>row.id));expect(body.annotations).toEqual([])
  expect(body.history.map(row=>row.content)).toEqual(before.history.map(row=>row.content))
  await retains(c,before)
 },90_000)

 it('refuses a captured empty domain when a real head appears before the fresh consumer rescan',async()=>{
  const c=await setup(),authority=await c.authority(),empty=await topics(c,authority),before=await snapshot(c)
  expect(before.observations.length).toBeGreaterThan(0)
  // The first physical scan has observed no heads. Publish normally before the
  // independent consumer-domain rescan; no reader helper or guard is patched.
  expect((await domainCurrent(c,empty)).value?.sourceKind).toBe('application_query_domain')
  const added=await publish(c,2)
  expect((await domainCurrent(c,empty)).value).toBeUndefined()
  await expect(assertSourceModelInputAuthority({...executionToolContext(authority.execution,{appId:'fixture:annotation-race'}),scopeAccumulator:authority.accumulator})).rejects.toBeDefined()
  const fresh=await topics(c,await c.authority())
  expect(fresh).toEqual([{id:c.messages[2].id,sequenceNum:3,topicLabel:added.content.topicLabel,topicConfidence:0.9,replyToText:null}])
  await retains(c,before)
 },90_000)

 it('keeps a present held annotation on canonical denial paths',async()=>{
  const c=await setup(),revision=await publish(c,1,'Fictional held topic'),authority=await c.authority()
  const admitted=await topics(c,authority);expect(admitted.some(row=>row.id===c.messages[1].id)).toBe(true)
  await pool.query('UPDATE session_context_scope_revisions SET scope_held=true WHERE workspace_id=$1 AND id=$2',[c.f.workspaceId,revision.id])
  const result=await topics(c,await c.authority()).catch(()=>null)
  expect(result===null||result.every(row=>row.topicLabel!=='Fictional held topic')).toBe(true)
  await expect(assertSourceModelInputAuthority({...executionToolContext(authority.execution,{appId:'fixture:annotation-held'}),scopeAccumulator:authority.accumulator})).rejects.toBeDefined()
 },90_000)

 it('does not release a present confidential annotation to a lower-clearance workspace member',async()=>{
  const c=await setup(6,'confidential'),memory=await c.f.memory('Fictional confidential annotation source',null,'confidential')
  const raw=(await pool.query("SELECT read_scope_source($1,'memory',$2) source",[c.f.workspaceId,memory.id])).rows[0].source
  const {workspaceId,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version}=raw
  const authority=await c.authority(),label='Fictional confidential topic'
  const revision=await writeSessionContextRevision({sessionId:c.f.session.id,parentId:c.messages[1].id,kind:'message_annotation',
   content:{topicLabel:label,topicConfidence:0.9,replyToText:null},authority,
   derivation:{producer:'fixture:confidential-annotation',sources:[{workspaceId,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version}]}})
  expect(revision).not.toBeNull();expect((await topics(c,await c.authority())).some(row=>row.topicLabel===label)).toBe(true)
  const scan=async(actor:typeof c.f.ownerId)=>appFrame(await c.authority(actor),async client=>(await client.query<{value:{value?:{points?:unknown[]}}}>(
   `SELECT public.${port}($1,$2,'scan',NULL,$3) value`,[c.f.workspaceId,c.f.session.id,c.count])).rows[0].value)
  const positive=await scan(c.f.ownerId);expect(positive.value?.points).toHaveLength(1)
  const restricted=await scan(c.f.firstId)
  expect(restricted.value?.points??[]).toEqual([])
  expect(JSON.stringify(restricted)).not.toContain(label)
 },90_000)

 it('rejects a malformed present payload instead of interpreting its head as absent',async()=>{
  const c=await setup(),revision=await publish(c,1,'Fictional payload before corruption')
  expect((await topics(c,await c.authority())).some(row=>row.id===c.messages[1].id)).toBe(true)
  // Explicit legacy-corruption injection on this owned fixture only. Restore
  // the named immutable trigger before invoking the real application reader.
  const client=await pool.connect()
  try{
   await client.query('BEGIN')
   await client.query('ALTER TABLE session_context_revision_contents DISABLE TRIGGER session_context_content_guard')
   await client.query("UPDATE session_context_revision_contents SET content='{}' WHERE workspace_id=$1 AND revision_id=$2",[c.f.workspaceId,revision.id])
   await client.query('ALTER TABLE session_context_revision_contents ENABLE TRIGGER session_context_content_guard')
   await client.query('COMMIT')
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  expect((await pool.query('SELECT scope_revision_id FROM session_message_annotation_heads WHERE message_id=$1',[c.messages[1].id])).rows).toEqual([{scope_revision_id:revision.id}])
  await expect(topics(c,await c.authority())).rejects.toBeDefined()
 },90_000)

 it('retains the physical 4096-attempt limit even when every annotation head is absent',async()=>{
  const c=await setup(4097)
  await expect(appFrame(await c.authority(),client=>client.query(`SELECT public.${port}($1,$2,'scan',NULL,$3)`,
   [c.f.workspaceId,c.f.session.id,c.count]))).rejects.toMatchObject({code:'42501',message:'query_domain_complexity_unavailable'})
 },90_000)
})
