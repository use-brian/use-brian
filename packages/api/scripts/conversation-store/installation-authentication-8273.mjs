// [COMP:api/native-turn-frame] Fresh source authentication of the current installation.
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
const hash=value=>createHash('sha256').update(value).digest('hex')
const literal=value=>"'"+value.replaceAll("'","''")+"'"
function once(source,needle,replacement){if(source.split(needle).length!==2)throw Error('installation_source_transform_changed');return source.replace(needle,()=>replacement)}
const currentMigrationSha='5617c736f9abf63b737ffd771479b4dba285c26b905532bf047ed470be9c4996'
function between(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);if(a<0||b<0||source.indexOf(start,a+1)!==-1)throw Error('installation_source_section_changed');return source.slice(a,b)}
function block(source,tag){return between(source,'DO $'+tag+'$','END $'+tag+'$;')+'END $'+tag+'$;'}
export function assertAuthenticationReadOnly(sql){
 let code='',quoted=false,line=false,blockDepth=0
 for(let at=0;at<sql.length;at++){
  const c=sql[at],next=sql[at+1]
  if(line){if(c==='\n'){line=false;code+='\n'}continue}
  if(blockDepth){if(c==='/'&&next==='*'){blockDepth++;at++}else if(c==='*'&&next==='/'){blockDepth--;at++}continue}
  if(quoted){if(c==="'"&&next==="'")at++;else if(c==="'")quoted=false;continue}
  if(c==="'"){quoted=true;code+=' ';continue}
  if(c==='-'&&next==='-'){line=true;at++;continue}
  if(c==='/'&&next==='*'){blockDepth=1;at++;continue}
  // Dollar bodies remain visible as executable code; only their delimiters go.
  if(c==='$'){const tag=sql.slice(at).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];if(tag){at+=tag.length-1;continue}}
  code+=c
 }
 if(quoted||blockDepth)throw Error('installation_authentication_source_unterminated')
 const mutation=/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:public\.|(?:native_|crm_|sessions\b|workspaces\b))/i
 const ddl=/\b(?:CREATE(?:\s+OR\s+REPLACE)?|ALTER|DROP)\s+(?:FUNCTION|TABLE|TYPE|INDEX|SCHEMA)\s+(?:public\.|native_|crm_)/i
 code=code.replace(/"([A-Za-z_][A-Za-z_0-9]*)"/g,'$1')
 for(const trigger of code.matchAll(/\b(?:CREATE(?:\s+CONSTRAINT)?|ALTER|DROP)\s+TRIGGER\b[^;]*?\bON\s+([a-z_0-9.]+)/gi)){
  if(!/^(?:pg_temp\.a8273_[a-z_0-9]+|a8273_(?:conversion|publication)_source_reference\.[a-z_0-9]+)$/i.test(trigger[1]))throw Error('installation_authentication_public_trigger_mutation')
 }
 const role=/\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|DATABASE)\b/i
 // This exact source recipe's dynamic DDL may create only private compiler refs.
 const dynamic=/EXECUTE\s+format\('(?:CREATE|ALTER|DROP)\s+(?:FUNCTION|TABLE|TYPE|INDEX|TRIGGER|SCHEMA)\s+public\./i
 if(mutation.test(code)||ddl.test(code)||role.test(code)||dynamic.test(sql))throw Error('installation_authentication_public_mutation: '+[code.match(mutation)?.[0],code.match(ddl)?.[0],code.match(role)?.[0],sql.match(dynamic)?.[0]].filter(Boolean).join(' | '))
}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const path=sourceRoot.replace(/\/$/,'')+'/migrations/8273_conversation_requirement_conversion.sql'
 const shipped=await readFile(path,'utf8');if(hash(shipped)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const first=shipped.indexOf('BEGIN;\n')+'BEGIN;\n'.length
 const prefix=shipped.slice(first,shipped.indexOf('CREATE TEMP TABLE c8273_publication_predecessor_table_snapshot('))
 const references=between(shipped,'CREATE FUNCTION pg_temp.c8273_publication_reference_schema()','CREATE FUNCTION pg_temp.c8273_publication_table_snapshot()')
 const tableSnapshot=between(shipped,'CREATE FUNCTION pg_temp.c8273_publication_table_snapshot()','DO $before_installer$')
 let baseSchema=block(shipped,'before_installer')
 baseSchema=baseSchema.replace("OR key='triggers' AND value->>'tgrelid'=work_id::text AND value->>'tgconstraint'=foreign_key::text)","OR key='triggers' AND value->>'tgrelid'=work_id::text AND value->>'tgconstraint'=foreign_key::text\n   OR key='triggers' AND EXISTS(SELECT 1 FROM c8273_conversion_source_added_triggers added WHERE added.metadata=value))")
 let oldFunctions=block(shipped,'conversion_authenticate_poststate')
 oldFunctions=oldFunctions.replace('(actual.prosrc COLLATE "C") IS DISTINCT FROM (body COLLATE "C")',"((expected->>'signature') NOT IN('native_turn_helpers_current()','native_turn_publication_contract()') AND (actual.prosrc COLLATE \"C\") IS DISTINCT FROM (body COLLATE \"C\"))")
 const guardCheck=" IF native_turn_helpers_current() IS NOT TRUE OR native_turn_publication_contract() IS NOT TRUE OR native_retained_helpers_current() IS NOT TRUE\n THEN RAISE EXCEPTION 'conversion_predecessor_contract_changed';END IF;"
 if(!oldFunctions.includes(guardCheck))throw Error('installation_source_guard_phase_changed');oldFunctions=oldFunctions.replace(guardCheck,'')
 const predecessorBody=between(shipped,'CREATE FUNCTION pg_temp.c8273_conversion_predecessor_body(','DO $conversion_authenticate_poststate$')
 const sourceFunctions=block(shipped,'conversion_source_functions')
 let schema=between(shipped,'CREATE FUNCTION pg_temp.c8273_conversion_map_relation(','-- Every field except the explicitly typed engine attribute-version identity')
 // Source input tables are compiled with their exact current physical history.
 // Migration 522 grants nothing on crm_erasure_journal_targets: its app_user entry
 // is the maintained bootstrap's schema table default, whose items PostgreSQL sorts
 // by grantee OID. Render that closed default the same way; an appended GRANT matches
 // only installations whose owner role predates app_user.
 const extraDDL=`CREATE TABLE c8273_conversion_source_reference.native_turn_contract_helpers(signature text PRIMARY KEY,fingerprint text NOT NULL);
ALTER TABLE c8273_conversion_source_reference.native_turn_contract_helpers ADD COLUMN contract pg_catalog.pg_proc;
ALTER TABLE c8273_conversion_source_reference.native_turn_contract_helpers ALTER COLUMN contract SET NOT NULL;
ALTER TABLE c8273_conversion_source_reference.native_turn_contract_helpers DROP COLUMN fingerprint;
CREATE TABLE c8273_conversion_source_reference.native_retained_contract_helpers(signature text PRIMARY KEY,fingerprint text NOT NULL);
ALTER DEFAULT PRIVILEGES IN SCHEMA c8273_conversion_source_reference GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO app_user;
CREATE TABLE c8273_conversion_source_reference.crm_erasure_journal_targets(table_name text PRIMARY KEY,key_columns text[] NOT NULL,capture_inserts boolean NOT NULL);
ALTER DEFAULT PRIVILEGES IN SCHEMA c8273_conversion_source_reference REVOKE SELECT,INSERT,UPDATE,DELETE ON TABLES FROM app_user;
REVOKE ALL ON c8273_conversion_source_reference.native_turn_contract_helpers,c8273_conversion_source_reference.native_retained_contract_helpers FROM PUBLIC,app_user;
ALTER TABLE c8273_conversion_source_reference.native_turn_contract_helpers ENABLE ROW LEVEL SECURITY;
ALTER TABLE c8273_conversion_source_reference.native_retained_contract_helpers ENABLE ROW LEVEL SECURITY;
ALTER TABLE c8273_conversion_source_reference.crm_erasure_journal_targets ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON c8273_conversion_source_reference.native_turn_contract_helpers FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect();
CREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON c8273_conversion_source_reference.native_retained_contract_helpers FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect();
`
 const oldNames="'native_conversation_frame_requirements','native_conversation_conversion_runs','native_conversation_conversion_inputs','native_conversation_conversion_pending','native_conversation_conversion_pages'"
 const inputNames=oldNames+",'native_turn_contract_helpers','native_retained_contract_helpers','crm_erasure_journal_targets'"
 if(!schema.includes(oldNames))throw Error('installation_source_relation_roster_changed')
 schema=schema.replaceAll(oldNames,inputNames)
 schema=schema.replace("AND coalesce(relacl,acldefault('r',relowner)) IS DISTINCT FROM acldefault('r',relowner)","AND relname<>'crm_erasure_journal_targets' AND coalesce(relacl,acldefault('r',relowner)) IS DISTINCT FROM acldefault('r',relowner)")
 const typeNames="'_native_conversation_conversion_unit_kind']"
 schema=schema.replace(typeNames,"'_native_conversation_conversion_unit_kind','native_turn_contract_helpers','native_retained_contract_helpers','crm_erasure_journal_targets','_native_turn_contract_helpers','_native_retained_contract_helpers','_crm_erasure_journal_targets']")
 schema=schema.replace("FROM relations c)\n    ELSE(SELECT jsonb_agg(to_jsonb(t)","FROM relations c WHERE c.relname<>'crm_erasure_journal_targets')\n    ELSE(SELECT jsonb_agg(to_jsonb(t)")
 const metadataStart=schema.indexOf('CREATE FUNCTION pg_temp.c8273_conversion_schema_snapshot('),metadataEnd=schema.indexOf('$$;',metadataStart)+3
 let metadata=schema.slice(metadataStart,metadataEnd).replace('c8273_conversion_schema_snapshot(','c8273_conversion_schema_snapshot_metadata(')
 const recoveryStart=metadata.indexOf("  'recoveryTargets',"),recoveryEnd=metadata.indexOf("  'policies',",recoveryStart)
 if(recoveryStart<0||recoveryEnd<0)throw Error('installation_source_metadata_section_changed')
 metadata=metadata.slice(0,recoveryStart)+metadata.slice(recoveryEnd)
 schema=once(schema,'CREATE TEMP TABLE c8273_conversion_verified_schema',metadata+'\nCREATE TEMP TABLE c8273_conversion_verified_schema')
 schema=once(schema,'DO $conversion_assert_source_relations$',extraDDL+'\nDO $conversion_assert_source_relations$')
 schema=schema.replace(" actual:=pg_temp.c8273_conversion_schema_snapshot('public',false);expected:=pg_temp.c8273_conversion_schema_snapshot('c8273_conversion_source_reference',true);",` actual:=pg_temp.c8273_conversion_schema_snapshot_metadata('public',false);expected:=pg_temp.c8273_conversion_schema_snapshot_metadata('c8273_conversion_source_reference',true);
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'installation_input_schema_mismatch' USING DETAIL=(SELECT jsonb_agg(key)::text FROM jsonb_each(expected) e WHERE e.value IS DISTINCT FROM actual->e.key);END IF;
 actual:=pg_temp.c8273_conversion_schema_snapshot('public',false);expected:=pg_temp.c8273_conversion_schema_snapshot('c8273_conversion_source_reference',true);`)
 const runtimeSnapshot=between(shipped,'CREATE TEMP TABLE c8273_conversion_verified_runtime_snapshot(','DO $conversion_table_contract$')
 let contract=block(shipped,'conversion_table_contract')
 const createPublic=" EXECUTE format('CREATE FUNCTION public.native_conversation_conversion_contract() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',body);\n REVOKE ALL ON FUNCTION public.native_conversation_conversion_contract() FROM PUBLIC,app_user;"
 if(!contract.includes(createPublic))throw Error('installation_source_contract_declaration_changed');contract=contract.replace(createPublic,'')
 let templates=block(shipped,'conversion_table_templates')
 templates=templates.replace(" SELECT jsonb_agg(value ORDER BY (value->>'oid')::oid) INTO added FROM jsonb_array_elements((original->'triggers')||added);"," added:=original->'triggers';")
 const render=between(shipped,'CREATE FUNCTION pg_temp.c8273_conversion_source_body(','DO $conversion_enroll_functions$')
 let enroll=block(shipped,'conversion_enroll_functions')
 enroll=enroll.replace('DECLARE signature text;actual pg_proc;','DECLARE routine_signature text;actual pg_proc;').replace('FOREACH signature IN','FOREACH routine_signature IN').replaceAll("||signature)","||routine_signature)").replaceAll('VALUES(signature,','VALUES(routine_signature,').replace("IF signature<>","IF routine_signature<>")
 enroll=once(enroll,'  INSERT INTO native_turn_contract_helpers VALUES(routine_signature,actual);',"  IF NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=routine_signature AND h.contract IS NOT DISTINCT FROM actual) THEN RAISE EXCEPTION 'installation_registry_source_mismatch';END IF;")
 const oldTablesSource=between(shipped,'CREATE TEMP TABLE c8273_publication_predecessor_table_snapshot(','CREATE FUNCTION pg_temp.c8273_publication_reference_schema()')
 const parentCheck=`DO $parent_rows$ BEGIN
 IF EXISTS(SELECT 1 FROM c8273_conversion_source_added_triggers expected LEFT JOIN pg_trigger actual ON actual.oid=(expected.metadata->>'oid')::oid WHERE to_jsonb(actual) IS DISTINCT FROM expected.metadata) THEN RAISE EXCEPTION 'installation_parent_trigger_source_mismatch';END IF;
END $parent_rows$;`
 const final=`DO $verify_current$
DECLARE routine record;actual pg_proc;expected jsonb;body text;
BEGIN
 FOR routine IN SELECT signature,parts FROM c8273_publication_successor_templates ORDER BY signature COLLATE "C" LOOP
  SELECT metadata INTO STRICT expected FROM c8273_publication_expected_current WHERE signature=routine.signature;
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure(routine.signature);
  body:=pg_temp.c8273_conversion_source_body(routine.signature,routine.parts,true);
  IF (to_jsonb(actual)-'prosrc') IS DISTINCT FROM(expected-'prosrc') OR(actual.prosrc COLLATE "C") IS DISTINCT FROM(body COLLATE "C") THEN RAISE EXCEPTION 'installation_current_source_changed: %',routine.signature;END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM native_turn_contract_helpers h JOIN pg_proc p ON p.oid=to_regprocedure(h.signature) WHERE p IS DISTINCT FROM h.contract)
  OR native_conversation_conversion_contract() IS NOT TRUE OR native_turn_helpers_current() IS NOT TRUE OR native_turn_publication_contract() IS NOT TRUE OR native_retained_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'installation_current_guard_changed';END IF;
END $verify_current$;
SELECT encode(sha256(convert_to(jsonb_agg(metadata ORDER BY signature COLLATE "C")::text,'UTF8')),'hex') local_digest,count(*)::int functions FROM c8273_publication_expected_current;
`
 const roleCheck=`DO $owner_roles$ DECLARE actor pg_roles;runtime pg_roles;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);BEGIN
 SELECT * INTO STRICT actor FROM pg_roles WHERE rolname=current_user;SELECT * INTO STRICT runtime FROM pg_roles WHERE rolname='app_user';
 IF actor.oid<>owner_id OR actor.rolsuper OR actor.rolbypassrls OR runtime.rolsuper OR runtime.rolbypassrls OR runtime.rolcreaterole OR runtime.rolcreatedb OR runtime.rolreplication OR runtime.rolinherit
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=runtime.oid OR roleid=runtime.oid)
 OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=runtime.oid) OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=runtime.oid) THEN RAISE EXCEPTION 'installation_runtime_role_unsafe';END IF;
END $owner_roles$;`
 let sql=roleCheck+'\n'+prefix+'\n'+references+'\n'+sourceFunctions+'\n'+schema+'\n'+parentCheck+'\n'+oldTablesSource+'\n'+tableSnapshot+'\n'+baseSchema+'\n'+predecessorBody+'\n'+oldFunctions+'\n'+runtimeSnapshot+'\n'+contract+'\n'+templates+'\n'+render+'\n'+enroll+'\n'+final
 const names=[...new Set([...sql.matchAll(/\bc8273_[a-z0-9_]+\b/g)].map(match=>match[0]))].sort()
 for(const name of names)sql=sql.replace(new RegExp('\\b'+name+'\\b','g'),name.replace('c8273_','a8273_'))
 const temporaryTables=[...new Set([...sql.matchAll(/CREATE TEMP TABLE (?:pg_temp\.)?(a8273_[a-z0-9_]+)/g)].map(match=>match[1]))]
 for(const name of temporaryTables)sql=sql.replace(new RegExp('(?<![\\w.])'+name+'\\b','g'),'pg_temp.'+name)
 assertAuthenticationReadOnly(sql)
 // Only the versioned compiler namespace is cleaned; public definitions and
 // canonical registry rows are never repaired or rewritten by authentication.
 const cleanup=`DO $cleanup$ DECLARE f record;BEGIN FOR f IN SELECT p.oid::regprocedure identity FROM pg_proc p WHERE p.pronamespace=pg_my_temp_schema() AND p.proname=ANY(ARRAY[${[...new Set([...sql.matchAll(/CREATE FUNCTION pg_temp\.(a8273_[a-z0-9_]+)\(/g)].map(match=>match[1]))].map(literal).join(',')}]) LOOP EXECUTE 'DROP FUNCTION '||f.identity;END LOOP;END $cleanup$;`
 return{sql,cleanup,sourceDigest:hash(shipped),migrationSha:currentMigrationSha}
}
