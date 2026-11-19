// [COMP:api/native-turn-frame] Source-authenticated, single-registry forward representation.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource} from './installation-authentication-8273.mjs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {executableRecordSql,convertCanonicalRegistrySql,executableRecordShapeSql,executableProjection} from './executable-record.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/8274_inputtable_executable_contracts.sql'))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
if(sha(await readFile(root+'scripts/conversation-store/installation-authentication-8273.mjs'))!=='244efe86dad38d3d2e1e9fa89c3cfa91b4cfe5b85f1cba3e9fb7af23fb6be447')throw Error('executable_predecessor_auth_source_changed')
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
let original=await readFile(root+'scripts/conversation-store/conversion-original-consumers.sql','utf8')
original=original.replaceAll('publication_expected_current','a8273_publication_expected_current').replaceAll('publication_successor_templates','a8273_publication_successor_templates').replaceAll('conversion_affected_functions','c8274_affected_functions')
const projection=executableProjection('p'),rootPrefix='BEGIN\n IF '+executableRecordShapeSql+' IS NOT TRUE THEN RETURN false;END IF;\n RETURN (',rootSuffix=');\nEND'
// The sole runtime comparator is replaced in its source-owned template, never in
// an unverified actual body. All remaining hash slots keep the original renderer.
const renderer=`CREATE FUNCTION pg_temp.c8274_source_body(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $render$
DECLARE body text;BEGIN
 body:=pg_temp.a8273_conversion_source_body(routine,parts,successor);
 IF routine='native_turn_helpers_current()' THEN
  IF(length(body)-length(replace(body,'p IS NOT DISTINCT FROM h.contract','')))/length('p IS NOT DISTINCT FROM h.contract')<>1 THEN RAISE EXCEPTION 'executable_root_comparison_source_changed';END IF;
  body:=${lit(rootPrefix)}||replace(body,'p IS NOT DISTINCT FROM h.contract',${lit(projection+' IS NOT DISTINCT FROM h.contract')})||${lit(rootSuffix)};
 END IF;
 RETURN body;
END $render$;`
const alterRoot=`DO $executable_root$
DECLARE parts jsonb;body text;expected jsonb;reference pg_proc;actual pg_proc;next_expected jsonb;
BEGIN
 SELECT t.parts INTO STRICT parts FROM pg_temp.a8273_publication_successor_templates t WHERE signature='native_turn_helpers_current()';
 body:=pg_temp.c8274_source_body('native_turn_helpers_current()',parts,true);
 SELECT metadata INTO STRICT expected FROM pg_temp.a8273_publication_expected_current WHERE signature='native_turn_helpers_current()';
 EXECUTE format('CREATE FUNCTION pg_temp.c8274_root_reference() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',body);
 SELECT * INTO STRICT reference FROM pg_proc WHERE oid='pg_temp.c8274_root_reference()'::regprocedure;
 next_expected:=(to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proowner','proacl'])||(SELECT jsonb_object_agg(key,value) FROM jsonb_each(expected) WHERE key=ANY(ARRAY['oid','proname','pronamespace','proowner','proacl']));
 EXECUTE format('CREATE OR REPLACE FUNCTION public.native_turn_helpers_current() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',body);
 SELECT * INTO STRICT actual FROM pg_proc WHERE oid='public.native_turn_helpers_current()'::regprocedure;
 IF to_jsonb(actual) IS DISTINCT FROM next_expected THEN RAISE EXCEPTION 'executable_new_root_source_mismatch';END IF;
 IF NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature='native_turn_helpers_current()' AND to_jsonb(h.contract)=expected) THEN RAISE EXCEPTION 'executable_original_registry_changed';END IF;
 UPDATE native_turn_contract_helpers SET contract=${executableProjection('actual')} WHERE signature='native_turn_helpers_current()';
 UPDATE native_retained_contract_helpers SET fingerprint=encode(sha256(convert_to(next_expected::text,'UTF8')),'hex') WHERE signature='native_turn_helpers_current()' AND fingerprint=encode(sha256(convert_to(expected::text,'UTF8')),'hex');
 UPDATE pg_temp.a8273_publication_expected_current SET metadata=next_expected WHERE signature='native_turn_helpers_current()';
END $executable_root$;`
let installer=await readFile(root+'scripts/conversation-store/conversion-install.mjs','utf8')
if(sha(installer)!=='29f1606b2a882b93c3bdd75a102e1b1d821277cecbdddc742aaad4bea84ad2a8')throw Error('executable_propagation_source_changed')
let propagation=installer.slice(installer.indexOf('DO $conversion_propagate$'),installer.indexOf('END $conversion_propagate$;')+'END $conversion_propagate$;'.length)
if(!propagation.startsWith('DO $conversion_propagate$'))throw Error('executable_propagation_source_changed')
propagation=propagation.replaceAll('publication_expected_current','a8273_publication_expected_current').replaceAll('publication_successor_templates','a8273_publication_successor_templates').replaceAll('pg_temp.conversion_source_body','pg_temp.c8274_source_body')
if(propagation.split('SET contract=after_row').length!==2||propagation.split('p IS DISTINCT FROM h.contract').length!==2)throw Error('executable_propagation_comparison_changed')
propagation=propagation.replace('SET contract=after_row',()=>`SET contract=${executableProjection('after_row')}`).replace('p IS DISTINCT FROM h.contract',()=>projection+' IS DISTINCT FROM h.contract')
const inventory=`DO $executable_original_consumers$ DECLARE unknown text;relation oid:='public.native_turn_contract_helpers'::regclass;row_type oid;array_type oid;BEGIN
 SELECT reltype INTO STRICT row_type FROM pg_class WHERE oid=relation;SELECT typarray INTO STRICT array_type FROM pg_type WHERE oid=row_type;
 -- Every allowed dependent below belongs to the independently source-verified
 -- registry schema. Nothing else may acquire a dependency on its relation or
 -- row/array types, regardless of expression language or executable namespace.
 SELECT pg_describe_object(d.classid,d.objid,d.objsubid) INTO unknown FROM pg_depend d
 WHERE ((d.refclassid='pg_class'::regclass AND d.refobjid=relation)
 OR(d.refclassid='pg_type'::regclass AND d.refobjid IN(row_type,array_type)))
 AND NOT(
  d.classid='pg_type'::regclass AND d.objsubid=0 AND d.objid IN(row_type,array_type) AND d.deptype='i'
  OR d.classid='pg_constraint'::regclass AND d.objsubid=0 AND d.objid IN(SELECT oid FROM pg_constraint WHERE conrelid=relation AND(conname='native_turn_contract_helpers_pkey' AND contype='p' OR conname IN('native_turn_contract_helpers_signature_not_null','native_turn_contract_helpers_contract_not_null') AND contype='n')) AND d.deptype='a'
  OR d.classid='pg_class'::regclass AND d.objsubid=0 AND d.objid='public.native_turn_contract_helpers_pkey'::regclass AND d.deptype='a'
  OR d.classid='pg_class'::regclass AND d.objsubid=0 AND d.objid=(SELECT reltoastrelid FROM pg_class WHERE oid=relation) AND d.deptype='i'
  OR d.classid='pg_trigger'::regclass AND d.objsubid=0 AND d.objid=(SELECT oid FROM pg_trigger WHERE tgrelid=relation AND tgname='crm_recovery_capture' AND NOT tgisinternal) AND d.deptype='a') LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'executable_unreviewed_registry_dependency: %',unknown;END IF;
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
 AND p.prosrc ~* '\\mnative_turn_contract_helpers\\M' AND p.oid<>'public.native_turn_helpers_current()'::regprocedure LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'executable_unreviewed_registry_consumer: %',unknown;END IF;
 IF to_regtype('public.native_executable_contract_v1') IS NOT NULL THEN RAISE EXCEPTION 'executable_target_type_already_exists';END IF;
END $executable_original_consumers$;`
// Source guard execution is deferred until every source-derived body pin and
// its exact typed registry record has been propagated atomically.
const sql=`-- [COMP:api/native-turn-frame] Authenticated inputtable executable contracts.\n-- Applied8272/8273 are immutable; complete source predecessor verification precedes every mutation.\nBEGIN;\n${source.sql}\n${inventory}\n${original}\n${executableRecordSql}\n${convertCanonicalRegistrySql}\n${renderer}\n${alterRoot}\n${propagation}\n${source.cleanup}\nDROP FUNCTION pg_temp.c8274_root_reference();\nDROP FUNCTION pg_temp.c8274_source_body(text,jsonb,boolean);\nCOMMIT;\n`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const target=await readFile(root+'migrations/8274_inputtable_executable_contracts.sql','utf8');if(!target.startsWith('-- [COMP:api/native-turn-frame] Authenticated inputtable executable contracts.'))throw Error('executable_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
if(!existing&&Math.max(...numbered)!==8273)throw Error('executable_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('executable_generated_migration_changed');console.log('Executable registry source matches')}else await writeFile(output,sql)
