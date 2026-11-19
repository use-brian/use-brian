// [COMP:api/native-turn-frame] Durable completion header for every lane (8277).
// Authenticates the complete installed 8276 closure from source (311 functions and
// the witness), creates the per-turn completion header and its four members,
// enrolls them, re-renders the guard roster and the expired-turn classifier
// through the reviewed propagation, and ends with the owner-only witness refresh.
// Applied SQL is immutable; this writes only the new forward migration.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8276.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'
import {completionSql,completionSignatures,completionEnrollSql,completionRendererSql,completionAuthenticationSql,completionReferenceCleanup,outcomeSignature} from './turn-completion.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
const target='8277_durable_turn_completions.sql'
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/'+target))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const pinned={
 'scripts/conversation-store/installation-authentication-8276.mjs':'7df592e19728ba99b5db47ca2ade2f296f4639b4c23403ccb2e3e0ac238d19b4',
 'scripts/conversation-store/conversion-install.mjs':'29f1606b2a882b93c3bdd75a102e1b1d821277cecbdddc742aaad4bea84ad2a8',
 'scripts/conversation-store/conversion-original-consumers.sql':'1fdca4e0e240c866519211e583f9ba93b67a7896c20766f4b80fe1ac0b842e26',
 'scripts/conversation-store/registry-guard-successor.mjs':'2c7ff5d6d619a42cce742c10611726e7c679a486e18bd872fee3df468529c61e',
 'migrations/8276_registry_guard_successor.sql':'e3fa2d4c7c7b5d2079d88dd48dc6a6d6f8e200bb961e912020bebeb381cb1849',
}
for(const[path,digest]of Object.entries(pinned))if(sha(await readFile(root+path))!==digest)throw Error('completion_source_input_changed: '+path)
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const prerequisites=`DO $completion_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'completion_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8276_registry_guard_successor.sql') THEN RAISE EXCEPTION 'completion_predecessor_missing';END IF;
 IF to_regclass('public.native_turn_completions') IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(${'ARRAY['+completionSignatures.map(s=>lit('public.'+s)).join(',')+']'}::text[]) s WHERE to_regprocedure(s) IS NOT NULL)
  OR EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=ANY(${'ARRAY['+completionSignatures.map(lit).join(',')+']'}::text[]))
 THEN RAISE EXCEPTION 'completion_successor_already_installed';END IF;
END $completion_prerequisites$;`
// Only the guard and the witness refresh may read the registry or the witness.
const inventory=`DO $completion_registry_consumers$ DECLARE unknown text;BEGIN
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
 AND p.prosrc ~* '\\m(native_turn_contract_helpers|native_turn_contract_witness|native_turn_completions)\\M'
 AND p.oid NOT IN('public.native_turn_helpers_current()'::regprocedure,'public.native_turn_contract_witness_refresh()'::regprocedure) LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'completion_unreviewed_registry_consumer: %',unknown;END IF;
END $completion_registry_consumers$;`
// Classify every original pin consumer of the two re-rendered members (and the
// contracts that pin them) before anything changes; unknown consumers refuse.
let original=await readFile(root+'scripts/conversation-store/conversion-original-consumers.sql','utf8')
const affected="WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');"
if(original.split(affected).length!==2)throw Error('completion_original_consumer_source_changed')
original=original.replace(affected,`WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()',${lit(outcomeSignature)});`)
original=original.replaceAll('publication_expected_current','a8276_publication_expected_current').replaceAll('publication_successor_templates','a8276_publication_successor_templates').replaceAll('conversion_affected_functions','c8277_affected_functions').replaceAll('$conversion_original_consumers$','$completion_original_consumers$')
const renderer=completionRendererSql('c8277_source_body','a8276_conversion_source_body')
const installer=await readFile(root+'scripts/conversation-store/conversion-install.mjs','utf8')
let propagation=installer.slice(installer.indexOf('DO $conversion_propagate$'),installer.indexOf('END $conversion_propagate$;')+'END $conversion_propagate$;'.length)
if(!propagation.startsWith('DO $conversion_propagate$'))throw Error('completion_propagation_source_changed')
propagation=propagation.replaceAll('publication_expected_current','a8276_publication_expected_current').replaceAll('publication_successor_templates','a8276_publication_successor_templates').replaceAll('pg_temp.conversion_source_body','pg_temp.c8277_source_body').replaceAll('$conversion_propagate$','$completion_propagate$')
// The 8274 typed registry record replaces the raw pg_proc comparisons (as 8276).
const {executableProjection}=await import('./executable-record.mjs')
if(propagation.split('SET contract=after_row').length!==2||propagation.split('p IS DISTINCT FROM h.contract').length!==2)throw Error('completion_propagation_comparison_changed')
propagation=propagation.replace('SET contract=after_row',()=>`SET contract=${executableProjection('after_row')}`).replace('p IS DISTINCT FROM h.contract',()=>executableProjection('p')+' IS DISTINCT FROM h.contract')
// Both re-rendered members must actually have changed exactly as the source says.
const rendered=`DO $completion_rendered$ BEGIN
 IF (SELECT prosrc FROM pg_proc WHERE oid=${lit('public.'+outcomeSignature)}::regprocedure) IS DISTINCT FROM pg_temp.c8277_source_body(${lit(outcomeSignature)},(SELECT parts FROM pg_temp.a8276_publication_successor_templates WHERE signature=${lit(outcomeSignature)}),true)
  OR strpos((SELECT prosrc FROM pg_proc WHERE oid='public.native_turn_helpers_current()'::regprocedure),${lit("'"+completionSignatures[1].replaceAll("'","''")+"'")})=0
 THEN RAISE EXCEPTION 'completion_rerender_missing';END IF;
END $completion_rendered$;`
const record=`DO $completion_record$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'completion_witness_record_failed';END IF;
 IF (SELECT count(*) FROM public.native_turn_contract_witness)<>1 THEN RAISE EXCEPTION 'completion_witness_record_failed';END IF;
END $completion_record$;
${witnessRelationCheckSql('c8277_')}`
const sql=`-- [COMP:api/native-turn-frame] Durable completion header for every owned turn and lane.
-- Applied 8269-8276 are immutable; complete source predecessor verification precedes every mutation.
BEGIN;
${prerequisites}
${source.sql}
${inventory}
${original}
${completionSql}
${completionEnrollSql}
${renderer}
${propagation}
${rendered}
${completionAuthenticationSql('c8277_')}
${record}
${source.cleanup}
${completionReferenceCleanup('c8277_')}
DROP FUNCTION pg_temp.c8277_source_body(text,jsonb,boolean);
COMMIT;
`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const current=await readFile(root+'migrations/'+target,'utf8');if(!current.startsWith('-- [COMP:api/native-turn-frame] Durable completion header'))throw Error('completion_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
if(!existing&&Math.max(...numbered)!==8276)throw Error('completion_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('completion_generated_migration_changed');console.log('Durable completion header source matches')}else{await writeFile(output,sql);console.log('wrote',output,sql.length)}
