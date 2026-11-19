// [COMP:api/fused-admission] Fused admission plan-size successor (8294).
// Authenticates the complete installed 8290 closure from source (392 functions and the
// witness), refuses unless the 17 tuned compiled helpers are the exact 8289 members, gives
// each the function-level search_path its callers run with (so the planner no longer
// inlines it), records their typed registry records, verifies them and ends with the
// owner-only witness refresh. No member is added or removed; bodies are unchanged and no
// body pins these members, so no consumer changes. 8291 is unused; 8292 and 8293 are
// ordinary migrations. Applied SQL is immutable; this writes only the new forward migration.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8290.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'
import {tuningPredecessorSql,tuningInstallSql,tuningCheckSql} from './fused-admission-tuning.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
const target='8294_fused_admission_plan_size.sql',predecessorMigration='8290_participation_read_retirement.sql'
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/'+target))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const pinned={
 'scripts/conversation-store/installation-authentication-8290.mjs':'42991313d28697d9a5ea9e059dd6e821cd504caaee8511d8f1386189552e0ed6',
 'scripts/conversation-store/registry-guard-successor.mjs':'2c7ff5d6d619a42cce742c10611726e7c679a486e18bd872fee3df468529c61e',
 'scripts/conversation-store/fused-admission.mjs':'576565ce0043df3a18d3c2ce04b1e7b62af07acac88af01c88b65ebd5b912318',
 'scripts/conversation-store/fused-admission.sql':'1bcb05cb722163a075ae3df39a7c21507939fe549220b8f5adb6f8270ad2e761',
 ['migrations/'+predecessorMigration]:'5fdaec0ab2468bc805c7163478d58e88b5c407efbc02a55fafdb5dc89a74b8d0',
}
for(const[path,digest]of Object.entries(pinned))if(sha(await readFile(root+path))!==digest)throw Error('fused_tuning_source_input_changed: '+path)
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const prerequisites=`DO $fused_tuning_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'fused_tuning_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${lit(predecessorMigration)}) THEN RAISE EXCEPTION 'fused_tuning_predecessor_missing';END IF;
END $fused_tuning_prerequisites$;`
// Only the guard and the witness refresh may read the registry or the witness.
const inventory=`DO $fused_tuning_registry_consumers$ DECLARE unknown text;BEGIN
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
 AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
 AND p.prosrc ~* '\\m(native_turn_contract_helpers|native_turn_contract_witness)\\M'
 AND p.oid NOT IN('public.native_turn_helpers_current()'::regprocedure,'public.native_turn_contract_witness_refresh()'::regprocedure) LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'fused_tuning_unreviewed_registry_consumer: %',unknown;END IF;
END $fused_tuning_registry_consumers$;`
const record=`DO $fused_tuning_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'fused_tuning_witness_record_failed';END IF;
 IF (SELECT count(*) FROM public.native_turn_contract_witness)<>1 THEN RAISE EXCEPTION 'fused_tuning_witness_record_failed';END IF;
END $fused_tuning_witness$;
${witnessRelationCheckSql('c8294_')}`
const sql=`-- [COMP:api/fused-admission] Fused admission plan-size successor: the 17 largest compiled helpers are called, not inlined.
-- Applied 8269-8293 are immutable; complete source predecessor verification precedes every mutation.
BEGIN;
${prerequisites}
${source.sql}
${inventory}
${tuningPredecessorSql}
${tuningInstallSql}
${tuningCheckSql('c8294_')}
${record}
${source.cleanup}
COMMIT;
`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const current=await readFile(root+'migrations/'+target,'utf8');if(!current.startsWith('-- [COMP:api/fused-admission] Fused admission plan-size successor'))throw Error('fused_tuning_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
if(!existing&&(numbered.includes(8294)||numbered.some(n=>n>8294)||!numbered.includes(8290)))throw Error('fused_tuning_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('fused_tuning_generated_migration_changed');console.log('Fused admission plan-size source matches')}else{await writeFile(output,sql);console.log('wrote',output,sql.length)}
