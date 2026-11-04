import { isDeepStrictEqual } from 'node:util'
import {
  DEPARTMENT_ISOLATION_BOUNDARIES,
  DEPARTMENT_ISOLATION_CASES,
  DEPARTMENT_ISOLATION_CASE_IDS,
  DEPARTMENT_ISOLATION_MANIFEST_REVISION,
  DEPARTMENT_ISOLATION_SUITES,
  departmentIsolationManifestCoverage,
} from '../../packages/shared/src/department-isolation-coverage.ts'

// [COMP:ci/execution-topology] Partial receipts never certify the full matrix.
export function parseShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value)
  if (!match) throw new Error('Expected --shard <index>/<total>')
  const [index, total] = match.slice(1).map(Number)
  if (total < 2 || total > DEPARTMENT_ISOLATION_SUITES.length || index > total) {
    throw new Error('Shard index/total is out of range')
  }
  return { index, total }
}

export function suitesForShard(shard) {
  if (!shard) return [...DEPARTMENT_ISOLATION_SUITES]
  // The embedded migration replay is the dominant suite and gets a runner alone.
  return shard.index === 1
    ? DEPARTMENT_ISOLATION_SUITES.filter(suite => suite.id === 'migration-lifecycle')
    : DEPARTMENT_ISOLATION_SUITES.filter(suite => suite.id !== 'migration-lifecycle')
      .filter((_, index) => index % (shard.total - 1) === shard.index - 2)
}

function evidenceFor(selectors, assertions) {
  return selectors.map(selector => {
    const suiteAssertions = assertions.filter(assertion => assertion.suiteId === selector.suiteId)
    const fileAssertions = suiteAssertions.filter(assertion => assertion.testFile.endsWith(selector.testFile))
    const matches = fileAssertions.filter(assertion => assertion.fullName.includes(selector.titleIncludes))
    return {
      ...selector,
      actual: matches.map(({ testFile, fullName, status, durationMs }) => ({ testFile, fullName, status, durationMs })),
      passed: matches.length > 0 && matches.every(match => match.status === 'passed'),
      ...(matches.length === 0 ? { candidates: (fileAssertions.length ? fileAssertions : suiteAssertions)
        .map(({ testFile, fullName, status }) => ({ testFile, fullName, status })) } : {}),
    }
  })
}

export function createAcceptanceReport({ metadata, suites, assertions, foundation = false, shard = null }) {
  const manifestCoverage = departmentIsolationManifestCoverage()
  const partial = foundation || shard !== null
  const cases = partial ? [] : DEPARTMENT_ISOLATION_CASES.map(entry => {
    const evidence = evidenceFor(entry.assertions, assertions)
    return { id: entry.id, passed: evidence.length > 0 && evidence.every(item => item.passed), evidence }
  })
  const boundaries = partial ? [] : DEPARTMENT_ISOLATION_BOUNDARIES.map(entry => {
    const evidence = evidenceFor(entry.tests, assertions)
    return { id: entry.id, family: entry.family, cases: [...entry.cases],
      passed: evidence.length > 0 && evidence.every(item => item.passed), evidence }
  })
  const expected = foundation
    ? DEPARTMENT_ISOLATION_SUITES.filter(suite => !['review-lifecycle', 'ui', 'compatibility'].includes(suite.id))
    : suitesForShard(shard)
  const expectedIds = expected.map(suite => suite.id).sort()
  const actualIds = suites.map(suite => suite.id).sort()
  const suitesPassed = isDeepStrictEqual(expectedIds, actualIds)
    && assertions.every(assertion => expectedIds.includes(assertion.suiteId) && assertion.status === 'passed')
    && expected.every(suite => {
      const result = suites.find(result => result.id === suite.id)
      const actual = assertions.filter(assertion => assertion.suiteId === suite.id)
      return result && !result.executionError && actual.length > 0
        && isDeepStrictEqual(result.testFiles, [...suite.testFiles])
        && actual.every(assertion => suite.testFiles.includes(assertion.testFile))
        && suite.testFiles.every(file => actual.some(assertion => assertion.testFile === file))
    })
  return {
    ...metadata,
    formatVersion: 2, mode: foundation ? 'foundation' : shard ? 'shard' : 'full',
    createdAt: new Date().toISOString(), shard,
    manifestRevision: DEPARTMENT_ISOLATION_MANIFEST_REVISION,
    manifestCoverage: { ...manifestCoverage, caseIds: [...DEPARTMENT_ISOLATION_CASE_IDS],
      boundaryIds: DEPARTMENT_ISOLATION_BOUNDARIES.map(entry => entry.id) },
    suites, assertions, cases, boundaries,
    counts: { suites: suites.length, assertions: assertions.length,
      passed: assertions.filter(item => item.status === 'passed').length,
      failed: assertions.filter(item => item.status === 'failed').length,
      skipped: assertions.filter(item => !['passed', 'failed'].includes(item.status)).length },
    suitesPassed,
    fullMatrixAccepted: !partial && manifestCoverage.complete && suitesPassed
      && cases.length === DEPARTMENT_ISOLATION_CASE_IDS.length && cases.every(entry => entry.passed)
      && boundaries.length === DEPARTMENT_ISOLATION_BOUNDARIES.length && boundaries.every(entry => entry.passed),
  }
}

export function mergeAcceptanceReports(reports, expectedMetadata) {
  if (!reports.length) throw new Error('No acceptance shard reports found')
  const total = reports[0].shard?.total
  parseShard(`1/${total}`)
  if (reports.length !== total) throw new Error('Missing acceptance shards')
  const seen = new Set()
  for (const report of reports) {
    if (report.formatVersion !== 2 || report.mode !== 'shard' || report.fullMatrixAccepted !== false) {
      throw new Error('Expected a partial acceptance shard receipt')
    }
    const shard = parseShard(`${report.shard?.index}/${report.shard?.total}`)
    if (shard.total !== total || seen.has(shard.index)) throw new Error('Duplicate or inconsistent acceptance shards')
    seen.add(shard.index)
    for (const key of ['revision', 'sourceHashes', 'dirtySourceHashes']) {
      if (!isDeepStrictEqual(report[key], expectedMetadata[key])) throw new Error(`Acceptance ${key} mismatch`)
    }
    if (report.manifestRevision !== DEPARTMENT_ISOLATION_MANIFEST_REVISION) throw new Error('Acceptance manifest mismatch')
    if (!report.migration?.ledgerHash || !isDeepStrictEqual(report.migration, reports[0].migration)) {
      throw new Error('Acceptance migration mismatch')
    }
    const checked = createAcceptanceReport({ metadata: {}, suites: report.suites, assertions: report.assertions, shard })
    if (!checked.suitesPassed) throw new Error(`Acceptance shard ${shard.index} has incomplete or failed execution`)
  }
  const ordered = [...reports].sort((a, b) => a.shard.index - b.shard.index)
  return createAcceptanceReport({
    metadata: { ...expectedMetadata, migration: reports[0].migration, shards: ordered.map(report => report.shard) },
    suites: ordered.flatMap(report => report.suites), assertions: ordered.flatMap(report => report.assertions),
  })
}
