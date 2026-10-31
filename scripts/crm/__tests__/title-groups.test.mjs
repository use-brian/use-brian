import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import pg from 'pg'
import {createLocalFixture} from '../local-fixture.mjs'
const migration=(await readFile(new URL('../../../packages/api/migrations/8157_native_personal_title_groups.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
test('[COMP:api/application-persistence] grouped title installation normalizes defaults and refuses prerequisite drift',async()=>{
 let fixture
 try{
  fixture=await createLocalFixture({beforeApplyFile:'8157_native_personal_title_groups.sql',beforeApply:async({adminUrl})=>{
   const client=new pg.Client({connectionString:adminUrl});await client.connect()
   try{
    await client.query('BEGIN')
    await client.query('CREATE ROLE fictional_title_default NOLOGIN')
    await client.query('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO app_user,fictional_title_default')
    await client.query(migration)
    const rows=(await client.query(`SELECT proname,has_function_privilege('app_user',oid,'EXECUTE') AS runtime,
     has_function_privilege('fictional_title_default',oid,'EXECUTE') AS inherited,
     EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee=0) AS public
     FROM pg_proc WHERE oid=ANY(ARRAY['read_native_personal_title_group(uuid,uuid[],uuid[])'::regprocedure,'application_native_title_group_helpers_current()'::regprocedure]) ORDER BY proname`)).rows
    assert.deepEqual(rows,[{proname:'application_native_title_group_helpers_current',runtime:false,inherited:false,public:false},
     {proname:'read_native_personal_title_group',runtime:true,inherited:false,public:false}])
    assert.equal((await client.query('SELECT application_native_title_group_helpers_current() AS valid')).rows[0].valid,true)
    await client.query('ROLLBACK')
    for(const sql of [
     "ALTER FUNCTION read_session_title_revision(uuid,uuid,uuid) COST 101",
     "REVOKE EXECUTE ON FUNCTION read_session_title_revision(uuid,uuid,uuid) FROM app_user",
     "GRANT EXECUTE ON FUNCTION read_session_context_revision(uuid,uuid) TO PUBLIC",
     "ALTER FUNCTION read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean) SET search_path=public",
     "CREATE OR REPLACE FUNCTION public.application_empty_query_helpers_current() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS 'SELECT true'",
     "GRANT EXECUTE ON FUNCTION application_empty_query_helpers_current() TO app_user",
    ]){
     await client.query('BEGIN');await client.query(sql)
     await assert.rejects(client.query(migration),/Title group (prerequisite|existing guard|canonical helpers) changed/)
     await client.query('ROLLBACK')
    }
   }finally{await client.query('ROLLBACK').catch(()=>{});await client.end()}
  }})
 }finally{await fixture?.dispose()}
})
