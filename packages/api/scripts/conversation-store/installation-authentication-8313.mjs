// [COMP:api/page-thread-audience] Authenticate the installed Page publication rule.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentInstallationAuthenticationSource as previousSource,
  assertAuthenticationReadOnly as previousReadOnly } from './installation-authentication-8312.mjs'
import { pagePublicationMigrationName, pagePublicationPrefix, pagePublicationRenderClause,
  replacePagePublicationSource } from './build-conversation-page-publication.mjs'

const installedPrefix = 'a8313_'
const migrationSha = '66f7ac2d26ed9dd627b41d5febff5ca4b05980abf349429433cfefbd17a00cee'
const hash = value => createHash('sha256').update(value).digest('hex')

export function assertAuthenticationReadOnly(sql) {
  previousReadOnly(sql.replaceAll(installedPrefix, pagePublicationPrefix))
}

export async function pagePublicationInstallationSource(migration, options) {
  const [previous, clause] = await Promise.all([previousSource(options), pagePublicationRenderClause()])
  if (migration.split(clause).length !== 2) throw Error('conversation_page_publication_definition_changed')
  // The predecessor already separates this routine's historical body from
  // its current body. Add the exact guard to its current renderer only.
  const declaration = `CREATE FUNCTION pg_temp.${pagePublicationPrefix}conversion_source_body(signature text,parts jsonb,successor boolean)`
  const begin = previous.sql.indexOf(declaration)
  const close = 'ELSE NULL; END CASE; RETURN body; END $private_page_body$;'
  const end = previous.sql.indexOf(close, begin) + close.length
  if (previous.sql.split(declaration).length !== 2 || begin < 0 || end < begin)
    throw Error('conversation_page_publication_renderer_missing')
  const original = previous.sql.slice(begin, end)
  const renderer = replacePagePublicationSource(original, close, clause + '\n' + close)
  const sql = (previous.sql.slice(0, begin) + renderer + previous.sql.slice(end)).replaceAll(pagePublicationPrefix, installedPrefix)
  assertAuthenticationReadOnly(sql)
  const sha = hash(migration)
  return { ...previous, sql, cleanup: previous.cleanup.replaceAll(pagePublicationPrefix, installedPrefix),
    sourceDigest: sha, migrationSha: sha }
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const migration = await readFile(resolve(sourceRoot, 'migrations', pagePublicationMigrationName), 'utf8')
  if (hash(migration) !== migrationSha) throw Error('installation_source_migration_changed')
  return pagePublicationInstallationSource(migration, { sourceRoot })
}

export async function authenticateConversationInstallation(client, options) {
  if (client?.getTransactionStatus?.() !== 'I') throw Error('installation_authentication_requires_idle_owner')
  const source = await currentInstallationAuthenticationSource(options)
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  try {
    const result = await client.query(source.sql)
    const row = (Array.isArray(result) ? result.at(-1) : result)?.rows?.[0]
    if (!row || row.functions !== source.functions || !/^[a-f0-9]{64}$/.test(row.local_digest) || typeof row.witness_current !== 'boolean')
      throw Error('installation_authentication_receipt_malformed')
    await client.query(source.cleanup)
    await client.query('COMMIT')
    return Object.freeze({ format: 1, sourceDefinitionDigest: source.sourceDigest, functions: row.functions,
      localContractDigest: row.local_digest, witnessCurrent: row.witness_current })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}
