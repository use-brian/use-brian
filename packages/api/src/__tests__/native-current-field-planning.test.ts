/** [COMP:api/native-chat-read-cost] Real planning SQL, controlled canonical ports.
 * Actual ancestry/current-state/delivery qualification uses the native PG18 gate. */
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest'
const db=new PGlite(),[workspace,actor,memory,native,parent]=Array.from({length:5},()=>randomUUID())
const migration=await readFile(new URL('../../migrations/8245_native_current_field_planning.sql',import.meta.url),'utf8')
const section=(name:string)=>migration.split(`$${name}$`)[1]
const declaration=section('snapshot_declaration_after').replace('DECLARE ','')
const variables=declaration.slice(0,declaration.indexOf('\n position integer;'))
const source=(id:string)=>({workspaceId:workspace,userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[],resourceKind:'application_field',resourceId:id,version:'v1'})
const snapshots=(ids=[memory,native],versions=ids.map(()=> 'v1'))=>db.query<{ord:number;snapshot:unknown}>('SELECT * FROM read_native_session_field_snapshots($1,$2,$3)',[workspace,ids,versions])
const read=(kinds=['application_field','application_field'],ids=[memory,native],versions=['v1','v1'])=>db.query<{node_version:string;source:unknown}>('SELECT * FROM read_native_session_field_dependencies($1,$2,$3,$4)',[workspace,kinds,ids,versions])
beforeAll(async()=>{
 await db.exec(`CREATE ROLE mixed_planning_owner;CREATE ROLE mixed_planning_actor LOGIN;
  GRANT CREATE ON SCHEMA public TO mixed_planning_owner;SET ROLE mixed_planning_owner;
  CREATE TABLE session_messages(id uuid);
  CREATE TABLE memories(id uuid,workspace_id uuid);
  CREATE TABLE application_native_resource_owners(workspace_id uuid,origin jsonb,resource_type text);
  CREATE TABLE application_field_resources(id uuid,workspace_id uuid,origin jsonb,type_key text,selection text,selected_version text);
  CREATE TABLE fixture_state(mode text,helper_current boolean,generation integer,memory_generation integer,memory_calls integer,native_seen boolean,metadata_generation integer);
  CREATE TABLE application_field_observations(workspace_id uuid,resource_id uuid,version text,source_scope jsonb);
  CREATE TABLE fixture_lineage(root_id uuid,kind text,id uuid,version text);
  CREATE TABLE fixture_dependencies(root_id uuid,node_version text,source jsonb);
  CREATE FUNCTION native_turn_helpers_current() RETURNS boolean LANGUAGE sql AS $$SELECT helper_current FROM fixture_state$$;
  CREATE FUNCTION application_memory_statement_helpers_current() RETURNS boolean LANGUAGE sql AS $$SELECT helper_current FROM fixture_state$$;
  CREATE FUNCTION native_turn_context() RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('generation',generation) FROM fixture_state$$;
  CREATE FUNCTION application_memory_query_context(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('generation',memory_generation,'policy',jsonb_build_object('nativeDefault',true)) FROM fixture_state$$;
  CREATE FUNCTION application_scope_lineage(uuid,text[],uuid[],text[]) RETURNS TABLE(kind text,id uuid,version text)
   LANGUAGE plpgsql AS $$BEGIN IF cardinality($3)>100 THEN RAISE EXCEPTION 'legacy_lineage_root_limit';END IF;RETURN QUERY SELECT DISTINCT n.kind,n.id,n.version FROM fixture_lineage n WHERE root_id=ANY($3);END$$;
  CREATE FUNCTION read_application_field_dependencies(uuid,text[],uuid[],text[]) RETURNS TABLE(node_version text,source jsonb)
   LANGUAGE plpgsql AS $$BEGIN IF cardinality($3)>100 THEN RAISE EXCEPTION 'legacy_dependencies_root_limit';END IF;RETURN QUERY SELECT DISTINCT n.node_version,n.source FROM fixture_dependencies n WHERE root_id=ANY($3);END$$;
  CREATE FUNCTION application_scope_source_edges(w uuid,k text,i uuid,v text) RETURNS TABLE(kind text,id uuid,version text)
   LANGUAGE sql AS $$SELECT n.kind,n.id,n.version FROM fixture_lineage n WHERE n.root_id=i AND (n.kind,n.id,n.version) IS DISTINCT FROM (k,i,v)$$;
  CREATE FUNCTION fixture_proof(roots uuid[],family text) RETURNS jsonb LANGUAGE plpgsql AS $$
   DECLARE m text;immutable jsonb;BEGIN
    SELECT mode INTO m FROM fixture_state;
    IF family='memory' THEN
     IF (SELECT count(*) FROM fixture_lineage WHERE root_id=ANY(roots))>4096 THEN RAISE EXCEPTION 'legacy_memory_graph_limit';END IF;
     UPDATE fixture_state SET memory_calls=memory_calls+1;
     IF m='memory_null_after_native' AND (SELECT native_seen FROM fixture_state) THEN RETURN NULL;END IF;
    END IF;
    IF m=family||'_null' THEN RETURN NULL;END IF;
    IF m=family||'_false' THEN RETURN '{"admitted":false}';END IF;
    IF m='sql_cancel' AND family='native' THEN RAISE EXCEPTION 'fixture_query_cancelled' USING ERRCODE='57014';END IF;
    SELECT coalesce(jsonb_agg(source ORDER BY source::text),'[]') INTO immutable FROM(SELECT DISTINCT source FROM fixture_dependencies WHERE root_id=ANY(roots)) d;
    IF m='cross_conflict' AND family='memory' THEN
     immutable:=immutable||jsonb_build_array((SELECT source||'{"sensitivity":"confidential"}' FROM fixture_dependencies WHERE root_id<>roots[1] LIMIT 1));
    END IF;
    IF family='native' THEN
     UPDATE fixture_state SET native_seen=true;
     IF m='native_metadata_changed' THEN UPDATE fixture_state SET metadata_generation=metadata_generation+1;END IF;
     IF m='broader_compartment' THEN SELECT jsonb_agg(value||'{"compartments":["extra"]}') INTO immutable FROM jsonb_array_elements(immutable);END IF;
     IF m='broader_project' THEN SELECT jsonb_agg(value||'{"projectIds":["00000000-0000-4000-8000-000000000088"]}') INTO immutable FROM jsonb_array_elements(immutable);END IF;
     IF m='conflicting_descriptor' THEN immutable:=immutable||jsonb_build_array((immutable->0)||'{"sensitivity":"confidential"}');END IF;
     IF m='missing_dependency' THEN SELECT coalesce(jsonb_agg(value),'[]') INTO immutable FROM jsonb_array_elements(immutable) WHERE value->>'resourceId'<>roots[1]::text;END IF;
     IF m='wrong_envelope' THEN SELECT jsonb_agg(value||'{"sensitivity":"public"}') INTO immutable FROM jsonb_array_elements(immutable);END IF;
     IF m='context_changed' THEN UPDATE fixture_state SET generation=generation+1;END IF;
     IF m='memory_context_changed' THEN UPDATE fixture_state SET memory_generation=memory_generation+1;END IF;
     IF m='helper_changed' THEN UPDATE fixture_state SET helper_current=false;END IF;
     IF m='graph_changed' THEN INSERT INTO fixture_lineage VALUES(roots[1],'application_field','00000000-0000-4000-8000-000000000099','v1');END IF;
     IF m='metadata_changed' THEN UPDATE fixture_dependencies SET source=source||'{"sensitivity":"confidential"}' WHERE root_id=roots[1];END IF;
    END IF;
    IF family='native' AND m IN('current_changed','current_version_changed','current_conflict','current_held','current_retired') THEN
     RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',
      CASE m WHEN 'current_conflict' THEN immutable||jsonb_build_array((immutable->0)||'{"sensitivity":"confidential"}')
       ELSE (SELECT jsonb_agg(value||CASE m WHEN 'current_version_changed' THEN '{"version":"v2"}'::jsonb
        WHEN 'current_held' THEN '{"held":true}'::jsonb WHEN 'current_retired' THEN '{"validTo":"2025-01-01"}'::jsonb
        ELSE '{"compartments":["extra"]}'::jsonb END) FROM jsonb_array_elements(immutable)) END);
    END IF;
    IF family='memory' AND m='memory_new_candidate' AND (SELECT native_seen FROM fixture_state) THEN
     RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',(SELECT jsonb_agg(value||'{"version":"v2"}') FROM jsonb_array_elements(immutable)));
    END IF;
    RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',immutable);
   END$$;
  CREATE FUNCTION read_native_attended_memory_evidence(uuid,text[],uuid[],text[]) RETURNS jsonb LANGUAGE sql AS $$SELECT fixture_proof($3,'memory')$$;
  CREATE FUNCTION read_native_turn_scope_evidence(uuid,jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT fixture_proof(ARRAY(SELECT (value->>'id')::uuid FROM jsonb_array_elements($2)),'native')$$;
  CREATE FUNCTION native_turn_metadata_acquire(uuid,jsonb,jsonb) RETURNS jsonb LANGUAGE sql AS $$
   SELECT jsonb_build_object('eligibleMetadata',mode<>'unsupported_native_metadata','witness',jsonb_build_object('version',metadata_generation,
    'nodes',(SELECT jsonb_agg(to_jsonb(n) ORDER BY n.root_id,n.kind,n.id,n.version) FROM fixture_lineage n WHERE n.root_id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements($2))),
    'fields',(SELECT jsonb_agg(to_jsonb(n) ORDER BY n.root_id,n.source::text) FROM fixture_dependencies n WHERE n.root_id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements($2))))) FROM fixture_state$$;
  CREATE FUNCTION read_native_turn_compact_requirements(uuid,jsonb,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
   DECLARE proof jsonb;m text;BEGIN
    proof:=fixture_proof(ARRAY(SELECT (value->>'id')::uuid FROM jsonb_array_elements($2)),'native');
    SELECT mode INTO m FROM fixture_state;
    RETURN proof||jsonb_build_object('available',proof->>'admitted'='true','validUntil',CASE WHEN m='expired_native' THEN '2000-01-01' ELSE 'infinity' END);
   END$$;
  CREATE FUNCTION read_native_session_field_dependencies(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS TABLE(node_version text,source jsonb)
   LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
   DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;${variables}
   BEGIN ${section('dependency_after')}
    RAISE EXCEPTION 'original_dependency_reader';
   END $body$;
  CREATE FUNCTION read_native_session_field_snapshots(w uuid,ids uuid[],versions text[]) RETURNS TABLE(ord integer,snapshot jsonb)
   LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
   DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;${variables}
   BEGIN ${section('snapshot_branch')}
    RAISE EXCEPTION 'original_snapshot_reader';
   END $body$;
  GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO mixed_planning_actor;
  RESET ROLE;SET SESSION AUTHORIZATION mixed_planning_actor;`)
 await db.query("SELECT set_config('app.current_user_id',$1,false)",[actor])
})
beforeEach(async()=>{
 await db.exec(`DELETE FROM memories;DELETE FROM application_native_resource_owners;DELETE FROM application_field_observations;DELETE FROM fixture_state;DELETE FROM fixture_lineage;DELETE FROM fixture_dependencies;DELETE FROM application_field_resources;
  INSERT INTO fixture_state VALUES('normal',true,1,1,0,false,1);`)
 await db.query('INSERT INTO memories VALUES($1,$2)',[memory,workspace])
 for(const [id,type] of [[memory,'memory'],[native,'session_message'],[parent,'session_message_annotation']]){
  await db.query('INSERT INTO application_field_resources VALUES($1,$2,$3,$4,$5,NULL)',[id,workspace,{kind:'native',moduleKey:'native'},type,type==='memory'?'query_domain':'query'])
  await db.query('INSERT INTO fixture_lineage VALUES($1,$2,$1,$3)',[id,'application_field','v1'])
  await db.query('INSERT INTO fixture_dependencies VALUES($1,$2,$3)',[id,'v1',source(id)])
  await db.query('INSERT INTO application_field_observations VALUES($1,$2,$3,$4)',[workspace,id,'v1',Object.fromEntries(Object.entries(source(id)).filter(([key])=>!['resourceKind','resourceId','version'].includes(key)))])
 }
 await db.query('INSERT INTO fixture_lineage VALUES($1,$2,$3,$4)',[native,'application_field',parent,'v1'])
 await db.query('INSERT INTO fixture_dependencies VALUES($1,$2,$3)',[native,'v1',source(parent)])
})
afterAll(async()=>db.close())
describe.sequential('[COMP:api/native-chat-read-cost] current native field planning',()=>{
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
 it('supports pure native ancestry without manufacturing a Memory proof',async()=>{
  expect((await read(['application_field'],[native],['v1'])).rows).toHaveLength(2)
  expect((await db.query<{memory_calls:number}>('SELECT memory_calls FROM fixture_state')).rows[0].memory_calls).toBe(0)
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

describe.sequential('[COMP:api/native-chat-read-cost] unchanged current field snapshots',()=>{
 it('matches canonical unchanged field metadata and original ordinal order exactly',async()=>{
  expect((await snapshots()).rows).toEqual([memory,native].map((id,index)=>({ord:index+1,snapshot:{...source(id),held:false,validTo:null,retractedAt:null}})))
  expect((await db.query<{memory_calls:number}>('SELECT memory_calls FROM fixture_state')).rows[0].memory_calls).toBe(2)
 })
 it('supports pure native roots without a synthetic Memory packet',async()=>{
  expect((await snapshots([native,parent])).rows).toEqual([native,parent].map((id,index)=>({ord:index+1,snapshot:{...source(id),held:false,validTo:null,retractedAt:null}})))
  expect((await db.query<{memory_calls:number}>('SELECT memory_calls FROM fixture_state')).rows[0].memory_calls).toBe(0)
 })
 it.each(['memory_null','memory_false','native_null','native_false','missing_dependency','wrong_envelope','broader_compartment','broader_project','conflicting_descriptor','cross_conflict','context_changed','memory_context_changed','helper_changed','graph_changed','metadata_changed','current_changed','current_version_changed','current_conflict','current_held','current_retired','memory_new_candidate','memory_null_after_native','native_metadata_changed','unsupported_native_metadata','expired_native'])(
  'retains original changed/held/gone/current classification for unsupported or changed proof: %s',async(mode)=>{
   await db.query('UPDATE fixture_state SET mode=$1',[mode]);await expect(snapshots()).rejects.toThrow('original_snapshot_reader')
  })
 it('retains the original path for duplicate roots and unsupported field families',async()=>{
  await expect(snapshots([native,native])).rejects.toThrow('original_snapshot_reader')
  await db.query("UPDATE application_field_resources SET type_key='unknown' WHERE id=$1",[native])
  await expect(snapshots()).rejects.toThrow('original_snapshot_reader')
 })
 it('propagates actual SQL cancellation',async()=>{
  await db.exec("UPDATE fixture_state SET mode='sql_cancel'");await expect(snapshots()).rejects.toThrow('fixture_query_cancelled')
 })
})
describe.sequential('[COMP:api/native-chat-read-cost] original array and cohort limits',()=>{
 it.each([
  [`[0:1]={${memory},${native}}`,'[0:1]={v1,v1}'],
 ])('retains snapshot fallback for noncanonical dimensions/bounds',async(ids,versions)=>{
  await expect(db.query('SELECT * FROM read_native_session_field_snapshots($1,$2::uuid[],$3::text[])',[workspace,ids,versions])).rejects.toThrow('original_snapshot_reader')
 })
 it('preserves the original multidimensional-array validation error',async()=>{
  const ids=`{{${memory},${native}}}`,versions='{{v1,v1}}'
  await expect(db.query('SELECT array_position($1::uuid[],NULL)',[ids])).rejects.toThrow('searching for elements in multidimensional arrays is not supported')
  await expect(db.query('SELECT * FROM read_native_session_field_snapshots($1,$2::uuid[],$3::text[])',[workspace,ids,versions])).rejects.toThrow('searching for elements in multidimensional arrays is not supported')
 })
 it('retains exact8244 behavior for noncanonical dependency array bounds',async()=>{
  await expect(db.query('SELECT * FROM read_native_session_field_dependencies($1,$2::text[],$3::uuid[],$4::text[])',[
   workspace,'[0:0]={application_field}',[native],['v1'],
  ])).rejects.toThrow('original_dependency_reader')
  const unchangedMixed=await db.query('SELECT * FROM read_native_session_field_dependencies($1,$2::text[],$3::uuid[],$4::text[])',[
   workspace,'[0:1]={application_field,application_field}',[memory,native],['v1','v1'],
  ])
  expect(unchangedMixed.rows).toHaveLength(3)
 })
 it('does not trim a Memory subset above its original100-root limit',async()=>{
  const ids=Array.from({length:101},()=>randomUUID())
  await db.query(`INSERT INTO application_field_resources
   SELECT id,$2,$3::jsonb,'memory','query_domain',NULL FROM unnest($1::uuid[]) generated(id)`,[ids,workspace,{kind:'native',moduleKey:'native'}])
  await expect(snapshots([...ids,native])).rejects.toThrow('original_snapshot_reader')
 })
 it('does not trim original fieldsets above4096',async()=>{
  await expect(snapshots(Array.from({length:4097},()=>native))).rejects.toThrow('original_snapshot_reader')
 })
})

describe.sequential('[COMP:api/native-chat-read-cost] full original fieldsets',()=>{
 it('qualifies more than100 native roots without calling bounded legacy metadata ports on that set',async()=>{
  const ids=Array.from({length:201},()=>randomUUID()),descriptors=ids.map(source)
  await db.query(`INSERT INTO application_field_resources SELECT id,$2,$3::jsonb,'session_message','query',NULL FROM unnest($1::uuid[]) generated(id)`,[ids,workspace,{kind:'native',moduleKey:'native'}])
  await db.query(`INSERT INTO fixture_lineage SELECT id,'application_field',id,'v1' FROM unnest($1::uuid[]) generated(id)`,[ids])
  await db.query(`INSERT INTO fixture_dependencies SELECT (value->>'resourceId')::uuid,'v1',value FROM jsonb_array_elements($1::jsonb)`,[JSON.stringify(descriptors)])
  await db.query(`INSERT INTO application_field_observations SELECT $2,(value->>'resourceId')::uuid,'v1',value-ARRAY['resourceKind','resourceId','version'] FROM jsonb_array_elements($1::jsonb)`,[JSON.stringify(descriptors),workspace])
  expect((await snapshots(ids)).rows).toEqual(descriptors.map((value,index)=>({ord:index+1,snapshot:{...value,held:false,validTo:null,retractedAt:null}})))
 })
})

describe.sequential('[COMP:api/native-chat-read-cost] optional Memory discovery',()=>{
 it('declines a Memory union above4096 before invoking its older bounded proof',async()=>{
  await db.query(`INSERT INTO fixture_lineage SELECT $1,'memory',id,'1' FROM unnest($2::uuid[]) generated(id)`,[memory,Array.from({length:4097},()=>randomUUID())])
  await expect(snapshots()).rejects.toThrow('original_snapshot_reader')
 })
 it('declines missing Memory field observations before invoking its older proof',async()=>{
  await db.query('DELETE FROM application_field_observations WHERE resource_id=$1',[memory])
  await expect(snapshots()).rejects.toThrow('original_snapshot_reader')
 })
})

describe.sequential('[COMP:api/native-chat-read-cost] preserve existing empty-profile paths',()=>{
 it('skips new plans when globally empty and retains the exact8244 mixed metadata behavior',async()=>{
  await db.exec('DELETE FROM memories')
  await expect(read(['application_field'],[native],['v1'])).rejects.toThrow('original_dependency_reader')
  await expect(snapshots()).rejects.toThrow('original_snapshot_reader')
  expect((await read()).rows.map(row=>row.source)).toEqual(expect.arrayContaining([source(memory),source(native),source(parent)]))
 })
 it('also selects the new pure plans for the exact native Memory owner disqualifier',async()=>{
  await db.exec('DELETE FROM memories')
  await db.query('INSERT INTO application_native_resource_owners VALUES($1,$2,$3)',[workspace,{kind:'native',moduleKey:'native'},'memory'])
  expect((await read(['application_field'],[native],['v1'])).rows).toHaveLength(2)
  expect((await snapshots([native])).rows).toEqual([{ord:1,snapshot:{...source(native),held:false,validTo:null,retractedAt:null}}])
 })
 it('does not infer eligibility from unrelated Memory rows or owners',async()=>{
  await db.query('UPDATE memories SET workspace_id=$1',[randomUUID()])
  await db.query('INSERT INTO application_native_resource_owners VALUES($1,$2,$3)',[workspace,{kind:'native',moduleKey:'other'},'memory'])
  await expect(read(['application_field'],[native],['v1'])).rejects.toThrow('original_dependency_reader')
  await expect(snapshots()).rejects.toThrow('original_snapshot_reader')
 })
})
