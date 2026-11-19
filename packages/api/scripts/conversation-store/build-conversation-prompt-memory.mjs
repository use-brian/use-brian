// [COMP:api/native-chat-read-cost] Promote one bounded prompt Memory owner.
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { currentInstallationAuthenticationSource } from './installation-authentication-8301.mjs'

export const promptMemoryMigrationName = '8306_conversation_prompt_memory.sql'
export const promptMemorySignature = 'capture_native_prompt_memory_sections(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid)'
const previousName = '8301_conversation_receiving_owners.sql'
const owner = 'capture_native_prompt_memory_sections'
const literal = value => "'" + value.replaceAll("'", "''") + "'"
const sha = value => createHash('sha256').update(value).digest('hex')
const read = name => readFile(new URL(name, import.meta.url), 'utf8')

export function promptMemoryDefinition(source) {
  const begin = '-- BEGIN REVIEWED CONVERSATION PROMPT MEMORY\n'
  const end = '-- END REVIEWED CONVERSATION PROMPT MEMORY'
  if (source.split(begin).length !== 2 || source.split(end).length !== 2) {
    throw new Error('prompt_memory_source_manifest_changed')
  }
  return source.slice(source.indexOf(begin) + begin.length, source.indexOf(end))
}

/** Read-only equality with a source-compiled local reference. */
export function promptMemoryCatalogProof(definition, prefix) {
  const expected = `CREATE FUNCTION public.${owner}(`
  if (!definition.startsWith(expected) || definition.split('CREATE FUNCTION').length !== 2) {
    throw new Error('prompt_memory_source_declaration_changed')
  }
  const ref = prefix + 'prompt_memory_ref'
  const reference = definition.replace(expected, `CREATE FUNCTION pg_temp.${ref}(`)
  return `DO $prompt_memory_compile$ BEGIN
 EXECUTE ${literal(reference)};
END $prompt_memory_compile$;
DO $prompt_memory_current$
DECLARE actual pg_proc;reviewed pg_proc;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 runtime_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
BEGIN
 SELECT * INTO STRICT reviewed FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname='${ref}';
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.${promptMemorySignature}');
 IF actual.oid IS NULL OR actual.pronamespace<>'public'::regnamespace OR actual.proowner<>owner_id
  OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(runtime_id,owner_id,'EXECUTE',false)]
  OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
     (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl'])
 THEN RAISE EXCEPTION 'prompt_memory_executable_contract_changed';END IF;
END $prompt_memory_current$;
DROP FUNCTION pg_temp.${promptMemorySignature.replace(owner,ref)};`
}

export async function buildPromptMemoryCandidate() {
  const [predecessor, source, host] = await Promise.all([
    currentInstallationAuthenticationSource(),
    read('conversation-prompt-memory.sql'),
    read('../../src/db/memories.ts'),
  ])
  const aclBoundary = `REVOKE ALL ON FUNCTION public.${promptMemorySignature}`
  const anchor = 'AS $prompt$'
  if (source.split(aclBoundary).length !== 2 || source.split(anchor).length !== 2) {
    throw new Error('prompt_memory_source_boundaries_changed')
  }
  const [definitions, privileges] = source.split(aclBoundary)
  if (privileges.trim() !== `FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.${promptMemorySignature}
 TO app_user;`) throw new Error('prompt_memory_source_acl_changed')
  const declaration = definitions.slice(definitions.indexOf('CREATE FUNCTION '))
  const bodyStart = declaration.indexOf(anchor) + anchor.length
  const close = declaration.indexOf('$prompt$;', bodyStart)
  if (close < bodyStart || !host.includes(`const promptMemoryBodySha = '${sha(declaration.slice(bodyStart, close))}'`)) {
    throw new Error('prompt_memory_host_body_pin_changed')
  }
  return `-- [COMP:api/native-chat-read-cost] Exact native prompt Memory context acquisition.
BEGIN;
DO $prompt_memory_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') THEN
  RAISE EXCEPTION 'prompt_memory_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='${previousName}') THEN
  RAISE EXCEPTION 'prompt_memory_predecessor_missing';END IF;
END $prompt_memory_predecessor$;
${predecessor.sql}
-- BEGIN REVIEWED CONVERSATION PROMPT MEMORY
${declaration}-- END REVIEWED CONVERSATION PROMPT MEMORY
${aclBoundary}${privileges}
${promptMemoryCatalogProof(declaration,'a8306_')}
DO $prompt_memory_guard$ BEGIN
 IF public.native_turn_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'prompt_memory_original_contract_changed';END IF;
END $prompt_memory_guard$;
${predecessor.cleanup}
COMMIT;
`
}

const entry = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (entry) {
  const args = process.argv.slice(2)
  if (args.length && !(args.length === 1 && args[0] === '--check')
    && !(args.length === 2 && args[0] === '--candidate')) {
    throw new Error('Use --candidate PATH or --check')
  }
  const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url))
  const target = resolve(migrations, promptMemoryMigrationName)
  const sql = await buildPromptMemoryCandidate()
  if (args[0] === '--check') {
    if (await readFile(target,'utf8') !== sql) throw new Error('prompt_memory_generated_source_changed')
  } else if (args[0] === '--candidate') {
    await writeFile(resolve(args[1]), sql, {mode:0o600,flag:'wx'})
  } else {
    const files = await readdir(migrations)
    if (files.some(file => file.startsWith('8306_'))) throw new Error('prompt_memory_number_already_used')
    await writeFile(target, sql, {flag:'wx'})
  }
}
