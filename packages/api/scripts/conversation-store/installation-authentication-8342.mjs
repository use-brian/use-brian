// [COMP:api/portable-restore] Authenticate the canonical Memory terminal proof.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { boundedClassification, currentInstallationAuthenticationSource as predecessor } from './installation-authentication-8341.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const migration = '8342_memory_history_terminal_proof.sql'
const migrationSha = '1be5638a9d13e1b682ab46f86457fab73f00e2ca7a6259b2b922b1d54fae896b'
const oldBodySha = '129079ae5b1096a988366358b0a45ca0d8da8102361a3df8e25d48d0e510c6ce'
const newBodySha = '1013c73163439f258f2d6fbd943d958c2e8b032f99095c257371c5d095e158af'
const encoded = text => JSON.stringify(text).slice(1,-1).replaceAll("'", "''")

export const memoryHistoryCatalogScope = {
  functions: ['application_memory_history_status'], tables: [], triggers: [], types: [],
}
const catalog = { scope: memoryHistoryCatalogScope, sha256: '74b601b6b1117a1f3f646647ad34620274c060eb2f32c9322756d6490785c899' }

export function memoryHistoryClassification(classification) {
  const bounded = boundedClassification(classification)
  return { ...bounded, ledgerCount: bounded.ledgerCount+1 }
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../',import.meta.url)) } = {}) {
  const [previous, original, numbered] = await Promise.all([
    predecessor({ sourceRoot }),
    readFile(resolve(sourceRoot,'migrations','8128_native_memory_history_admission.sql'),'utf8'),
    readFile(resolve(sourceRoot,'migrations',migration),'utf8'),
  ])
  if (sha(numbered) !== migrationSha) throw Error('memory_history_terminal_migration_changed')
  const oldBody = original.split('$history_status$')[1]
  if (!oldBody || sha(oldBody) !== oldBodySha || previous.sql.split(encoded(oldBody)).length !== 2)
    throw Error('memory_history_terminal_reference_changed')
  // Use the exact, source-pinned delta shipped in the migration for the
  // predecessor verifier's reference definition. Never enroll a live body.
  const replacements = [...numbered.matchAll(/\$before\$([\s\S]*?)\$before\$,\$after\$([\s\S]*?)\$after\$/g)]
  if (replacements.length !== 4) throw Error('memory_history_terminal_delta_changed')
  let body = oldBody
  for (const [,before,after] of replacements) body = body.replace(before,after)
  if (sha(body) !== newBodySha) throw Error('memory_history_terminal_successor_changed')
  const sql = previous.sql.replace(encoded(oldBody), encoded(body))
  assertAuthenticationReadOnly(sql)
  return { ...previous, sql, migrationSha, additionalCatalogs: [...previous.additionalCatalogs,catalog],
    portableSuccessor: { ...previous.portableSuccessor, migrations: [...previous.portableSuccessor.migrations,migration] },
    sourceDigest: sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, catalog, verifier: sha(sql) })),
  }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
