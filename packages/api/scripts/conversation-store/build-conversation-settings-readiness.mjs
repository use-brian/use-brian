// [COMP:api/conversation-visibility] Install the versioned settings handshake.
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { receivingOwnerDeclaration } from './build-conversation-receiving-owners.mjs'
import { pagePublicationMigrationName } from './build-conversation-page-publication.mjs'
import { assertAuthenticationReadOnly as previousReadOnly,
  currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8313.mjs'

const start='-- BEGIN REVIEWED SETTINGS READINESS\n'
const end='-- END REVIEWED SETTINGS READINESS'
const previousPrefix='a8313_'
const prefix='a8314_'
const marker='conversation_visibility_settings_ready'
const hash=value=>createHash('sha256').update(value).digest('hex')
const literal=value=>"'"+value.replaceAll("'","''")+"'"
export const settingsReadinessMigrationName='8314_conversation_settings_readiness.sql'

async function reviewedSettingsReadiness(options) {
 const [previous,source]=await Promise.all([
  previousSource(options),
  readFile(new URL('./conversation-settings-readiness.sql',import.meta.url),'utf8'),
 ])
 return {previous,source}
}

export async function buildConversationSettingsReadinessCandidate(options={}) {
 const {previous,source}=await reviewedSettingsReadiness(options)
 return `-- [COMP:api/conversation-visibility] Enable the reviewed settings handshake.
BEGIN;
DO $settings_readiness_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='${pagePublicationMigrationName}')
 OR to_regprocedure('public.conversation_visibility_settings_ready()') IS NOT NULL
 OR to_regprocedure('public.conversation_visibility_settings_ready(integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'conversation_settings_readiness_predecessor_changed';END IF;
END $settings_readiness_predecessor$;
${previous.sql}
${start}${source}${end}
DO $settings_readiness_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE THEN RAISE EXCEPTION 'conversation_settings_readiness_witness_changed';END IF;
END $settings_readiness_witness$;
${previous.cleanup}
COMMIT;\n`
}

function once(value,old,replacement) {
 if(value.split(old).length!==2)throw Error('conversation_settings_readiness_authentication_source_changed')
 return value.replace(old,()=>replacement)
}

export function assertAuthenticationReadOnly(sql) {
 previousReadOnly(sql.replaceAll(prefix,previousPrefix))
}

export async function settingsReadinessInstallationSource(migration,options={}) {
 const {previous,source}=await reviewedSettingsReadiness(options)
 const reference='settings_readiness_reviewed'
 if(migration.split(start).length!==2||migration.split(end).length!==2||!migration.includes(start+source+end))
  throw Error('conversation_settings_readiness_definition_changed')
 const reviewed=once(receivingOwnerDeclaration(source,marker),'CREATE FUNCTION public.'+marker,'CREATE FUNCTION pg_temp.'+reference)
 const proof=`DO $settings_readiness_reference$ BEGIN
 EXECUTE ${literal(reviewed)};
END $settings_readiness_reference$;
DO $settings_readiness_catalog$
DECLARE actual pg_proc;reviewed pg_proc;owner_id oid;app_id oid;
BEGIN
 SELECT relowner INTO STRICT owner_id FROM pg_class WHERE oid='public.sessions'::regclass;
 SELECT oid INTO STRICT app_id FROM pg_roles WHERE rolname='app_user';
 SELECT * INTO STRICT reviewed FROM pg_proc WHERE oid='pg_temp.${reference}(integer)'::regprocedure;
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.${marker}(integer)');
 IF actual.oid IS NULL OR actual.proowner<>owner_id OR to_regprocedure('public.${marker}()') IS NOT NULL
  OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(app_id,owner_id,'EXECUTE',false)]
  OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
     (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl'])
 THEN RAISE EXCEPTION 'conversation_settings_readiness_function_changed';END IF;
END $settings_readiness_catalog$;`
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.'+previousPrefix+'publication_expected_current)::text'
 let sql=once(previous.sql,receipt,proof+'\n'+receipt+`||(SELECT to_jsonb(p) FROM pg_proc p WHERE p.oid='public.${marker}(integer)'::regprocedure)::text`)
 sql=once(sql,')::int functions,','+1)::int functions,').replaceAll(previousPrefix,prefix)
 assertAuthenticationReadOnly(sql)
 return {...previous,sql,cleanup:(previous.cleanup+`\nDROP FUNCTION pg_temp.${reference}(integer);`).replaceAll(previousPrefix,prefix),
  functions:previous.functions+1,sourceDigest:hash(migration),migrationSha:hash(migration)}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const [mode,target,...extra]=process.argv.slice(2)
 if(extra.length)throw Error('Use --candidate PATH or --check')
 const directory=new URL('../../migrations/',import.meta.url)
 const migration=new URL(settingsReadinessMigrationName,directory)
 const sql=await buildConversationSettingsReadinessCandidate()
 if(mode==='--candidate'&&target) await writeFile(resolve(target),sql,{mode:0o600,flag:'wx'})
 else if(mode==='--check'&&!target) {
  if(await readFile(migration,'utf8')!==sql)throw Error('conversation_settings_readiness_numbered_source_changed')
 } else if(!mode) {
  const hosted=new URL('../../../../../packages/api-platform/migrations/',import.meta.url)
  const files=(await Promise.all([readdir(directory),readdir(hosted)])).flat()
  if(files.some(file=>file.startsWith('8314_')))throw Error('conversation_settings_readiness_number_occupied')
  await writeFile(migration,sql,{flag:'wx'})
 } else throw Error('Use --candidate PATH or --check')
}
