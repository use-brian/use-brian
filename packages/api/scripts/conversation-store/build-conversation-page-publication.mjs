// [COMP:api/page-thread-audience] Install the Page publication containment rule.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentInstallationAuthenticationSource } from './installation-authentication-8312.mjs'
import { executableProjection } from './executable-record.mjs'

export const pagePublicationMigrationName = '8313_conversation_page_publication.sql'
export const pagePublicationSignature = 'conversation_prepare_publications(uuid,uuid,jsonb)'
export const pagePublicationPrefix = 'a8312_'
const renderer = 'conversation_page_publication_body'
const previousRenderer = pagePublicationPrefix + 'conversion_source_body'
const marker = ' FOR dependency IN\n  WITH history_roots AS MATERIALIZED('
const literal = value => "'" + value.replaceAll("'", "''") + "'"

export function replacePagePublicationSource(source, before, after) {
  if (source.split(before).length !== 2) throw Error('conversation_page_publication_source_changed: ' + before.slice(0, 80))
  return source.replace(before, () => after)
}

export async function pagePublicationRenderClause() {
  const guard = await readFile(new URL('./conversation-page-publication-guard.sql', import.meta.url), 'utf8')
  return `WHEN ${literal(pagePublicationSignature)} THEN
 marker:=${literal(marker)};
 IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'conversation_page_publication_placement_changed';END IF;
 body:=replace(body,marker,${literal(guard + marker)});`
}

async function pagePublicationSuccessor() {
  const [consumers, installer, clause] = await Promise.all([
    readFile(new URL('./conversion-original-consumers.sql', import.meta.url), 'utf8'),
    readFile(new URL('./conversion-install.mjs', import.meta.url), 'utf8'),
    pagePublicationRenderClause(),
  ])
  const configure = source => source.replaceAll('publication_expected_current', pagePublicationPrefix + 'publication_expected_current')
    .replaceAll('publication_successor_templates', pagePublicationPrefix + 'publication_successor_templates')
    .replaceAll('pg_temp.conversion_source_body', 'pg_temp.' + renderer)
  const begin = installer.indexOf('DO $conversion_propagate$')
  const endMarker = 'END $conversion_propagate$;'
  const end = installer.indexOf(endMarker, begin)
  if (begin < 0 || end < 0) throw Error('conversation_page_publication_propagation_missing')
  let propagate = configure(installer.slice(begin, end + endMarker.length))
  propagate = replacePagePublicationSource(propagate, 'SET contract=after_row', 'SET contract=' + executableProjection('after_row'))
  propagate = replacePagePublicationSource(propagate, 'p IS DISTINCT FROM h.contract', executableProjection('p') + ' IS DISTINCT FROM h.contract')
  propagate = replacePagePublicationSource(propagate, 'to_jsonb(h.contract) IS DISTINCT FROM expected', 'h.contract IS DISTINCT FROM ' + executableProjection('actual'))
  const classify = replacePagePublicationSource(consumers, "WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
    `WHERE signature=${literal(pagePublicationSignature)};`)
  return `${configure(classify)}
CREATE FUNCTION pg_temp.${renderer}(signature text,parts jsonb,successor boolean) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $page_publication_body$
DECLARE body text:=pg_temp.${previousRenderer}(signature,parts,successor);marker text;
BEGIN CASE signature
${clause}
ELSE NULL; END CASE; RETURN body; END $page_publication_body$;
${propagate}
DROP FUNCTION pg_temp.${renderer}(text,jsonb,boolean);`
}

export async function buildConversationPagePublicationCandidate(options) {
  const [previous, successor] = await Promise.all([currentInstallationAuthenticationSource(options), pagePublicationSuccessor()])
  return `-- [COMP:api/page-thread-audience] Contain retained Page evidence to its actual destination.
BEGIN;
DO $page_publication_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8312_conversation_verified_channel_publication.sql')
 OR to_regprocedure('public.conversation_visibility_settings_ready()') IS NOT NULL
 THEN RAISE EXCEPTION 'conversation_page_publication_predecessor_changed';END IF;
END $page_publication_predecessor$;
${previous.sql}
${successor}
DO $page_publication_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE THEN RAISE EXCEPTION 'conversation_page_publication_witness_changed';END IF;
END $page_publication_witness$;
${previous.cleanup}
COMMIT;
`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, target, ...extra] = process.argv.slice(2)
  if (extra.length) throw Error('Use --candidate PATH or --check')
  const oss = new URL('../../migrations/', import.meta.url)
  const migration = new URL(pagePublicationMigrationName, oss)
  const sql = await buildConversationPagePublicationCandidate()
  if (mode === '--candidate' && target) await writeFile(resolve(target), sql, { mode: 0o600, flag: 'wx' })
  else if (mode === '--check' && !target) {
    if (await readFile(migration, 'utf8') !== sql) throw Error('conversation_page_publication_numbered_source_changed')
  } else if (!mode) {
    const hosted = new URL('../../../../../packages/api-platform/migrations/', import.meta.url)
    const files = (await Promise.all([readdir(oss), readdir(hosted)])).flat()
    if (files.some(file => file.startsWith('8313_'))) throw Error('conversation_page_publication_number_occupied')
    await writeFile(migration, sql, { flag: 'wx' })
  } else throw Error('Use --candidate PATH or --check')
}
