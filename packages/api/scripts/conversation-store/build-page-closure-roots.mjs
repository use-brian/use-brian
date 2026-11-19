// [COMP:api/page-closure-adapter] Page-root successor of the Page source-family adapter (8287).
// Authenticates the complete installed 8286 closure from source (316 functions and
// the witness), refuses unless capture_page_closure_evidence is the exact 8278 body
// with its reviewed metadata, two-role ACL, registry record and no pin consumer,
// replaces its body so Page receipts may be roots, records the new typed registry
// record, verifies the installed successor and ends with the owner-only witness
// refresh. No member is added or removed; the member is outside the reviewed
// propagation templates and nothing pins its fingerprint, so no consumer changes.
// Applied SQL is immutable; this writes only
// the new forward migration.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8286.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'
import {rootsPredecessorSql,rootsInstallSql,rootsCheckSql} from './page-closure-roots.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
const target='8287_page_closure_roots.sql',predecessorMigration='8286_title_revision_admission.sql'
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/'+target))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const pinned={
 'scripts/conversation-store/installation-authentication-8286.mjs':'00bb159c6d4ebee17f345a4c82471f977fc6709e2441b75ee01a92434ea41ad2',
 'scripts/conversation-store/registry-guard-successor.mjs':'2c7ff5d6d619a42cce742c10611726e7c679a486e18bd872fee3df468529c61e',
 'scripts/conversation-store/page-closure.mjs':'ca83caa7108501c1e66a0601ce81cce5441c2d197e3fa754b73c8ce8094d87f9',
 ['migrations/'+predecessorMigration]:'c601a5145d310b8381c69b88958f8c1f54215805d2c95761ff5ad09afae9c2f7',
}
for(const[path,digest]of Object.entries(pinned))if(sha(await readFile(root+path))!==digest)throw Error('page_roots_source_input_changed: '+path)
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const prerequisites=`DO $page_roots_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'page_roots_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${lit(predecessorMigration)}) THEN RAISE EXCEPTION 'page_roots_predecessor_missing';END IF;
END $page_roots_prerequisites$;`
// Only the guard and the witness refresh may read the registry or the witness.
const inventory=`DO $page_roots_registry_consumers$ DECLARE unknown text;BEGIN
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
 AND p.prosrc ~* '\\m(native_turn_contract_helpers|native_turn_contract_witness)\\M'
 AND p.oid NOT IN('public.native_turn_helpers_current()'::regprocedure,'public.native_turn_contract_witness_refresh()'::regprocedure) LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'page_roots_unreviewed_registry_consumer: %',unknown;END IF;
END $page_roots_registry_consumers$;`
const record=`DO $page_roots_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'page_roots_witness_record_failed';END IF;
 IF (SELECT count(*) FROM public.native_turn_contract_witness)<>1 THEN RAISE EXCEPTION 'page_roots_witness_record_failed';END IF;
END $page_roots_witness$;
${witnessRelationCheckSql('c8287_')}`
const sql=`-- [COMP:api/page-closure-adapter] Page-root successor of the Page source-family adapter: a doc-thread turn's own Page receipt no longer forces the generic validator.
-- Applied 8269-8286 are immutable; complete source predecessor verification precedes every mutation.
BEGIN;
${prerequisites}
${source.sql}
${inventory}
${rootsPredecessorSql}
${rootsInstallSql}
${rootsCheckSql('c8287_')}
${record}
${source.cleanup}
COMMIT;
`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const current=await readFile(root+'migrations/'+target,'utf8');if(!current.startsWith('-- [COMP:api/page-closure-adapter] Page-root successor'))throw Error('page_roots_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
if(!existing&&Math.max(...numbered)!==8286)throw Error('page_roots_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('page_roots_generated_migration_changed');console.log('Page-root successor source matches')}else{await writeFile(output,sql);console.log('wrote',output,sql.length)}
