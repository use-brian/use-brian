import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {adminDatabaseUrls} from '../rig-admin.mjs'
import {runtimeRoleSql} from '../crm/runtime-role.mjs'
import {assertLocalFixture,cleanRuntimeEnvironment} from '../crm/local-fixture.mjs'
let psql
if(process.env.BRIAN_ASSURANCE_FIXTURE!==undefined||process.env.BRIAN_ASSURANCE_TOKEN!==undefined){
 // Partial markers, wrong tokens and URLs outside this owned loopback cluster
 // fail before any connection. No ambient fallback or database repair target.
 await assertLocalFixture(process.env)
 const owner=new URL(process.env.DATABASE_URL),runtime=new URL(process.env.DATABASE_URL_APP)
 psql=(role,sql)=>{
  if(role!=='brian'&&role!=='app_user')throw new Error('Unsupported maintained fixture test role')
  const target=role==='brian'?owner:runtime
  const env={...cleanRuntimeEnvironment(process.env),PGHOST:target.hostname,PGPORT:target.port,
   PGUSER:decodeURIComponent(target.username),PGPASSWORD:decodeURIComponent(target.password),
   PGDATABASE:decodeURIComponent(target.pathname.slice(1))}
  // Credentials stay in the sealed child environment, never argv or logs.
  return execFileSync('psql',['-X','-v','ON_ERROR_STOP=1','-tA'],{env,input:sql,encoding:'utf8',timeout:15000})
 }
}else{
 const {port}=adminDatabaseUrls(process.env),container=port==='5443'?'usebrian-admin-test':'usebrian-admin-test-'+port,database='usebrian_admin_test'
 assert.equal(execFileSync('docker',['container','inspect','-f','{{index .Config.Labels "com.usebrian.rig"}}',container],{encoding:'utf8',timeout:10000}).trim(),'admin-test','Only maintained labelled fixtures are allowed')
 psql=(role,sql)=>execFileSync('docker',['exec','-i',container,'psql','-U',role,'-d',database,'-v','ON_ERROR_STOP=1','-tA'],{input:sql,encoding:'utf8',timeout:15000})
}
const verifySql=await runtimeRoleSql('verify')
test('[COMP:platform/local-rig] actual canonical runtime is nonowner nonbypass and inherit no roles',()=>{
 const row=JSON.parse(psql('brian',`SELECT json_build_object('unsafe',(SELECT count(*) FROM pg_roles WHERE rolname IN('app_user') AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole)),'memberships',(SELECT count(*) FROM pg_auth_members WHERE member IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user')) OR roleid IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user'))),'ownedObjects',(SELECT count(*) FROM pg_class WHERE relowner IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user'))),'canonicalRolePresent',(SELECT count(*) FROM pg_roles WHERE rolname='app_user' AND rolcanlogin));`))
 assert.deepEqual(row,{unsafe:0,memberships:0,ownedObjects:0,canonicalRolePresent:1})
})
test('actual nonowner guarded port succeeds while private functions and explicitly revoked tables deny',()=>{
 const output=psql('app_user',`DO $$ DECLARE relation text;denied integer:=0;guarded boolean;BEGIN
 IF current_user<>'app_user' THEN RAISE EXCEPTION 'wrong runtime role';END IF;
 SELECT application_native_crm_configuration_protected('00000000-0000-0000-0000-000000000000') INTO guarded;
 IF guarded IS DISTINCT FROM false THEN RAISE EXCEPTION 'unexpected guarded port result';END IF;
 BEGIN PERFORM application_scoped_qualified_before_frontend('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000');RAISE EXCEPTION 'private function exposed';EXCEPTION WHEN insufficient_privilege THEN denied:=denied+1;END;
 FOREACH relation IN ARRAY ARRAY['connector_actor_signing_keys','connector_actor_key_events','external_source_resources','external_source_observations','external_source_authorizations','application_native_configuration_operations','application_native_configuration_execution','session_message_annotation_heads','_migrations'] LOOP
  BEGIN EXECUTE format('SELECT 1 FROM public.%I LIMIT 1',relation);RAISE EXCEPTION 'private table exposed: %',relation;EXCEPTION WHEN insufficient_privilege THEN denied:=denied+1;END;
 END LOOP;
 IF denied<>10 THEN RAISE EXCEPTION 'incomplete denied boundaries';END IF;
 END $$;SELECT current_user;`)
 assert.equal(output.trim(),'DO\napp_user')
})
test('recognizes the exact chat read frame phase and keeps its complete proof private',()=>{
 const shape=JSON.parse(psql('brian',`SELECT json_build_object(
  'installed',EXISTS(SELECT FROM _migrations WHERE name='8148_native_chat_read_frame.sql'),
  'current',application_memory_statement_helpers_current(),
  'pins',(SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL regexp_matches(p.prosrc,'\\(([0-9]+)::oid,''([0-9a-f]{64})''::text\\)','g') pin WHERE p.oid='application_memory_statement_helpers_current()'::regprocedure));`))
 assert.deepEqual(shape,{installed:true,current:true,pins:127})
 assert.doesNotThrow(()=>psql('brian',verifySql))
 const output=psql('app_user',`DO $$ BEGIN
  BEGIN PERFORM read_native_session_cohort_frame('00000000-0000-0000-0000-000000000000',ARRAY['session_message'],ARRAY['00000000-0000-0000-0000-000000000000']::uuid[],ARRAY['1'],true);
   RAISE EXCEPTION 'private frame exposed';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END $$;SELECT current_user;`)
 assert.equal(output.trim(),'DO\napp_user')
})
test('refuses a runtime grant or an untracked chat read frame without repairing either',()=>{
 for(const mutation of [
  'GRANT EXECUTE ON FUNCTION read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean) TO app_user;',
  "DELETE FROM _migrations WHERE name='8148_native_chat_read_frame.sql';",
  "DELETE FROM _migrations WHERE name='8135_channel_recording_privacy_hold.sql';",
 ]){
  // Each rejected installer runs in its original transaction. psql's failed
  // connection closes without COMMIT, rolling back the deliberately injected drift.
  assert.throws(()=>psql('brian',verifySql.replace('BEGIN;\n','BEGIN;\n'+mutation+'\n')),/Unknown fixture Memory guard/)
 }
 assert.equal(psql('brian','SELECT application_memory_statement_helpers_current();').trim(),'t')
})
