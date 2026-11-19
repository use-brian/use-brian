// [COMP:api/private-transcript] Private-transcript floor successor (8281).
// Authenticates the complete installed 8280 closure from source (316 functions
// and the witness), refuses unless private_session_display_parent is the exact
// predecessor body with its reviewed metadata and no pin consumer, replaces that
// body so the personal scope floor is checked for the assistant that reads,
// verifies the installed successor and ends with the owner-only witness refresh.
// The parent is outside the canonical registry: no member, record or pin changes.
// Applied SQL is immutable; this writes only the new forward migration.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8280.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'
import {floorPredecessorSql,floorSuccessorSql,floorCheckSql} from './private-transcript-floor.mjs'
const args=process.argv.slice(2),directory=fileURLToPath(new URL('./',import.meta.url))
const option=(name,fallback)=>{const at=args.indexOf(name);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error('Missing '+name);return args[at+1]}
const target='8281_private_transcript_floor.sql',predecessorMigration='8280_query_domain_visibility.sql'
const root=resolve(option('--source-root',directory+'../../'))+'/',output=resolve(option('--output',root+'migrations/'+target))
const sha=x=>createHash('sha256').update(x).digest('hex'),lit=x=>"'"+x.replaceAll("'","''")+"'"
const pinned={
 'scripts/conversation-store/installation-authentication-8280.mjs':'eb42e3b3950f711cf3bf6cb61f3beb2db954090d3d29a49d329c212792383747',
 'scripts/conversation-store/registry-guard-successor.mjs':'2c7ff5d6d619a42cce742c10611726e7c679a486e18bd872fee3df468529c61e',
 ['migrations/'+predecessorMigration]:'f27960cfbf5bc9b22cefd1c2b7627008a2ec2b2d52d0dd57ea2a0d375f1bc75c',
}
for(const[path,digest]of Object.entries(pinned))if(sha(await readFile(root+path))!==digest)throw Error('private_floor_source_input_changed: '+path)
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const prerequisites=`DO $private_floor_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'private_floor_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${lit(predecessorMigration)}) THEN RAISE EXCEPTION 'private_floor_predecessor_missing';END IF;
END $private_floor_prerequisites$;`
const record=`DO $private_floor_record$ BEGIN
 IF public.native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'private_floor_registry_changed';END IF;
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'private_floor_witness_record_failed';END IF;
 IF (SELECT count(*) FROM public.native_turn_contract_witness)<>1 THEN RAISE EXCEPTION 'private_floor_witness_record_failed';END IF;
END $private_floor_record$;
${witnessRelationCheckSql('c8281_')}`
const sql=`-- [COMP:api/private-transcript] Private-transcript floor successor: the personal scope floor is the reading assistant's.
-- Applied 8269-8280 are immutable; complete source predecessor verification precedes every mutation.
BEGIN;
${prerequisites}
${source.sql}
${floorPredecessorSql}
${floorSuccessorSql}
${floorCheckSql('c8281_')}
${record}
${source.cleanup}
COMMIT;
`
const numbered=(await readdir(root+'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>Number(name.slice(0,4)))
let existing=false
try{const current=await readFile(root+'migrations/'+target,'utf8');if(!current.startsWith('-- [COMP:api/private-transcript] Private-transcript floor successor'))throw Error('private_floor_existing_migration_not_owned');existing=true}catch(error){if(error.code!=='ENOENT')throw error}
// 8281 was assigned to this owner; later numbers belong to other owners and run after it.
if(!existing&&(!numbered.includes(8280)||numbered.includes(8281)))throw Error('private_floor_migration_number_changed')
if(args.includes('--check')){if(await readFile(output,'utf8')!==sql)throw Error('private_floor_generated_migration_changed');console.log('Private-transcript floor successor source matches')}else{await writeFile(output,sql);console.log('wrote',output,sql.length)}
