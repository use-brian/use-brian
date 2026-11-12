import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { embeddedTestFiles } from '../testing/embedded-database-tests.mjs'
import {
  DEPARTMENT_ISOLATION_BOUNDARIES, DEPARTMENT_ISOLATION_CASES, DEPARTMENT_ISOLATION_SUITES,
} from '../../packages/shared/src/department-isolation-coverage.ts'
import { acceptanceShards, createAcceptanceReport, mergeAcceptanceReports, parseShard, suitesForShard } from '../testing/department-isolation-report.mjs'

const metadata = { revision: 'fixture-revision', sourceHashes: { 'fixture.ts': 'hash' }, dirtySourceHashes: {},
  migration: { latest: 'fixture.sql', count: 1, ledgerHash: 'fixture-ledger' } }

function receipts(profile = 'full') {
  const indexes = acceptanceShards(profile)
  const total = indexes.length
  return indexes.map(index => {
    const shard = parseShard(`${index}/${total}`)
    const suites = suitesForShard(shard, profile).map(suite => ({ id: suite.id, testFiles: [...suite.testFiles], executionError: null }))
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
    return createAcceptanceReport({ metadata, suites, assertions, shard, profile })
  })
}

describe('[COMP:ci/execution-topology] complete acceptance across isolated runners', () => {
  it('registers existing test files within their owning packages', () => {
    for (const suite of DEPARTMENT_ISOLATION_SUITES) {
      for (const file of suite.testFiles) {
        const path = new URL(`../../${suite.packageDir}/${file}`, import.meta.url)
        assert.equal(statSync(path).isFile(), true, `${suite.id}: ${file}`)
      }
    }
  })
  it('keeps heavy embedded replays apart and automatically includes new files', () => {
    const files = readdirSync(new URL('../../apps/api/src/__tests__/', import.meta.url))
    files.push('future-fixture.test.ts', 'helper.ts')
    const partitions = [1, 2, 3].map(shard => embeddedTestFiles(files, shard))
    assert.ok(partitions.slice(0, 2).every(files => files.length === 1))
    assert.ok(partitions[2].includes('future-fixture.test.ts'))
    const acceptanceFiles = [1, 2, 3, 4, 5, 6].flatMap(index => suitesForShard(parseShard(`${index}/6`)))
      .filter(suite => suite.packageDir === 'apps/api')
      .flatMap(suite => suite.testFiles.map(file => file.replace(/^src\/__tests__\//, '')))
    assert.deepEqual([...partitions.flat(), ...acceptanceFiles].sort(), files.filter(file => file.endsWith('.test.ts')).sort())
    assert.throws(() => embeddedTestFiles(files, 0), /Expected/)
    assert.throws(() => embeddedTestFiles([], 1), /Missing/)
  })
  it('partitions every registered suite once and isolates embedded migration replay', () => {
    for (let total = 4; total <= DEPARTMENT_ISOLATION_SUITES.length; total++) {
      const partitions = Array.from({ length: total }, (_, i) => suitesForShard(parseShard(`${i + 1}/${total}`)))
      assert.deepEqual(partitions.slice(0, 3).map(suites => suites.map(suite => suite.id)),
        [['migration-lifecycle'], ['migration-upgrade-591'], ['migration-upgrade-602']])
      assert.ok(partitions.every(suites => suites.length > 0))
      assert.deepEqual(partitions.flat().map(suite => suite.id).sort(), DEPARTMENT_ISOLATION_SUITES.map(suite => suite.id).sort())
    }
    for (const value of ['0/4', '5/4', '1/1', '1/99', '1/4junk', '1.5/4']) assert.throws(() => parseShard(value))
  })

  it('isolates capacity and recovered-history workloads while covering every suite and file exactly once in both production profiles', () => {
    const capacityFile = 'packages/api/src/__tests__/native-query-capture-capacity.integration.test.ts'
    assert.deepEqual(acceptanceShards('full'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.deepEqual(acceptanceShards('current'), [1, 2, 3, 4, 5, 6, 7])
    assert.throws(() => acceptanceShards('unknown'), /Unknown/)
    for (const profile of ['current', 'full']) {
      const indexes = acceptanceShards(profile)
      const partitions = indexes.map(index => suitesForShard(parseShard(`${index}/${indexes.length}`), profile))
      for (const id of ['native-query-capacity', 'recovered-topic-history', 'recovered-calendar-history']) {
        const owners = partitions.filter(suites => suites.some(suite => suite.id === id))
        assert.equal(owners.length, 1)
        assert.deepEqual(owners[0].map(suite => suite.id), [id])
      }
      const files = partitions.flat().flatMap(suite => suite.testFiles.map(file => `${suite.packageDir}/${file}`))
      const expected = suitesForShard(null, profile).flatMap(suite => suite.testFiles.map(file => `${suite.packageDir}/${file}`))
      assert.deepEqual(files.toSorted(), expected.toSorted())
      assert.equal(new Set(files).size, files.length)
      assert.equal(files.filter(file => file === capacityFile).length, 1)
    }
  })

  it('cannot certify missing, failed or skipped capacity or recovered-history execution', () => {
    for (const profile of ['current', 'full']) {
      for (const id of ['native-query-capacity', 'recovered-topic-history', 'recovered-calendar-history']) {
        const missing = receipts(profile).filter(part => !part.suites.some(suite => suite.id === id))
        assert.throws(() => mergeAcceptanceReports(missing, metadata, profile), /Missing/)
        for (const status of ['failed', 'skipped']) {
          const parts = receipts(profile)
          const selected = parts.find(part => part.suites.some(suite => suite.id === id))
          selected.assertions[0].status = status
          assert.throws(() => mergeAcceptanceReports(parts, metadata, profile), /incomplete or failed/)
        }
      }
    }
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

  it('accepts current scope explicitly without certifying deferred historical coverage', () => {
    const parts = receipts('current')
    assert.deepEqual(parts.flatMap(part => part.suites.map(suite => suite.id)).sort(),
      DEPARTMENT_ISOLATION_SUITES.filter(suite => suite.packageDir !== 'apps/api').map(suite => suite.id).sort())
    const merged = mergeAcceptanceReports(parts, metadata, 'current')
    assert.equal(merged.profileAccepted, true)
    assert.equal(merged.fullMatrixAccepted, false)
    assert.ok(merged.cases.some(entry => entry.deferred.length > 0))
    assert.throws(() => mergeAcceptanceReports(parts, metadata, 'full'), /partial acceptance/)
    assert.throws(() => mergeAcceptanceReports(parts.slice(1), metadata, 'current'), /Missing/)
    parts[0].assertions[0].status = 'failed'
    assert.throws(() => mergeAcceptanceReports(parts, metadata, 'current'), /incomplete or failed/)
    assert.throws(() => suitesForShard(parseShard('1/3'), 'current'), /7 shards/)
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

  it('requires executed recovered-topic, Calendar and connector-state journeys in every upgrade profile', () => {
    const journeys = [
      'src/application-platform/__tests__/native-session-parent-audience.integration.test.ts',
      'src/__tests__/native-query-capture-capacity.integration.test.ts',
      'src/__tests__/native-recording-ancestry-migration.integration.test.ts',
      'src/application-platform/__tests__/native-recording-file-ancestry.integration.test.ts',
      'src/__tests__/channel-recording-recovery.integration.test.ts',
      'src/__tests__/channel-calendar-recovery.integration.test.ts',
      'src/__tests__/channel-connector-operational-state.integration.test.ts',
    ]
    for (const profile of ['current', 'full']) {
      for (const file of journeys) {
        const parts = receipts(profile)
        const selected = parts.flatMap(part => part.suites.filter(suite => suite.testFiles.includes(file)))
        assert.equal(selected.length, 1)
        assert.equal(DEPARTMENT_ISOLATION_SUITES.find(suite => suite.id === selected[0].id).integration, true)
        for (const part of parts) part.assertions = part.assertions.filter(assertion => assertion.testFile !== file)
        assert.throws(() => mergeAcceptanceReports(parts, metadata, profile), /incomplete or failed/)
      }
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
