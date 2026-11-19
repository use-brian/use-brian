// [COMP:api/native-turn-frame] Generate the committed-room source proof successor.
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executableProjection } from './executable-record.mjs'
import { routeBodyDigest } from './build-mixed-evidence-route.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8317.mjs'

const previousMigration = '8317_shared_room_resume_evidence.sql'
const resultSignature = 'native_conversation_publication_result(uuid,uuid,uuid)'
const helper = 'capture_committed_room_record_evidence'
const prefix = 'a8314_'
const previousRenderer = prefix + 'conversion_source_body'
const successorRenderer = 'committed_room_evidence_body'
const marker = ' proof:=capture_conversation_evidence(w,roots);'
const reference = 'committed_room_evidence_reviewed'
const literal = value => "'" + value.replaceAll("'", "''") + "'"
const hash = value => createHash('sha256').update(value).digest('hex')
export const committedRoomEvidenceMigration = '8318_committed_room_record_evidence.sql'

function replaceOnce(source, marker, replacement) {
  if (source.split(marker).length !== 2) throw Error('committed_room_evidence_source_changed: ' + marker.slice(0, 100))
  return source.replace(marker, () => replacement)
}

async function reviewedHelper() {
  const [source, ports] = await Promise.all([
    readFile(new URL('./committed-room-evidence.sql', import.meta.url), 'utf8'),
    routeBodyDigest(),
  ])
  const definition = replaceOnce(source, '__ROUTE_BODY_SHA__', ports.conversation_mixed_evidence_route)
  const body = definition.split('$committed_room$')
  if (body.length !== 3 || !body[1].startsWith('\nDECLARE ') || !body[1].endsWith('END ')) {
    throw Error('committed_room_evidence_definition_changed')
  }
  return { definition, bodySha: hash(body[1]) }
}

async function renderClause() {
  const { bodySha } = await reviewedHelper()
  const extension = `${marker}
 IF proof IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid='public.sessions'::regclass
   WHERE p.oid='public.${helper}(uuid,uuid,jsonb)'::regprocedure
   AND p.proowner=c.relowner AND p.prosecdef AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
   AND p.proacl=ARRAY[makeaclitem(c.relowner,c.relowner,'EXECUTE',false)]
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='${bodySha}')
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  proof:=public.${helper}(w,s,roots);
 END IF;`
  return `WHEN ${literal(resultSignature)} THEN
 marker:=${literal(marker)};
 IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'committed_room_evidence_placement_changed';END IF;
 body:=replace(body,marker,${literal(extension)});`
}

async function successorSql(clause) {
  const [consumers, installer] = await Promise.all([
    readFile(new URL('./conversion-original-consumers.sql', import.meta.url), 'utf8'),
    readFile(new URL('./conversion-install.mjs', import.meta.url), 'utf8'),
  ])
  const configure = source => source.replaceAll('publication_expected_current', prefix + 'publication_expected_current')
    .replaceAll('publication_successor_templates', prefix + 'publication_successor_templates')
    .replaceAll('pg_temp.conversion_source_body', 'pg_temp.' + successorRenderer)
  const start = installer.indexOf('DO $conversion_propagate$')
  const endMarker = 'END $conversion_propagate$;'
  const end = installer.indexOf(endMarker, start)
  if (start < 0 || end < start) throw Error('committed_room_evidence_propagation_missing')
  let propagate = configure(installer.slice(start, end + endMarker.length))
  propagate = replaceOnce(propagate, 'SET contract=after_row', 'SET contract=' + executableProjection('after_row'))
  propagate = replaceOnce(propagate, 'p IS DISTINCT FROM h.contract', executableProjection('p') + ' IS DISTINCT FROM h.contract')
  propagate = replaceOnce(propagate, 'to_jsonb(h.contract) IS DISTINCT FROM expected', 'h.contract IS DISTINCT FROM ' + executableProjection('actual'))
  const classify = replaceOnce(consumers, "WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
    `WHERE signature=${literal(resultSignature)};`)
  return `${configure(classify)}
CREATE FUNCTION pg_temp.${successorRenderer}(signature text,parts jsonb,successor boolean) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $committed_room_body$
DECLARE body text:=pg_temp.${previousRenderer}(signature,parts,successor);marker text;
BEGIN CASE signature
${clause}
ELSE NULL;END CASE;RETURN body;END $committed_room_body$;
${propagate}
DROP FUNCTION pg_temp.${successorRenderer}(text,jsonb,boolean);`
}

export async function buildCommittedRoomEvidenceMigration(options) {
  const [previous, clause, { definition }] = await Promise.all([previousSource(options), renderClause(), reviewedHelper()])
  return `-- [COMP:api/native-turn-frame] Reopen an exact committed publication with original same-room record evidence.
BEGIN;
DO $committed_room_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='${previousMigration}')
 OR to_regprocedure('public.${helper}(uuid,uuid,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'committed_room_evidence_predecessor_changed';END IF;
END $committed_room_predecessor$;
${previous.sql}
${definition}
${await successorSql(clause)}
DO $committed_room_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'committed_room_evidence_witness_changed';END IF;
END $committed_room_witness$;
${previous.cleanup}
COMMIT;\n`
}

export async function committedRoomEvidenceInstallationSource(migration, options) {
  const [previous, clause, { definition }] = await Promise.all([previousSource(options), renderClause(), reviewedHelper()])
  if (!migration.includes(definition) || migration.split(clause).length !== 2) {
    throw Error('committed_room_evidence_definition_changed')
  }
  const start = previous.sql.indexOf(`CREATE FUNCTION pg_temp.${previousRenderer}(signature text,parts jsonb,successor boolean)`)
  const endMarker = 'ELSE NULL; END CASE; RETURN body; END $private_page_body$;'
  const end = previous.sql.indexOf(endMarker, start) + endMarker.length
  if (start < 0 || end < start) throw Error('committed_room_evidence_renderer_missing')
  const renderer = replaceOnce(previous.sql.slice(start, end), endMarker, clause + '\n' + endMarker)
  let sql = previous.sql.slice(0, start) + renderer + previous.sql.slice(end)
  // Preserve the predecessor metadata and ACL comparison. This one body
  // moves to the final source-rendered comparison with its reviewed change.
  const earlyBodyCheck = "'native_worklist_source_capture(uuid,text,uuid,jsonb)') AND (actual.prosrc"
  sql = replaceOnce(sql, earlyBodyCheck,
    "'native_worklist_source_capture(uuid,text,uuid,jsonb)'," + literal(resultSignature) + ') AND (actual.prosrc')
  const ref = replaceOnce(definition.slice(0, definition.indexOf('\nREVOKE')), 'CREATE FUNCTION public.' + helper, 'CREATE FUNCTION pg_temp.' + reference)
  const probe = `DO $committed_room_reference$ BEGIN
 EXECUTE ${literal(ref)};
END $committed_room_reference$;
DO $committed_room_catalog$
DECLARE actual pg_proc;reviewed pg_proc;owner_id oid;
BEGIN
 SELECT relowner INTO STRICT owner_id FROM pg_class WHERE oid='public.sessions'::regclass;
 SELECT * INTO STRICT reviewed FROM pg_proc WHERE oid='pg_temp.${reference}(uuid,uuid,jsonb)'::regprocedure;
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.${helper}(uuid,uuid,jsonb)');
 IF actual.oid IS NULL OR actual.proowner IS DISTINCT FROM owner_id
  OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
  OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
     (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl'])
 THEN RAISE EXCEPTION 'installation_committed_room_evidence_changed';END IF;
END $committed_room_catalog$;`
  const receipt = 'SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.' + prefix + 'publication_expected_current)::text'
  sql = replaceOnce(sql, receipt, probe + '\n' + receipt
    + `||(SELECT to_jsonb(p) FROM pg_proc p WHERE p.oid='public.${helper}(uuid,uuid,jsonb)'::regprocedure)::text`)
  sql = replaceOnce(sql, ')::int functions,', '+1)::int functions,')
  assertAuthenticationReadOnly(sql)
  return { ...previous, sql, cleanup: previous.cleanup + `\nDROP FUNCTION pg_temp.${reference}(uuid,uuid,jsonb);`,
    functions: previous.functions + 1, sourceDigest: hash(migration), migrationSha: hash(migration) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, target, ...extra] = process.argv.slice(2)
  if (extra.length) throw Error('Use --candidate PATH or --check')
  const directory = new URL('../../migrations/', import.meta.url)
  const migration = new URL(committedRoomEvidenceMigration, directory)
  const sql = await buildCommittedRoomEvidenceMigration()
  if (mode === '--candidate' && target) await writeFile(resolve(target), sql, { mode: 0o600, flag: 'wx' })
  else if (mode === '--check' && !target) {
    if (await readFile(migration, 'utf8') !== sql) throw Error('committed_room_evidence_numbered_source_changed')
  } else if (!mode) {
    const hosted = new URL('../../../../../packages/api-platform/migrations/', import.meta.url)
    const files = (await Promise.all([readdir(directory), readdir(hosted)])).flat()
    if (files.some(file => file.startsWith('8318_'))) throw Error('committed_room_evidence_number_occupied')
    await writeFile(migration, sql, { flag: 'wx' })
  } else throw Error('Use --candidate PATH or --check')
}
