// [COMP:api/portable-restore] Authenticate the ranked workspace Files index.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8332.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'

const migration = '8333_workspace_files_prompt_catalog.sql'
const migrationSha = 'e85fd4732b238948979e38f09b4ce82b3874d42eb8446a6ff4a7a41d500fa27e'
const sha = value => createHash('sha256').update(value).digest('hex')
const indexCatalog = `SET LOCAL search_path=pg_catalog;
DO $workspace_files_prompt_catalog_receipt$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='${migration}')
 THEN RAISE EXCEPTION 'workspace_files_prompt_catalog_release_missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_index installed
  JOIN pg_class relation ON relation.oid=installed.indrelid
  JOIN pg_class index_relation ON index_relation.oid=installed.indexrelid AND index_relation.relowner=relation.relowner
  WHERE installed.indexrelid=to_regclass('public.idx_wf_prompt_catalog_updated')
    AND relation.oid='public.workspace_files'::regclass AND installed.indisvalid AND installed.indisready AND installed.indislive
    AND pg_get_indexdef(installed.indexrelid)=$definition$CREATE INDEX idx_wf_prompt_catalog_updated ON public.workspace_files USING btree (workspace_id, updated_at DESC) WHERE ((purpose = 'operational'::text) AND (valid_to IS NULL) AND ((path !~~ '/doc/%'::text) OR ((upload_identity IS NOT NULL) AND (source_episode_id IS NOT NULL))) AND (path !~~ '/apps/%'::text) AND (path !~~ '/office/sessions/%'::text) AND ((metadata ->> 'noIndex'::text) IS DISTINCT FROM 'true'::text))$definition$)
 THEN RAISE EXCEPTION 'workspace_files_prompt_catalog_changed'; END IF;
END $workspace_files_prompt_catalog_receipt$;
`

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, numbered] = await Promise.all([
    previousSource({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', migration)),
  ])
  if (sha(numbered) !== migrationSha) throw Error('workspace_files_prompt_catalog_numbered_source_changed')
  const sql = indexCatalog + previous.sql
  assertAuthenticationReadOnly(sql)
  const sourceDigest = sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, authenticationSha: sha(sql) }))
  return { ...previous, sql, sourceDigest, migrationSha }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
