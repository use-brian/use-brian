// [COMP:api/portable-restore] Verify both conversation capture functions using
// their original source contracts, including installation-local guard slots.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { updateCaptureVerifier } from './capture-verifier.mjs'
import { currentInstallationAuthenticationSource as predecessor, memoryHistoryClassification } from './installation-authentication-8342.mjs'

const migration = '8343_conversation_capture_linear_aggregation.sql'
const sha = text => createHash('sha256').update(text).digest('hex')

export function captureClassification(classification) {
  const previous = memoryHistoryClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 1 }
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, original, numbered] = await Promise.all([
    predecessor({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', '8269_canonical_conversation_publication.sql'), 'utf8'),
    readFile(resolve(sourceRoot, 'migrations', migration), 'utf8'),
  ])
  const migrationSha = sha(numbered)
  if (migrationSha !== '82fd79155830472c4bece33751bbb7137eb813740b1437e7223ecb0552b2199c') throw Error('conversation_capture_migration_changed')
  const sql = updateCaptureVerifier(previous.sql, original, numbered, ['capture_conversation_selection', 'capture_conversation_query'])
  return { ...previous, sql, migrationSha,
    portableSuccessor: { ...previous.portableSuccessor, migrations: [...previous.portableSuccessor.migrations, migration] },
    sourceDigest: sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, verifier: sha(sql) })),
  }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
