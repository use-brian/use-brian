// [COMP:api/portable-restore] Authenticate the canonical Knowledge query scan and private field state.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { currentInstallationAuthenticationSource as predecessor, envelopeClassification } from './installation-authentication-8344.mjs'

const migration = '8345_knowledge_query_scan_cost.sql'
const migrationSha = '32bdedd59bbbb6590404d2b3936c83f59bddf9700acad41aed537368c7dc703a'
const sha = value => createHash('sha256').update(value).digest('hex')
const catalog = {
  scope: {
    functions: ['application_knowledge_admitted_fields', 'application_knowledge_field_state', 'application_knowledge_query_scan', 'application_knowledge_related_fields'],
    tables: [], types: [], triggers: [],
  },
  sha256: 'aa61172d5fb9372c4e268b323e0aa32ae97fbd3dcbeb9f7946c43f8e7e4a33c1',
}

export function knowledgeQueryClassification(classification) {
  const previous = envelopeClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 1 }
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, numbered] = await Promise.all([
    predecessor({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', migration)),
  ])
  if (sha(numbered) !== migrationSha) throw Error('knowledge_query_scan_migration_changed')
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
