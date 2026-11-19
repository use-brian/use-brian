// [COMP:api/conversation-visibility] Generate the transition from the reviewed lineage declaration.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { receivingOwnerDeclaration } from './build-conversation-receiving-owners.mjs'
import { settingsReadinessMigrationName } from './build-conversation-settings-readiness.mjs'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8314.mjs'

export const rowTransitionsMigrationName = '8315_conversation_retained_row_transitions.sql'

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error('conversation_row_transitions_predecessor_source_changed')
  return source.replace(before, () => after)
}

export async function reviewedRowTransitions(options) {
  const [previous, declaration] = await Promise.all([
    previousSource(options),
    readFile(new URL('./conversation-record-downstream-read.sql', import.meta.url), 'utf8'),
  ])
  const name = 'conversation_record_derivation_current'
  const original = receivingOwnerDeclaration(declaration, name)
  let successor = replaceOnce(original, ' snapshot jsonb;', ' snapshot jsonb;\n destination_current boolean;')
  successor = replaceOnce(successor, ` IF snapshot->>'workspaceId' IS DISTINCT FROM w::text OR snapshot->>'version' IS DISTINCT FROM v
  OR snapshot->>'held' IS DISTINCT FROM 'false' OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
 THEN RETURN false;END IF;`, ` destination_current:=snapshot->>'workspaceId' IS NOT DISTINCT FROM w::text
  AND snapshot->>'version' IS NOT DISTINCT FROM v AND snapshot->>'held' IS NOT DISTINCT FROM 'false'
  AND snapshot->>'validTo' IS NULL AND snapshot->>'retractedAt' IS NULL;`)
  successor = replaceOnce(successor, ' IF NOT record_found THEN RETURN true;END IF;', ` -- A native predecessor link can exist without conversation evidence. Native
 -- policies govern those rows, including their historical and in-flight versions.
 IF NOT record_found THEN RETURN true;END IF;
 IF NOT destination_current THEN RETURN false;END IF;`)
  const reference = source => source.replace('CREATE FUNCTION public.'+name, 'CREATE FUNCTION pg_temp.a8314_lineage_ref_3')
  const installed = successor.replace('CREATE FUNCTION public.'+name, 'CREATE OR REPLACE FUNCTION public.'+name)
  const authentication = replaceOnce(previous.sql, reference(original), reference(successor))
  return { previous, installed, authentication }
}

export async function buildRowTransitionsMigration(options) {
  const { previous, installed } = await reviewedRowTransitions(options)
  return `-- [COMP:api/conversation-visibility] Keep native row transitions and retained evidence distinct.
BEGIN;
DO $row_transitions_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
  OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='${settingsReadinessMigrationName}')
 THEN RAISE EXCEPTION 'conversation_row_transitions_predecessor_changed';END IF;
END $row_transitions_predecessor$;
${previous.sql}
${installed}
DO $row_transitions_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE THEN RAISE EXCEPTION 'conversation_row_transitions_witness_changed';END IF;
END $row_transitions_witness$;
${previous.cleanup}
COMMIT;\n`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, target, ...extra] = process.argv.slice(2)
  if (extra.length) throw Error('Use --candidate PATH or --check')
  const directory = new URL('../../migrations/', import.meta.url)
  const migration = new URL(rowTransitionsMigrationName, directory)
  const sql = await buildRowTransitionsMigration()
  if (mode === '--candidate' && target) await writeFile(resolve(target), sql, { mode: 0o600, flag: 'wx' })
  else if (mode === '--check' && !target) {
    if (await readFile(migration, 'utf8') !== sql) throw Error('conversation_row_transitions_numbered_source_changed')
  } else if (!mode) {
    const hosted = new URL('../../../../../packages/api-platform/migrations/', import.meta.url)
    const files = (await Promise.all([readdir(directory), readdir(hosted)])).flat()
    if (files.some(file => file.startsWith('8315_'))) throw Error('conversation_row_transitions_number_occupied')
    await writeFile(migration, sql, { flag: 'wx' })
  } else throw Error('Use --candidate PATH or --check')
}
