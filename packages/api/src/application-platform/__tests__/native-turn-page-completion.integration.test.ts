import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {publishNativeSessionMessageBatch} from '../../db/session-message-publication.js'
import {withSessionMessagePublication} from '../../db/session-context-revisions.js'
import {createWorkspaceFile} from '../../db/workspace-files.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Json=Record<string,any>
describe.sequential('[COMP:api/native-turn-frame] sealed native Page obligations',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined,port:string|undefined
 afterEach(async()=>{if(port)await getPool().query(`DROP FUNCTION ${port}(text,jsonb)`);port=undefined;await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(count=3,withFile=false){
  const f=fixture=await persistentContextFixture(),history=await f.history(),authority=await f.modelContext(f.firstId)
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority}),sources=boundScopeSources(input)
  const file=withFile?(await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
   VALUES($1,'/fictional-page-root.txt','Fictional Page root','fixture://page-root',$2,'user','internal') RETURNING id,scope_version::text version`,[f.workspaceId,f.ownerId])).rows[0]:undefined
  const allSources=[...sources,...(file?[{...f.envelope,resourceKind:'workspace_file' as const,resourceId:file.id as string,version:file.version as string}]:[])]
  port=`page_event_fixture_${randomUUID().replaceAll('-','')}`
  await f.pool.query(`CREATE FUNCTION ${port}(action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   DECLARE event jsonb;d uuid;source jsonb;predecessor uuid;BEGIN
    IF action='trace' THEN PERFORM set_config('track_functions','all',true);
    ELSIF action='stats' THEN RETURN coalesce((SELECT jsonb_object_agg(p.proname,s.calls) FROM pg_stat_xact_user_functions s JOIN pg_proc p ON p.oid=s.funcid),'{}');
    ELSIF action='state' THEN RETURN jsonb_build_object('work',(SELECT count(*) FROM native_turn_publication_work WHERE transaction_id=txid_current()),
     'debt',(SELECT count(*) FROM native_turn_publication_debt WHERE transaction_id=txid_current()),'events',(SELECT count(*) FROM native_turn_publication_events WHERE transaction_id=txid_current()),
     'fired',(SELECT count(*) FROM native_turn_publication_events WHERE transaction_id=txid_current() AND fired));
    ELSIF action IN('exact','forged') THEN
     SELECT e.event INTO event FROM native_turn_publication_events e WHERE transaction_id=txid_current() LIMIT 1;
     IF action='forged' THEN event:=event||'{"source_version":"fictional-uncaptured-version"}'::jsonb;END IF;
     RETURN jsonb_build_object('delegated',native_turn_page_event(event));
    ELSIF action='missing-event' THEN DELETE FROM native_turn_publication_events WHERE ctid=(SELECT ctid FROM native_turn_publication_events WHERE transaction_id=txid_current() LIMIT 1);
    ELSIF action='missing-seal' THEN DELETE FROM native_turn_publication_seals WHERE transaction_id=txid_current();
    ELSIF action='completion' THEN DROP TRIGGER application_field_derivation_dependencies ON native_turn_publication_seals;
    ELSIF action='helper' THEN ALTER FUNCTION native_turn_page_event(jsonb) COST 101;
    ELSIF action='helper-body' THEN
     EXECUTE $attack$CREATE OR REPLACE FUNCTION public.native_turn_page_event(event jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $body$BEGIN RAISE EXCEPTION 'changed_page_helper_must_not_execute';END$body$$attack$;
    ELSIF action='contract-body' THEN
     EXECUTE $attack$CREATE OR REPLACE FUNCTION public.native_turn_publication_contract() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $body$BEGIN RAISE EXCEPTION 'changed_page_contract_must_not_execute';END$body$$attack$;
    ELSIF action IN('late-page','historical-page','historical-unknown','predecessor-page') THEN
     source:=read_scope_source('${f.workspaceId}'::uuid,'page_event_changed',(payload->>'id')::uuid);
     IF action IN('historical-page','historical-unknown') THEN
      INSERT INTO application_field_observations(workspace_id,resource_id,version,record_version,policy_version,source_kind,source_id,source_version,source_scope,owner_id)
      SELECT o.workspace_id,o.resource_id,repeat('a',64),o.record_version,o.policy_version,CASE WHEN action='historical-page' THEN 'page_event_changed' ELSE 'fictional_unknown_source' END,(payload->>'id')::uuid,source->>'version',o.source_scope,o.owner_id
      FROM native_turn_publication_work work CROSS JOIN LATERAL jsonb_array_elements(work.original_sources) n
      JOIN application_field_observations o ON o.workspace_id=work.workspace_id AND o.resource_id=(n->>'resourceId')::uuid AND o.version=n->>'version'
      WHERE work.transaction_id=txid_current() AND n->>'resourceKind'='application_field' LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'Historical Page fixture observation missing';END IF;
      RETURN '{}'::jsonb;
     END IF;
     IF action='predecessor-page' THEN
      INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity,superseded_by)
      VALUES('${f.workspaceId}'::uuid,'/fictional-page-predecessor.txt','Fictional Page predecessor','fixture://page-predecessor','${f.ownerId}'::uuid,'user','internal',(payload->>'file')::uuid) RETURNING id INTO predecessor;
      INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
      SELECT workspace_id,'workspace_file',id,scope_version::text,'fixture:late-page-predecessor',user_id,assistant_id,sensitivity,compartments,project_ids,
       (SELECT revision FROM workspace_access_policies WHERE workspace_id='${f.workspaceId}'::uuid)
      FROM workspace_files WHERE id=predecessor RETURNING id INTO d;
     ELSE
     INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
     SELECT workspace_id,'session_message',id,scope_version::text,'fixture:late-page',user_id,assistant_id,sensitivity,compartments,project_ids,
      (SELECT revision FROM workspace_access_policies WHERE workspace_id='${f.workspaceId}'::uuid)
     FROM session_messages WHERE id='${history[0].id}'::uuid RETURNING id INTO d;
     END IF;
     INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
     VALUES('${f.workspaceId}'::uuid,d,'page_event_changed',(payload->>'id')::uuid,source->>'version');
    ELSIF action='unowned' THEN RETURN jsonb_build_object('delegated',native_turn_page_event(payload));
    ELSE IF action<>'trace' THEN RAISE EXCEPTION 'Unknown Page fixture action';END IF;END IF;
    RETURN '{}'::jsonb;END $fixture$;
   REVOKE ALL ON FUNCTION ${port}(text,jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION ${port}(text,jsonb) TO app_user`)
  const op=async(db:{query:Function},action:string,payload:unknown={}):Promise<Json>=>(await db.query(`SELECT ${port}($1,$2) value`,[action,JSON.stringify(payload)])).rows[0].value
  const command={sessionId:f.session.id,authority,derivationTarget:f.envelope,derivation:{producer:'fixture:page-delegation',sources:allSources},
   messages:Array.from({length:count},(_,i)=>({role:'assistant',content:`Fictional Page-proof reply ${i}`}))}
  const page=async()=>(await f.pool.query(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,page,state,clearance)
   VALUES($1,$2,'Fictional source page','tasks','table','{"blocks":[]}','saved','internal') RETURNING page_event_revision`,[f.workspaceId,f.ownerId])).rows[0]
  return{f,authority,sources:allSources,command,op,page,file}
 }
 it('eliminates per-edge Page walks while retaining two fresh proofs and durable cleanup',async()=>{
  const{f,authority,sources,command,op}=await setup(9)
  const rows=await withSessionMessagePublication(authority,sources,async db=>{
   await op(db,'trace');const before=await op(db,'stats')
   const rows=await publishNativeSessionMessageBatch(command,db)
   await db.query('SET CONSTRAINTS ALL IMMEDIATE')
   const after=await op(db,'stats')
   expect((after.native_turn_page_event??0)-(before.native_turn_page_event??0)).toBeGreaterThan(9)
   expect((after.read_resource_page_dependencies??0)-(before.read_resource_page_dependencies??0)).toBe(0)
   expect((after.read_native_turn_compact_requirements??0)-(before.read_native_turn_compact_requirements??0)).toBe(2)
   expect(await op(db,'state')).toEqual({work:0,debt:0,events:0,fired:0})
   return rows
  })
  expect(rows).toHaveLength(9)
  expect((await f.pool.query('SELECT count(*)::int count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(12)
 })
 it('keeps completion debt and field callbacks pending after a Page-only flush',async()=>{
  const{authority,sources,command,op}=await setup()
  await withSessionMessagePublication(authority,sources,async db=>{
   await publishNativeSessionMessageBatch(command,db)
   const before=await op(db,'state');expect(before.debt).toBe(1);expect(before.fired).toBe(0)
   expect(await op(db,'exact')).toEqual({delegated:true})
   await db.query('SET CONSTRAINTS page_derivation_dependencies IMMEDIATE')
   expect(await op(db,'state')).toEqual(before)
   await db.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
   expect(await op(db,'state')).toEqual({work:0,debt:0,events:0,fired:0})
  })
 })
 it('uses the unchanged generic Page path after field completion has removed its owned work',async()=>{
  const{authority,sources,command,op}=await setup()
  await withSessionMessagePublication(authority,sources,async db=>{
   await publishNativeSessionMessageBatch(command,db)
   await db.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
   await op(db,'trace');const before=await op(db,'stats')
   await db.query('SET CONSTRAINTS page_derivation_dependencies IMMEDIATE')
   const after=await op(db,'stats')
   expect((after.read_resource_page_dependencies??0)-(before.read_resource_page_dependencies??0)).toBeGreaterThan(0)
  })
 })
 it('falls back before payload writes when only the Page constraint is immediate',async()=>{
  const{f,authority,sources,command}=await setup()
  await withSessionMessagePublication(authority,sources,async db=>{
   await db.query('SET CONSTRAINTS page_derivation_dependencies IMMEDIATE')
   expect(await publishNativeSessionMessageBatch(command,db)).toHaveLength(3)
  })
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
 })
 it.each(['forged','missing-event','missing-seal','completion','helper'] as const)('refuses %s after Page delegation and rolls back every output',async action=>{
  const{f,authority,sources,command,op}=await setup()
  await expect(withSessionMessagePublication(authority,sources,async db=>{
   await publishNativeSessionMessageBatch(command,db)
   await db.query('SET CONSTRAINTS page_derivation_dependencies IMMEDIATE')
   await op(db,action)
   await db.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
  })).rejects.toThrow()
  expect((await f.pool.query('SELECT count(*)::int count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
 })
 it.each(['late-page','historical-page','historical-unknown','predecessor-page'] as const)('refuses a late %s ancestor added after its Page callbacks have delegated',async action=>{
  const{f,authority,sources,command,op,page,file}=await setup(3,action==='predecessor-page'),receipt=await page()
  let inserted=false
  await expect(withSessionMessagePublication(authority,sources,async db=>{
   await publishNativeSessionMessageBatch(command,db)
   await db.query('SET CONSTRAINTS page_derivation_dependencies IMMEDIATE')
   await db.query('SET CONSTRAINTS page_derivation_dependencies DEFERRED')
   await op(db,action,{id:receipt.page_event_revision,file:file?.id});inserted=true
   await db.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
  })).rejects.toThrow()
  expect(inserted).toBe(true)
  expect((await f.pool.query('SELECT count(*)::int count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
 })
 it('does not execute a replaced delegate before its pinned generic fallback',async()=>{
  const{authority,sources,command,op}=await setup();let pageFlushed=false
  await expect(withSessionMessagePublication(authority,sources,async db=>{
   await publishNativeSessionMessageBatch(command,db)
   await op(db,'helper-body')
   await db.query('SET CONSTRAINTS page_derivation_dependencies IMMEDIATE');pageFlushed=true
   await db.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
  })).rejects.toThrow()
  expect(pageFlushed).toBe(true)
 })
 it('refuses a replaced small contract before invoking its executable',async()=>{
  const{authority,sources,command,op}=await setup();let refusal:unknown,stage='publication'
  try{await withSessionMessagePublication(authority,sources,async db=>{
   await publishNativeSessionMessageBatch(command,db)
   expect((await op(db,'state')).work).toBe(1)
   expect(await op(db,'exact')).toEqual({delegated:true})
   stage='replacement';await op(db,'contract-body')
   expect((await db.query("SELECT prosrc LIKE '%changed_page_contract_must_not_execute%' changed FROM pg_proc WHERE oid='public.native_turn_publication_contract()'::regprocedure")).rows[0].changed).toBe(true)
   stage='delegate'
   try{await op(db,'exact');stage='escaped'}catch(error){refusal=error;throw error}
  })}catch(error){refusal??=error}
  const sql=refusal&&typeof refusal==='object'&&'cause'in refusal?refusal.cause:refusal
  expect({stage,refusal:sql}).toMatchObject({stage:'delegate',refusal:{code:'42501',message:'scope_source_changed'}})
 })
 it('preserves genuine unowned Page publication through the original file writer',async()=>{
  const{f,op,page}=await setup(),receipt=await page()
  const source=(await f.pool.query("SELECT read_scope_source($1,'page_event_changed',$2) source",[f.workspaceId,receipt.page_event_revision])).rows[0].source
  expect(await op(f.pool,'unowned',{workspace_id:f.workspaceId,derivation_id:randomUUID(),source_kind:'page_event_changed',source_id:receipt.page_event_revision,source_version:source.version})).toEqual({delegated:false})
  const file=await createWorkspaceFile(f.ownerId,{workspaceId:f.workspaceId,path:`/${randomUUID()}.txt`,parentPath:'/',name:'fictional-page-copy.txt',mime:'text/plain',sizeBytes:1,storageUri:'fixture://page-copy',createdByUserId:f.ownerId,source:'extracted'},
   {derivation:{producer:'fixture:unowned-page',sources:[source]}})
  expect(file.id).toBeTruthy()
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
 })
})
