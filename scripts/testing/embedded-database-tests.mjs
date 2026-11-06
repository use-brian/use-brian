import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEPARTMENT_ISOLATION_SUITES } from '../../packages/shared/src/department-isolation-coverage.ts'
import { MIGRATION_OWNER_GROUPS, MIGRATION_OWNER_SCENARIOS } from '../../apps/api/src/__tests__/migration-owner-groups.ts'

// [COMP:ci/execution-topology] The acceptance gate already executes its registered
// Node files. Keep the other full-chain replays on separate runners; round-robin
// sharding would put owner-role and session-schema together.
const isolatedFiles = [
  'migration-owner-role.test.ts',
  'session-schema.integration.test.ts',
]
const acceptanceFiles = DEPARTMENT_ISOLATION_SUITES.filter(suite => suite.packageDir === 'apps/api')
  .flatMap(suite => suite.testFiles.map(file => file.replace(/^src\/__tests__\//, '')))

export function embeddedTestFiles(files, shard) {
  if (![1, 2, 3].includes(shard)) throw new Error('Expected embedded database shard 1, 2 or 3')
  const tests = files.filter(file => file.endsWith('.test.ts')).sort()
  for (const file of [...isolatedFiles, ...acceptanceFiles]) {
    if (!tests.includes(file)) throw new Error(`Missing isolated embedded database test: ${file}`)
  }
  if (isolatedFiles.some(file => acceptanceFiles.includes(file))) throw new Error('Embedded test also assigned to acceptance')
  return shard === 3
    ? tests.filter(file => !isolatedFiles.includes(file) && !acceptanceFiles.includes(file))
    : [isolatedFiles[shard - 1]]
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const cwd = fileURLToPath(new URL('../../apps/api/', import.meta.url))
  if (process.argv[2] === 'current') {
    const directory = mkdtempSync(join(tmpdir(), 'brian-pglite-ci-'))
    const env = { ...process.env, BRIAN_TEST_PGLITE_SNAPSHOT: join(directory, 'prepared.tar'), BRIAN_TEST_HISTORY: '0' }
    const execute = (args, environment = process.env) => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...args], { cwd, env: environment, stdio: 'inherit' })
      if (result.error || result.status !== 0) throw result.error ?? new Error('Current embedded database tests failed')
    }
    try {
      execute(['--test-name-pattern=replays the whole chain from empty without a superuser', 'src/__tests__/migration-owner-role.test.ts'], env)
      execute(['src/__tests__/context-scope-security-matrix.test.ts'], env)
      const files = embeddedTestFiles(readdirSync(new URL('../../apps/api/src/__tests__/', import.meta.url)), 3)
        .filter(file => file !== 'migration-publication-privileges.test.ts')
      execute(files.map(file => `src/__tests__/${file}`))
    } finally { rmSync(directory, { recursive: true, force: true }) }
    process.exit(0)
  }
  const group = process.argv[2]
  const ownerGroup = group?.startsWith('owner-') ? group.slice('owner-'.length) : undefined
  if (ownerGroup && !MIGRATION_OWNER_GROUPS.includes(ownerGroup)) throw new Error('Unknown migration owner group')
  const shard = ownerGroup ? 1 : group === 'session' ? 2 : group === 'remaining' ? 3 : NaN
  if (!Number.isInteger(shard)) throw new Error(`Expected current, ${MIGRATION_OWNER_GROUPS.map(group => `owner-${group}`).join(', ')}, session or remaining`)
  const files = embeddedTestFiles(readdirSync(new URL('../../apps/api/src/__tests__/', import.meta.url)), shard)
  if (ownerGroup) {
    const source = readFileSync(new URL('../../apps/api/src/__tests__/migration-owner-role.test.ts', import.meta.url), 'utf8')
    for (const [title, target] of Object.entries(MIGRATION_OWNER_SCENARIOS)) {
      if (target === ownerGroup && !source.includes(title)) throw new Error(`Missing migration owner scenario: ${title}`)
    }
  }
  if (!files.length) throw new Error('Embedded database shard has no tests')
  console.log(`Embedded database group ${group}: ${files.join(', ')}`)
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
    ...files.map(file => `src/__tests__/${file}`)], { cwd, stdio: 'inherit',
    env: { ...process.env, ...(ownerGroup ? { BRIAN_TEST_MIGRATION_OWNER_GROUP: ownerGroup } : {}) } })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
