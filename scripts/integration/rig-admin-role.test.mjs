import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {adminDatabaseUrls} from '../rig-admin.mjs'
const {port}=adminDatabaseUrls(process.env),container=port==='5443'?'usebrian-admin-test':'usebrian-admin-test-'+port,database='usebrian_admin_test'
assert.equal(execFileSync('docker',['container','inspect','-f','{{index .Config.Labels "com.usebrian.rig"}}',container],{encoding:'utf8',timeout:10000}).trim(),'admin-test','Only maintained labelled fixtures are allowed')
const psql=(role,sql)=>execFileSync('docker',['exec','-i',container,'psql','-U',role,'-d',database,'-v','ON_ERROR_STOP=1','-tA'],{input:sql,encoding:'utf8',timeout:15000})
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
