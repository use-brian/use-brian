// [COMP:api/telegram-conversation-context] Authenticate the verified provider room history owner.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifiedTelegramEvidenceInstallationSource, verifiedTelegramEvidenceMigration } from './build-verified-telegram-evidence.mjs'

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const migration = await readFile(resolve(sourceRoot, 'migrations', verifiedTelegramEvidenceMigration), 'utf8')
  return verifiedTelegramEvidenceInstallationSource(migration, { sourceRoot })
}

export async function authenticateConversationInstallation(client, options) {
  if (client?.getTransactionStatus?.() !== 'I') throw Error('installation_authentication_requires_idle_owner')
  const source = await currentInstallationAuthenticationSource(options)
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  try {
    const result = await client.query(source.sql)
    const row = (Array.isArray(result) ? result.at(-1) : result)?.rows?.[0]
    if (!row || row.functions !== source.functions || !/^[a-f0-9]{64}$/.test(row.local_digest) || row.witness_current !== true)
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
