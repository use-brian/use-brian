// [COMP:api/native-turn-frame] Page source-family adapter of the native capture (8278).
// Authenticates the complete installed 8277 closure from source (315 functions and
// the witness), creates the Page closure member, enrolls it, re-renders the guard
// roster through the reviewed propagation, replaces the exact 725 body of
// read_page_event_authority with its row-lock successor, and ends with the
// owner-only witness refresh. Applied SQL is immutable; this writes only the new
// forward migration.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8277.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'
import {pageClosureParts,pageClosureSignatures,pageClosureEnrollSql,pageClosureRendererSql,pageClosureAuthenticationSql,pageClosureReferenceCleanup,pageAuthorityPredecessorSql} from './page-closure.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
const target='8278_page_closure_adapter.sql'
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/'+target))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const pinned={
 'scripts/conversation-store/installation-authentication-8277.mjs':'6b060db97621991a4b6c4df4e6029775f18b2409fa51a915c20d862e281748fe',
 'scripts/conversation-store/conversion-install.mjs':'29f1606b2a882b93c3bdd75a102e1b1d821277cecbdddc742aaad4bea84ad2a8',
 'scripts/conversation-store/conversion-original-consumers.sql':'1fdca4e0e240c866519211e583f9ba93b67a7896c20766f4b80fe1ac0b842e26',
 'scripts/conversation-store/registry-guard-successor.mjs':'2c7ff5d6d619a42cce742c10611726e7c679a486e18bd872fee3df468529c61e',
 'migrations/8277_durable_turn_completions.sql':'9531458b8f0dcce872f2debff5efdda58ac898a5793d48bd147e2bfe54b77aaa',
}
for(const[path,digest]of Object.entries(pinned))if(sha(await readFile(root+path))!==digest)throw Error('page_closure_source_input_changed: '+path)
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const parts=pageClosureParts()
const prerequisites=`DO $page_closure_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'page_closure_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8277_durable_turn_completions.sql') THEN RAISE EXCEPTION 'page_closure_predecessor_missing';END IF;
 IF EXISTS(SELECT 1 FROM unnest(${'ARRAY['+pageClosureSignatures.map(s=>lit('public.'+s)).join(',')+']'}::text[]) s WHERE to_regprocedure(s) IS NOT NULL)
  OR EXISTS(SELECT 1 FROM pg_proc WHERE proname='capture_page_closure_evidence')
  OR EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=ANY(${'ARRAY['+pageClosureSignatures.map(lit).join(',')+']'}::text[]))
 THEN RAISE EXCEPTION 'page_closure_successor_already_installed';END IF;
END $page_closure_prerequisites$;`
// Only the guard and the witness refresh may read the registry or the witness.
const inventory=`DO $page_closure_registry_consumers$ DECLARE unknown text;BEGIN
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
 AND p.prosrc ~* '\\m(native_turn_contract_helpers|native_turn_contract_witness)\\M'
 AND p.oid NOT IN('public.native_turn_helpers_current()'::regprocedure,'public.native_turn_contract_witness_refresh()'::regprocedure) LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'page_closure_unreviewed_registry_consumer: %',unknown;END IF;
END $page_closure_registry_consumers$;`
// Classify every original pin consumer of the re-rendered guard (and the
// contracts that pin it) before anything changes; unknown consumers refuse.
let original=await readFile(root+'scripts/conversation-store/conversion-original-consumers.sql','utf8')
const affected="WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');"
if(original.split(affected).length!==2)throw Error('page_closure_original_consumer_source_changed')
original=original.replaceAll('publication_expected_current','a8277_publication_expected_current').replaceAll('publication_successor_templates','a8277_publication_successor_templates').replaceAll('conversion_affected_functions','c8278_affected_functions').replaceAll('$conversion_original_consumers$','$page_closure_original_consumers$')
const renderer=pageClosureRendererSql('c8278_source_body','a8277_conversion_source_body')
const installer=await readFile(root+'scripts/conversation-store/conversion-install.mjs','utf8')
let propagation=installer.slice(installer.indexOf('DO $conversion_propagate$'),installer.indexOf('END $conversion_propagate$;')+'END $conversion_propagate$;'.length)
if(!propagation.startsWith('DO $conversion_propagate$'))throw Error('page_closure_propagation_source_changed')
propagation=propagation.replaceAll('publication_expected_current','a8277_publication_expected_current').replaceAll('publication_successor_templates','a8277_publication_successor_templates').replaceAll('pg_temp.conversion_source_body','pg_temp.c8278_source_body').replaceAll('$conversion_propagate$','$page_closure_propagate$')
// The 8274 typed registry record replaces the raw pg_proc comparisons (as 8276, 8277).
const {executableProjection}=await import('./executable-record.mjs')
if(propagation.split('SET contract=after_row').length!==2||propagation.split('p IS DISTINCT FROM h.contract').length!==2)throw Error('page_closure_propagation_comparison_changed')
propagation=propagation.replace('SET contract=after_row',()=>`SET contract=${executableProjection('after_row')}`).replace('p IS DISTINCT FROM h.contract',()=>executableProjection('p')+' IS DISTINCT FROM h.contract')
// The guard must actually carry the new member exactly as the source says.
const rendered=`DO $page_closure_rendered$ BEGIN
 IF (SELECT prosrc FROM pg_proc WHERE oid='public.native_turn_helpers_current()'::regprocedure) IS DISTINCT FROM pg_temp.c8278_source_body('native_turn_helpers_current()',(SELECT parts FROM pg_temp.a8277_publication_successor_templates WHERE signature='native_turn_helpers_current()'),true)
  OR strpos((SELECT prosrc FROM pg_proc WHERE oid='public.native_turn_helpers_current()'::regprocedure),${lit("'"+pageClosureSignatures[0].replaceAll("'","''")+"'")})=0
 THEN RAISE EXCEPTION 'page_closure_rerender_missing';END IF;
END $page_closure_rendered$;`
const record=`DO $page_closure_record$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'page_closure_witness_record_failed';END IF;
 IF (SELECT count(*) FROM public.native_turn_contract_witness)<>1 THEN RAISE EXCEPTION 'page_closure_witness_record_failed';END IF;
END $page_closure_record$;
${witnessRelationCheckSql('c8278_')}`
const sql=`-- [COMP:api/native-turn-frame] Page source-family adapter of the native capture; row-lock Page principal reader.
-- Applied 8269-8277 are immutable; complete source predecessor verification precedes every mutation.
BEGIN;
${prerequisites}
${source.sql}
${inventory}
${original}
${pageAuthorityPredecessorSql}
${parts.members}${parts.successor}
${pageClosureEnrollSql}
${renderer}
${propagation}
${rendered}
${pageClosureAuthenticationSql('c8278_')}
${record}
${source.cleanup}
${pageClosureReferenceCleanup('c8278_')}
DROP FUNCTION pg_temp.c8278_source_body(text,jsonb,boolean);
COMMIT;
`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const current=await readFile(root+'migrations/'+target,'utf8');if(!current.startsWith('-- [COMP:api/native-turn-frame] Page source-family adapter'))throw Error('page_closure_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
if(!existing&&Math.max(...numbered)!==8277)throw Error('page_closure_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('page_closure_generated_migration_changed');console.log('Page closure adapter source matches')}else{await writeFile(output,sql);console.log('wrote',output,sql.length)}
