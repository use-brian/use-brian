import type {persistentContextFixture} from './persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
type Fixture=Pick<Awaited<ReturnType<typeof persistentContextFixture>>,'pool'|'workspaceId'|'ownerId'|'secondId'>
/** Real metadata dictionaries and role rows for the protected source location. */
export async function knowledgeSourcePolicyFixture(f:Fixture){
 await assertLocalFixture();const pool=f.pool;let installed=false
 const keys=['id','sourceType','repo','branch','rootPath','lastSyncedAt']
 const cleanup=async()=>{
  await pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND resource_type='knowledge_source'",[f.workspaceId])
  await pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[f.workspaceId])
  if(installed)await pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
  await pool.query('DROP FUNCTION IF EXISTS r3_knowledge_source_policy_record(uuid,jsonb,text,text);DROP FUNCTION IF EXISTS r3_knowledge_source_policy_catalog(uuid,jsonb,text);DROP TABLE IF EXISTS r3_knowledge_source_policy_fields')
 }
 try{
  await pool.query(`CREATE TABLE r3_knowledge_source_policy_fields(workspace_id uuid PRIMARY KEY,fields jsonb NOT NULL);
   CREATE FUNCTION r3_knowledge_source_policy_catalog(w uuid,o jsonb,t text) RETURNS jsonb
   LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','knowledge-source-policy-v1','policyVersion','1',
     'fieldKeys','["id","sourceType","repo","branch","rootPath","lastSyncedAt"]'::jsonb,'fields',fields,
     'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb))
    FROM r3_knowledge_source_policy_fields WHERE workspace_id=w $$;
   CREATE FUNCTION r3_knowledge_source_policy_record(w uuid,o jsonb,t text,i text) RETURNS jsonb
   LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT (r3_knowledge_source_policy_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',source.binding_version::text,'source',read_scope_source(w,'knowledge_source',source.id))
    FROM workspace_knowledge_sources source WHERE source.workspace_id=w AND source.id=i::uuid $$;
   REVOKE ALL ON FUNCTION r3_knowledge_source_policy_catalog(uuid,jsonb,text),r3_knowledge_source_policy_record(uuid,jsonb,text,text) FROM PUBLIC`)
  await pool.query(`INSERT INTO r3_knowledge_source_policy_fields(workspace_id,fields) SELECT $1,jsonb_agg(jsonb_build_object('key',key,
   'read',CASE WHEN key='repo' THEN '[["source_location_reader"]]'::jsonb ELSE '[]'::jsonb END,'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb)) FROM unnest($2::text[]) key`,[f.workspaceId,keys])
  await pool.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
   VALUES('native','1',ARRAY['source_location_reader'],'r3_knowledge_source_policy_record(uuid,jsonb,text,text)'::regprocedure,'r3_knowledge_source_policy_catalog(uuid,jsonb,text)'::regprocedure)`);installed=true
  await pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}','knowledge_source','native')`,[f.workspaceId])
  const grant=async(user:string)=>{await pool.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'source_location_reader',$3)`,[f.workspaceId,user,f.ownerId])}
  const revoke=async(user:string)=>{await pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND module_key='native' AND user_id=$2 AND role_key='source_location_reader'",[f.workspaceId,user])}
  for(const user of [f.ownerId,f.secondId])await grant(user)
  const malformed=async()=>{await pool.query(`UPDATE r3_knowledge_source_policy_fields SET fields=(SELECT jsonb_agg(CASE WHEN value->>'key'='repo' THEN jsonb_set(value,'{read}','["source_location_reader"]'::jsonb) ELSE value END) FROM jsonb_array_elements(fields)) WHERE workspace_id=$1`,[f.workspaceId])}
  return{grant,revoke,malformed,cleanup}
 }catch(error){await cleanup();throw error}
}
