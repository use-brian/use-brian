// [COMP:api/native-turn-frame] Query-domain visibility successor of the native reader (8280).
// Authenticates the complete installed 8278 closure from source (the reviewed
// function set and the witness), replaces the exact 8269 body of the registry
// member conversation_dag_domain through the reviewed propagation (its registry
// record, retained fingerprints and every consumer pin follow from the renderer),
// verifies the installed successor and ends with the owner-only witness refresh.
// No member is added or removed. Applied SQL is immutable; this writes only the
// new forward migration. 8278 and 8279 are reserved numbers; this owner is 8280.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8278.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'
import {domainSignature,domainRendererSql,domainPredecessorSql,domainCheckSql} from './query-domain-visibility.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
const target='8280_query_domain_visibility.sql',predecessorMigration='8278_page_closure_adapter.sql'
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/'+target))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const pinned={
 'scripts/conversation-store/installation-authentication-8278.mjs':'266a934c8e5cad3f86a0fb3c9a01a141abc2e1c731a60147964e6f7f42074d15',
 'scripts/conversation-store/conversion-install.mjs':'29f1606b2a882b93c3bdd75a102e1b1d821277cecbdddc742aaad4bea84ad2a8',
 'scripts/conversation-store/conversion-original-consumers.sql':'1fdca4e0e240c866519211e583f9ba93b67a7896c20766f4b80fe1ac0b842e26',
 'scripts/conversation-store/registry-guard-successor.mjs':'2c7ff5d6d619a42cce742c10611726e7c679a486e18bd872fee3df468529c61e',
 ['migrations/'+predecessorMigration]:'9fa28fcbb7aa3c2654c1c2a097512cc79beb2e6062bbc759d397241985722920',
}
for(const[path,digest]of Object.entries(pinned))if(sha(await readFile(root+path))!==digest)throw Error('query_domain_source_input_changed: '+path)
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const prerequisites=`DO $query_domain_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'query_domain_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${lit(predecessorMigration)}) THEN RAISE EXCEPTION 'query_domain_predecessor_missing';END IF;
END $query_domain_prerequisites$;`
// Only the guard and the witness refresh may read the registry or the witness.
const inventory=`DO $query_domain_registry_consumers$ DECLARE unknown text;BEGIN
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
 AND p.prosrc ~* '\\m(native_turn_contract_helpers|native_turn_contract_witness)\\M'
 AND p.oid NOT IN('public.native_turn_helpers_current()'::regprocedure,'public.native_turn_contract_witness_refresh()'::regprocedure) LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'query_domain_unreviewed_registry_consumer: %',unknown;END IF;
END $query_domain_registry_consumers$;`
// Classify every original pin consumer of the re-rendered member (and the
// contracts that pin it) before anything changes; unknown consumers refuse.
let original=await readFile(root+'scripts/conversation-store/conversion-original-consumers.sql','utf8')
const affected="WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');"
if(original.split(affected).length!==2)throw Error('query_domain_original_consumer_source_changed')
original=original.replace(affected,`WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()',${lit(domainSignature)});`)
original=original.replaceAll('publication_expected_current','a8278_publication_expected_current').replaceAll('publication_successor_templates','a8278_publication_successor_templates').replaceAll('conversion_affected_functions','c8280_affected_functions').replaceAll('$conversion_original_consumers$','$query_domain_original_consumers$')
const renderer=domainRendererSql('c8280_source_body','a8278_conversion_source_body')
const installer=await readFile(root+'scripts/conversation-store/conversion-install.mjs','utf8')
let propagation=installer.slice(installer.indexOf('DO $conversion_propagate$'),installer.indexOf('END $conversion_propagate$;')+'END $conversion_propagate$;'.length)
if(!propagation.startsWith('DO $conversion_propagate$'))throw Error('query_domain_propagation_source_changed')
propagation=propagation.replaceAll('publication_expected_current','a8278_publication_expected_current').replaceAll('publication_successor_templates','a8278_publication_successor_templates').replaceAll('pg_temp.conversion_source_body','pg_temp.c8280_source_body').replaceAll('$conversion_propagate$','$query_domain_propagate$')
// The 8274 typed registry record replaces the raw pg_proc comparisons (as 8276-8278).
const {executableProjection}=await import('./executable-record.mjs')
if(propagation.split('SET contract=after_row').length!==2||propagation.split('p IS DISTINCT FROM h.contract').length!==2)throw Error('query_domain_propagation_comparison_changed')
propagation=propagation.replace('SET contract=after_row',()=>`SET contract=${executableProjection('after_row')}`).replace('p IS DISTINCT FROM h.contract',()=>executableProjection('p')+' IS DISTINCT FROM h.contract')
// The member must actually have changed exactly as the source says.
const rendered=`DO $query_domain_rendered$ BEGIN
 IF (SELECT prosrc FROM pg_proc WHERE oid=${lit('public.'+domainSignature)}::regprocedure) IS DISTINCT FROM pg_temp.c8280_source_body(${lit(domainSignature)},(SELECT parts FROM pg_temp.a8278_publication_successor_templates WHERE signature=${lit(domainSignature)}),true)
 THEN RAISE EXCEPTION 'query_domain_rerender_missing';END IF;
END $query_domain_rendered$;`
const record=`DO $query_domain_record$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'query_domain_witness_record_failed';END IF;
 IF (SELECT count(*) FROM public.native_turn_contract_witness)<>1 THEN RAISE EXCEPTION 'query_domain_witness_record_failed';END IF;
END $query_domain_record$;
${witnessRelationCheckSql('c8280_')}`
const sql=`-- [COMP:api/native-turn-frame] Query-domain visibility successor: a frozen assistant visibility is capture metadata, never authority.
-- Applied 8269-8278 are immutable; complete source predecessor verification precedes every mutation.
BEGIN;
${prerequisites}
${source.sql}
${inventory}
${domainPredecessorSql}
${original}
${renderer}
${propagation}
${rendered}
${domainCheckSql('c8280_')}
${record}
${source.cleanup}
DROP FUNCTION pg_temp.c8280_source_body(text,jsonb,boolean);
COMMIT;
`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const current=await readFile(root+'migrations/'+target,'utf8');if(!current.startsWith('-- [COMP:api/native-turn-frame] Query-domain visibility successor'))throw Error('query_domain_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
// 8279 is reserved for another owner; until it lands the predecessor is 8278.
if(!existing&&Math.max(...numbered)!==8278)throw Error('query_domain_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('query_domain_generated_migration_changed');console.log('Query-domain visibility successor source matches')}else{await writeFile(output,sql);console.log('wrote',output,sql.length)}
