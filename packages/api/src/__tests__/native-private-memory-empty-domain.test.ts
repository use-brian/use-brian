/** [COMP:api/native-chat-read-cost] Execute the narrow namespace predicate and
 * genuine STABLE Memory domain/context ports with controlled canonical grants.
 * Whole-DAG/currentness/delivery qualification belongs to the native PG18 gate. */
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest'
const db=new PGlite(),[workspace,actor,domain]=Array.from({length:3},()=>randomUUID())
const migration=await readFile(new URL('../../migrations/8246_native_private_memory_empty_domain.sql',import.meta.url),'utf8')
const predicate=migration.split('$private_memory_absence$')[1]
const source=await readFile(new URL('../../migrations/8183_native_turn_requirements.sql',import.meta.url),'utf8')
function definition(name:string){
 const start=source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
 if(start<0)throw new Error(`Missing canonical port: ${name}`)
 return source.slice(start,source.indexOf('\n;',source.indexOf('END $function$',start))+2)
}
const domainBefore=definition('native_turn_empty_memory_domain')
const domainAfter=domainBefore.replace('OR EXISTS(SELECT 1 FROM memories WHERE workspace_id=w)',`OR NOT(${predicate})`)
const visibilitySource=await readFile(new URL('../../migrations/712_workflow_history_evidence.sql',import.meta.url),'utf8')
const visibility=visibilitySource.slice(visibilitySource.indexOf('CREATE FUNCTION workflow_evidence_envelope_visible'),visibilitySource.indexOf('END $$;')+'END $$;'.length)
const originalDomain={kind:'memory_query_domain_v1',fields:['summary'],bounds:{tier:3},visibility:{userId:null,assistants:null},includeRetained:true,candidates:[],policies:[]}
const seed=(count:number)=>db.query(`INSERT INTO fixture_memories(id,workspace_id,user_id,scope,scope_held,valid_to)
 SELECT md5(n::text)::uuid,$1,$2,CASE WHEN n%3=0 THEN 'legacy_unrecognized' ELSE 'shared' END,
 n%5=0,CASE WHEN n%2=0 THEN now()-interval '1 day' ELSE NULL END FROM generate_series(1,$3::int) n`,[workspace,actor,count])
const read=async()=> (await db.query<{value:unknown}>('SELECT native_turn_empty_memory_domain($1,$2,$3,jsonb_build_object(\'context\',native_turn_empty_memory_context($1))) AS value',[workspace,domain,['summary']])).rows[0].value
const absent=async()=> (await db.query<{value:boolean}>('SELECT fixture_namespace_absent($1) AS value',[workspace])).rows[0].value
const setting=(value:string)=>db.query("SELECT set_config('app.agent_shared_audience',$1,false)",[value])
beforeAll(async()=>{
 expect(predicate?.startsWith('CASE')).toBe(true)
 expect(domainAfter).not.toBe(domainBefore)
 await db.exec(`CREATE ROLE namespace_owner;CREATE ROLE namespace_actor LOGIN;
 GRANT CREATE ON SCHEMA public TO namespace_owner;SET ROLE namespace_owner;
 CREATE TABLE fixture_memories(id uuid,workspace_id uuid,user_id uuid,scope text,scope_held boolean,valid_to timestamptz);
 CREATE VIEW memories AS SELECT id,workspace_id,user_id,scope,scope_held,valid_to FROM fixture_memories;
 CREATE TABLE workspaces(id uuid,department_read_v2 boolean);
 CREATE TABLE workspace_members(workspace_id uuid,user_id uuid);
 CREATE TABLE application_native_resource_owners(workspace_id uuid,origin jsonb,resource_type text);
 CREATE TABLE application_query_domains(workspace_id uuid,id uuid,origin jsonb,type_key text,domain jsonb,schema_version text,identity text);
 CREATE TABLE fixture_state(helper_current boolean,read_fields jsonb,bounds_valid boolean);
 CREATE FUNCTION application_memory_statement_helpers_current() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT helper_current FROM fixture_state$$;
 CREATE FUNCTION fixture_namespace_absent(w uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$SELECT ${predicate}$body$;
 CREATE FUNCTION native_turn_query_bounds(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{"tier":3}'::jsonb$$;
 CREATE FUNCTION application_query_scope_valid(jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT bounds_valid FROM fixture_state$$;
 CREATE FUNCTION application_memory_field_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$SELECT ARRAY['summary']$$;
 CREATE FUNCTION application_native_member_field_permissions(uuid,jsonb,uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('read',read_fields) FROM fixture_state$$;
 CREATE FUNCTION application_query_scope_union_contains(jsonb,jsonb,integer) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{"contains":true}'::jsonb$$;
 CREATE FUNCTION application_field_digest(jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT md5($1::text)$$;
 CREATE FUNCTION application_field_resource_uuid(text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT md5($1)::uuid$$;
 CREATE FUNCTION entity_derivation_envelope_valid(jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT true$$;
 CREATE FUNCTION agent_visibility_allows(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
 CREATE FUNCTION agent_scope_grant_allows(text,text[]) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
 CREATE FUNCTION department_read_grants() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{}'::jsonb$$;
 CREATE FUNCTION department_row_allows(jsonb,uuid,text,text[],uuid) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT true$$;
 CREATE FUNCTION agent_read_scope_allows(text,text[],uuid[]) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
 CREATE FUNCTION member_operation_scope_allows(uuid,text,text[],boolean) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;`)
 await db.exec(visibility)
 await db.exec(definition('native_turn_empty_memory_context'))
 await db.exec(domainAfter)
 await db.exec(definition('native_turn_empty_memory_envelope'))
 await db.exec('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO namespace_actor;RESET ROLE;SET SESSION AUTHORIZATION namespace_actor;')
 await db.query("SELECT set_config('app.current_user_id',$1,false),set_config('app.agent_workspace_id',$2,false)",[actor,workspace])
 await db.query('INSERT INTO workspaces VALUES($1,false)',[workspace])
 await db.query('INSERT INTO workspace_members VALUES($1,$2)',[workspace,actor])
})
beforeEach(async()=>{
 await db.exec('DELETE FROM fixture_memories;DELETE FROM application_native_resource_owners;DELETE FROM application_query_domains;DELETE FROM fixture_state;INSERT INTO fixture_state VALUES(true,\'["summary"]\',true)')
 await setting('true')
 await db.query("INSERT INTO application_query_domains VALUES($1,$2,$3,'memory',$4,'memory-fields-v1','fictional-domain')",[workspace,domain,{kind:'native',moduleKey:'native'},originalDomain])
})
afterAll(async()=>db.close())
describe.sequential('[COMP:api/native-chat-read-cost] private namespace empty Memory domain',()=>{
 it('keeps the physically empty profile unchanged even outside a shared operation',async()=>{
  await setting('false');expect(await absent()).toBe(true)
  await db.exec('UPDATE fixture_state SET helper_current=false')
  expect(await absent()).toBe(true)
 })
 it('returns exactly the old empty-domain state for289 private rows despite lifecycle and legacy scope text',async()=>{
  const expected=await read();expect(expected).not.toBeNull()
  await seed(289)
  expect(await absent()).toBe(true)
  expect(await read()).toEqual(expected)
  expect(JSON.stringify(await read())).not.toContain('legacy_unrecognized')
 })
 it.each(['','false','TRUE','True','1','null','garbage'])('declines a noncanonical shared-audience setting: %j',async(value)=>{
  await seed(1);await setting(value)
  expect(await absent()).toBe(false);expect(await read()).toBeNull()
 })
 it('accepts4096 private rows and declines an overflow rather than truncating exclusion',async()=>{
  await seed(4096);expect(await absent()).toBe(true)
  await db.query('INSERT INTO fixture_memories VALUES($1,$2,$3,$4,false,NULL)',[randomUUID(),workspace,actor,'shared'])
  expect(await absent()).toBe(false);expect(await read()).toBeNull()
 })
 it('declines any user-independent row, including an otherwise held or retired row',async()=>{
  await seed(2)
  await db.exec('UPDATE fixture_memories SET user_id=NULL,scope_held=true,valid_to=now()')
  expect(await absent()).toBe(false);expect(await read()).toBeNull()
 })
 it('does not reuse exclusion after a current unheld private row becomes user-independent',async()=>{
  await seed(1);expect(await read()).not.toBeNull()
  await db.exec('UPDATE fixture_memories SET user_id=NULL,scope_held=false,valid_to=NULL')
  expect(await absent()).toBe(false);expect(await read()).toBeNull()
 })
 it('keeps other workspace rows outside this exact namespace',async()=>{
  await seed(1)
  await db.query('INSERT INTO fixture_memories VALUES($1,$2,NULL,$3,false,NULL)',[randomUUID(),randomUUID(),'shared'])
  expect(await absent()).toBe(true);expect(await read()).not.toBeNull()
 })
 it('declines changed canonical Memory helper contracts for the nonempty namespace',async()=>{
  await seed(1);await db.exec('UPDATE fixture_state SET helper_current=false')
  expect(await absent()).toBe(false);expect(await read()).toBeNull()
 })
 it('retains native Memory ownership and field-mask admission',async()=>{
  await seed(1)
  await db.query('INSERT INTO application_native_resource_owners VALUES($1,$2,$3)',[workspace,{kind:'native',moduleKey:'native'},'memory'])
  expect(await read()).toBeNull()
  await db.exec('DELETE FROM application_native_resource_owners;UPDATE fixture_state SET read_fields=\'[]\'')
  expect(await read()).toBeNull()
 })
 it.each(['candidates','policies'])('rejects a frozen nonempty %s list',async(key)=>{
  await seed(1)
  await db.query('UPDATE application_query_domains SET domain=jsonb_set(domain,$1,$2)',[[key],[{id:randomUUID(),version:'1'}]])
  expect(await read()).toBeNull()
 })
 it.each(['read','query','identity','history'])('does not expand the actual envelope port to Memory %s observations',async(selection)=>{
  await seed(1)
  const state=await read()
  const value=await db.query<{value:unknown}>('SELECT native_turn_empty_memory_envelope($1,$2,$3,$4,$5,NULL,$6,0,$7) AS value',[workspace,{kind:'native',moduleKey:'native'},'memory',domain,selection,['summary'],state])
  expect(value.rows[0].value).toBeNull()
 })
 it('executes the canonical unconditional shared-audience rejection even for the original actor',async()=>{
  const scope={workspaceId:workspace,userId:actor,assistantId:null,sensitivity:'public',compartments:[],projectIds:[]}
  expect((await db.query<{value:boolean}>('SELECT workflow_evidence_envelope_visible($1,$2) value',[workspace,scope])).rows[0].value).toBe(false)
  await setting('false')
  expect((await db.query<{value:boolean}>('SELECT workflow_evidence_envelope_visible($1,$2) value',[workspace,scope])).rows[0].value).toBe(true)
 })
 it('uses one literal for all six metadata and consuming guard splices without rewriting the physical-empty witness',()=>{
  const profile=migration.split('DO $private_memory_domain_profile$')[1].split('END $private_memory_domain_profile$;')[0]
  const targets=[...profile.matchAll(/\('([^']+)',\s*'[a-f0-9]{64}',\s*'(?:AND\(EXISTS|OR EXISTS)/g)].map(match=>match[1])
  expect(targets).toEqual(['native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)'])
  expect(profile.match(/private_memory_absence constant text/g)).toHaveLength(1)
  expect(profile).toContain("WHEN 'metadata' THEN 'AND(NOT('||private_memory_absence||')' ELSE 'OR NOT('||private_memory_absence||')'")
  expect(profile).not.toContain('memoryPhysicalEmpty')
  expect(profile).toContain("INSERT INTO native_turn_contract_helpers(signature,fingerprint)")
  expect(profile).toContain("SELECT 'application_memory_statement_helpers_current()'")
 })
})
