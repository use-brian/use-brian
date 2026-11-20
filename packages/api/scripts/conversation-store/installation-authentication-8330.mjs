// [COMP:api/portable-restore] Authenticate the installed prompt candidate indexes.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8329.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'

const migration = '8330_memory_prompt_candidates.sql'
const migrationSha = '132422d41f323b06bd9f08aff75f57fc5e8e8dec2f8b32a33381c1fa1ad16e5c'
const sha = value => createHash('sha256').update(value).digest('hex')
const promptCatalog = `SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $memory_prompt_candidates_receipt$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='${migration}')
 THEN RAISE EXCEPTION 'memory_prompt_candidates_release_missing'; END IF;
 IF 2<>(SELECT count(*)
  FROM (VALUES
   ('public.idx_memories_prompt_voice_identity',
    $definition$CREATE INDEX idx_memories_prompt_voice_identity ON public.memories USING btree (workspace_id) WHERE ((((scope = 'workspace'::text) AND (tags @> ARRAY['self-profile'::text])) OR (tags @> ARRAY['voice'::text])) AND (valid_to IS NULL))$definition$),
   ('public.idx_memories_learning_exception',
    $definition$CREATE INDEX idx_memories_learning_exception ON public.memories USING btree (workspace_id) WHERE (((learning #>> '{applicability,exceptionTo}'::text[]) IS NOT NULL) AND ((learning ->> 'origin'::text) = 'explicit'::text) AND ((learning ->> 'confirmed'::text) = 'true'::text) AND (valid_to IS NULL) AND (retracted_at IS NULL) AND (NOT scope_held))$definition$)
  ) expected(index_name,definition)
  JOIN pg_index installed ON installed.indexrelid=to_regclass(expected.index_name)
  JOIN pg_class relation ON relation.oid=installed.indrelid
  JOIN pg_class index_relation ON index_relation.oid=installed.indexrelid AND index_relation.relowner=relation.relowner
  WHERE relation.oid='public.memories'::regclass AND installed.indisvalid AND installed.indisready AND installed.indislive
    AND pg_get_indexdef(installed.indexrelid)=expected.definition)
 THEN RAISE EXCEPTION 'memory_prompt_candidates_catalog_changed'; END IF;
END $memory_prompt_candidates_receipt$;
`

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, numbered] = await Promise.all([
    previousSource({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', migration)),
  ])
  if (sha(numbered) !== migrationSha) throw Error('memory_prompt_candidates_numbered_source_changed')
  const sql = promptCatalog + previous.sql
  assertAuthenticationReadOnly(sql)
  const sourceDigest = sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, authenticationSha: sha(sql) }))
  return { ...previous, sql, sourceDigest, migrationSha }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
