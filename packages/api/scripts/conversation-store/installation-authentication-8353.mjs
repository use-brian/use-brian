// [COMP:api/portable-restore] Authenticate the bounded recording channel lock.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { currentInstallationAuthenticationSource as predecessor, packedMemoryClassification } from './installation-authentication-8352.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'

export const migration = '8353_recording_channel_lock_wait.sql'
const migrationSha = 'd50482b816da0b6670da3561843ffbc1ae8521a800c5d2bcf703a287462c1eea'
const signature = 'conversation_recording_scope(uuid,jsonb)'
const sha = value => createHash('sha256').update(value).digest('hex')
const bodyLiteral = body => JSON.stringify(body).replaceAll("'", "''")

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error('recording_channel_lock_authentication_anchor_changed')
  return source.replace(before, () => after)
}

export function recordingChannelLockClassification(classification) {
  const previous = packedMemoryClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 1 }
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, numbered, canonical] = await Promise.all([
    predecessor({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', migration), 'utf8'),
    readFile(resolve(sourceRoot, 'scripts/conversation-store/recording.sql'), 'utf8'),
  ])
  if (sha(numbered) !== migrationSha) throw Error('recording_channel_lock_migration_changed')
  const original = canonical.split('$body$')[1]
  const originalSha = numbered.match(/before_sha constant text:='([0-9a-f]{64})'/)?.[1]
  const successorSha = numbered.match(/after_sha constant text:='([0-9a-f]{64})'/)?.[1]
  const edits = [...numbered.matchAll(/\$before\$([\s\S]*?)\$before\$,\s*\$after\$([\s\S]*?)\$after\$/g)]
  if (!original || sha(original) !== originalSha || edits.length !== 4) throw Error('recording_channel_lock_authentication_predecessor_changed')
  let successor = original
  for (const [, before, after] of edits) successor = replaceOnce(successor, before, after)
  if (sha(successor) !== successorSha) throw Error('recording_channel_lock_authentication_successor_changed')
  // Update the catalog template and the independent fused-call dependency
  // fingerprint. Older release verifiers retain their original sources.
  const sql = replaceOnce(replaceOnce(previous.sql, bodyLiteral(original), bodyLiteral(successor)),
    `('${signature}','${originalSha}')`, `('${signature}','${successorSha}')`)
  assertAuthenticationReadOnly(sql)
  return {
    ...previous, sql, migrationSha,
    portableSuccessor: { ...previous.portableSuccessor, migrations: [...previous.portableSuccessor.migrations, migration] },
    sourceDigest: sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, verifier: sha(sql) })),
  }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
