// [COMP:api/conversation-visibility] Public history and turn authority.
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentInstallationAuthenticationSource } from './installation-authentication-8309.mjs'

const foundation = '8295_conversation_envelope_foundation.sql'
const foundationSha = '6b3a12c236cf24cbafad9d467a9918a10ffba717faeabd68f866262dc5b6b975'
const predecessorMarker = " WHEN w IS NOT NULL AND NOT historical AND ((s.guest_session_token IS NOT NULL OR s.channel_type='api')"
const memberBranch = " WHEN w IS NOT NULL AND NOT historical AND s.channel_type='api' AND member_now THEN 'private_by_kind'\n"
const sqlSourceDirectory = fileURLToPath(new URL('./', import.meta.url))
const defaultSourceRoot = fileURLToPath(new URL('../../', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')

export const publicReceivingSectionStart = '-- BEGIN REVIEWED PUBLIC CONVERSATION RECEIVING\n'
export const publicReceivingSectionEnd = '-- END REVIEWED PUBLIC CONVERSATION RECEIVING'
export const publicReceivingMigrationName = '8310_conversation_public_receiving.sql'

export async function reviewedPublicConversationReceiving(options = {}) {
  const sourceRoot = options.sourceRoot ?? defaultSourceRoot
  const [original, receiving] = await Promise.all([
    readFile(resolve(sourceRoot, 'migrations', foundation), 'utf8'),
    readFile(resolve(sqlSourceDirectory, 'conversation-public-history.sql'), 'utf8'),
  ])
  if (hash(original) !== foundationSha) throw Error('conversation_public_foundation_source_changed')
  const start = 'CREATE FUNCTION classify_conversation_envelope('
  const end = '\nREVOKE ALL ON FUNCTION classify_conversation_envelope(uuid,boolean)'
  const declaration = start + original.split(start)[1]?.split(end)[0]
  if (declaration.split(predecessorMarker).length !== 2) throw Error('conversation_public_classifier_source_changed')
  const reference = declaration.replace(start, 'CREATE FUNCTION pg_temp.public_conversation_classifier_predecessor(')
  const classifier = declaration.replace(start, 'CREATE OR REPLACE FUNCTION public.classify_conversation_envelope(')
    .replace(predecessorMarker, memberBranch + predecessorMarker)
  return { reference, classifier, receiving, source: [classifier, receiving].join('\n') }
}

export async function buildConversationPublicReceivingCandidate(options = {}) {
  const [previous, { reference, source }] = await Promise.all([
    currentInstallationAuthenticationSource(options), reviewedPublicConversationReceiving(options),
  ])
  return `-- [COMP:api/conversation-visibility] Credential-bound public conversation owners.
BEGIN;
DO $public_receiving_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8309_conversation_record_lineage.sql')
 OR to_regprocedure('public.conversation_visibility_settings_ready()') IS NOT NULL
 THEN RAISE EXCEPTION 'conversation_public_receiving_predecessor_changed';END IF;
END $public_receiving_predecessor$;
${previous.sql}
${reference}
DO $public_receiving_classifier$ DECLARE previous pg_proc;reviewed pg_proc;owner_id oid;BEGIN
 SELECT relowner INTO STRICT owner_id FROM pg_class WHERE oid='public.sessions'::regclass;
 SELECT * INTO STRICT reviewed FROM pg_proc WHERE oid='pg_temp.public_conversation_classifier_predecessor(uuid,boolean)'::regprocedure;
 SELECT * INTO STRICT previous FROM pg_proc WHERE oid='public.classify_conversation_envelope(uuid,boolean)'::regprocedure;
 IF previous.proowner<>owner_id
 OR previous.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
 OR (to_jsonb(previous)-ARRAY['oid','proname','pronamespace','proacl'])
  IS DISTINCT FROM (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl'])
 THEN RAISE EXCEPTION 'conversation_public_classifier_predecessor_changed';END IF;
END $public_receiving_classifier$;
DROP FUNCTION pg_temp.public_conversation_classifier_predecessor(uuid,boolean);
${publicReceivingSectionStart}${source}${publicReceivingSectionEnd}
DO $public_receiving_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE THEN RAISE EXCEPTION 'conversation_public_receiving_witness_changed';END IF;
END $public_receiving_witness$;
${previous.cleanup}
COMMIT;\n`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, target, ...rest] = process.argv.slice(2)
  const directory = new URL('../../migrations/', import.meta.url)
  const migration = new URL(publicReceivingMigrationName, directory)
  const sql = await buildConversationPublicReceivingCandidate()
  if (mode === '--candidate' && target && !rest.length) {
    await writeFile(resolve(target), sql, { mode: 0o600, flag: 'wx' })
  } else if (mode === '--check' && !target) {
    if (await readFile(migration, 'utf8') !== sql) throw Error('conversation_public_receiving_numbered_source_changed')
  } else if (mode === undefined) {
    const hosted = new URL('../../../../../packages/api-platform/migrations/', import.meta.url)
    const both = (await Promise.all([readdir(directory), readdir(hosted)])).flat()
    if (both.some(file => file.startsWith('8310_'))) throw Error('conversation_public_receiving_number_occupied')
    await writeFile(migration, sql, { flag: 'wx' })
  } else {
    throw Error('Use --candidate PATH or --check')
  }
}
