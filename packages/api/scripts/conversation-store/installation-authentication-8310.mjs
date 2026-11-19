// [COMP:api/conversation-visibility] Numbered public receiving source profile.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicReceivingMigrationName } from './build-conversation-public-receiving.mjs'
import { assertPublicReceivingAuthenticationReadOnly, publicReceivingInstallationSource } from './public-receiving-authentication.mjs'

const migrationSha = '2b641c4fe17c8aa5b821f22da1774d151e0b8eaa79e57ecf8a9ffd80d1abf4ac'

export const assertAuthenticationReadOnly = assertPublicReceivingAuthenticationReadOnly

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const migration = await readFile(resolve(sourceRoot, 'migrations', publicReceivingMigrationName), 'utf8')
  if (createHash('sha256').update(migration).digest('hex') !== migrationSha) throw Error('installation_source_migration_changed')
  return publicReceivingInstallationSource(migration, { sourceRoot })
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
