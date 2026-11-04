import { spawnSync } from 'node:child_process'
import { readdirSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEPARTMENT_ISOLATION_SUITES } from '../../packages/shared/src/department-isolation-coverage.ts'

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
  const files = embeddedTestFiles(readdirSync(new URL('../../apps/api/src/__tests__/', import.meta.url)), Number(process.argv[2]))
  if (!files.length) throw new Error('Embedded database shard has no tests')
  console.log(`Embedded database shard ${process.argv[2]}/3: ${files.join(', ')}`)
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
    ...files.map(file => `src/__tests__/${file}`)], { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
