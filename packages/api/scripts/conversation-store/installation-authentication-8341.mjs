// [COMP:api/portable-restore] Verify the batch catalog and rebuildable import indexes.
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {authenticateCrmSuccessor} from './crm-release-catalog.mjs'
import {currentInstallationAuthenticationSource as predecessor} from './installation-authentication-8339.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const migrationHashes = {
  '8340_generic_application_catalog_batch.sql': '9585952ce0dc9a485b51acff04ee75d80ceb7c21640d985f70a5f538664364bb',
  '8341_crm_import_csv_index.sql': 'cf3396a665bc52d6cba900e8817f2e59bf9bb16a827e985c82891395f95072e0',
}
export const boundedCatalogScope = {
  functions: ['crm_import_csv_index_cleanup', 'read_generic_application_catalog_state', 'read_generic_application_catalog_states'],
  tables: ['crm_import_csv_index_chunks', 'crm_import_csv_indexes'],
  triggers: ['crm_import_csv_index_file_closed', 'crm_import_csv_index_file_deleted',
    'crm_import_csv_index_job_cancelled', 'crm_import_csv_index_source_retired'],
  types: [],
}
const catalog = {scope: boundedCatalogScope, sha256: '0ff5049e60ce5b25eb2100ae09473ffaf6b6a7cee4208536550dedf830cbb4fe'}

export function boundedClassification(classification) {
  const tables = boundedCatalogScope.tables.map(table => ({
    schema: 'public', table, ownership: 'installation_derived', generatedColumns: [], identityColumns: [],
    forceRls: false, namedSlots: [],
  }))
  // The reviewed inventory is pinned at 8337. Releases 8338 and 8339 added no tables.
  return {...classification, ledgerCount: classification.ledgerCount + 2 + Object.keys(migrationHashes).length,
    tables: [...classification.tables, ...tables]}
}

export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}) {
  const previous = await predecessor({sourceRoot})
  for (const [name, hash] of Object.entries(migrationHashes)) {
    if (sha(await readFile(resolve(sourceRoot, 'migrations', name))) !== hash) throw Error('bounded_data_access_migration_changed: ' + name)
  }
  return {...previous, additionalCatalogs: [...previous.additionalCatalogs, catalog],
    portableSuccessor: {...previous.portableSuccessor, migrations: [...previous.portableSuccessor.migrations, ...Object.keys(migrationHashes)]},
    sourceDigest: sha(JSON.stringify({predecessor: previous.sourceDigest, migrationHashes, catalog}))}
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
