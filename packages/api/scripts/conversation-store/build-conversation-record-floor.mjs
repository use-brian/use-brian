// [COMP:api/conversation-visibility] Install an exact revision of two existing
// publication helpers and the legacy continuation transition.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentInstallationAuthenticationSource as installed8306 } from './installation-authentication-8306.mjs'
import { receivingOwnerDeclaration } from './build-conversation-receiving-owners.mjs'
import { fusedRecordFloorChanges, fusedRecordFloorSignature, recordFloorChanges, recordFloorRenderer } from './conversation-record-floor.mjs'
import { executableProjection } from './executable-record.mjs'

const read = name => readFile(new URL(name, import.meta.url), 'utf8')
const q = value => "'" + value.replaceAll("'", "''") + "'"
export const recordFloorMigrationName = '8307_conversation_record_floor.sql'
function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('conversation_floor_source_changed: ' + before.slice(0, 80))
  return source.replace(before, () => after)
}

export async function reviewedRecordFloorDeclarations() {
  const base = await read('../../migrations/8297_conversation_record_admission.sql')
  const promotion = receivingOwnerDeclaration(base, 'mutate_conversation_settings')
  const combined = `  IF public.enroll_conversation_legacy_history(sid) IS NOT TRUE
   OR public.conversation_legacy_enrolled(sid,w,actor,s.assistant_id) IS NOT TRUE
  THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;`
  const promote = once(promotion, combined, `  IF public.enroll_conversation_legacy_history(sid) IS NOT TRUE
  THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;
  IF public.conversation_legacy_enrolled(sid,w,actor,s.assistant_id) IS NOT TRUE
  THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;`)
  const targets = receivingOwnerDeclaration(base, 'withdraw_conversation_record_targets')
  const begin = '  UPDATE public.conversation_envelopes e SET record_data_revision'
  const end = ' THEN 1 ELSE 0 END WHERE e.session_id=target.session_id;'
  const update = targets.slice(targets.indexOf(begin), targets.indexOf(end) + end.length)
  const match = update.match(/version=e\.version\+CASE WHEN (EXISTS\([\s\S]+?\))\s+THEN 1 ELSE 0 END/)
  if (!match) throw Error('conversation_floor_capture_watermark_source_changed')
  const withdraw = once(targets, update, `  WITH change AS MATERIALIZED (
   SELECT ${match[1]} AS advances
   FROM public.conversation_envelopes e WHERE e.session_id=target.session_id
  )
  UPDATE public.conversation_envelopes e SET record_data_revision=e.record_data_revision+1,
   record_dirty_from=least(e.record_dirty_from,(SELECT min((item->>'sequence')::integer) FROM jsonb_array_elements(targets) item
    WHERE (item->>'sessionId')::uuid=e.session_id)),
   version=e.version+change.advances::integer,
   record_captured_through=CASE WHEN change.advances THEN 0 ELSE e.record_captured_through END,
   record_topic_captured_through=CASE WHEN change.advances THEN 0 ELSE e.record_topic_captured_through END
  FROM change WHERE e.session_id=target.session_id;`)
  return [
    { name: 'mutate_conversation_settings', original: promotion, successor: promote },
    { name: 'withdraw_conversation_record_targets', original: targets, successor: withdraw },
  ]
}

export async function buildRecordFloorCandidate() {
  const prefix = 'a8306_', name = 'record_floor_successor_body'
  const [predecessor, installer, originalConsumers, declarations] = await Promise.all([
    installed8306(),
    read('conversion-install.mjs'), read('conversion-original-consumers.sql'), reviewedRecordFloorDeclarations(),
  ])
  const contextualize = source => source.replaceAll('publication_expected_current', prefix + 'publication_expected_current')
    .replaceAll('publication_successor_templates', prefix + 'publication_successor_templates')
    .replaceAll('pg_temp.conversion_source_body', 'pg_temp.' + name)
  const owned = Object.keys(recordFloorChanges)
  const consumers = contextualize(once(originalConsumers,
    "WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
    `WHERE signature IN(${owned.map(q).join(',')});`))
  const start = installer.indexOf('DO $conversion_propagate$')
  const end = installer.indexOf('END $conversion_propagate$;', start)
  if (start < 0 || end < start) throw Error('conversation_floor_propagation_source_changed')
  let propagate = contextualize(installer.slice(start, end + 'END $conversion_propagate$;'.length))
  propagate = once(propagate, 'SET contract=after_row', 'SET contract=' + executableProjection('after_row'))
  propagate = once(propagate, 'p IS DISTINCT FROM h.contract', executableProjection('p') + ' IS DISTINCT FROM h.contract')
  propagate = once(propagate, 'to_jsonb(h.contract) IS DISTINCT FROM expected', 'h.contract IS DISTINCT FROM ' + executableProjection('actual'))
  const fused = `DO $conversation_floor_fused$
DECLARE actual pg_proc;changed pg_proc;old_hash text;body text;definition text;marker text;
BEGIN
 SELECT * INTO STRICT actual FROM pg_proc WHERE oid='public.${fusedRecordFloorSignature}'::regprocedure;
 IF NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=${q(fusedRecordFloorSignature)}
  AND h.contract=${executableProjection('actual')}) THEN
  RAISE EXCEPTION 'conversation_floor_fused_registry_changed';END IF;
 old_hash:=encode(sha256(convert_to(to_jsonb(actual)::text,'UTF8')),'hex');
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace)
    AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast' AND position(old_hash in p.prosrc)>0)
 THEN RAISE EXCEPTION 'conversation_floor_fused_unreviewed_pin_consumer';END IF;
 body:=actual.prosrc;
 ${fusedRecordFloorChanges.map(([before, after, count])=>`marker:=${q(before)};
 IF (length(body)-length(replace(body,marker,'')))/length(marker)<>${count} THEN
  RAISE EXCEPTION 'conversation_floor_fused_predecessor_changed';END IF;
 body:=replace(body,marker,${q(after)});`).join('\n ')}
 definition:=pg_get_functiondef(actual.oid);
 IF (length(definition)-length(replace(definition,actual.prosrc,'')))/length(actual.prosrc)<>1 THEN
  RAISE EXCEPTION 'conversation_floor_fused_declaration_changed';END IF;
 EXECUTE replace(definition,actual.prosrc,body);
 SELECT * INTO STRICT changed FROM pg_proc WHERE oid=actual.oid;
 IF to_jsonb(changed) IS DISTINCT FROM jsonb_set(to_jsonb(actual),'{prosrc}',to_jsonb(body)) THEN
  RAISE EXCEPTION 'conversation_floor_fused_metadata_changed';END IF;
 UPDATE public.native_turn_contract_helpers SET contract=${executableProjection('changed')}
 WHERE signature=${q(fusedRecordFloorSignature)};
END $conversation_floor_fused$;`
  return `-- [COMP:api/conversation-visibility] Canonical Project floor and legacy continuation.
BEGIN;
DO $conversation_floor_predecessor$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
  RAISE EXCEPTION 'conversation_floor_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8306_conversation_prompt_memory.sql') THEN
  RAISE EXCEPTION 'conversation_floor_predecessor_unavailable';END IF;
END $conversation_floor_predecessor$;
${predecessor.sql}
${consumers}
${recordFloorRenderer(name, prefix + 'conversion_source_body')}
${fused}
${propagate}
-- BEGIN REVIEWED CONVERSATION RECORD FLOOR
${declarations.map(change => change.successor.replace('CREATE FUNCTION ', 'CREATE OR REPLACE FUNCTION ')).join('\n')}
-- END REVIEWED CONVERSATION RECORD FLOOR
DO $conversation_floor_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_floor_witness_changed';END IF;
END $conversation_floor_witness$;
DROP FUNCTION pg_temp.${name}(text,jsonb,boolean);
${predecessor.cleanup}
COMMIT;\n`
}

const entry = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (entry) {
  const args = process.argv.slice(2)
  if (args.length && !(args.length===1 && args[0]==='--check') && !(args.length===2 && args[0]==='--candidate'))
    throw Error('Use --candidate PATH or --check')
  const directory = new URL('../../migrations/',import.meta.url)
  const target = new URL(recordFloorMigrationName,directory)
  const sql = await buildRecordFloorCandidate()
  if (args[0]==='--check') {
    if (await readFile(target,'utf8')!==sql) throw Error('record_floor_numbered_source_changed')
  } else if (args[0]==='--candidate') {
    await writeFile(resolve(args[1]),sql,{mode:0o600,flag:'wx'})
  } else {
    const hosted = new URL('../../../../../packages/api-platform/migrations/',import.meta.url)
    const both = (await Promise.all([readdir(directory),readdir(hosted).catch(error => { if(error.code==='ENOENT')return [];throw error })])).flat()
    if (both.some(file=>file.startsWith('8307_'))) throw Error('record_floor_migration_number_occupied')
    await writeFile(target,sql,{flag:'wx'})
  }
}
