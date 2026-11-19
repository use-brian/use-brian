/** Canonical reference ownership and its original receiving boundaries. [COMP:api/application-persistence] */
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import type {PoolClient} from 'pg'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {listWorkspaceFilesIndexRanked} from '../../db/workspace-files.js'
import {readAdmittedSessionQuery,publishNativeSessionMessage} from '../../db/conversation-store.js'
import {withSessionMessagePublication} from '../../db/session-context-revisions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const fn=`reference_owner_${randomUUID().replaceAll('-','')}`
let f:Awaited<ReturnType<typeof persistentContextFixture>>,sources:ScopeSource[],file:ScopeSource,field:ScopeSource
async function op<T=unknown>(client:Pick<PoolClient,'query'>,action:string,payload:unknown={}){
 return(await client.query<{value:T}>(`SELECT ${fn}($1,$2,$3) value`,[f.workspaceId,action,payload])).rows[0].value
}
async function frame(run:(c:PoolClient)=>Promise<void>,owner=false){
 const execution=await f.execution(f.firstId),c=await(owner?getPool():getAppPool()).connect()
 try{await runWithAgentAccess(execution.security.access,async()=>{await c.query('BEGIN');await applyRLSGucs(c,f.firstId)
  await c.query("SELECT set_config('app.v2_assistant_id',$1,true)",[f.assistantId]);await run(c)})}finally{await rollbackAndRelease(c)}
}
async function publication(run:(c:PoolClient,id:string)=>Promise<void>){
 const authority=await f.modelContext(f.firstId)
 return withSessionMessagePublication(authority,sources,async c=>{
  const row=await publishNativeSessionMessage({sessionId:f.session.id,role:'assistant',content:'Fictional canonical reference reply',
   senderAssistantId:f.assistantId,authority,derivationTarget:f.envelope,derivation:{producer:'fixture:canonical-reference',sources}},c)
  await run(c,row.id);return row
 })
}
async function noDebt(){
 for(const table of ['native_turn_publication_work','native_turn_publication_events','native_turn_publication_seals','native_turn_publication_debt'])
  expect((await f.pool.query(`SELECT count(*)::int value FROM ${table}`)).rows[0].value).toBe(0)
}
describe.sequential('[COMP:api/application-persistence] canonical field reference owner',()=>{
 beforeAll(async()=>{
  f=await persistentContextFixture();await f.history()
  await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
   VALUES($1,'/fictional/reference.txt','Fictional reference','fixture://reference',$2,'user','internal')`,[f.workspaceId,f.ownerId])
  const authority=await f.modelContext(f.firstId)
  file=(await listWorkspaceFilesIndexRanked(authority.execution.security.access,50)).flatMap(boundScopeSources)[0]
  expect(file).toBeDefined()
  const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  sources=[...boundScopeSources(query),file];field=sources.find(s=>s.resourceKind==='application_field')!
  expect(field).toBeDefined()
  // Same-named relations exercise the actual reference trigger without granting
  // canonical publication's private construction ownership to another relation.
  await f.pool.query(`CREATE SCHEMA ${fn};
   CREATE TABLE ${fn}.scope_derivation_sources(workspace_id uuid,derivation_id uuid,source_kind text,source_id uuid,source_version text);
   CREATE TRIGGER reference BEFORE INSERT ON ${fn}.scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION validate_scope_resource_reference();
   CREATE TABLE ${fn}.scope_resource_states(workspace_id uuid,resource_kind text,resource_id uuid,resource_version text);
   CREATE TRIGGER reference BEFORE INSERT ON ${fn}.scope_resource_states FOR EACH ROW EXECUTE FUNCTION validate_scope_resource_reference();
   CREATE TABLE ${fn}.scope_derivations(workspace_id uuid,resource_kind text,resource_id uuid,resource_version text,user_id uuid,assistant_id uuid,sensitivity text,compartments text[],project_ids uuid[]);
   CREATE TRIGGER reference BEFORE INSERT ON ${fn}.scope_derivations FOR EACH ROW EXECUTE FUNCTION validate_scope_resource_reference();
   REVOKE ALL ON SCHEMA ${fn} FROM PUBLIC,app_user;
   CREATE FUNCTION ${fn}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   DECLARE signature text;definition text;body text;
   BEGIN
    IF action='reference' THEN INSERT INTO ${fn}.scope_derivation_sources VALUES(w,gen_random_uuid(),payload->>'resourceKind',(payload->>'resourceId')::uuid,payload->>'version');
    ELSIF action='review' THEN INSERT INTO ${fn}.scope_resource_states VALUES(w,payload->>'resourceKind',(payload->>'resourceId')::uuid,payload->>'version');
    ELSIF action='envelope' THEN INSERT INTO ${fn}.scope_derivations VALUES(w,payload->>'resourceKind',(payload->>'resourceId')::uuid,payload->>'version',NULL,NULL,payload->>'sensitivity','{}','{}');
    ELSIF action='hold' THEN INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
     VALUES(w,'workspace_file','${file.resourceId}'::uuid,'${file.version}','held',1,'Fictional reference hold');
    ELSIF action='labels' THEN UPDATE workspace_files SET sensitivity='confidential' WHERE workspace_id=w AND id='${file.resourceId}'::uuid;
    ELSIF action='permission' THEN UPDATE workspace_members SET clearance='public' WHERE workspace_id=w AND user_id='${f.firstId}'::uuid;
    ELSIF action='delete_output' THEN DELETE FROM session_messages WHERE workspace_id=w AND id=(payload->>'id')::uuid;
    ELSIF action='drift' THEN
     signature:=payload->>'signature';
     IF payload->>'mode'='acl' THEN EXECUTE 'GRANT EXECUTE ON FUNCTION '||signature||' TO app_user';
     ELSIF payload->>'mode'='body' THEN
      SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid=to_regprocedure(signature);
      EXECUTE replace(definition,body,body||E'\n-- fictional drift');
     ELSE EXECUTE 'ALTER FUNCTION '||signature||' COST 101';END IF;
    ELSIF action='unowned_identity' THEN RETURN native_turn_field_reference(w,gen_random_uuid(),(payload->>'resourceId')::uuid,payload->>'version');
    ELSE RAISE EXCEPTION 'Unknown fictional reference operation';END IF;
    RETURN 'true'::jsonb;
   END $fixture$;
   REVOKE ALL ON FUNCTION ${fn}(uuid,text,jsonb) FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION ${fn}(uuid,text,jsonb) TO app_user`)
 },60_000)
 afterAll(async()=>{try{await f?.pool.query(`DROP FUNCTION IF EXISTS ${fn}(uuid,text,jsonb);DROP SCHEMA IF EXISTS ${fn} CASCADE`);await f?.cleanup()}finally{await getAppPool().end();await getPool().end()}})
 it('commits, reopens and follows immutable frame lineage without a specialized fallback',async()=>{
  const row=await publication(async()=>{});await noDebt()
  const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:row.sequenceNum,authority:await f.modelContext(f.firstId)})
  expect(query.history.some(m=>m.id===row.id&&m.content==='Fictional canonical reference reply')).toBe(true)
  expect((await f.pool.query("SELECT to_regprocedure('read_native_field_reference_snapshot(uuid,uuid,uuid,text)') value")).rows[0].value).toBeNull()
 })
 for(const change of ['hold','labels','permission'])for(const boundary of ['named','commit'])it(`rejects ${change} at ${boundary} completion`,async()=>{
  let attempted:string|undefined
  await expect(publication(async(c,id)=>{attempted=id;await op(c,change);if(boundary==='named')await c.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')})).rejects.toThrow()
  expect(attempted).toBeDefined();expect((await f.pool.query('SELECT id FROM session_messages WHERE id=$1',[attempted])).rows).toEqual([]);await noDebt()
 })
 it('recovers a rolled-back source hold and completes without retaining an allow result',async()=>{
  const row=await publication(async c=>{await c.query('SAVEPOINT repair');await op(c,'hold');await c.query('ROLLBACK TO SAVEPOINT repair');await c.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')})
  expect((await f.pool.query('SELECT id FROM session_messages WHERE id=$1',[row.id])).rows).toHaveLength(1);await noDebt()
 })
 it('cannot leave an admitted publication when its physical output is deleted',async()=>{
  let attempted:string|undefined
  await expect(publication(async(c,id)=>{attempted=id;await op(c,'delete_output',{id})})).rejects.toThrow()
  expect(attempted).toBeDefined();expect((await f.pool.query('SELECT id FROM session_messages WHERE id=$1',[attempted])).rows).toEqual([]);await noDebt()
 })
 it.each([false,true])('uses original references outside canonical construction for owner=%s',async owner=>frame(async c=>{
  expect(await op(c,'unowned_identity',field)).toBeNull()
  expect(await op(c,'reference',file)).toBe(true)
  if(owner)await expect(op(c,'reference',field)).rejects.toMatchObject({message:'scope_source_changed'})
  else expect(await op(c,'reference',field)).toBe(true)
 },owner))
 for(const change of ['missing','stale'])it(`rejects a ${change} field at the actual BEFORE reference trigger`,async()=>frame(async c=>{
  await expect(op(c,'reference',{...field,...(change==='missing'?{resourceId:randomUUID()}:{version:'fictional-stale-version'})})).rejects.toMatchObject({message:'scope_source_changed'})
 }))
 it('preserves review-source and exact derivation-envelope validation',async()=>frame(async c=>{
  expect(await op(c,'review',file)).toBe(true)
  await expect(op(c,'envelope',{...file,sensitivity:'confidential'})).rejects.toMatchObject({message:'scope_envelope_mismatch'})
 }))
 for(const [signature,mode] of [['crm_capture_erasure_effect()','body'],['native_turn_capture_event()','body'],['native_turn_capture_event()','acl'],['native_turn_capture_event(jsonb)','body'],['native_turn_validate_event(jsonb)','body'],['native_turn_page_event(jsonb)','body'],['native_turn_field_reference(uuid,uuid,uuid,text)','body'],['native_turn_guard_completion_debt()','body'],['native_turn_publication_contract()','body'],['native_turn_complete_publication()','body'],['application_current_field_snapshot(uuid,uuid)','cost'],['recording_source_read_allowed(uuid,text,uuid)','cost']])for(const boundary of ['commit','named'])it(`rejects ${signature} ${mode} drift at ${boundary}`,async()=>{
  let attempted:string|undefined
  await expect(publication(async(c,id)=>{attempted=id;await op(c,'drift',{signature,mode});if(boundary==='named')await c.query('SET CONSTRAINTS ALL IMMEDIATE')})).rejects.toThrow()
  expect(attempted).toBeDefined();expect((await f.pool.query('SELECT id FROM session_messages WHERE id=$1',[attempted])).rows).toEqual([]);await noDebt()
 })
})
