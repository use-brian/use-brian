// [COMP:api/conversation-visibility] Authenticate the numbered settings marker.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAuthenticationReadOnly, settingsReadinessInstallationSource,
  settingsReadinessMigrationName } from './build-conversation-settings-readiness.mjs'

const migrationSha = '194f272258aa1e96c3809e69ab952c96bdb5f9245f3bcb3738cd836620938cd3'

export { assertAuthenticationReadOnly }

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const migration = await readFile(resolve(sourceRoot, 'migrations', settingsReadinessMigrationName), 'utf8')
  if (createHash('sha256').update(migration).digest('hex') !== migrationSha) throw Error('installation_source_migration_changed')
  return settingsReadinessInstallationSource(migration, { sourceRoot })
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
