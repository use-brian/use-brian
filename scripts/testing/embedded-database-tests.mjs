import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { DEPARTMENT_ISOLATION_SUITES } from '../../packages/shared/src/department-isolation-coverage.ts'
import { MIGRATION_OWNER_GROUPS, MIGRATION_OWNER_SCENARIOS } from '../../apps/api/src/__tests__/migration-owner-groups.ts'
import { contextFile, ownerFile, runEmbeddedTests, withPreparedPglite } from '../../apps/api/src/__tests__/run-embedded-tests.mjs'

// [COMP:ci/execution-topology] The acceptance gate already executes its registered
// Node files. Keep the other full-chain replays on separate runners; round-robin
// sharding would put owner-role and session-schema together.
const isolatedFiles = {
  1: ownerFile,
  2: 'session-schema.integration.test.ts',
  4: 'publication-catalog-ordering-upgrade.test.ts',
}
const acceptanceFiles = DEPARTMENT_ISOLATION_SUITES.filter(suite => suite.packageDir === 'apps/api')
  .flatMap(suite => suite.testFiles.map(file => file.replace(/^src\/__tests__\//, '')))

export function embeddedTestFiles(files, shard) {
  if (![1, 2, 3, 4].includes(shard)) throw new Error('Expected embedded database shard 1, 2, 3 or 4')
  const tests = files.filter(file => file.endsWith('.test.ts')).sort()
  for (const file of [...Object.values(isolatedFiles), ...acceptanceFiles]) {
    if (!tests.includes(file)) throw new Error(`Missing isolated embedded database test: ${file}`)
  }
  if (Object.values(isolatedFiles).some(file => acceptanceFiles.includes(file))) throw new Error('Embedded test also assigned to acceptance')
  return shard === 3
    ? tests.filter(file => !Object.values(isolatedFiles).includes(file) && !acceptanceFiles.includes(file))
    : [isolatedFiles[shard]]
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const files = readdirSync(new URL('../../apps/api/src/__tests__/', import.meta.url))
  const group = process.argv[2]
  if (group === 'current') {
    // Like owner-legacy, the isolated publication replay runs only when the CI
    // scope selects history. Current-schema mode uses the fresh owner image instead.
    process.exit(await withPreparedPglite(async (env, prepared) =>
      await runEmbeddedTests([ownerFile], { ...prepared, BRIAN_TEST_MIGRATION_OWNER_GROUP: 'fresh' })
      || await runEmbeddedTests([contextFile], { ...prepared, BRIAN_TEST_HISTORY: '0' })
      || await runEmbeddedTests(embeddedTestFiles(files, 3).filter(file => file !== 'migration-publication-privileges.test.ts'), env)))
  }
  const ownerGroup = group?.startsWith('owner-') ? group.slice('owner-'.length) : undefined
  if (ownerGroup && !MIGRATION_OWNER_GROUPS.includes(ownerGroup)) throw new Error('Unknown migration owner group')
  const shard = ownerGroup ? 1 : group === 'session' ? 2 : group === 'remaining' ? 3 : group === 'publication-upgrade' ? 4 : NaN
  if (!Number.isInteger(shard)) throw new Error(`Expected current, ${MIGRATION_OWNER_GROUPS.map(group => `owner-${group}`).join(', ')}, session, publication-upgrade or remaining`)
  const selectedFiles = embeddedTestFiles(files, shard)
  if (ownerGroup) {
    const source = readFileSync(new URL(`../../apps/api/src/__tests__/${ownerFile}`, import.meta.url), 'utf8')
    for (const [title, target] of Object.entries(MIGRATION_OWNER_SCENARIOS)) {
      if (target === ownerGroup && !source.includes(title)) throw new Error(`Missing migration owner scenario: ${title}`)
    }
  }
  if (!selectedFiles.length) throw new Error('Embedded database shard has no tests')
  console.log(`Embedded database group ${group}: ${selectedFiles.join(', ')}`)
  process.exitCode = await runEmbeddedTests(selectedFiles, { ...process.env, ...(ownerGroup ? { BRIAN_TEST_MIGRATION_OWNER_GROUP: ownerGroup } : {}) })
}
