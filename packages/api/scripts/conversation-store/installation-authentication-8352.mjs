// [COMP:api/portable-restore] Authenticate the packed Memory observation owner.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { currentInstallationAuthenticationSource as predecessor, derivationParentClassification } from './installation-authentication-8351.mjs'

export const migration = '8352_packed_memory_observation.sql'
const migrationSha = 'bfaac352514a7273a505ac3bdf5d343644b9efd30083591a3afbbd74b48c197e'
const sha = value => createHash('sha256').update(value).digest('hex')
const catalog = {
  scope: {
    functions: ['capture_native_prompt_memory_sections_once', 'capture_native_prompt_memory_sections_v2',
      'observe_native_prompt_memory_field_once', 'read_native_memory_query_projection_once'],
    tables: [], types: [], triggers: [],
    closedPrefixes: { functions: ['capture_native_prompt_memory_sections_', 'observe_native_prompt_memory_field_',
      'read_native_memory_query_projection_'], tables: [] },
  },
  sha256: '657ab160d72f07e958d44c293f6f5d4f86482904d68139566fa0b5e8b0264993',
}

export function packedMemoryClassification(classification) {
  const previous = derivationParentClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 1 }
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, numbered] = await Promise.all([
    predecessor({ sourceRoot }), readFile(resolve(sourceRoot, 'migrations', migration)),
  ])
  if (sha(numbered) !== migrationSha) throw Error('packed_memory_observation_migration_changed')
  return {
    ...previous, migrationSha,
    additionalCatalogs: [...previous.additionalCatalogs, catalog],
    portableSuccessor: { ...previous.portableSuccessor, migrations: [...previous.portableSuccessor.migrations, migration] },
    sourceDigest: sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, catalog })),
  }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
