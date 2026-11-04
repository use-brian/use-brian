import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoveryEnvironment, reconcile, runnerSegments, writeReport } from '../testing/inventory.mjs'

describe('[COMP:tooling/test-evidence] discovery does not overclaim execution', () => {
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
