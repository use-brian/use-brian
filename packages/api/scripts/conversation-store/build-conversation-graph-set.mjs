// [COMP:api/native-turn-frame] Generate the reviewed retained graph successor.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { graphReplacements, graphSignature } from './conversation-graph-set.mjs'
import { executableProjection } from './executable-record.mjs'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8326.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'

export const graphSetMigration = '8327_conversation_graph_set_verification.sql'
const predecessor = '8326_native_memory_query_write_contract.sql'
const defaultSourceRoot = fileURLToPath(new URL('../../', import.meta.url))
const prefix = 'a8314_'
const priorRenderer = prefix + 'conversion_source_body'
const successorRenderer = 'conversation_graph_set_body'
const sha = value => createHash('sha256').update(value).digest('hex')
const literal = value => "'" + value.replaceAll("'", "''") + "'"

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw Error('conversation_graph_installation_source_changed: ' + before.slice(0, 120))
  return source.replace(before, () => after)
}

const edits = graphReplacements.map(([before, after]) => `
  marker:=${literal(before)};
  IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1
  THEN RAISE EXCEPTION 'conversation_graph_body_marker_changed: %',left(marker,120);END IF;
  body:=replace(body,marker,${literal(after)});`).join('')
const renderGraph = `IF signature=${literal(graphSignature)} AND successor THEN${edits}
 END IF;`

function reviewedAuthentication(previous) {
  const header = `CREATE FUNCTION pg_temp.${priorRenderer}(signature text,parts jsonb,successor boolean)`
  const tail = 'ELSE NULL; END CASE; RETURN body; END $private_page_body$;'
  const start = previous.sql.indexOf(header)
  const finish = previous.sql.indexOf(tail, start)
  if (start < 0 || finish < start || previous.sql.indexOf(header, start + header.length) >= 0)
    throw Error('conversation_graph_authentication_renderer_changed')
  // The fused member validator still separately authenticates the historical
  // graph which that compiler copied. Only the installed canonical owner
  // changes here; its current checked renderer uses this reviewed splice.
  const rendered = previous.sql.slice(0, finish) +
    'ELSE NULL; END CASE;\n ' + renderGraph + '\n RETURN body; END $private_page_body$;' +
    previous.sql.slice(finish + tail.length)
  const marker = `SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $conversation_graph_receipt$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${literal(graphSetMigration)})
 THEN RAISE EXCEPTION 'conversation_graph_release_missing';END IF;
END $conversation_graph_receipt$;
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
  if (start < 0 || end < start) throw Error('conversation_graph_propagation_source_missing')
  let propagate = configure(installer.slice(start, end + endMarker.length))
  // Only the graph and authenticated consumers of its old fingerprints can
  // change. Unaffected definitions stay in the final full catalog comparison
  // with their original metadata, including amendments from later releases.
  propagate = replaceOnce(propagate,
    `SELECT t.signature,t.parts FROM ${prefix}publication_successor_templates t ORDER BY t.signature COLLATE "C"`,
    `SELECT t.signature,t.parts FROM ${prefix}publication_successor_templates t
   JOIN conversion_affected_functions a ON a.signature=t.signature ORDER BY t.signature COLLATE "C"`)
  propagate = replaceOnce(propagate, 'SET contract=after_row', 'SET contract=' + executableProjection('after_row'))
  propagate = replaceOnce(propagate, 'p IS DISTINCT FROM h.contract', executableProjection('p') + ' IS DISTINCT FROM h.contract')
  propagate = replaceOnce(propagate, 'to_jsonb(h.contract) IS DISTINCT FROM expected', 'h.contract IS DISTINCT FROM ' + executableProjection('actual'))
  const classify = replaceOnce(consumers, "WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
    `WHERE signature=${literal(graphSignature)};`)
  return `-- [COMP:api/native-turn-frame] Verify retained adjacency independently without replaying every native source edge.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $conversation_graph_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
  OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${literal(predecessor)})
 THEN RAISE EXCEPTION 'conversation_graph_predecessor_changed';END IF;
END $conversation_graph_predecessor$;
${previous.sql}
${configure(classify)}
CREATE FUNCTION pg_temp.${successorRenderer}(signature text,parts jsonb,successor boolean) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $conversation_graph_set_body$
DECLARE body text:=pg_temp.${priorRenderer}(signature,parts,successor);marker text;
BEGIN
 ${renderGraph}
 RETURN body;
END $conversation_graph_set_body$;
${propagate}
DROP FUNCTION pg_temp.${successorRenderer}(text,jsonb,boolean);
DO $conversation_graph_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_graph_successor_witness_changed';END IF;
END $conversation_graph_witness$;
${previous.cleanup}
COMMIT;
`.replace(/^ +$/gm, '')
}

export async function currentGraphReleaseSource({ sourceRoot = defaultSourceRoot } = {}) {
  const previous = await previousSource({ sourceRoot })
  const path = resolve(sourceRoot, 'migrations', graphSetMigration)
  const [numbered, expected] = await Promise.all([readFile(path, 'utf8'), buildMigration(previous)])
  if (numbered !== expected) throw Error('conversation_graph_numbered_source_changed')
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
  } else if (mode === '--check' && !output) await currentGraphReleaseSource()
  else throw Error('Use --candidate PATH or --check')
}
