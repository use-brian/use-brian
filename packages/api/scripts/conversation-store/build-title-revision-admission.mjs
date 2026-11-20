// [COMP:api/page-closure-adapter] Page-derived title payload admission successor (8286).
// Authenticates the complete installed 8281 closure from source (316 functions and
// the witness), replaces the exact installed body of the registry member
// session_context_revision_allowed through the reviewed propagation (its registry
// record and every consumer pin follow from the renderer), verifies the installed
// successor and ends with the owner-only witness refresh. No member is added or
// removed. Applied SQL is immutable; this writes only the new forward migration.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8281.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'
import {admissionSignature,admissionRendererSql,admissionPredecessorSql,admissionCheckSql} from './title-revision-admission.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
// The recipe owner is 8281; 8282 is unassigned and 8283-8285 change no
// authenticated function, so the authenticated predecessor closure is 8281's.
const target='8286_title_revision_admission.sql',predecessorMigration='8281_private_transcript_floor.sql',prefix='a8281_',numberedPredecessor=8285
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/'+target))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const pinned={
 'scripts/conversation-store/installation-authentication-8281.mjs':'b664d546437d2bb09b64773f0270deacadbc7b2c20393e4dce192829071d275f',
 'scripts/conversation-store/conversion-install.mjs':'29f1606b2a882b93c3bdd75a102e1b1d821277cecbdddc742aaad4bea84ad2a8',
 'scripts/conversation-store/conversion-original-consumers.sql':'1fdca4e0e240c866519211e583f9ba93b67a7896c20766f4b80fe1ac0b842e26',
 'scripts/conversation-store/registry-guard-successor.mjs':'2c7ff5d6d619a42cce742c10611726e7c679a486e18bd872fee3df468529c61e',
 ['migrations/'+predecessorMigration]:'7b30be0c4ddcf68b285c9aea9bdc259da8d5608b5fd1e07ded94d38660f46fb7',
}
for(const[path,digest]of Object.entries(pinned))if(sha(await readFile(root+path))!==digest)throw Error('title_admission_source_input_changed: '+path)
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const prerequisites=`DO $title_admission_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'title_admission_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${lit(predecessorMigration)}) THEN RAISE EXCEPTION 'title_admission_predecessor_missing';END IF;
END $title_admission_prerequisites$;`
// Only the guard and the witness refresh may read the registry or the witness.
const inventory=`DO $title_admission_registry_consumers$ DECLARE unknown text;BEGIN
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
 AND p.prosrc ~* '\\m(native_turn_contract_helpers|native_turn_contract_witness)\\M'
 AND p.oid NOT IN('public.native_turn_helpers_current()'::regprocedure,'public.native_turn_contract_witness_refresh()'::regprocedure) LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'title_admission_unreviewed_registry_consumer: %',unknown;END IF;
END $title_admission_registry_consumers$;`
// Classify every original pin consumer of the re-rendered member (and the
// contracts that pin it) before anything changes; unknown consumers refuse.
let original=await readFile(root+'scripts/conversation-store/conversion-original-consumers.sql','utf8')
const affected="WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');"
if(original.split(affected).length!==2)throw Error('title_admission_original_consumer_source_changed')
original=original.replace(affected,`WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()',${lit(admissionSignature)});`)
original=original.replaceAll('publication_expected_current',prefix+'publication_expected_current').replaceAll('publication_successor_templates',prefix+'publication_successor_templates').replaceAll('conversion_affected_functions','c8286_affected_functions').replaceAll('$conversion_original_consumers$','$title_admission_original_consumers$')
const renderer=admissionRendererSql('c8286_source_body',prefix+'conversion_source_body')
const installer=await readFile(root+'scripts/conversation-store/conversion-install.mjs','utf8')
let propagation=installer.slice(installer.indexOf('DO $conversion_propagate$'),installer.indexOf('END $conversion_propagate$;')+'END $conversion_propagate$;'.length)
if(!propagation.startsWith('DO $conversion_propagate$'))throw Error('title_admission_propagation_source_changed')
propagation=propagation.replaceAll('publication_expected_current',prefix+'publication_expected_current').replaceAll('publication_successor_templates',prefix+'publication_successor_templates').replaceAll('pg_temp.conversion_source_body','pg_temp.c8286_source_body').replaceAll('$conversion_propagate$','$title_admission_propagate$')
// The 8274 typed registry record replaces the raw pg_proc comparisons (as 8276-8280).
const {executableProjection}=await import('./executable-record.mjs')
if(propagation.split('SET contract=after_row').length!==2||propagation.split('p IS DISTINCT FROM h.contract').length!==2)throw Error('title_admission_propagation_comparison_changed')
propagation=propagation.replace('SET contract=after_row',()=>`SET contract=${executableProjection('after_row')}`).replace('p IS DISTINCT FROM h.contract',()=>executableProjection('p')+' IS DISTINCT FROM h.contract')
// The member must actually have changed exactly as the source says.
const rendered=`DO $title_admission_rendered$ BEGIN
 IF (SELECT prosrc FROM pg_proc WHERE oid=${lit('public.'+admissionSignature)}::regprocedure) IS DISTINCT FROM pg_temp.c8286_source_body(${lit(admissionSignature)},(SELECT parts FROM pg_temp.${prefix}publication_successor_templates WHERE signature=${lit(admissionSignature)}),true)
 THEN RAISE EXCEPTION 'title_admission_rerender_missing';END IF;
END $title_admission_rendered$;`
const record=`DO $title_admission_record$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'title_admission_witness_record_failed';END IF;
 IF (SELECT count(*) FROM public.native_turn_contract_witness)<>1 THEN RAISE EXCEPTION 'title_admission_witness_record_failed';END IF;
END $title_admission_record$;
${witnessRelationCheckSql('c8286_')}`
const sql=`-- [COMP:api/page-closure-adapter] Page-derived title payload admission: the Page source-family adapter before the generic ancestry evaluation.
-- Applied 8269-8285 are immutable; complete source predecessor verification precedes every mutation.
BEGIN;
${prerequisites}
${source.sql}
${inventory}
${admissionPredecessorSql}
${original}
${renderer}
${propagation}
${rendered}
${admissionCheckSql('c8286_')}
${record}
${source.cleanup}
DROP FUNCTION pg_temp.c8286_source_body(text,jsonb,boolean);
COMMIT;
`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const current=await readFile(root+'migrations/'+target,'utf8');if(!current.startsWith('-- [COMP:api/page-closure-adapter] Page-derived title payload admission'))throw Error('title_admission_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
if(!existing&&Math.max(...numbered)!==numberedPredecessor)throw Error('title_admission_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('title_admission_generated_migration_changed');console.log('Title revision admission source matches')}else{await writeFile(output,sql);console.log('wrote',output,sql.length)}
