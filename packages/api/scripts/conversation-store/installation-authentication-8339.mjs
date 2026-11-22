// [COMP:api/portable-restore] Verify the source-scoped Knowledge writers and indexes.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { currentInstallationAuthenticationSource as predecessor } from './installation-authentication-8338.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const migration = '8339_knowledge_source_path_identity.sql'
const migrationSha = '449ea5e8f2a41f539114ed1d743aa1a02f7ef8e27688b3674fd32fdf8aa9fa4e'
const catalog = {
  scope: {
    functions: ['admit_knowledge_repo_write', 'apply_knowledge_source_refresh', 'apply_knowledge_source_sync_worker', 'publish_admitted_knowledge_repo_write'],
    tables: ['kb_chunks', 'knowledge_entries'],
    types: [],
    triggers: [],
  },
  sha256: 'c51d302b116fba419c216b63d021e3a668b2cef99cf942d5cf3e73f8b65f22ad',
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, numbered] = await Promise.all([
    predecessor({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', migration)),
  ])
  if (sha(numbered) !== migrationSha) throw Error('knowledge_source_path_migration_changed')
  // Two of the four edited writers also have full reference definitions in the
  // earlier verifier. Keep those checks and change their lookup in lockstep.
  const lookup = "SELECT * INTO old FROM knowledge_entries WHERE workspace_id=w AND path=p->>'path' FOR UPDATE;"
  if (previous.sql.split(lookup).length !== 3) throw Error('knowledge_source_path_reference_changed')
  const sql = previous.sql.replaceAll(lookup, lookup.replace('AND path=', 'AND source_id=s.id AND path='))
  assertAuthenticationReadOnly(sql)
  return {
    ...previous, sql, migrationSha, additionalCatalogs: [previous.additionalCatalog, catalog],
    portableSuccessor: { ...previous.portableSuccessor, migrations: [...previous.portableSuccessor.migrations, migration] },
    sourceDigest: sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, catalog, verifier: sha(sql) })),
  }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
