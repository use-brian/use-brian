// [COMP:api/portable-restore] Verify the search reader and its independent current-cohort check.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { currentInstallationAuthenticationSource, knowledgeFieldProofClassification } from './installation-authentication-8346.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')

export function searchRelease(predecessor, migration, migrationSha, functions, catalogSha) {
  const catalog = { scope: { functions, tables: [], types: [], triggers: [] }, sha256: catalogSha }
  async function source({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
    const [previous, numbered] = await Promise.all([
      predecessor({ sourceRoot }), readFile(resolve(sourceRoot, 'migrations', migration)),
    ])
    if (sha(numbered) !== migrationSha) throw Error('knowledge_search_migration_changed')
    return {
      ...previous, migrationSha,
      additionalCatalogs: [...previous.additionalCatalogs, catalog],
      portableSuccessor: { ...previous.portableSuccessor, migrations: [...previous.portableSuccessor.migrations, migration] },
      sourceDigest: sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, catalog })),
    }
  }
  return {
    migration,
    currentInstallationAuthenticationSource: source,
    async authenticateConversationInstallation(owner, options) {
      return authenticateCrmSuccessor(owner, await source(options))
    },
  }
}

export const indexedSearchRelease = searchRelease(
  currentInstallationAuthenticationSource, '8347_knowledge_set_search.sql', '792a4a0f8cc570cb00a0f608234acbd24b7387e59d38c31084db36bd673e667e',
  ['application_knowledge_search_context', 'application_knowledge_search_snapshot',
    'application_knowledge_search_domain_state', 'application_knowledge_query_domain_state',
    'application_knowledge_exact_query_domain_state', 'read_native_knowledge_search'],
  'cf4942b5ac59358c21322cacb9e4c060257de55bcd75f845d71dd83a015f93c0',
)
export const searchCohortRelease = searchRelease(
  indexedSearchRelease.currentInstallationAuthenticationSource, '8348_knowledge_search_cohort_proof.sql',
  'a671156ec876f43c7fa54ebb3f0ed6b270792db36199f989276eb7d801a9bbeb',
  ['read_native_knowledge_query_cohort_sources_before_point_identit'], '48afb38f0f3ef31ce002c60bedcb94660d7f87c8c99152bce3dd99e6c545ab9b',
)

export function knowledgeSearchClassification(classification) {
  const previous = knowledgeFieldProofClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 2 }
}
