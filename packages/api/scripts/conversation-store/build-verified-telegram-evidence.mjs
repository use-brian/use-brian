// [COMP:api/telegram-conversation-context] Render and authenticate the normal provider-room evidence owner.
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8318.mjs'
import { committedRoomEvidenceMigration } from './build-committed-room-evidence.mjs'

const helper = 'capture_verified_telegram_conversation_evidence'
const reference = 'verified_telegram_conversation_evidence_reviewed'
const argumentsSql = 'uuid,uuid,uuid,uuid,text,uuid,text,bigint,bigint,uuid,text,text,jsonb'
const signature = 'public.' + helper + '(' + argumentsSql + ')'
const beginDefinition = '-- BEGIN REVIEWED VERIFIED TELEGRAM OWNER\n'
const endDefinition = '-- END REVIEWED VERIFIED TELEGRAM OWNER'
const hash = value => createHash('sha256').update(value).digest('hex')
const literal = value => "'" + value.replaceAll("'", "''") + "'"
const readDeclaration = () => readFile(new URL('./verified-telegram-evidence.sql', import.meta.url), 'utf8')

export const verifiedTelegramEvidenceMigration = '8323_verified_telegram_conversation_evidence.sql'

function replaceOnce(source, marker, replacement) {
  if (source.split(marker).length !== 2) throw Error('verified_telegram_source_changed')
  return source.replace(marker, () => replacement)
}

async function buildVerifiedTelegramEvidenceMigration(options) {
  const [previous, definition] = await Promise.all([previousSource(options), readDeclaration()])
  return `-- [COMP:api/telegram-conversation-context] Add the verified normal provider room evidence owner.
BEGIN;
DO $verified_telegram_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='${committedRoomEvidenceMigration}')
 OR to_regprocedure('${signature}') IS NOT NULL
 THEN RAISE EXCEPTION 'verified_telegram_predecessor_changed'; END IF;
END $verified_telegram_predecessor$;
${previous.sql}
${beginDefinition}${definition}${endDefinition}
${previous.cleanup}
COMMIT;\n`
}

export async function verifiedTelegramEvidenceInstallationSource(migration, options) {
  const [previous, definition] = await Promise.all([previousSource(options), readDeclaration()])
  if (migration !== await buildVerifiedTelegramEvidenceMigration(options)) throw Error('verified_telegram_migration_changed')
  const declaration = definition.slice(0,definition.indexOf('\nREVOKE'))
  const referenceDeclaration = replaceOnce(declaration,'CREATE FUNCTION public.' + helper,'CREATE FUNCTION pg_temp.' + reference)
  const probe = `DO $verified_telegram_reference$ BEGIN
 EXECUTE ${literal(referenceDeclaration)};
END $verified_telegram_reference$;
DO $verified_telegram_catalog$
DECLARE actual pg_proc;reviewed pg_proc;owner_id oid;app_id oid;
BEGIN
 SELECT relowner INTO STRICT owner_id FROM pg_class WHERE oid='public.sessions'::regclass;
 SELECT oid INTO STRICT app_id FROM pg_roles WHERE rolname='app_user';
 SELECT * INTO STRICT reviewed FROM pg_proc WHERE oid='pg_temp.${reference}(${argumentsSql})'::regprocedure;
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('${signature}');
 IF actual.oid IS NULL OR actual.proowner IS DISTINCT FROM owner_id
  OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(app_id,owner_id,'EXECUTE',false)]
  OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
     (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl'])
 THEN RAISE EXCEPTION 'installation_verified_telegram_owner_changed'; END IF;
END $verified_telegram_catalog$;`
  const receipt = 'SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8314_publication_expected_current)::text'
  let sql = replaceOnce(previous.sql, receipt, probe + '\n' + receipt
    + `||(SELECT to_jsonb(p) FROM pg_proc p WHERE p.oid='${signature}'::regprocedure)::text`)
  sql = replaceOnce(sql, ')::int functions,', '+1)::int functions,')
  assertAuthenticationReadOnly(sql)
  return { ...previous, sql, cleanup: previous.cleanup + `\nDROP FUNCTION pg_temp.${reference}(${argumentsSql});`,
    functions: previous.functions + 1, sourceDigest: hash(migration), migrationSha: hash(migration) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, target, ...extra] = process.argv.slice(2)
  if (extra.length) throw Error('Use --candidate PATH or --check')
  const directory = new URL('../../migrations/', import.meta.url)
  const migration = new URL(verifiedTelegramEvidenceMigration, directory)
  const sql = await buildVerifiedTelegramEvidenceMigration()
  if (mode === '--candidate' && target) await writeFile(resolve(target), sql, { mode: 0o600, flag: 'wx' })
  else if (mode === '--check' && !target) {
    if (await readFile(migration, 'utf8') !== sql) throw Error('verified_telegram_numbered_source_changed')
  } else if (!mode) {
    const hosted = new URL('../../../../../packages/api-platform/migrations/', import.meta.url)
    const files = (await Promise.all([readdir(directory), readdir(hosted)])).flat()
    if (files.some(file => file.startsWith('8323_'))) throw Error('verified_telegram_evidence_number_occupied')
    await writeFile(migration, sql, { flag: 'wx' })
  }
}
