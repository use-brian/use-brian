import type {persistentContextFixture} from './persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
type Fixture=Pick<Awaited<ReturnType<typeof persistentContextFixture>>,'pool'|'workspaceId'|'ownerId'|'secondId'>
type Role='body_reader'|'target_body_reader'|'identity_reader'|'body_writer'
/** Actual native metadata dictionaries and role rows, never an admission stub. */
export async function knowledgeFieldPolicyFixture(f:Fixture,options:{requireBodyWriter?:boolean}={}){
 await assertLocalFixture();const pool=f.pool;let installed=false
 const cleanup=async()=>{
  await pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[f.workspaceId])
  await pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[f.workspaceId])
  if(installed)await pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
  await pool.query(`DROP FUNCTION IF EXISTS r3_knowledge_point_policy_record(uuid,jsonb,text,text);
   DROP FUNCTION IF EXISTS r3_knowledge_point_policy_catalog(uuid,jsonb,text);
   DROP TABLE IF EXISTS r3_knowledge_point_policy_overrides;DROP TABLE IF EXISTS r3_knowledge_point_policy_fields`)
 }
 try{
  await pool.query(`CREATE TABLE r3_knowledge_point_policy_fields(workspace_id uuid PRIMARY KEY,fields jsonb NOT NULL);
   CREATE TABLE r3_knowledge_point_policy_overrides(workspace_id uuid NOT NULL,resource_id uuid PRIMARY KEY,fields jsonb NOT NULL);
   CREATE FUNCTION r3_knowledge_point_policy_catalog(w uuid,o jsonb,t text) RETURNS jsonb
   LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','knowledge-point-policy-v1','policyVersion','1',
     'fieldKeys',to_jsonb(application_knowledge_field_keys()),'fields',p.fields,
     'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb))
    FROM r3_knowledge_point_policy_fields p WHERE p.workspace_id=w $$;
   CREATE FUNCTION r3_knowledge_point_policy_record(w uuid,o jsonb,t text,i text) RETURNS jsonb
   LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT (r3_knowledge_point_policy_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',k.scope_version::text,
     'fields',coalesce(override.fields,(r3_knowledge_point_policy_catalog(w,o,t)->'fields')),'source',read_scope_source(w,'knowledge_entry',k.id))
    FROM knowledge_entries k LEFT JOIN r3_knowledge_point_policy_overrides override ON override.workspace_id=k.workspace_id AND override.resource_id=k.id
    WHERE k.workspace_id=w AND k.id=i::uuid $$;
   REVOKE ALL ON FUNCTION r3_knowledge_point_policy_catalog(uuid,jsonb,text),r3_knowledge_point_policy_record(uuid,jsonb,text,text) FROM PUBLIC`)
  await pool.query(`INSERT INTO r3_knowledge_point_policy_fields(workspace_id,fields) SELECT $1,jsonb_agg(jsonb_build_object('key',key,
   'read',CASE WHEN key='content' THEN '[["body_reader"]]'::jsonb ELSE '[]'::jsonb END,'write',CASE WHEN key='content' AND $2::boolean THEN '[["body_writer"]]'::jsonb ELSE '[]'::jsonb END,
   'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb)) FROM unnest(application_knowledge_field_keys()) key`,[f.workspaceId,options.requireBodyWriter===true])
  await pool.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
   VALUES('native','1',ARRAY['body_reader','target_body_reader','identity_reader','body_writer'],'r3_knowledge_point_policy_record(uuid,jsonb,text,text)'::regprocedure,
    'r3_knowledge_point_policy_catalog(uuid,jsonb,text)'::regprocedure)`);installed=true
  await pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key)
   VALUES($1,'{"kind":"native","moduleKey":"native"}','knowledge_entry','native')`,[f.workspaceId])
  const grant=async(user:string,role:Role)=>{await pool.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id)
   VALUES($1,'native',$2,$3,$4)`,[f.workspaceId,user,role,f.ownerId])}
  const revoke=async(user:string,role:Role)=>{await pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND module_key='native' AND user_id=$2 AND role_key=$3",[f.workspaceId,user,role])}
  const protect=async(id:string,field:'id'|'content',role:Role)=>{await pool.query(`INSERT INTO r3_knowledge_point_policy_overrides(workspace_id,resource_id,fields)
   SELECT workspace_id,$2,(SELECT jsonb_agg(CASE WHEN value->>'key'=$3 THEN jsonb_set(value,'{read}',jsonb_build_array(jsonb_build_array($4::text))) ELSE value END)
    FROM jsonb_array_elements(fields)) FROM r3_knowledge_point_policy_fields WHERE workspace_id=$1
   ON CONFLICT(resource_id) DO UPDATE SET fields=EXCLUDED.fields`,[f.workspaceId,id,field,role])}
  const protectWrite=async(id:string,field:'content'|'tags',role:Role)=>{await pool.query(`INSERT INTO r3_knowledge_point_policy_overrides(workspace_id,resource_id,fields)
   SELECT workspace_id,$2,(SELECT jsonb_agg(CASE WHEN value->>'key'=$3 THEN jsonb_set(value,'{write}',jsonb_build_array(jsonb_build_array($4::text))) ELSE value END)
    FROM jsonb_array_elements(fields)) FROM r3_knowledge_point_policy_fields WHERE workspace_id=$1
   ON CONFLICT(resource_id) DO UPDATE SET fields=EXCLUDED.fields`,[f.workspaceId,id,field,role])}
  const protectCatalogWrite=async(field:'content'|'tags',role:Role)=>{await pool.query(`UPDATE r3_knowledge_point_policy_fields SET fields=(
   SELECT jsonb_agg(CASE WHEN value->>'key'=$2 THEN jsonb_set(value,'{write}',jsonb_build_array(jsonb_build_array($3::text))) ELSE value END)
    FROM jsonb_array_elements(fields)) WHERE workspace_id=$1`,[f.workspaceId,field,role])}
  for(const user of [f.ownerId,f.secondId])await grant(user,'body_reader')
  return{grant,revoke,protect,protectWrite,protectCatalogWrite,cleanup}
 }catch(error){await cleanup();throw error}
}
