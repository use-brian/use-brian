// [COMP:ci/execution-topology] Prepare the current-schema fixture once per run.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const cwd = fileURLToPath(new URL('../../', import.meta.url))
export const ownerFile = 'migration-owner-role.test.ts'
export const contextFile = 'context-scope-security-matrix.test.ts'

export function runEmbeddedTests(testFiles, env = process.env, flags = ['--test-concurrency=1']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...flags,
    ...testFiles.map(file => `src/__tests__/${file}`)], { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

export function withPreparedPglite(run) {
  const directory = mkdtempSync(join(tmpdir(), 'brian-pglite-test-'))
  const env = { ...process.env }
  delete env.BRIAN_TEST_PGLITE_SNAPSHOT
  delete env.BRIAN_TEST_MIGRATION_OWNER_GROUP
  const prepared = { ...env, BRIAN_TEST_PGLITE_SNAPSHOT: join(directory, 'prepared.tar') }
  try {
    return run(env, prepared)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const others = readdirSync(new URL('./', import.meta.url)).filter(file => file.endsWith('.test.ts') && file !== ownerFile)
  process.exitCode = withPreparedPglite((env, prepared) => {
    const ownerStatus = runEmbeddedTests([ownerFile], prepared)
    const otherStatus = runEmbeddedTests(others, ownerStatus === 0 ? prepared : env, [])
    return ownerStatus || otherStatus
  })
}
