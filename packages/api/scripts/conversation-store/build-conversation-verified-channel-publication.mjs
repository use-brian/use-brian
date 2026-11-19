// [COMP:api/conversation-visibility] Verified provider append installation.
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pageDeliveryInstallationSource } from './page-delivery-authentication.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const predecessorName = '8311_conversation_page_delivery.sql'
const predecessorSha = '945bf1137d8c38cbcde5d98454f3f015f51b25566d737df11f1932be482b05c7'
const hash = value => createHash('sha256').update(value).digest('hex')
export const verifiedChannelPublicationMigrationName = '8312_conversation_verified_channel_publication.sql'
export const channelPublicationSectionStart = '-- BEGIN REVIEWED VERIFIED CHANNEL PUBLICATION\n'
export const channelPublicationSectionEnd = '-- END REVIEWED VERIFIED CHANNEL PUBLICATION'

export async function reviewedChannelPublication() {
  return readFile(new URL('./conversation-verified-channel-publication.sql', import.meta.url), 'utf8')
}

export async function channelPublicationPredecessor({ sourceRoot = root, pageMigration } = {}) {
  const predecessor = await readFile(pageMigration ?? resolve(sourceRoot, 'migrations', predecessorName), 'utf8')
  if (hash(predecessor) !== predecessorSha) throw Error('verified_channel_publication_predecessor_changed')
  return pageDeliveryInstallationSource(predecessor,{sourceRoot})
}

export async function buildVerifiedChannelPublicationCandidate(options = {}) {
  const [previous, source] = await Promise.all([channelPublicationPredecessor(options),reviewedChannelPublication()])
  return `-- [COMP:api/conversation-visibility] Verified provider append installation.
BEGIN;
DO $channel_publication_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='${predecessorName}')
 OR to_regprocedure('public.conversation_visibility_settings_ready()') IS NOT NULL
 THEN RAISE EXCEPTION 'verified_channel_publication_predecessor_changed';END IF;
END $channel_publication_predecessor$;
${previous.sql}
${channelPublicationSectionStart}${source}${channelPublicationSectionEnd}
DO $channel_publication_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE THEN RAISE EXCEPTION 'verified_channel_publication_witness_changed';END IF;
END $channel_publication_witness$;
${previous.cleanup}
COMMIT;\n`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode,target,pageMigration,...extra] = process.argv.slice(2)
  if (extra.length || pageMigration && mode!=='--candidate') throw Error('Use --candidate PATH [EXACT_PAGE_SQL] or --check')
  const directory = new URL('../../migrations/',import.meta.url)
  const migration = new URL(verifiedChannelPublicationMigrationName,directory)
  const sql = await buildVerifiedChannelPublicationCandidate({pageMigration})
  if (mode==='--candidate' && target) await writeFile(resolve(target),sql,{mode:0o600,flag:'wx'})
  else if (mode==='--check' && !target) {
    if (await readFile(migration,'utf8')!==sql) throw Error('verified_channel_publication_numbered_source_changed')
  } else if (!mode) {
    const hosted=new URL('../../../../../packages/api-platform/migrations/',import.meta.url)
    const files=(await Promise.all([readdir(directory),readdir(hosted)])).flat()
    if (files.some(file=>file.startsWith('8312_'))) throw Error('verified_channel_publication_number_occupied')
    await writeFile(migration,sql,{flag:'wx'})
  } else throw Error('Use --candidate PATH [EXACT_PAGE_SQL] or --check')
}
