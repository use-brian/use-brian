// [COMP:ci/execution-topology] Prepare the current-schema fixture once per run.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { globSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const cwd = fileURLToPath(new URL('../../', import.meta.url))
export const ownerFile = 'migration-owner-role.test.ts'
export const contextFile = 'context-scope-security-matrix.test.ts'
export const localTestGlob = 'src/__tests__/*.test.ts'

export async function runEmbeddedTests(testFiles, env = process.env, flags = ['--test-concurrency=1']) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...flags,
    ...testFiles.map(file => `src/__tests__/${file}`)], { cwd, env, stdio: 'inherit' })
  const [status] = await once(child, 'exit')
  return status ?? 1
}

export async function withPreparedPglite(run) {
  const directory = mkdtempSync(join(tmpdir(), 'brian-pglite-test-'))
  const env = { ...process.env }
  delete env.BRIAN_TEST_PGLITE_SNAPSHOT
  delete env.BRIAN_TEST_MIGRATION_OWNER_GROUP
  const prepared = { ...env, BRIAN_TEST_PGLITE_SNAPSHOT: join(directory, 'prepared.tar') }
  try {
    return await run(env, prepared)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const others = globSync(localTestGlob, { cwd }).map(file => basename(file)).sort()
    .filter(file => file !== ownerFile && file !== contextFile)
  process.exitCode = await withPreparedPglite(async (env, prepared) => {
    const ownerAndContext = runEmbeddedTests([ownerFile], prepared).then(async ownerStatus => {
      const contextStatus = await runEmbeddedTests([contextFile], ownerStatus === 0 ? prepared : env)
      return ownerStatus || contextStatus
    })
    const outcomes = await Promise.allSettled([ownerAndContext, runEmbeddedTests(others, env, [])])
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') throw outcome.reason
    }
    return outcomes.find(outcome => outcome.value !== 0)?.value ?? 0
  })
}
