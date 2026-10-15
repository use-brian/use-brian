import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CATALOGUE } from '../readiness-catalogue.mjs'
import { aggregate, artifact, assessSuite, captureSource, command, digest, parseVitest, validateCatalogue, verifyArtifacts } from '../readiness-contract.mjs'
import { optionsFrom } from '../v1-readiness.mjs'
import { assertLocalFixture, validateAmbientDatabase } from '../../crm/local-fixture.mjs'

export function completeEvidence() {
  const repos = { oss: { sha: 'a'.repeat(40), files: Object.fromEntries(CATALOGUE.suites.map(s => [s.file, 'd'.repeat(64)])) }, platform: { sha: 'b'.repeat(40), files: { 'package.json': 'e'.repeat(64) } } }
  const source = { ...repos, digest: digest(repos) }
  const proof = { path: 'evidence/fixture.json', sha256: 'c'.repeat(64), bytes: 10 }
  const artifacts = { [proof.path]: proof }
  const receipt = names => ({ status: 'passed', sourceDigest: source.digest, artifact: { ...proof }, command: ['node', '--test', 'fictional.test.mjs'],
    exitCode: 0, startedAt: '2026-10-15T00:00:00Z', endedAt: '2026-10-15T00:00:01Z', assertions: names.map(name => ({ name, status: 'passed' })) })
  return { source, artifacts, receipts: Object.fromEntries(CATALOGUE.suites.map(s => [s.file, receipt(s.assertions.length ? s.assertions : ['fixture assertion'])])),
    cases: Object.fromEntries(CATALOGUE.cases.map(c => [c.id, receipt([c.id])])) }
}
const run = f => aggregate(CATALOGUE, f.receipts, f.source, f.artifacts, f.cases)

describe('[COMP:operations/v1-readiness] source-bound evidence contract', () => {
  it('V01 V02 V14 accepts complete synthetic evidence without certifying native or live execution', () => {
    const result = run(completeEvidence())
    assert.equal(result.exitCode, 0)
    assert.equal(result.verdicts.localReadiness, 'ready')
    assert.equal(result.verdicts.liveActivation, 'not_checked')
    assert.equal(Object.keys(result.dependencies).length, 9)
    assert.equal(Object.keys(result.cases).length, 14)
  })
  it('V02 refuses removing dependencies, suites, assertions or cases from the catalogue', () => {
    for (const key of ['dependencies', 'suites', 'cases']) {
      const c = structuredClone(CATALOGUE); c[key].pop()
      assert.throws(() => validateCatalogue(c), /catalogue_changed/)
    }
    const c = structuredClone(CATALOGUE); c.suites[0].assertions.pop()
    assert.throws(() => validateCatalogue(c), /catalogue_changed/)
  })
  it('V02 V14 missing, zero, skipped, failed and stale evidence never passes', () => {
    for (const mutate of [
      f => { delete f.receipts[CATALOGUE.suites[0].file] },
      f => { f.receipts[CATALOGUE.suites[0].file].assertions = [] },
      f => { f.receipts[CATALOGUE.suites[0].file].assertions[0].status = 'pending' },
      f => { f.receipts[CATALOGUE.suites[0].file].exitCode = 1 },
      f => { f.source.digest = 'changed-source' },
      f => { f.artifacts = {} },
      f => { f.receipts[CATALOGUE.suites[0].file].artifact.sha256 = 'altered' },
      f => { f.receipts[CATALOGUE.suites[0].file].status = 'not_applicable' },
      f => { f.receipts[CATALOGUE.suites[0].file].status = 'green' },
      f => { delete f.cases.V07 },
      f => { f.source.oss.sha = 'unknown' },
      f => { delete f.source.oss.files[CATALOGUE.suites[0].file] },
    ]) {
      const f = completeEvidence(); mutate(f)
      assert.equal(run(f).exitCode, 1)
    }
  })
  it('V02 requires every pinned assertion and timestamped command identity', () => {
    const f = completeEvidence(), s = CATALOGUE.suites.find(s => s.assertions.length > 1)
    const row = f.receipts[s.file]; row.assertions.pop()
    assert.equal(assessSuite(s, row, f.source.digest, f.artifacts).status, 'failed')
    row.assertions = [{ name: 'unrelated test', status: 'passed' }]; row.endedAt = 'invalid'
    assert.equal(assessSuite(s, row, f.source.digest, f.artifacts).status, 'failed')
  })
  it('V02 parses actual Vitest results and refuses unrelated or absent suite output', () => {
    const suite = CATALOGUE.suites[0], execution = { exitCode: 0 }
    assert.equal(parseVitest(suite, { success: true, testResults: [] }, execution, 'x', {}).status, 'failed')
    assert.equal(parseVitest(suite, { success: true, testResults: [{ name: `/repo/${suite.file}`, status: 'passed', assertionResults: [] }] }, execution, 'x', {}).assertions.length, 0)
  })
  it('V02 verifies artifact bytes, refuses traversal and symlink escapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'operations-proof-'))
    const outside = await mkdtemp(join(tmpdir(), 'operations-outside-'))
    try {
      await writeFile(join(dir, 'proof.json'), '{}')
      const proof = await artifact(dir, 'proof.json')
      assert.deepEqual(Object.keys(await verifyArtifacts(dir, [proof])), ['proof.json'])
      await writeFile(join(dir, 'proof.json'), '{"changed":true}')
      assert.deepEqual(await verifyArtifacts(dir, [proof]), {})
      await assert.rejects(artifact(dir, '../proof.json'), /escape/)
      await writeFile(join(outside, 'secret'), 'fictional')
      await symlink(join(outside, 'secret'), join(dir, 'escape'))
      await assert.rejects(artifact(dir, 'escape'), /escape/)
      assert.notEqual(digest({ a: 1 }), digest({ a: 2 }))
    } finally { await rm(dir, { recursive: true }); await rm(outside, { recursive: true }) }
  })
  it('V11 V12 refuses remote modes, credentials, unsafe ambient databases and unowned fixtures before connecting', async () => {
    for (const args of [['--mode', 'remote', '--report-dir', '/tmp/new'], ['--report-dir', 'relative'], ['--api-url', 'https://production.example'], ['--token', 'fictional']]) {
      assert.throws(() => optionsFrom(args))
    }
    for (const url of ['postgres://production.example/db', 'postgres://localhost/db?host=production.example', 'postgres://localhost/db?service=production']) {
      assert.throws(() => validateAmbientDatabase({ DATABASE_URL: url }))
    }
    await assert.rejects(assertLocalFixture({}), /local-fixture/)
  })
  it('V02 V14 unavailable source inventory retains an explicitly blocked snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'operations-missing-source-'))
    try {
      const result = await captureSource(dir, dir)
      assert.equal(result.status, 'blocked')
      const f = completeEvidence(); f.source = result.source
      assert.equal(run(f).exitCode, 1)
    } finally { await rm(dir, { recursive: true }) }
  })
  it('V02 Git diagnostics cannot contaminate machine source identity output', async () => {
    const result = await command(process.execPath, ['-e', "process.stdout.write('source-identity'); process.stderr.write('diagnostic warning')"], { stdoutOnly: true, timeoutMs: 5000 })
    assert.equal(result.exitCode, 0)
    assert.equal(result.output, 'source-identity')
  })
})
