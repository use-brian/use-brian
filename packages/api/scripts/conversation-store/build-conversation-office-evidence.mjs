// [COMP:api/native-turn-frame] Generate the reviewed Office provenance successor and witness.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { replacements } from './conversation-office-evidence-clauses.mjs'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8323.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const previousMigration = '8324_crm_summary_declared_lineage.sql'
const prefix = 'a8314_'
const priorRenderer = prefix + 'conversion_source_body'
const successorRenderer = 'conversation_office_evidence_body'
const endRenderer = 'ELSE NULL; END CASE; RETURN body; END $private_page_body$;'
const literal = value => "'" + value.replaceAll("'", "''") + "'"
export const reviewedRoutines = Object.keys(replacements)
export const officeMigration = '8325_conversation_office_observation.sql'

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) {
    throw Error('conversation_office_evidence_source_changed: ' + before.slice(0,100))
  }
  return source.replace(before, () => after)
}

const editsSql = edits => edits.map(([before,after]) => ` marker:=${literal(before)};
 IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'conversation_office_evidence_placement_changed: % (% occurrences of %)',signature,
   (length(body)-length(replace(body,marker,'')))/length(marker),left(marker,160);
 END IF;
 body:=replace(body,marker,${literal(after)});`).join('\n')
const caseFor = (signature, edits) => `WHEN ${literal(signature)} THEN\n${editsSql(edits)}`
const statements = Object.entries(replacements).map(([signature, edits]) => caseFor(signature,edits)).join('\n')

export function currentOfficeSource(previous) {
  const start = previous.sql.indexOf(`CREATE FUNCTION pg_temp.${priorRenderer}(signature text,parts jsonb,successor boolean)`)
  const end = previous.sql.indexOf(endRenderer, start) + endRenderer.length
  if (start < 0 || end < start) throw Error('conversation_office_evidence_renderer_missing')
  let source = previous.sql.slice(start, end)
  // Append to the renderer's existing successor branches. A new branch
  // owns a change only if its exact existing body contains every marker.
  for (const [signature,edits] of Object.entries(replacements)) {
    const branch = `WHEN ${literal(signature)} THEN`
    const startBranch = source.indexOf(branch)
    if (startBranch < 0) {
      source = replaceOnce(source, endRenderer, caseFor(signature,edits)+'\n'+endRenderer)
      continue
    }
    const match = /\n(?:WHEN |ELSE NULL; END CASE;)/.exec(source.slice(startBranch + branch.length))
    if (!match) throw Error('conversation_office_evidence_branch_end_missing: '+signature)
    const endBranch = startBranch + branch.length + match.index
    source = source.slice(0,endBranch) + '\n' + editsSql(edits) + source.slice(endBranch)
  }
  let sql = previous.sql.slice(0, start) + source + previous.sql.slice(end)
  const earlyBodyCheck = "'native_worklist_source_capture(uuid,text,uuid,jsonb)','native_conversation_publication_result(uuid,uuid,uuid)') AND (actual.prosrc"
  sql = replaceOnce(sql, earlyBodyCheck,
    "'native_worklist_source_capture(uuid,text,uuid,jsonb)','native_conversation_publication_result(uuid,uuid,uuid)','conversation_dag(uuid,jsonb,jsonb)','native_turn_frame_payload_shape(jsonb)') AND (actual.prosrc")
  const compiled = 'native_conversation_compiled_frame_pair(uuid,uuid)'
  const callStart = `pg_temp.a8314_page_delivery_early_body((spec->>'name')`
  const callEnd = 'ELSE reference.prosrc END),true)'
  const earlyStart = sql.indexOf(callStart)
  const earlyLast = sql.indexOf(callEnd,earlyStart) + callEnd.length
  if (earlyStart < 0 || earlyLast < earlyStart) throw Error('conversation_office_early_compiled_source_missing')
  const [priorMark,nextMark] = replacements[compiled][0]
  const call = sql.slice(earlyStart,earlyLast)
  sql = sql.slice(0,earlyStart) +
    `CASE WHEN spec->>'name'='native_conversation_compiled_frame_pair' THEN replace(${call},${literal(priorMark)},${literal(nextMark)}) ELSE ${call} END` +
    sql.slice(earlyLast)
  // The fused admission module still authenticates its original graph template.
  // The main source-rendered comparison above authenticates the new graph body.
  const fused = "WHEN x.signature IN('conversation_message_snapshot(uuid,uuid,jsonb)','session_context_parent_snapshot(uuid,uuid)') THEN"
  sql = replaceOnce(sql,fused,`WHEN x.signature='conversation_dag(uuid,jsonb,jsonb)' THEN
  pg_temp.a8314_page_delivery_predecessor_body(x.signature,(SELECT parts FROM pg_temp.a8314_publication_successor_templates WHERE signature=x.signature),true)
  ${fused}`)
  assertAuthenticationReadOnly(sql)
  return { ...previous, sql }
}

export async function buildOfficeMigration(options) {
  const previous = await previousSource(options)
  const read = file => readFile(resolve(sourceDirectory, file), 'utf8')
  const { executableProjection } = await import('./executable-record.mjs')
  const [consumers, installer] = await Promise.all([read('conversion-original-consumers.sql'), read('conversion-install.mjs')])
  const configure = source => source.replaceAll('publication_expected_current', prefix + 'publication_expected_current')
    .replaceAll('publication_successor_templates', prefix + 'publication_successor_templates')
    .replaceAll('pg_temp.conversion_source_body', 'pg_temp.' + successorRenderer)
  const start = installer.indexOf('DO $conversion_propagate$')
  const endMarker = 'END $conversion_propagate$;'
  const end = installer.indexOf(endMarker, start)
  if (start < 0 || end < start) throw Error('conversation_office_evidence_propagation_missing')
  let propagate = configure(installer.slice(start, end + endMarker.length))
  propagate = replaceOnce(propagate, 'SET contract=after_row', 'SET contract=' + executableProjection('after_row'))
  propagate = replaceOnce(propagate, 'p IS DISTINCT FROM h.contract', executableProjection('p') + ' IS DISTINCT FROM h.contract')
  propagate = replaceOnce(propagate, 'to_jsonb(h.contract) IS DISTINCT FROM expected', 'h.contract IS DISTINCT FROM ' + executableProjection('actual'))
  const signatures = reviewedRoutines.map(literal).join(',')
  const classify = replaceOnce(consumers, "WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
    `WHERE signature IN(${signatures});`)
  return `-- [COMP:api/native-turn-frame] Keep current Office observations in retained conversation lineage.
BEGIN;
DO $conversation_office_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${literal(previousMigration)})
 THEN RAISE EXCEPTION 'conversation_office_evidence_predecessor_changed';END IF;
END $conversation_office_predecessor$;
${previous.sql}
${configure(classify)}
CREATE FUNCTION pg_temp.${successorRenderer}(signature text,parts jsonb,successor boolean) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $conversation_office_body$
DECLARE body text:=pg_temp.${priorRenderer}(signature,parts,successor);marker text;
BEGIN CASE signature
${statements}
ELSE NULL;END CASE;RETURN body;END $conversation_office_body$;
${propagate}
DROP FUNCTION pg_temp.${successorRenderer}(text,jsonb,boolean);
DO $conversation_office_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_office_evidence_witness_changed';END IF;
END $conversation_office_witness$;
${previous.cleanup}
COMMIT;
`
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, output, ...extra] = process.argv.slice(2)
  if (extra.length) throw Error('Use --candidate PATH or --check')
  const migration = new URL('../../migrations/' + officeMigration, import.meta.url)
  const sql = await buildOfficeMigration()
  if (mode === '--candidate' && output) await writeFile(resolve(output), sql, { flag: 'wx', mode: 0o600 })
  else if (mode === '--check' && !output) {
    if (await readFile(migration, 'utf8') !== sql) throw Error('conversation_office_numbered_source_changed')
  } else throw Error('Use --candidate PATH or --check')
}
