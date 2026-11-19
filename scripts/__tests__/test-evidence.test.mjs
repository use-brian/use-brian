import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoveryEnvironment, reconcile, runnerSegments, writeReport } from '../testing/inventory.mjs'
import { unitTestExclusions } from '../testing/unit-partition.mjs'

describe('[COMP:tooling/test-evidence] discovery does not overclaim execution', () => {
  it('keeps local coverage complete and assigns ordinary-CI exclusions to acceptance owners only', () => {
    assert.deepEqual(unitTestExclusions('packages/api', ''), [])
    assert.deepEqual(unitTestExclusions('packages/channels', 'ordinary'), [])
    assert.ok(unitTestExclusions('packages/api', 'ordinary').includes('src/context-scope/__tests__/authority-lease.test.ts'))
    assert.ok(!unitTestExclusions('packages/api', 'ordinary').includes('src/routes/__tests__/auth-email.test.ts'))
    assert.ok(unitTestExclusions('packages/core', 'ordinary').includes('src/security/__tests__/access-ceiling.test.ts'))
    assert.ok(unitTestExclusions('apps/app-web', 'ordinary').includes('src/components/organization/__tests__/organization-chart.test.tsx'))
    assert.throws(() => unitTestExclusions('packages/api', 'typo'), /Unknown test partition/)
  })
  it('separates mixed Node/Vitest commands and refuses to execute custom shell text', () => {
    const parsed = runnerSegments('node --import tsx --test src/__tests__/*.test.ts && vitest run src/runtime.test.ts')
    assert.deepEqual(parsed.map(entry => entry.runner), ['node', 'vitest'])
    assert.deepEqual(parsed[1].args, ['src/runtime.test.ts'])
    assert.equal(runnerSegments('vitest run; curl https://fixture.example')[0].runner, 'manual')
    assert.equal(runnerSegments('vitest run $(cat .env)')[0].runner, 'manual')
    assert.equal(runnerSegments('vitest run --config')[0].runner, 'manual')
    assert.deepEqual(runnerSegments('vitest run --config vitest.integration.config.ts')[0].args, ['--config', 'vitest.integration.config.ts'])
  })
  it('reports excluded files as unmapped and never as passing tests', () => {
    const result = reconcile([{ path: 'a.test.ts' }, { path: 'b.integration.test.ts' }], [{ id: 'unit', lane: 'default', runner: 'vitest', files: ['a.test.ts'] }])
    assert.equal(result[0].discovery, 'discovered')
    assert.equal(result[1].discovery, 'unmapped')
    assert.ok(result.every(entry => entry.execution === 'not_run'))
  })
  it('drops inherited credentials and Node injection flags', () => {
    const env = discoveryEnvironment({ PATH: '/bin', HOME: '/fixture', DATABASE_URL: 'secret', GEMINI_API_KEY: 'secret', NODE_OPTIONS: '--import=untrusted.mjs' })
    assert.deepEqual(Object.keys(env).sort(), ['BRIAN_TEST_NO_PAID', 'CI', 'HOME', 'NODE_ENV', 'PATH'])
  })
  it('never replaces a retained failure report with a later pass', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'brian-evidence-test-'))
    try {
      const path = join(directory, 'result.json')
      await writeReport(path, { status: 'fail' })
      await assert.rejects(writeReport(path, { status: 'pass' }), /already exists/)
      assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'fail')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
