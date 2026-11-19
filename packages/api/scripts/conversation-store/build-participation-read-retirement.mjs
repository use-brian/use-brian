// [COMP:api/task-mutation-scope] Project participation retirement and unmovable-child successor (8290).
// Authenticates the complete installed 8289 closure from source (392 functions and
// the witness), refuses unless the two registry members are the exact 631 reader
// body and the three ordinary functions are their exact declared bodies, replaces the
// ordinary bodies in place, replaces both member bodies through the reviewed
// propagation (their registry records and every consumer pin follow from the
// renderer), verifies the installed successors and ends with the owner-only witness
// refresh. No member is added or removed. Applied SQL is immutable; this writes only
// the new forward migration.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8289.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'
import {readSignatures,readBody,participationRendererSql,participationPredecessorSql,ordinaryInstallSql,participationCheckSql} from './participation-read-retirement.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
// The recipe owner is 8289; 8288 is reserved for another lane and 8292 and 8293 are
// ordinary migrations that change no authenticated function.
const target='8290_participation_read_retirement.sql',predecessorMigration='8289_fused_admission.sql',prefix='a8289_'
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/'+target))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const pinned={
 'scripts/conversation-store/installation-authentication-8289.mjs':'6ba340467bed84b2b2551f9a151579ca8433ac92c42c30c9d1d99feb8e52040d',
 'scripts/conversation-store/conversion-install.mjs':'29f1606b2a882b93c3bdd75a102e1b1d821277cecbdddc742aaad4bea84ad2a8',
 'scripts/conversation-store/conversion-original-consumers.sql':'1fdca4e0e240c866519211e583f9ba93b67a7896c20766f4b80fe1ac0b842e26',
 'scripts/conversation-store/registry-guard-successor.mjs':'2c7ff5d6d619a42cce742c10611726e7c679a486e18bd872fee3df468529c61e',
 ['migrations/'+predecessorMigration]:'d0566b58861ffd12bfe4d1a2b91d4a80aaccae5a7d8abba7ca2af9b8186876b0',
}
for(const[path,digest]of Object.entries(pinned))if(sha(await readFile(root+path))!==digest)throw Error('participation_retirement_source_input_changed: '+path)
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const prerequisites=`DO $participation_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'participation_retirement_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${lit(predecessorMigration)}) THEN RAISE EXCEPTION 'participation_retirement_predecessor_missing';END IF;
END $participation_prerequisites$;`
// Only the guard and the witness refresh may read the registry or the witness.
const inventory=`DO $participation_registry_consumers$ DECLARE unknown text;BEGIN
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
 AND p.prosrc ~* '\\m(native_turn_contract_helpers|native_turn_contract_witness)\\M'
 AND p.oid NOT IN('public.native_turn_helpers_current()'::regprocedure,'public.native_turn_contract_witness_refresh()'::regprocedure) LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'participation_retirement_unreviewed_registry_consumer: %',unknown;END IF;
END $participation_registry_consumers$;`
// Classify every original pin consumer of the two re-rendered members (and the
// contracts that pin them) before anything changes; unknown consumers refuse.
let original=await readFile(root+'scripts/conversation-store/conversion-original-consumers.sql','utf8')
const affected="WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');"
if(original.split(affected).length!==2)throw Error('participation_retirement_original_consumer_source_changed')
original=original.replace(affected,`WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()',${readSignatures.map(lit).join(',')});`)
original=original.replaceAll('publication_expected_current',prefix+'publication_expected_current').replaceAll('publication_successor_templates',prefix+'publication_successor_templates').replaceAll('conversion_affected_functions','c8290_affected_functions').replaceAll('$conversion_original_consumers$','$participation_original_consumers$')
const renderer=participationRendererSql('c8290_source_body',prefix+'conversion_source_body')
const installer=await readFile(root+'scripts/conversation-store/conversion-install.mjs','utf8')
let propagation=installer.slice(installer.indexOf('DO $conversion_propagate$'),installer.indexOf('END $conversion_propagate$;')+'END $conversion_propagate$;'.length)
if(!propagation.startsWith('DO $conversion_propagate$'))throw Error('participation_retirement_propagation_source_changed')
propagation=propagation.replaceAll('publication_expected_current',prefix+'publication_expected_current').replaceAll('publication_successor_templates',prefix+'publication_successor_templates').replaceAll('pg_temp.conversion_source_body','pg_temp.c8290_source_body').replaceAll('$conversion_propagate$','$participation_propagate$')
// The 8274 typed registry record replaces the raw pg_proc comparisons (as 8276-8289).
const {executableProjection}=await import('./executable-record.mjs')
if(propagation.split('SET contract=after_row').length!==2||propagation.split('p IS DISTINCT FROM h.contract').length!==2)throw Error('participation_retirement_propagation_comparison_changed')
propagation=propagation.replace('SET contract=after_row',()=>`SET contract=${executableProjection('after_row')}`).replace('p IS DISTINCT FROM h.contract',()=>executableProjection('p')+' IS DISTINCT FROM h.contract')
// Both members must actually have changed exactly as the source says.
const rendered=`DO $participation_rendered$ BEGIN
${readSignatures.map(signature=>` IF (SELECT prosrc FROM pg_proc WHERE oid=${lit('public.'+signature)}::regprocedure) IS DISTINCT FROM ${lit(readBody)}
  OR (SELECT prosrc FROM pg_proc WHERE oid=${lit('public.'+signature)}::regprocedure) IS DISTINCT FROM pg_temp.c8290_source_body(${lit(signature)},(SELECT parts FROM pg_temp.${prefix}publication_successor_templates WHERE signature=${lit(signature)}),true)
 THEN RAISE EXCEPTION 'participation_retirement_rerender_missing';END IF;`).join('\n')}
END $participation_rendered$;`
const record=`DO $participation_record$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'participation_retirement_witness_record_failed';END IF;
 IF (SELECT count(*) FROM public.native_turn_contract_witness)<>1 THEN RAISE EXCEPTION 'participation_retirement_witness_record_failed';END IF;
END $participation_record$;
${witnessRelationCheckSql('c8290_')}`
const sql=`-- [COMP:api/task-mutation-scope] Project participation grants no read authority (631, 720 retired) and an unmovable child blocks a task edit.
-- Applied 8269-8289 are immutable; complete source predecessor verification precedes every mutation.
BEGIN;
${prerequisites}
${source.sql}
${inventory}
${participationPredecessorSql}
${ordinaryInstallSql}
${original}
${renderer}
${propagation}
${rendered}
${participationCheckSql('c8290_')}
${record}
${source.cleanup}
DROP FUNCTION pg_temp.c8290_source_body(text,jsonb,boolean);
COMMIT;
`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const current=await readFile(root+'migrations/'+target,'utf8');if(!current.startsWith('-- [COMP:api/task-mutation-scope] Project participation grants no read authority'))throw Error('participation_retirement_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
// 8288 is reserved for another lane; 8291 and later belong to other lanes.
if(!existing&&(!numbered.includes(8289)||numbered.includes(8290)))throw Error('participation_retirement_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('participation_retirement_generated_migration_changed');console.log('Participation retirement source matches')}else{await writeFile(output,sql);console.log('wrote',output,sql.length)}
