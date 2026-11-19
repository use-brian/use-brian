// [COMP:api/native-turn-frame] Registry guard successor: tuple-version witness and enrollment.
// Authenticates the complete installed 8274 closure plus the 8275 joint owner from
// source, then replaces only the guard body (fast path + extended roster), enrolls
// the joint owner and the owner-only witness refresh, propagates reviewed pins and
// records the witness from a passing full comparison. Applied SQL is immutable.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8274.mjs'
import {executableProjection} from './executable-record.mjs'
import {witnessTableSql,refreshDeclaration,refreshBody,guardRendererSql,enrolledAuthenticationSql,enrolledSignatures,witnessRelationCheckSql} from './registry-guard-successor.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
const target='8276_registry_guard_successor.sql'
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/'+target))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const pinned={
 'scripts/conversation-store/installation-authentication-8274.mjs':'3eafc55a2487af0ac3ac04310bfd51063adda2ed8c77bc81e26f847a3b1df5c3',
 'scripts/conversation-store/conversion-install.mjs':'29f1606b2a882b93c3bdd75a102e1b1d821277cecbdddc742aaad4bea84ad2a8',
 'scripts/conversation-store/conversion-original-consumers.sql':'1fdca4e0e240c866519211e583f9ba93b67a7896c20766f4b80fe1ac0b842e26',
 'migrations/8275_joint_native_preparation_acquisition.sql':'df072f7844d6f3b295e02b781838b34662c60e6e6633fa073a5ecf9708d9a53e',
}
for(const[path,digest]of Object.entries(pinned))if(sha(await readFile(root+path))!==digest)throw Error('witness_source_input_changed: '+path)
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const preparationSource=await readFile(root+'migrations/8275_joint_native_preparation_acquisition.sql','utf8')
const preparationStart=preparationSource.indexOf('CREATE FUNCTION public.capture_conversation_preparation(')
const preparationEnd=preparationSource.indexOf('END $function$;',preparationStart)+'END $function$;'.length
if(preparationStart<0||preparationEnd<preparationStart)throw Error('witness_preparation_source_changed')
const preparationCreate=preparationSource.slice(preparationStart,preparationEnd)
const prerequisites=`DO $witness_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'witness_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8275_joint_native_preparation_acquisition.sql') THEN RAISE EXCEPTION 'witness_predecessor_missing';END IF;
END $witness_prerequisites$;`
// Only the guard may read the registry, and only reviewed schema objects may
// depend on it; the new refresh is created after this inventory.
const inventory=`DO $witness_registry_consumers$ DECLARE unknown text;relation oid:='public.native_turn_contract_helpers'::regclass;row_type oid;array_type oid;BEGIN
 SELECT reltype INTO STRICT row_type FROM pg_class WHERE oid=relation;SELECT typarray INTO STRICT array_type FROM pg_type WHERE oid=row_type;
 SELECT pg_describe_object(d.classid,d.objid,d.objsubid) INTO unknown FROM pg_depend d
 WHERE ((d.refclassid='pg_class'::regclass AND d.refobjid=relation) OR(d.refclassid='pg_type'::regclass AND d.refobjid IN(row_type,array_type)))
 AND NOT(
  d.classid='pg_type'::regclass AND d.objsubid=0 AND d.objid IN(row_type,array_type) AND d.deptype='i'
  OR d.classid='pg_constraint'::regclass AND d.objsubid=0 AND d.objid IN(SELECT oid FROM pg_constraint WHERE conrelid=relation AND(conname='native_turn_contract_helpers_pkey' AND contype='p' OR conname IN('native_turn_contract_helpers_signature_not_null','native_turn_contract_helpers_contract_not_null') AND contype='n')) AND d.deptype='a'
  OR d.classid='pg_class'::regclass AND d.objsubid=0 AND d.objid='public.native_turn_contract_helpers_pkey'::regclass AND d.deptype='a'
  OR d.classid='pg_class'::regclass AND d.objsubid=0 AND d.objid=(SELECT reltoastrelid FROM pg_class WHERE oid=relation) AND d.deptype='i'
  OR d.classid='pg_trigger'::regclass AND d.objsubid=0 AND d.objid=(SELECT oid FROM pg_trigger WHERE tgrelid=relation AND tgname='crm_recovery_capture' AND NOT tgisinternal) AND d.deptype='a') LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'witness_unreviewed_registry_dependency: %',unknown;END IF;
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
 AND p.prosrc ~* '\\m(native_turn_contract_helpers|native_turn_contract_witness)\\M' AND p.oid<>'public.native_turn_helpers_current()'::regprocedure LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'witness_unreviewed_registry_consumer: %',unknown;END IF;
END $witness_registry_consumers$;`
let original=await readFile(root+'scripts/conversation-store/conversion-original-consumers.sql','utf8')
original=original.replaceAll('publication_expected_current','a8274_publication_expected_current').replaceAll('publication_successor_templates','a8274_publication_successor_templates').replaceAll('conversion_affected_functions','c8276_affected_functions').replaceAll('$conversion_original_consumers$','$witness_original_consumers$')
// New members: exact source definitions, owner/app ACLs, then registry rows.
const enroll=`${witnessTableSql}
${refreshDeclaration(refreshBody)}
DO $witness_enroll$ DECLARE p pg_proc;signature text;BEGIN
 FOREACH signature IN ARRAY ${'ARRAY['+enrolledSignatures.map(lit).join(',')+']'} LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure('public.'||signature);
  INSERT INTO native_turn_contract_helpers VALUES(signature,${executableProjection('p')});
 END LOOP;
END $witness_enroll$;`
const renderer=guardRendererSql('c8276_source_body','a8274_conversion_source_body')
const alterRoot=`DO $witness_root$
DECLARE parts jsonb;body text;expected jsonb;reference pg_proc;actual pg_proc;next_expected jsonb;
BEGIN
 SELECT t.parts INTO STRICT parts FROM pg_temp.a8274_publication_successor_templates t WHERE signature='native_turn_helpers_current()';
 body:=pg_temp.c8276_source_body('native_turn_helpers_current()',parts,true);
 SELECT metadata INTO STRICT expected FROM pg_temp.a8274_publication_expected_current WHERE signature='native_turn_helpers_current()';
 EXECUTE format('CREATE FUNCTION pg_temp.c8276_root_reference() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',body);
 SELECT * INTO STRICT reference FROM pg_proc WHERE oid='pg_temp.c8276_root_reference()'::regprocedure;
 next_expected:=(to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proowner','proacl'])||(SELECT jsonb_object_agg(key,value) FROM jsonb_each(expected) WHERE key=ANY(ARRAY['oid','proname','pronamespace','proowner','proacl']));
 IF NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature='native_turn_helpers_current()' AND to_jsonb(h.contract)=expected) THEN RAISE EXCEPTION 'witness_original_registry_changed';END IF;
 EXECUTE format('CREATE OR REPLACE FUNCTION public.native_turn_helpers_current() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',body);
 SELECT * INTO STRICT actual FROM pg_proc WHERE oid='public.native_turn_helpers_current()'::regprocedure;
 IF to_jsonb(actual) IS DISTINCT FROM next_expected THEN RAISE EXCEPTION 'witness_new_root_source_mismatch';END IF;
 UPDATE native_turn_contract_helpers SET contract=${executableProjection('actual')} WHERE signature='native_turn_helpers_current()';
 UPDATE native_retained_contract_helpers SET fingerprint=encode(sha256(convert_to(next_expected::text,'UTF8')),'hex') WHERE signature='native_turn_helpers_current()' AND fingerprint=encode(sha256(convert_to(expected::text,'UTF8')),'hex');
 UPDATE pg_temp.a8274_publication_expected_current SET metadata=next_expected WHERE signature='native_turn_helpers_current()';
END $witness_root$;`
const installer=await readFile(root+'scripts/conversation-store/conversion-install.mjs','utf8')
let propagation=installer.slice(installer.indexOf('DO $conversion_propagate$'),installer.indexOf('END $conversion_propagate$;')+'END $conversion_propagate$;'.length)
if(!propagation.startsWith('DO $conversion_propagate$'))throw Error('witness_propagation_source_changed')
propagation=propagation.replaceAll('publication_expected_current','a8274_publication_expected_current').replaceAll('publication_successor_templates','a8274_publication_successor_templates').replaceAll('pg_temp.conversion_source_body','pg_temp.c8276_source_body').replaceAll('$conversion_propagate$','$witness_propagate$')
if(propagation.split('SET contract=after_row').length!==2||propagation.split('p IS DISTINCT FROM h.contract').length!==2)throw Error('witness_propagation_comparison_changed')
propagation=propagation.replace('SET contract=after_row',()=>`SET contract=${executableProjection('after_row')}`).replace('p IS DISTINCT FROM h.contract',()=>executableProjection('p')+' IS DISTINCT FROM h.contract')
// The first refresh runs the full comparator (no witness yet) in its own snapshot.
const record=`DO $witness_record$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'witness_record_failed';END IF;
 IF (SELECT count(*) FROM public.native_turn_contract_witness)<>1 THEN RAISE EXCEPTION 'witness_record_failed';END IF;
END $witness_record$;
${witnessRelationCheckSql('c8276_')}`
const sql=`-- [COMP:api/native-turn-frame] Registry guard successor: tuple-version witness and enrollment.
-- Applied 8269-8275 are immutable; complete source predecessor verification precedes every mutation.
BEGIN;
${prerequisites}
${source.sql}
${enrolledAuthenticationSql({prefix:'c8276_',preparationCreate,predecessor:true})}
${inventory}
${original}
${enroll}
${renderer}
${alterRoot}
${propagation}
${record}
${source.cleanup}
DROP FUNCTION pg_temp.c8276_root_reference();
DROP FUNCTION pg_temp.c8276_source_body(text,jsonb,boolean);
DROP FUNCTION pg_temp.c8276_preparation_reference(uuid,jsonb,jsonb,jsonb);
COMMIT;
`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const current=await readFile(root+'migrations/'+target,'utf8');if(!current.startsWith('-- [COMP:api/native-turn-frame] Registry guard successor'))throw Error('witness_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
if(!existing&&Math.max(...numbered)!==8275)throw Error('witness_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('witness_generated_migration_changed');console.log('Registry guard successor source matches')}else{await writeFile(output,sql);console.log('wrote',output,sql.length)}
