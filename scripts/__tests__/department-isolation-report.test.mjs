import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { embeddedTestFiles } from '../testing/embedded-database-tests.mjs'
import {
  DEPARTMENT_ISOLATION_BOUNDARIES, DEPARTMENT_ISOLATION_CASES, DEPARTMENT_ISOLATION_SUITES,
} from '../../packages/shared/src/department-isolation-coverage.ts'
import { createAcceptanceReport, mergeAcceptanceReports, parseShard, suitesForShard } from '../testing/department-isolation-report.mjs'

const metadata = { revision: 'fixture-revision', sourceHashes: { 'fixture.ts': 'hash' }, dirtySourceHashes: {},
  migration: { latest: 'fixture.sql', count: 1, ledgerHash: 'fixture-ledger' } }

function receipts() {
  return [1, 2, 3, 4].map(index => {
    const shard = parseShard(`${index}/4`)
    const suites = suitesForShard(shard).map(suite => ({ id: suite.id, testFiles: [...suite.testFiles], executionError: null }))
    const assertions = suites.flatMap(suite => suite.testFiles.map(testFile => ({
      suiteId: suite.id, testFile, fullName: 'fixture coverage', status: 'passed', durationMs: 1,
    })))
    for (const selector of [
      ...DEPARTMENT_ISOLATION_CASES.flatMap(entry => entry.assertions),
      ...DEPARTMENT_ISOLATION_BOUNDARIES.flatMap(entry => entry.tests),
    ]) {
      if (suites.some(suite => suite.id === selector.suiteId)) assertions.push({
        ...selector, fullName: selector.titleIncludes, status: 'passed', durationMs: 1,
      })
    }
    return createAcceptanceReport({ metadata, suites, assertions, shard })
  })
}

describe('[COMP:ci/execution-topology] complete acceptance across isolated runners', () => {
  it('keeps heavy embedded replays apart and automatically includes new files', () => {
    const files = readdirSync(new URL('../../apps/api/src/__tests__/', import.meta.url))
    files.push('future-fixture.test.ts', 'helper.ts')
    const partitions = [1, 2, 3].map(shard => embeddedTestFiles(files, shard))
    assert.ok(partitions.slice(0, 2).every(files => files.length === 1))
    assert.ok(partitions[2].includes('future-fixture.test.ts'))
    const acceptanceFiles = [1, 2, 3, 4].flatMap(index => suitesForShard(parseShard(`${index}/4`)))
      .filter(suite => suite.packageDir === 'apps/api')
      .flatMap(suite => suite.testFiles.map(file => file.replace(/^src\/__tests__\//, '')))
    assert.deepEqual([...partitions.flat(), ...acceptanceFiles].sort(), files.filter(file => file.endsWith('.test.ts')).sort())
    assert.throws(() => embeddedTestFiles(files, 0), /Expected/)
    assert.throws(() => embeddedTestFiles([], 1), /Missing/)
  })
  it('partitions every registered suite once and isolates embedded migration replay', () => {
    for (let total = 2; total <= DEPARTMENT_ISOLATION_SUITES.length; total++) {
      const partitions = Array.from({ length: total }, (_, i) => suitesForShard(parseShard(`${i + 1}/${total}`)))
      assert.deepEqual(partitions[0].map(suite => suite.id), ['migration-lifecycle'])
      assert.ok(partitions.every(suites => suites.length > 0))
      assert.deepEqual(partitions.flat().map(suite => suite.id).sort(), DEPARTMENT_ISOLATION_SUITES.map(suite => suite.id).sort())
    }
    for (const value of ['0/4', '5/4', '1/1', '1/99', '1/4junk', '1.5/4']) assert.throws(() => parseShard(value))
  })

  it('certifies only a complete matching set, regardless of report arrival order', () => {
    const parts = receipts()
    assert.ok(parts.every(part => part.suitesPassed && !part.fullMatrixAccepted))
    const merged = mergeAcceptanceReports(parts.reverse(), metadata)
    assert.equal(merged.fullMatrixAccepted, true)
    assert.equal(merged.mode, 'full')
    assert.equal(merged.cases.length, 18)
    assert.equal(merged.boundaries.length, DEPARTMENT_ISOLATION_BOUNDARIES.length)
  })

  it('rejects missing, duplicate, stale and mixed-migration receipts', () => {
    assert.throws(() => mergeAcceptanceReports([], metadata), /No acceptance/)
    assert.throws(() => mergeAcceptanceReports(receipts().slice(1), metadata), /Missing/)
    const duplicate = receipts(); duplicate[1] = duplicate[0]
    assert.throws(() => mergeAcceptanceReports(duplicate, metadata), /Duplicate/)
    for (const key of ['revision', 'sourceHashes', 'dirtySourceHashes', 'manifestRevision', 'migration']) {
      const parts = receipts(); parts[0][key] = 'different'
      assert.throws(() => mergeAcceptanceReports(parts, metadata), /mismatch/)
    }
  })

  it('rechecks execution instead of trusting a saved passing flag', () => {
    for (const mutate of [
      part => { part.assertions = [] },
      part => { part.assertions[0].status = 'skipped' },
      part => { part.assertions[0].status = 'failed' },
      part => { part.suites[0].executionError = 'process exited nonzero' },
      part => { part.suites.push(part.suites[0]) },
      part => { part.suites[0].testFiles = [] },
      part => { part.assertions[0].suiteId = 'unknown' },
      part => { part.assertions[0].testFile = 'unknown.test.ts' },
    ]) {
      const parts = receipts(); mutate(parts[0])
      assert.throws(() => mergeAcceptanceReports(parts, metadata), /incomplete or failed/)
    }
  })

  it('refuses certification when an A01-A18 selector has no executed match', () => {
    const parts = receipts()
    for (const part of parts) part.assertions = part.assertions.filter(assertion => assertion.fullName === 'fixture coverage')
    assert.equal(mergeAcceptanceReports(parts, metadata).fullMatrixAccepted, false)
  })

  it('keeps foundation and zero-test runs uncertified', () => {
    const full = mergeAcceptanceReports(receipts(), metadata)
    assert.equal(createAcceptanceReport({ metadata, suites: full.suites, assertions: full.assertions, foundation: true }).fullMatrixAccepted, false)
    assert.equal(createAcceptanceReport({ metadata, suites: [], assertions: [] }).fullMatrixAccepted, false)
  })
})
