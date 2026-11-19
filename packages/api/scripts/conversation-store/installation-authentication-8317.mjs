// [COMP:brain/session-resume-worker] Authenticate both shared-room resume ports.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8316.mjs'

const migrationName = '8317_shared_room_resume_evidence.sql'
const migrationSha = '84d43e737f3e95af618f224070642342ed026b3d0ed3a882f6d1965ac2d22f4e'
const ports = [
  ['lock_shared_room_resume_evidence', 'uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb,boolean', '$resume_evidence$', false],
  ['capture_shared_room_resume_evidence', 'uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb', '$capture$', true],
]
const literal = text => "'" + text.replaceAll("'", "''") + "'"

function replaceOnce(source, marker, replacement) {
  if (source.split(marker).length !== 2) throw Error('shared_room_resume_evidence_predecessor_changed')
  return source.replace(marker, () => replacement)
}

export async function currentInstallationAuthenticationSource({
  sourceRoot = fileURLToPath(new URL('../../', import.meta.url)),
} = {}) {
  const migration = await readFile(resolve(sourceRoot, 'migrations', migrationName), 'utf8')
  if (createHash('sha256').update(migration).digest('hex') !== migrationSha) throw Error('installation_source_migration_changed')
  const previous = await previousSource({ sourceRoot })
  const declarations = ports.map(([name, args, tag, exposed]) => {
    const start = 'CREATE FUNCTION public.' + name + '('
    const position = migration.indexOf(start)
    const closing = migration.indexOf('\nEND ' + tag + ';', position)
    if (position < 0 || closing < 0) throw Error('shared_room_resume_evidence_definition_changed')
    const temp = 'pg_temp.a8314_reviewed_' + name
    const sql = migration.slice(position, closing + ('\nEND ' + tag + ';').length)
      .replace(start, 'CREATE FUNCTION ' + temp + '(')
    return { sql, actual: 'public.' + name + '(' + args + ')', reference: temp + '(' + args + ')', exposed }
  })
  const probe = `DO $shared_room_resume_reference$ BEGIN
 ${declarations.map(port => 'EXECUTE ' + literal(port.sql) + ';').join('\n ')}
END $shared_room_resume_reference$;
DO $shared_room_resume_catalog$
DECLARE port record;actual pg_proc;reviewed pg_proc;owner_id oid;app_id oid;
BEGIN
 SELECT relowner INTO STRICT owner_id FROM pg_class WHERE oid='public.sessions'::regclass;
 SELECT oid INTO STRICT app_id FROM pg_roles WHERE rolname='app_user';
 FOR port IN SELECT * FROM (VALUES ${declarations.map(port =>
  '(' + [literal(port.actual), literal(port.reference), String(port.exposed)].join(',') + ')').join(',')})
  reviewed_ports(signature,reference,exposed) LOOP
  SELECT * INTO STRICT reviewed FROM pg_proc WHERE oid=to_regprocedure(port.reference);
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(port.signature);
  IF actual.oid IS NULL OR actual.proowner IS DISTINCT FROM owner_id
   OR actual.proacl IS DISTINCT FROM (CASE WHEN port.exposed THEN
    ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(app_id,owner_id,'EXECUTE',false)]
    ELSE ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)] END)
   OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
    (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl'])
  THEN RAISE EXCEPTION 'installation_shared_room_resume_evidence_changed: %',port.signature; END IF;
 END LOOP;
END $shared_room_resume_catalog$;`
  const receipt = 'SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8314_publication_expected_current)::text'
  const extraDigest = declarations.map(port =>
    "||(SELECT to_jsonb(p) FROM pg_proc p WHERE p.oid='" + port.actual + "'::regprocedure)::text").join('')
  let sql = replaceOnce(previous.sql, receipt, probe + '\n' + receipt + extraDigest)
  sql = replaceOnce(sql, ')::int functions,', '+2)::int functions,')
  assertAuthenticationReadOnly(sql)
  return { ...previous, sql, cleanup: previous.cleanup + '\n' + declarations.map(port => 'DROP FUNCTION ' + port.reference + ';').join('\n'),
    functions: previous.functions + 2, sourceDigest: migrationSha, migrationSha }
}

export async function authenticateConversationInstallation(client, options) {
  if (client?.getTransactionStatus?.() !== 'I') throw Error('installation_authentication_requires_idle_owner')
  const source = await currentInstallationAuthenticationSource(options)
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  try {
    const result = await client.query(source.sql)
    const row = (Array.isArray(result) ? result.at(-1) : result)?.rows?.[0]
    if (!row || row.functions !== source.functions || !/^[a-f0-9]{64}$/.test(row.local_digest) || row.witness_current !== true)
      throw Error('installation_authentication_receipt_malformed')
    await client.query(source.cleanup)
    await client.query('COMMIT')
    return Object.freeze({ format: 1, sourceDefinitionDigest: source.sourceDigest, functions: row.functions,
      localContractDigest: row.local_digest, witnessCurrent: row.witness_current })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}
