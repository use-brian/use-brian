import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fastCheckTestFiles, selectFastChecks } from '../testing/run-fast-checks.mjs'

const driver = new URL('../testing/run-fast-checks.mjs', import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const packageDir = 'packages/api'
const suite = 'src/routes/__tests__/teamspaces-contract.test.mjs'
const contract = 'packages/shared/src/teamspaces.ts'
const check = 'teamspaces-contract'
const homeSuite = 'src/routes/__tests__/home-dock-contract.test.mjs'
const homeCheck = 'home-dock-contract'
const homeRoute = 'packages/api/src/routes/home-dock.ts'

it('[COMP:tooling/fast-checks] selects only the registered contract inputs and suites', () => {
  assert.deepEqual(fastCheckTestFiles(packageDir), [suite, homeSuite])
  assert.deepEqual(fastCheckTestFiles('apps/app-web'), [])
  for (const path of [
    'apps/app-web/src/components/doc/doc-sidebar-data.tsx',
    'apps/app-web/src/components/doc/teamspace-settings-modal.tsx',
    'packages/api/src/routes/teamspaces.ts',
    'apps/app-web/src/lib/api/teamspaces.ts',
    `${packageDir}/${suite}`,
    contract,
    join(root, contract),
    './packages/shared/src/../src/teamspaces.ts',
  ]) {
    assert.deepEqual(selectFastChecks([path]), [check], path)
  }
  for (const path of [
    homeRoute,
    'apps/app-web/src/lib/api/home-dock.ts',
    'packages/core/src/home/merge.ts',
    'packages/core/src/home/types.ts',
    'packages/shared/src/home-dock.ts',
    `${packageDir}/${homeSuite}`,
  ]) {
    assert.deepEqual(selectFastChecks([path]), [homeCheck], path)
  }
  for (const path of [
    'packages/api/package.json',
    'packages/api/src/routes/__tests__/helpers.ts',
    'packages/shared/package.json',
    'pnpm-lock.yaml',
    'scripts/hooks/after-edit-fast-checks.mjs',
    'scripts/testing/run-fast-checks.mjs',
    'scripts/testing/unit-partition.mjs',
  ]) {
    assert.deepEqual(selectFastChecks([path]), [check, homeCheck], path)
  }
  assert.deepEqual(selectFastChecks([contract, `${packageDir}/${suite}`, contract]), [check])
  assert.deepEqual(selectFastChecks([homeRoute, contract, homeRoute]), [check, homeCheck])
  assert.deepEqual(selectFastChecks([
    'packages/api/src/routes/chat.ts',
    'packages/api/src/routes/__tests__/teamspaces.test.ts',
    `outside/${contract}`,
    join(root, '..', contract),
    `${contract}.bak`,
    `$(touch should-not-run);${contract}`,
  ]), [])
})

it('runs the same command for each selection mode and preserves a failing suite status', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'brian-fast-checks-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const script = join(fixture, 'scripts/testing/run-fast-checks.mjs')
  const api = join(fixture, packageDir)
  const runner = join(api, 'node_modules/vitest/vitest.mjs')
  mkdirSync(join(fixture, 'scripts/testing'), { recursive: true })
  copyFileSync(driver, script)
  const run = (args, status = 0, entry = script) => spawnSync(process.execPath, [entry, ...args], {
    cwd: api,
    encoding: 'utf8',
    env: { ...process.env, BRIAN_TEST_PARTITION: 'ordinary', FAST_CHECK_FIXTURE_STATUS: String(status) },
  })
  mkdirSync(api, { recursive: true })
  const noop = run(['--changed-file', 'README.md'])
  assert.equal(noop.status, 0, noop.stderr)
  assert.equal(noop.stdout + noop.stderr, '')
  const missing = run(['--check', check])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /pnpm install --frozen-lockfile/)

  mkdirSync(join(api, 'node_modules/vitest'), { recursive: true })
  writeFileSync(runner, `if (process.env.FAST_CHECK_FIXTURE_STATUS === '-1') await new Promise(resolve => setTimeout(resolve, 1000))
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), partition: process.env.BRIAN_TEST_PARTITION }))
process.exitCode = Number(process.env.FAST_CHECK_FIXTURE_STATUS)
`)
  for (const { args, expected } of [
    { args: ['--all'], expected: [[check, suite], [homeCheck, homeSuite]] },
    { args: ['--check', check], expected: [[check, suite]] },
    { args: ['--check', homeCheck], expected: [[homeCheck, homeSuite]] },
    { args: ['--changed-file', homeRoute, '--changed-file', homeRoute], expected: [[homeCheck, homeSuite]] },
  ]) {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split('\n'), expected.flatMap(([id, file]) => [
      `Running ${id}`,
      JSON.stringify({ args: ['run', file, '--maxWorkers=1', '--pool=threads'], cwd: realpathSync(api), partition: '' }),
    ]))
  }
  const failure = run(['--all'], 7)
  assert.equal(failure.status, 7)
  assert.match(failure.stderr, /pnpm check:fast --check teamspaces-contract/)
  assert.doesNotMatch(failure.stdout, /home-dock-contract/)

  const hook = join(fixture, 'hook.mjs')
  writeFileSync(hook, `import { runFastChecks } from './scripts/testing/run-fast-checks.mjs'
process.exitCode = runFastChecks(['teamspaces-contract'], {
  timeoutMs: 50,
  writeOutput: () => {},
  writeError: message => process.stdout.write(message),
})
`)
  const timeout = run([], -1, hook)
  assert.equal(timeout.status, 1)
  assert.match(timeout.stdout, /timed out within the 50 ms fast-check budget/)
  assert.equal(timeout.stderr, '')

  for (const args of [[], ['--check', 'unknown'], ['--changed-file', ''], ['--all', '--check', check]]) {
    const result = run(args)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Usage: pnpm check:fast/)
    assert.equal(result.stdout, '')
  }
})
