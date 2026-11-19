// [COMP:api/native-turn-frame] Forward-only historical conversion installer.
// Review candidate: explicit source/output paths make frozen-checkout use read-only.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {conversionInstall} from './conversion-install.mjs'
import {versionCompilerFunctions} from './conversion-compiler-namespace.mjs'
const args=process.argv.slice(2),directory=dirname(fileURLToPath(import.meta.url))+'/'
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
const root=resolve(option('--source-root',directory+'../../')),output=resolve(option('--output',root+'/migrations/8273_conversation_requirement_conversion.sql'))
const sha=x=>createHash('sha256').update(x).digest('hex'),literal=x=>"'"+x.replaceAll("'","''")+"'"
const predecessor='8272_durable_conversation_publications.sql',pinned='06afd49b1e8a165f8cee9ec78ee5c4fa42ef815cdbfd192fa77f453025451609'
if(sha(await readFile(join(root,'migrations',predecessor)))!==pinned)throw Error('conversion_predecessor_source_changed')
const migrations=(await readdir(join(root,'migrations'))).filter(x=>/^\d{4}_.*\.sql$/.test(x)).map(x=>Number(x.slice(0,4)))
let existingTarget=false
try{const existing=await readFile(root+'/migrations/8273_conversation_requirement_conversion.sql','utf8');if(!existing.startsWith('-- [COMP:api/native-turn-frame] Authenticated historical requirement conversion.'))throw Error('conversion_existing_migration_not_owned');existingTarget=true}catch(error){if(error.code!=='ENOENT')throw error}
if(!existingTarget&&Math.max(...migrations)!==8272)throw Error('conversion_migration_number_changed: recheck next global number')
const compilerInput=await readFile(option('--compiler-input',directory+'conversion-predecessor-source.json'),'utf8')
if(sha(compilerInput)!=='70b820546a5e58a99030d531e6ac2ec9b8e87d344146b0acabbe95db997fa3ed')throw Error('conversion_source_compiler_input_changed')
const input=JSON.parse(compilerInput)
if(sha(await readFile(join(root,'scripts/conversation-store/build-publication-recovery.mjs')))!==input.sourceSha)throw Error('conversion_source_compiler_changed')
if(input.format!==1||input.sourceSpecs.length!==17||input.manifest.contracts.length!==281)throw Error('conversion_compiler_profile_changed')
// All these inputs are source artifacts emitted by the frozen compiler, not DB rows.
for(const [file,digest] of Object.entries(input.manifest.source)){
 if(sha(await readFile(join(root,'migrations',file)))!==digest)throw Error('conversion_source_changed: '+file)
}
const {manifest,sourceSpecs,oldRoster,nextRoster,oldTableExpression,newTableExpression}=input
// The17 reviewed successor source bodies contain ZERO fingerprint/hash literals.
// Preserve that explicit empty inventory. Future hash sites require a named,
// context-reviewed profile; they cannot silently become dynamic expectations.
const partsForSource=body=>{
 if(/[a-f0-9]{64}/.test(body))throw Error('conversion_unreviewed_source_hash_occurrence')
 return [body]
}
const replacements=new Map(sourceSpecs.map(spec=>[spec.signature,spec]))
const contracts=manifest.contracts.map(contract=>{
 const copy=structuredClone(contract),replacement=replacements.get(copy.signature)
 if(replacement){copy.bodyParts=partsForSource(replacement.body);copy.sourceSpec=replacement}
 if(copy.signature==='native_turn_helpers_current()')copy.bodyParts=copy.bodyParts.map(p=>typeof p==='string'?p.replace(oldRoster,nextRoster):p)
 if(copy.signature==='native_turn_publication_contract()')copy.bodyParts=copy.bodyParts.map(p=>typeof p==='string'?p.replace(oldTableExpression,newTableExpression):p.slot?.template?.tables?{slot:{kind:'conversionVerifiedPublicationTables'}}:p)
 return copy
})
for(const spec of sourceSpecs.filter(spec=>!contracts.some(c=>c.signature===spec.signature)))contracts.push({signature:spec.signature,sourceSpec:spec,bodyParts:partsForSource(spec.body),acl:[{grantee:'OWNER',grantor:'OWNER',privilege:'EXECUTE',grantable:false},...(spec.appExecute?[{grantee:'app_user',grantor:'OWNER',privilege:'EXECUTE',grantable:false}]:[])]})
if(contracts.length!==296)throw Error('conversion_poststate_roster_changed')
const oldTables=manifest.contracts.find(c=>c.signature==='native_turn_publication_contract()').bodyParts.find(p=>p.slot?.template?.tables).slot.template
let references=input.successorSource.slice(input.successorSource.indexOf('CREATE FUNCTION pg_temp.publication_reference_schema()'),input.successorSource.indexOf('CREATE FUNCTION pg_temp.publication_table_snapshot()'))
const triggerMarker=" EXECUTE 'CREATE TRIGGER native_conversation_publication_immutable BEFORE UPDATE ON publication_source_reference.native_conversation_publications FOR EACH ROW EXECUTE FUNCTION public.native_conversation_publication_immutable()';"
if(references.split(triggerMarker).length!==2)throw Error('conversion_reference_trigger_seam_changed')
references=references.replace(triggerMarker,triggerMarker+"\n EXECUTE 'CREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON publication_source_reference.native_conversation_publications FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect()';")
let schemaCheck=input.successorSource.slice(input.successorSource.indexOf('DO $before_installer$'),input.successorSource.indexOf('CREATE FUNCTION pg_temp.publication_successors_after_install()'))
schemaCheck=schemaCheck.replaceAll(' PERFORM pg_temp.publication_assert_expected_functions();','')
const auth=`-- Source-bound complete post8272 authentication, before conversion enrollment.
${input.authenticationPreamble}
CREATE TEMP TABLE publication_predecessor_table_snapshot(snapshot jsonb NOT NULL) ON COMMIT DROP;
INSERT INTO publication_predecessor_table_snapshot SELECT pg_temp.publication_json(${literal(JSON.stringify(oldTables))}::jsonb);
CREATE TEMP TABLE publication_before_installer_schema(snapshot jsonb NOT NULL) ON COMMIT DROP;
${references}
CREATE FUNCTION pg_temp.publication_table_snapshot() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $snapshot$
${newTableExpression}
$snapshot$;
${schemaCheck}
DO $conversion_publication_target$ BEGIN
 IF (SELECT to_jsonb(t) FROM public.crm_erasure_journal_targets t WHERE table_name='native_conversation_publications')
 IS DISTINCT FROM jsonb_build_object('table_name','native_conversation_publications','key_columns',ARRAY['id']::text[],'capture_inserts',false)
 THEN RAISE EXCEPTION 'conversion_publication_recovery_target_changed';END IF;
END $conversion_publication_target$;
CREATE FUNCTION pg_temp.conversion_predecessor_body(routine text,parts jsonb) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $render$
DECLARE part jsonb;next_parts jsonb:='[]';tables jsonb;
BEGIN
 FOR part IN SELECT value FROM jsonb_array_elements(parts) LOOP
  IF part#>>'{slot,kind}'='conversionVerifiedPublicationTables' THEN
   SELECT snapshot INTO STRICT tables FROM publication_before_installer_schema;
   part:=to_jsonb(quote_literal(tables::text));
  END IF;
  next_parts:=next_parts||jsonb_build_array(part);
 END LOOP;
 RETURN pg_temp.publication_source_body(routine,next_parts,true);
END $render$;
DO $conversion_authenticate_poststate$
DECLARE expected jsonb;actual pg_proc;reference pg_proc;spec jsonb;body text;declaration text;part record;acl jsonb;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);runtime_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');expected_metadata jsonb;
BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements(${literal(JSON.stringify(contracts))}::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  IF actual.oid IS NULL OR actual.proowner<>owner_id THEN RAISE EXCEPTION 'conversion_predecessor_missing: %',expected->>'signature';END IF;
  body:=pg_temp.conversion_predecessor_body(expected->>'signature',expected->'bodyParts');
  spec:=expected->'sourceSpec';
  IF spec IS NOT NULL THEN
   SELECT coalesce(string_agg(format('%I %s',n.value,t.value)||CASE WHEN spec->>'signature'='read_native_conversation_publications(uuid,uuid,jsonb,integer)' AND t.ordinal=3 THEN ' DEFAULT NULL::jsonb' WHEN spec->>'signature'='read_native_conversation_publications(uuid,uuid,jsonb,integer)' AND t.ordinal=4 THEN ' DEFAULT 20' ELSE '' END,',' ORDER BY t.ordinal),'') INTO declaration
   FROM jsonb_array_elements_text(spec->'argTypes') WITH ORDINALITY t(value,ordinal) JOIN jsonb_array_elements_text(spec->'argNames') WITH ORDINALITY n(value,ordinal) USING(ordinal);
   EXECUTE format('CREATE FUNCTION pg_temp.conversion_function_reference(%s) RETURNS %s LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp %s AS %L',declaration,spec->>'returnType',CASE WHEN spec->>'name'='publish_native_session_message_batch' THEN 'SET plan_cache_mode=force_generic_plan' ELSE '' END,body);
   SELECT * INTO STRICT reference FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname='conversion_function_reference';
   expected_metadata:=to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proowner','proacl','prosrc'];
   expected_metadata:=expected_metadata||jsonb_build_object('proname',spec->>'name','pronamespace','public'::regnamespace::oid,'proowner',owner_id);
   EXECUTE format('DROP FUNCTION pg_temp.conversion_function_reference(%s)',(SELECT coalesce(string_agg(value,',' ORDER BY ordinal),'') FROM jsonb_array_elements_text(spec->'argTypes') WITH ORDINALITY t(value,ordinal)));
  ELSE expected_metadata:=pg_temp.publication_json(expected->'metadata');END IF;
  IF (actual.prosrc COLLATE "C") IS DISTINCT FROM (body COLLATE "C")
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proacl']) IS DISTINCT FROM expected_metadata
  THEN RAISE EXCEPTION 'conversion_predecessor_changed: %',expected->>'signature';END IF;
  SELECT jsonb_agg(jsonb_build_object('grantee',grantee,'grantor',grantor,'privilege',privilege,'grantable',grantable) ORDER BY grantee COLLATE "C") INTO acl
  FROM(SELECT CASE WHEN a.grantee=owner_id THEN 'OWNER' WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=runtime_id THEN 'app_user' ELSE 'UNREVIEWED_OID:'||a.grantee::text END grantee,
   CASE WHEN a.grantor=owner_id THEN 'OWNER' ELSE 'UNREVIEWED_OID:'||a.grantor::text END grantor,a.privilege_type privilege,a.is_grantable grantable
   FROM aclexplode(coalesce(actual.proacl,acldefault('f',owner_id))) a) grants;
  IF acl IS DISTINCT FROM expected->'acl' THEN RAISE EXCEPTION 'conversion_predecessor_acl_changed: %',expected->>'signature';END IF;
  INSERT INTO publication_expected_current VALUES(expected->>'signature',to_jsonb(actual)) ON CONFLICT(signature) DO UPDATE SET metadata=EXCLUDED.metadata;
  INSERT INTO publication_successor_templates VALUES(expected->>'signature',expected->'bodyParts') ON CONFLICT(signature) DO UPDATE SET parts=EXCLUDED.parts;
 END LOOP;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_publication_contract() IS NOT TRUE OR native_retained_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversion_predecessor_contract_changed';END IF;
END $conversion_authenticate_poststate$;
`
const moduleSource=await readFile(join(root,'scripts/conversation-store/conversion.sql'),'utf8')
const install=args.includes('--authentication-only')?'':await conversionInstall(input,moduleSource,directory)
let migration=`-- [COMP:api/native-turn-frame] Authenticated historical requirement conversion.\n-- Generated from immutable8272 ${pinned}; no reader activation.\nBEGIN;\n${auth}\n${install}\n${install?'COMMIT':'ROLLBACK'};\n`
migration=versionCompilerFunctions(migration,{full:!!install,runtimeBodies:[moduleSource,...manifest.contracts.flatMap(contract=>contract.bodyParts.filter(part=>typeof part==='string')),...sourceSpecs.map(spec=>spec.body)]})
if(args.includes('--check')){if(await readFile(output,'utf8')!==migration)throw Error('conversion_generated_migration_changed')}else await writeFile(output,migration)
if(args.includes('--receipt'))await writeFile(output+'.source.json',JSON.stringify({predecessor,pinned,compilerSourceSha:input.sourceSha,contracts:contracts.length,phase:install?'conversion-installation-candidate':'predecessor-authentication-only',authenticationSha:sha(auth)},null,2)+'\n')
