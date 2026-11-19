// [COMP:api/fused-admission] Fused admission owner (8289).
// Authenticates the complete installed 8287 closure from source (316 functions and
// the witness), installs the 75 compiled members and the generic owner (the exact
// predecessor capture body under a new owner-only name), enrolls the 76 members,
// re-renders the guard roster and the capture body (the fused wrapper) through the
// reviewed propagation, which repins every consumer, source-authenticates every
// member and ends with the owner-only witness refresh. Applied SQL is immutable;
// this writes only the new forward migration. 8288 is reserved for another lane and
// 8282 is retired, so the numbered predecessor is 8287.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8287.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'
import {captureSignature,genericSignature,fusedInstallSql,genericCreateSql,fusedAbsentSql,fusedEnrollSql,fusedRendererSql,fusedAuthenticationSql,fusedReferenceCleanup} from './fused-admission.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
const target='8289_fused_admission.sql',predecessorMigration='8287_page_closure_roots.sql',prefix='a8287_',numberedPredecessor=8287
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/'+target))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const pinned={
 'scripts/conversation-store/installation-authentication-8287.mjs':'5f785dce4017e846fce886807a2253189fd825ac730067395adb7fa265570a32',
 'scripts/conversation-store/conversion-install.mjs':'29f1606b2a882b93c3bdd75a102e1b1d821277cecbdddc742aaad4bea84ad2a8',
 'scripts/conversation-store/conversion-original-consumers.sql':'1fdca4e0e240c866519211e583f9ba93b67a7896c20766f4b80fe1ac0b842e26',
 'scripts/conversation-store/registry-guard-successor.mjs':'2c7ff5d6d619a42cce742c10611726e7c679a486e18bd872fee3df468529c61e',
 ['migrations/'+predecessorMigration]:'2ff9c8b66980f573279aa2e01db49bd802e86e53074569bc49717346bce42ff4',
}
for(const[path,digest]of Object.entries(pinned))if(sha(await readFile(root+path))!==digest)throw Error('fused_admission_source_input_changed: '+path)
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const prerequisites=`DO $fused_admission_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'fused_admission_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${lit(predecessorMigration)}) THEN RAISE EXCEPTION 'fused_admission_predecessor_missing';END IF;
 IF ${fusedAbsentSql} THEN RAISE EXCEPTION 'fused_admission_successor_already_installed';END IF;
END $fused_admission_prerequisites$;`
// Only the guard and the witness refresh may read the registry or the witness.
const inventory=`DO $fused_admission_registry_consumers$ DECLARE unknown text;BEGIN
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
 AND p.prosrc ~* '\\m(native_turn_contract_helpers|native_turn_contract_witness)\\M'
 AND p.oid NOT IN('public.native_turn_helpers_current()'::regprocedure,'public.native_turn_contract_witness_refresh()'::regprocedure) LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'fused_admission_unreviewed_registry_consumer: %',unknown;END IF;
END $fused_admission_registry_consumers$;`
// Classify every original pin consumer of the re-rendered guard, the publication
// contract and the capture owner before anything changes; unknown consumers refuse.
let original=await readFile(root+'scripts/conversation-store/conversion-original-consumers.sql','utf8')
const affected="WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');"
if(original.split(affected).length!==2)throw Error('fused_admission_original_consumer_source_changed')
original=original.replace(affected,`WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()',${lit(captureSignature)});`)
original=original.replaceAll('publication_expected_current',prefix+'publication_expected_current').replaceAll('publication_successor_templates',prefix+'publication_successor_templates').replaceAll('conversion_affected_functions','c8289_affected_functions').replaceAll('$conversion_original_consumers$','$fused_admission_original_consumers$')
const renderer=fusedRendererSql('c8289_source_body',prefix+'conversion_source_body')
const installer=await readFile(root+'scripts/conversation-store/conversion-install.mjs','utf8')
let propagation=installer.slice(installer.indexOf('DO $conversion_propagate$'),installer.indexOf('END $conversion_propagate$;')+'END $conversion_propagate$;'.length)
if(!propagation.startsWith('DO $conversion_propagate$'))throw Error('fused_admission_propagation_source_changed')
propagation=propagation.replaceAll('publication_expected_current',prefix+'publication_expected_current').replaceAll('publication_successor_templates',prefix+'publication_successor_templates').replaceAll('pg_temp.conversion_source_body','pg_temp.c8289_source_body').replaceAll('$conversion_propagate$','$fused_admission_propagate$')
// The 8274 typed registry record replaces the raw pg_proc comparisons (as 8276-8287).
const {executableProjection}=await import('./executable-record.mjs')
if(propagation.split('SET contract=after_row').length!==2||propagation.split('p IS DISTINCT FROM h.contract').length!==2)throw Error('fused_admission_propagation_comparison_changed')
propagation=propagation.replace('SET contract=after_row',()=>`SET contract=${executableProjection('after_row')}`).replace('p IS DISTINCT FROM h.contract',()=>executableProjection('p')+' IS DISTINCT FROM h.contract')
// The guard, the wrapper and the generic owner must carry exactly what the source says.
const templates=`pg_temp.${prefix}publication_successor_templates`
const rendered=`DO $fused_admission_rendered$ BEGIN
 IF (SELECT prosrc FROM pg_proc WHERE oid='public.native_turn_helpers_current()'::regprocedure) IS DISTINCT FROM pg_temp.c8289_source_body('native_turn_helpers_current()',(SELECT parts FROM ${templates} WHERE signature='native_turn_helpers_current()'),true)
  OR strpos((SELECT prosrc FROM pg_proc WHERE oid='public.native_turn_helpers_current()'::regprocedure),${lit("'"+genericSignature+"'")})=0
  OR (SELECT prosrc FROM pg_proc WHERE oid=${lit('public.'+captureSignature)}::regprocedure) IS DISTINCT FROM pg_temp.c8289_source_body(${lit(captureSignature)},(SELECT parts FROM ${templates} WHERE signature=${lit(captureSignature)}),true)
  OR strpos((SELECT prosrc FROM pg_proc WHERE oid=${lit('public.'+captureSignature)}::regprocedure),'fused_f_capture(')=0
  OR (SELECT prosrc FROM pg_proc WHERE oid=${lit('public.'+genericSignature)}::regprocedure) IS DISTINCT FROM pg_temp.c8289_source_body(${lit(genericSignature)},(SELECT parts FROM ${templates} WHERE signature=${lit(captureSignature)}),true)
 THEN RAISE EXCEPTION 'fused_admission_rerender_missing';END IF;
END $fused_admission_rendered$;`
const record=`DO $fused_admission_record$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'fused_admission_witness_record_failed';END IF;
 IF (SELECT count(*) FROM public.native_turn_contract_witness)<>1 THEN RAISE EXCEPTION 'fused_admission_witness_record_failed';END IF;
END $fused_admission_record$;
${witnessRelationCheckSql('c8289_')}`
const sql=`-- [COMP:api/fused-admission] Fused admission owner: one compiled statement set per protected boundary, the generic owner for every other shape.
-- Applied 8269-8287 are immutable; complete source predecessor verification precedes every mutation.
BEGIN;
${prerequisites}
${source.sql}
${inventory}
${original}
${fusedInstallSql}${genericCreateSql(prefix)}
${fusedEnrollSql}
${renderer}
${propagation}
${rendered}
${fusedAuthenticationSql('c8289_f_','c8289_source_body',prefix+'publication_successor_templates')}
${record}
${source.cleanup}
${fusedReferenceCleanup('c8289_f_')}
DROP FUNCTION pg_temp.c8289_source_body(text,jsonb,boolean);
COMMIT;
`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const current=await readFile(root+'migrations/'+target,'utf8');if(!current.startsWith('-- [COMP:api/fused-admission] Fused admission owner'))throw Error('fused_admission_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
// 8288 is reserved for another lane and may land before or after this file; later
// numbers (8290 and up) belong to other lanes and run after it.
if(!existing&&(!numbered.includes(numberedPredecessor)||numbered.some(n=>n>numberedPredecessor&&n<8289&&n!==8288)||numbered.includes(8289)))throw Error('fused_admission_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('fused_admission_generated_migration_changed');console.log('Fused admission source matches')}else{await writeFile(output,sql);console.log('wrote',output,sql.length)}
