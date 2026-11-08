/** [COMP:api/native-chat-read-cost] Real planning SQL, controlled canonical ports.
 * Actual ancestry/current-state/delivery qualification uses the native PG18 gate. */
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest'
const db=new PGlite(),[workspace,actor,memory,native,parent]=Array.from({length:5},()=>randomUUID())
const migration=await readFile(new URL('../../migrations/8244_native_mixed_field_dependencies.sql',import.meta.url),'utf8')
const section=(name:string)=>migration.split(`$${name}$`)[1]
const declaration=section('planning_declaration_new').replace('DECLARE ','')
const variables=declaration.slice(0,declaration.indexOf('\n dependency record;'))
const source=(id:string)=>({workspaceId:workspace,userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[],resourceKind:'application_field',resourceId:id,version:'v1'})
const read=(kinds=['application_field','application_field'],ids=[memory,native],versions=['v1','v1'])=>db.query<{node_version:string;source:unknown}>('SELECT * FROM read_native_session_field_dependencies($1,$2,$3,$4)',[workspace,kinds,ids,versions])
beforeAll(async()=>{
 await db.exec(`CREATE ROLE mixed_planning_owner;CREATE ROLE mixed_planning_actor LOGIN;
  GRANT CREATE ON SCHEMA public TO mixed_planning_owner;SET ROLE mixed_planning_owner;
  CREATE TABLE session_messages(id uuid);
  CREATE TABLE application_field_resources(id uuid,workspace_id uuid,origin jsonb,type_key text,selection text,selected_version text);
  CREATE TABLE fixture_state(mode text,helper_current boolean,generation integer,memory_generation integer);
  CREATE TABLE fixture_lineage(root_id uuid,kind text,id uuid,version text);
  CREATE TABLE fixture_dependencies(root_id uuid,node_version text,source jsonb);
  CREATE FUNCTION native_turn_helpers_current() RETURNS boolean LANGUAGE sql AS $$SELECT helper_current FROM fixture_state$$;
  CREATE FUNCTION application_memory_statement_helpers_current() RETURNS boolean LANGUAGE sql AS $$SELECT helper_current FROM fixture_state$$;
  CREATE FUNCTION native_turn_context() RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('generation',generation) FROM fixture_state$$;
  CREATE FUNCTION application_memory_query_context(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('generation',memory_generation) FROM fixture_state$$;
  CREATE FUNCTION application_scope_lineage(uuid,text[],uuid[],text[]) RETURNS TABLE(kind text,id uuid,version text)
   LANGUAGE sql AS $$SELECT DISTINCT kind,id,version FROM fixture_lineage WHERE root_id=ANY($3)$$;
  CREATE FUNCTION read_application_field_dependencies(uuid,text[],uuid[],text[]) RETURNS TABLE(node_version text,source jsonb)
   LANGUAGE sql AS $$SELECT DISTINCT node_version,source FROM fixture_dependencies WHERE root_id=ANY($3)$$;
  CREATE FUNCTION fixture_proof(roots uuid[],family text) RETURNS jsonb LANGUAGE plpgsql AS $$
   DECLARE m text;immutable jsonb;BEGIN
    SELECT mode INTO m FROM fixture_state;
    IF m=family||'_null' THEN RETURN NULL;END IF;
    IF m=family||'_false' THEN RETURN '{"admitted":false}';END IF;
    IF m='sql_cancel' AND family='native' THEN RAISE EXCEPTION 'fixture_query_cancelled' USING ERRCODE='57014';END IF;
    SELECT coalesce(jsonb_agg(source ORDER BY source::text),'[]') INTO immutable FROM(SELECT DISTINCT source FROM fixture_dependencies WHERE root_id=ANY(roots)) d;
    IF m='cross_conflict' AND family='memory' THEN
     immutable:=immutable||jsonb_build_array((SELECT source||'{"sensitivity":"confidential"}' FROM fixture_dependencies WHERE root_id<>roots[1] LIMIT 1));
    END IF;
    IF family='native' THEN
     IF m='broader_compartment' THEN SELECT jsonb_agg(value||'{"compartments":["extra"]}') INTO immutable FROM jsonb_array_elements(immutable);END IF;
     IF m='broader_project' THEN SELECT jsonb_agg(value||'{"projectIds":["00000000-0000-4000-8000-000000000088"]}') INTO immutable FROM jsonb_array_elements(immutable);END IF;
     IF m='conflicting_descriptor' THEN immutable:=immutable||jsonb_build_array((immutable->0)||'{"sensitivity":"confidential"}');END IF;
     IF m='missing_dependency' THEN immutable:=immutable-0;END IF;
     IF m='wrong_envelope' THEN SELECT jsonb_agg(value||'{"sensitivity":"public"}') INTO immutable FROM jsonb_array_elements(immutable);END IF;
     IF m='context_changed' THEN UPDATE fixture_state SET generation=generation+1;END IF;
     IF m='memory_context_changed' THEN UPDATE fixture_state SET memory_generation=memory_generation+1;END IF;
     IF m='helper_changed' THEN UPDATE fixture_state SET helper_current=false;END IF;
     IF m='graph_changed' THEN INSERT INTO fixture_lineage VALUES(roots[1],'application_field','00000000-0000-4000-8000-000000000099','v1');END IF;
     IF m='metadata_changed' THEN UPDATE fixture_dependencies SET source=source||'{"sensitivity":"confidential"}' WHERE root_id=roots[1];END IF;
    END IF;
    RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',immutable);
   END$$;
  CREATE FUNCTION read_native_attended_memory_evidence(uuid,text[],uuid[],text[]) RETURNS jsonb LANGUAGE sql AS $$SELECT fixture_proof($3,'memory')$$;
  CREATE FUNCTION read_native_turn_scope_evidence(uuid,jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT fixture_proof(ARRAY(SELECT (value->>'id')::uuid FROM jsonb_array_elements($2)),'native')$$;
  CREATE FUNCTION read_native_session_field_dependencies(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS TABLE(node_version text,source jsonb)
   LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
   DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;${variables}
   BEGIN ${section('planning_branch')}
    RAISE EXCEPTION 'original_dependency_reader';
   END $body$;
  GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO mixed_planning_actor;
  RESET ROLE;SET SESSION AUTHORIZATION mixed_planning_actor;`)
 await db.query("SELECT set_config('app.current_user_id',$1,false)",[actor])
})
beforeEach(async()=>{
 await db.exec(`DELETE FROM fixture_state;DELETE FROM fixture_lineage;DELETE FROM fixture_dependencies;DELETE FROM application_field_resources;
  INSERT INTO fixture_state VALUES('normal',true,1,1);`)
 for(const [id,type] of [[memory,'memory'],[native,'session_message'],[parent,'session_message_annotation']]){
  await db.query('INSERT INTO application_field_resources VALUES($1,$2,$3,$4,$5,NULL)',[id,workspace,{kind:'native',moduleKey:'native'},type,type==='memory'?'query_domain':'query'])
  await db.query('INSERT INTO fixture_lineage VALUES($1,$2,$1,$3)',[id,'application_field','v1'])
  await db.query('INSERT INTO fixture_dependencies VALUES($1,$2,$3)',[id,'v1',source(id)])
 }
 await db.query('INSERT INTO fixture_lineage VALUES($1,$2,$3,$4)',[native,'application_field',parent,'v1'])
 await db.query('INSERT INTO fixture_dependencies VALUES($1,$2,$3)',[native,'v1',source(parent)])
})
afterAll(async()=>db.close())
describe.sequential('[COMP:api/native-chat-read-cost] mixed native dependency planning',()=>{
 it('returns complete exact dependency metadata including nonroot ancestry, without proof packets',async()=>{
  const rows=(await read()).rows
  expect(rows).toHaveLength(3)
  expect(rows.map(row=>row.source)).toEqual(expect.arrayContaining([source(memory),source(native),source(parent)]))
  expect(rows.every(row=>row.node_version==='v1'&&Object.keys(row).sort().join(',')==='node_version,source')).toBe(true)
 })
 it.each(['memory_null','memory_false','native_null','native_false','missing_dependency','wrong_envelope','broader_compartment','broader_project','conflicting_descriptor','cross_conflict','context_changed','memory_context_changed','helper_changed','graph_changed','metadata_changed'])(
  'retains the original reader for a refused/incomplete/changed proof: %s',async(value)=>{
   await db.query('UPDATE fixture_state SET mode=$1',[value]);await expect(read()).rejects.toThrow('original_dependency_reader')
  })
 it('requires both cohorts and distinct original root identities',async()=>{
  await expect(read(['application_field'],[native],['v1'])).rejects.toThrow('original_dependency_reader')
  await expect(read(['application_field','application_field'],[memory,memory],['v1','v1'])).rejects.toThrow('original_dependency_reader')
 })
 it('retains unknown generic, historical and cross-profile ancestry',async()=>{
  await db.query('UPDATE application_field_resources SET origin=$1 WHERE id=$2',[{kind:'generic',entityTypeId:randomUUID()},native])
  await expect(read()).rejects.toThrow('original_dependency_reader')
  await db.query("UPDATE application_field_resources SET origin=$1,selection='history',selected_version='v0' WHERE id=$2",[{kind:'native',moduleKey:'native'},memory])
  await expect(read()).rejects.toThrow('original_dependency_reader')
  await db.query("UPDATE application_field_resources SET selection='query_domain',selected_version=NULL WHERE id=$1",[memory])
  await db.query('INSERT INTO fixture_lineage VALUES($1,$2,$3,$4)',[memory,'session_message',randomUUID(),'1'])
  await expect(read()).rejects.toThrow('original_dependency_reader')
 })
 it('requires exact workspace metadata even when both canonical arrays include it',async()=>{
  await db.query("UPDATE fixture_dependencies SET source=source||jsonb_build_object('workspaceId',$1::text) WHERE root_id=$2",[randomUUID(),memory])
  await expect(read()).rejects.toThrow('original_dependency_reader')
 })
 it('retains unknown helper contracts on the original path',async()=>{
  await db.exec('UPDATE fixture_state SET helper_current=false');await expect(read()).rejects.toThrow('original_dependency_reader')
 })
 it('propagates real SQL cancellation without reporting unsupported planning',async()=>{
  await db.exec("UPDATE fixture_state SET mode='sql_cancel'");await expect(read()).rejects.toThrow('fixture_query_cancelled')
 })
})
