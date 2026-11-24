// [COMP:api/portable-restore] Authenticate the batched Knowledge field proof.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { currentInstallationAuthenticationSource as predecessor, knowledgeQueryClassification } from './installation-authentication-8345.mjs'

const migration = '8346_knowledge_field_proof_batch.sql'
const migrationSha = '9634f0beef283d0ee8a6abc654f2e261b4dd0984a0c23d5ea713c5b81d3c414e'
const sha = value => createHash('sha256').update(value).digest('hex')
const catalog = {
  scope: {
    functions: ['application_knowledge_exact_field_proofs', 'read_admitted_application_field_dependencies',
      'read_admitted_application_field_snapshots', 'read_native_knowledge_query_projection'],
    tables: [], types: [], triggers: [],
  },
  sha256: '4304b8a2b31c7307f29c28d99ec288d590af8de2e1f51c712aa68f389cc798ae',
}

export function knowledgeFieldProofClassification(classification) {
  const previous = knowledgeQueryClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 1 }
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, numbered] = await Promise.all([
    predecessor({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', migration)),
  ])
  if (sha(numbered) !== migrationSha) throw Error('knowledge_field_proof_migration_changed')
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
