// [COMP:api/native-turn-frame] Generate the reviewed retained Memory candidate scan.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { genericSignature } from './fused-admission.mjs'
import { executableProjection } from './executable-record.mjs'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8328.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'

const memoryMigration = '8329_conversation_memory_query_candidates.sql'
const predecessor = '8328_conversation_graph_frontier.sql'
const defaultSourceRoot = fileURLToPath(new URL('../../', import.meta.url))
const prefix = 'a8314_'
const priorRenderer = prefix + 'conversion_source_body'
const successorRenderer = 'conversation_memory_candidates_body'
const sha = value => createHash('sha256').update(value).digest('hex')
const literal = value => "'" + value.replaceAll("'", "''") + "'"

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw Error('conversation_memory_candidates_installation_source_changed: ' + before.slice(0, 120))
  return source.replace(before, () => after)
}

const evidenceSource = await readFile(new URL('evidence.sql', import.meta.url), 'utf8')
const scanStart = '   FOR candidate IN SELECT id FROM memories WHERE workspace_id=w ORDER BY id LOOP'
const scanEnd = '  FOR dependency IN SELECT array_agg(cohort_source.node'
const start = evidenceSource.indexOf(scanStart)
const end = evidenceSource.indexOf(scanEnd, start)
if (start < 0 || end <= start) throw Error('conversation_memory_candidates_predecessor_scan_changed')
const oldScan = evidenceSource.slice(start, end)
const newScan = `   IF jsonb_typeof(selector.domain->'candidates') IS DISTINCT FROM 'array'
    THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
   -- Lock the complete bounded workspace cohort under this query's existing
   -- snapshot. A live source can return after a grant changes. A retired source
   -- can participate only as an exact original ID/version of this query domain.
   WITH frozen AS MATERIALIZED (
    SELECT c->>'id' id,c->>'version' version FROM jsonb_array_elements(selector.domain->'candidates') c
   ), locked AS MATERIALIZED (
    SELECT m.id,m.scope_version,m.scope_held,m.sensitivity,m.compartments,m.project_ids,m.valid_to
    FROM public.memories m WHERE m.workspace_id=w ORDER BY m.id
    LIMIT (4097-attempts) FOR SHARE
   ), candidates AS (
    SELECT m.id,m.scope_version FROM locked m WHERE (m.valid_to IS NULL OR EXISTS(
     SELECT 1 FROM frozen f WHERE f.id=m.id::text AND f.version=m.scope_version::text))
    AND NOT m.scope_held AND application_query_scope_admits_point(selector.domain->'bounds',
     jsonb_build_object('sensitivity',m.sensitivity,'compartments',m.compartments,'projectIds',m.project_ids)) IS TRUE
   )
   SELECT (SELECT count(*) FROM locked)::integer,
    coalesce(jsonb_agg(jsonb_build_object('kind','memory','id',c.id,'version',c.scope_version::text) ORDER BY c.id),'[]'::jsonb)
    INTO candidate_count,selected FROM candidates c;
   attempts:=attempts+candidate_count;
   IF attempts>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
   candidate_sources:=candidate_sources||selected;
  END LOOP;
`

const edits = [
  ['selector record;candidate record;candidate_sources', 'selector record;candidate_count integer;selected jsonb;candidate_sources'],
  [oldScan, newScan],
].map(([before, after]) => `
  marker:=${literal(before)};
  IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1
  THEN RAISE EXCEPTION 'conversation_memory_candidate_marker_changed: %',left(marker,120);END IF;
  body:=replace(body,marker,${literal(after)});`).join('')
const renderSuccessor = `IF signature=${literal(genericSignature)} AND successor THEN${edits}
 END IF;`

function reviewedAuthentication(previous) {
  const header = `CREATE FUNCTION pg_temp.${priorRenderer}(signature text,parts jsonb,successor boolean)`
  const tail = ' RETURN body; END $private_page_body$;'
  const start = previous.sql.indexOf(header)
  const finish = previous.sql.indexOf(tail, start)
  if (start < 0 || finish < start || previous.sql.indexOf(header, start + header.length) >= 0)
    throw Error('conversation_memory_candidates_authentication_renderer_changed')
  // The original compiled evaluator stays pinned. Its generic fallback has
  // the same signature and authority contract with the reviewed candidate scan.
  const rendered = previous.sql.slice(0, finish) +
    ' ' + renderSuccessor + '\n' + tail +
    previous.sql.slice(finish + tail.length)
  const marker = `SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $conversation_memory_candidates_receipt$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${literal(memoryMigration)})
 THEN RAISE EXCEPTION 'conversation_memory_candidates_release_missing';END IF;
END $conversation_memory_candidates_receipt$;
`
  const sql = marker + rendered
  assertAuthenticationReadOnly(sql)
  return sql
}

async function buildMigration(previous) {
  // These recipes ship with the verifier. The portable release directory
  // supplies numbered SQL and ledger aliases, never compiler code.
  const read = name => readFile(new URL(name, import.meta.url), 'utf8')
  const [consumers, installer] = await Promise.all([
    read('conversion-original-consumers.sql'),
    read('conversion-install.mjs'),
  ])
  const configure = sql => sql
    .replaceAll('publication_expected_current', prefix + 'publication_expected_current')
    .replaceAll('publication_successor_templates', prefix + 'publication_successor_templates')
    .replaceAll('pg_temp.conversion_source_body', 'pg_temp.' + successorRenderer)
  const start = installer.indexOf('DO $conversion_propagate$')
  const endMarker = 'END $conversion_propagate$;'
  const end = installer.indexOf(endMarker, start)
  if (start < 0 || end < start) throw Error('conversation_memory_candidates_propagation_source_missing')
  let propagate = configure(installer.slice(start, end + endMarker.length))
  // Only the generic owner and authenticated consumers of its fingerprint
  // may change. The full catalog check keeps all other definitions pinned.
  propagate = replaceOnce(propagate,
    `SELECT t.signature,t.parts FROM ${prefix}publication_successor_templates t ORDER BY t.signature COLLATE "C"`,
    `SELECT t.signature,t.parts FROM ${prefix}publication_successor_templates t
   JOIN conversion_affected_functions a ON a.signature=t.signature ORDER BY t.signature COLLATE "C"`)
  propagate = replaceOnce(propagate, 'SET contract=after_row', 'SET contract=' + executableProjection('after_row'))
  propagate = replaceOnce(propagate, 'p IS DISTINCT FROM h.contract', executableProjection('p') + ' IS DISTINCT FROM h.contract')
  propagate = replaceOnce(propagate, 'to_jsonb(h.contract) IS DISTINCT FROM expected', 'h.contract IS DISTINCT FROM ' + executableProjection('actual'))
  const classify = replaceOnce(consumers, "WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
    `WHERE signature=${literal(genericSignature)};`)
  return `-- [COMP:api/native-turn-frame] Bound the locked retained Memory candidates passed to canonical external lineage.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $conversation_memory_candidates_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
  OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${literal(predecessor)})
 THEN RAISE EXCEPTION 'conversation_memory_candidates_predecessor_changed';END IF;
END $conversation_memory_candidates_predecessor$;
${previous.sql}
${configure(classify)}
CREATE FUNCTION pg_temp.${successorRenderer}(signature text,parts jsonb,successor boolean) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $conversation_memory_candidates_body$
DECLARE body text:=pg_temp.${priorRenderer}(signature,parts,successor);marker text;
BEGIN
 ${renderSuccessor}
 RETURN body;
END $conversation_memory_candidates_body$;
${propagate}
DROP FUNCTION pg_temp.${successorRenderer}(text,jsonb,boolean);
DO $conversation_memory_candidates_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_memory_candidates_successor_witness_changed';END IF;
END $conversation_memory_candidates_witness$;
${previous.cleanup}
COMMIT;
`.replace(/^ +$/gm, '')
}

export async function currentMemoryCandidatesReleaseSource({ sourceRoot = defaultSourceRoot } = {}) {
  const previous = await previousSource({ sourceRoot })
  const path = resolve(sourceRoot, 'migrations', memoryMigration)
  const [numbered, expected] = await Promise.all([readFile(path, 'utf8'), buildMigration(previous)])
  if (numbered !== expected) throw Error('conversation_memory_candidates_numbered_source_changed')
  const sql = reviewedAuthentication(previous)
  const migrationSha = sha(numbered)
  const sourceDigest = sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, authenticationSha: sha(sql) }))
  return { ...previous, sql, sourceDigest, migrationSha }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, output, ...extra] = process.argv.slice(2)
  if (extra.length) throw Error('Use --candidate PATH or --check')
  if (mode === '--candidate' && output) {
    const previous = await previousSource({ sourceRoot: defaultSourceRoot })
    await writeFile(resolve(output), await buildMigration(previous), { flag: 'wx', mode: 0o600 })
  } else if (mode === '--check' && !output) await currentMemoryCandidatesReleaseSource()
  else throw Error('Use --candidate PATH or --check')
}
