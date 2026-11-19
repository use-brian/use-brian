// [COMP:api/configured-capture-authority] Authenticated configured-task COMMIT successor (8296).
// Authenticate the complete frozen 8290/8294 installation before any mutation,
// authenticate ordinary 8051/770 predecessors, install four private source-known
// helpers, enroll only those helpers, propagate the closed guard roster and pins,
// then verify complete source/schema metadata and refresh the protected witness.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8294.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'
import {executableProjection} from './executable-record.mjs'
import {configuredSignatures,configuredSourceSql,configuredRendererSql,configuredAuthenticationSql,
 configuredReferenceCleanup,configuredSchemaAuthenticationSql,configuredSchemaCleanup,configuredEnrollSql} from './configured-task-publication.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
const target='8296_configured_task_publication.sql',prefix='a8294_'
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/'+target))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const pinned={
 'scripts/conversation-store/installation-authentication-8294.mjs':'a7edd5e1084d4261ab20c638f0c69ea6c61d5150b71c2de8fda72c09304f025e',
 'scripts/conversation-store/conversion-install.mjs':'29f1606b2a882b93c3bdd75a102e1b1d821277cecbdddc742aaad4bea84ad2a8',
 'scripts/conversation-store/conversion-original-consumers.sql':'1fdca4e0e240c866519211e583f9ba93b67a7896c20766f4b80fe1ac0b842e26',
 'scripts/conversation-store/registry-guard-successor.mjs':'2c7ff5d6d619a42cce742c10611726e7c679a486e18bd872fee3df468529c61e',
 'scripts/conversation-store/configured-task-publication.mjs':'fa295bc4344f1c8676beba02eb253debaaa6274ed245139af706cc1734dc51bc',
 'scripts/conversation-store/configured-task-publication.sql':'3d7a895bf4b5eaa75ebb619996f5873b15d6e05a7bc1533e39b2d413be42e851',
 'migrations/8295_conversation_envelope_foundation.sql':'6b3a12c236cf24cbafad9d467a9918a10ffba717faeabd68f866262dc5b6b975',
}
for(const[path,digest]of Object.entries(pinned))if(sha(await readFile(root+path))!==digest)throw Error('configured_task_source_input_changed: '+path)
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const prerequisites=`DO $configured_task_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'configured_task_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8295_conversation_envelope_foundation.sql') THEN RAISE EXCEPTION 'configured_task_predecessor_missing';END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY[${configuredSignatures.map(s=>lit('public.'+s)).join(',')}]::text[]) s WHERE to_regprocedure(s) IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.native_turn_contract_helpers WHERE signature=ANY(ARRAY[${configuredSignatures.map(lit).join(',')}]::text[]))
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.episode_extraction_items'::regclass AND attname LIKE 'configured_%' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'configured_task_successor_already_installed';END IF;
END $configured_task_prerequisites$;`
const inventory=`DO $configured_task_registry_consumers$ DECLARE unknown text;BEGIN
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
 AND p.prosrc ~* '\\m(native_turn_contract_helpers|native_turn_contract_witness)\\M'
 AND p.oid NOT IN('public.native_turn_helpers_current()'::regprocedure,'public.native_turn_contract_witness_refresh()'::regprocedure) LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'configured_task_unreviewed_registry_consumer: %',unknown;END IF;
END $configured_task_registry_consumers$;`
let original=await readFile(root+'scripts/conversation-store/conversion-original-consumers.sql','utf8')
original=original.replaceAll('publication_expected_current',prefix+'publication_expected_current').replaceAll('publication_successor_templates',prefix+'publication_successor_templates').replaceAll('conversion_affected_functions','c8296_affected_functions').replaceAll('$conversion_original_consumers$','$configured_task_original_consumers$')
const renderer=configuredRendererSql('c8296_source_body',prefix+'conversion_source_body')
const installer=await readFile(root+'scripts/conversation-store/conversion-install.mjs','utf8')
let propagation=installer.slice(installer.indexOf('DO $conversion_propagate$'),installer.indexOf('END $conversion_propagate$;')+'END $conversion_propagate$;'.length)
if(!propagation.startsWith('DO $conversion_propagate$'))throw Error('configured_task_propagation_source_changed')
propagation=propagation.replaceAll('publication_expected_current',prefix+'publication_expected_current').replaceAll('publication_successor_templates',prefix+'publication_successor_templates').replaceAll('pg_temp.conversion_source_body','pg_temp.c8296_source_body').replaceAll('$conversion_propagate$','$configured_task_propagate$')
if(propagation.split('SET contract=after_row').length!==2||propagation.split('p IS DISTINCT FROM h.contract').length!==2)throw Error('configured_task_propagation_comparison_changed')
propagation=propagation.replace('SET contract=after_row',()=>`SET contract=${executableProjection('after_row')}`).replace('p IS DISTINCT FROM h.contract',()=>executableProjection('p')+' IS DISTINCT FROM h.contract')
const record=`DO $configured_task_record$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'configured_task_witness_record_failed';END IF;
 IF (SELECT count(*) FROM public.native_turn_contract_witness)<>1 THEN RAISE EXCEPTION 'configured_task_witness_record_failed';END IF;
END $configured_task_record$;
${witnessRelationCheckSql('c8296_')}`
const sql=`-- [COMP:api/configured-capture-authority] Transaction-bound configured task publication through fresh COMMIT.
-- Applied predecessors are immutable; complete source authentication precedes every mutation.
BEGIN;
${prerequisites}
${source.sql}
${inventory}
${configuredAuthenticationSql('c8296_pre_', {predecessor:true})}
${original}
${configuredSourceSql}
${configuredAuthenticationSql('c8296_installed_', {registry:false})}
${configuredSchemaAuthenticationSql('c8296_installed_')}
${configuredEnrollSql}
${renderer}
${propagation}
${configuredAuthenticationSql('c8296_enrolled_')}
${record}
${source.cleanup}
${configuredReferenceCleanup('c8296_pre_', {predecessor:true})}
${configuredReferenceCleanup('c8296_installed_')}
${configuredSchemaCleanup('c8296_installed_')}
${configuredReferenceCleanup('c8296_enrolled_')}
DROP FUNCTION pg_temp.c8296_source_body(text,jsonb,boolean);
COMMIT;
`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const current=await readFile(root+'migrations/'+target,'utf8');if(!current.startsWith('-- [COMP:api/configured-capture-authority] Transaction-bound configured task publication'))throw Error('configured_task_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
if(!existing&&(numbered.includes(8296)||!numbered.includes(8295)))throw Error('configured_task_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('configured_task_generated_migration_changed');console.log('Configured task publication source matches')}else{await writeFile(output,sql);console.log('wrote',output,sql.length)}
