// [COMP:crm/commercial-assurance] Fail-closed commercial acceptance report.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { COMMERCIAL_CASES, assessCommercialCases, junitResult, validateBrowserEvidence, validateCommercialCatalog, validateCommercialOptions }
  from '../commercial-contract-check.mjs'

const catalog = validateCommercialCatalog(JSON.parse(readFileSync(new URL('../fixtures/commercial-assurance.json', import.meta.url), 'utf8')))
const SHA = 'a'.repeat(40)
const screenshot = 'b'.repeat(64)

/** Evidence where every suite passed with assertions satisfying every requirement. */
function greenEvidence() {
  const evidence = {}
  for (const suite of catalog.suites) {
    const assertions = []
    for (const [id, requirements] of Object.entries(catalog.assertions)) {
      for (const requirement of requirements) {
        if (!(requirement.files ?? [requirement.file]).includes(suite.file)) continue
        for (let index = 0; index < (requirement.minimum ?? 1); index++) assertions.push({ name: `suite ${id} stale retry case ${index} ${requirement.pattern}`, status: 'passed' })
      }
    }
    if (!assertions.length) assertions.push({ name: 'covered', status: 'passed' })
    evidence[suite.file] = { status: 'passed', assertions }
  }
  return evidence
}
const artifacts = Object.fromEntries(Object.values(catalog.artifacts).flat().map((name) => [name, { sha256: 'c'.repeat(64), bytes: 10 }]))
const browserRecord = () => ({ schema: 'crm-commercial-browser-v1', ossSha: SHA, viewports: [1440, 360].map((width) => ({ width,
  checks: catalog.browserSurfaces.map((surface) => ({ surface, status: 'passed', screenshotSha256: screenshot, horizontalOverflow: false })) })) })
const browser = () => validateBrowserEvidence(browserRecord(), { ossSha: SHA, surfaces: catalog.browserSurfaces })

describe('[COMP:crm/commercial-assurance] commercial contract check', () => {
  it('validates a catalog that names every case, suite, assertion requirement and artifact', () => {
    assert.deepEqual(Object.keys(catalog.caseDescriptions), COMMERCIAL_CASES)
    const missingCase = structuredClone(catalog)
    missingCase.suites = missingCase.suites.map((suite) => ({ ...suite, cases: suite.cases.filter((id) => id !== 'E3') })).filter((suite) => suite.cases.length)
    assert.throws(() => validateCommercialCatalog(missingCase), /case E3 has no suite/)
    const missingAssertion = structuredClone(catalog)
    delete missingAssertion.assertions.G2
    assert.throws(() => validateCommercialCatalog(missingAssertion), /G2 has no assertion requirement/)
    const strayFile = structuredClone(catalog)
    strayFile.assertions.R1 = [{ file: 'packages/api/src/elsewhere.integration.test.ts', pattern: ' R1 ' }]
    assert.throws(() => validateCommercialCatalog(strayFile), /R1 assertion requirement/)
  })

  it('passes only when every suite, assertion requirement, artifact and browser record is satisfied', () => {
    const cases = assessCommercialCases(catalog, greenEvidence(), artifacts, browser())
    assert.deepEqual(Object.values(cases).map((row) => row.status), COMMERCIAL_CASES.map(() => 'passed'))
  })

  it('fails a case for a failed, skipped, empty, missing or blocked suite', () => {
    const file = 'packages/api/src/crm-operations/__tests__/erp-bridge.integration.test.ts'
    for (const [mutate, status] of [
      [(evidence) => { evidence[file].status = 'failed' }, 'failed'],
      [(evidence) => { evidence[file].assertions[0].status = 'skipped' }, 'failed'],
      [(evidence) => { evidence[file].assertions = [] }, 'failed'],
      [(evidence) => { delete evidence[file] }, 'failed'],
      [(evidence) => { evidence[file] = { status: 'blocked', reason: 'database_prerequisite', assertions: [] } }, 'blocked'],
    ]) {
      const evidence = greenEvidence()
      mutate(evidence)
      const cases = assessCommercialCases(catalog, evidence, artifacts, browser())
      assert.equal(cases.E1.status, status)
      assert.equal(cases.R1.status, 'passed')
    }
  })

  it('fails a case whose named assertion is absent even when its suite passed', () => {
    const evidence = greenEvidence()
    const file = 'packages/api/src/crm-operations/__tests__/governed-records.integration.test.ts'
    evidence[file].assertions = evidence[file].assertions.filter((row) => !row.name.includes(' G2 '))
    const cases = assessCommercialCases(catalog, evidence, artifacts, browser())
    assert.equal(cases.G2.status, 'failed')
    assert.match(cases.G2.problems.join(), /assertions: G2 :0/)
  })

  it('fails invoice and cutover cases without their evidence artifacts', () => {
    const { 'crm-invoice.pdf': _pdf, 'erp-cutover.json': _cutover, ...rest } = artifacts
    const cases = assessCommercialCases(catalog, greenEvidence(), rest, browser())
    assert.equal(cases.I5.status, 'failed')
    assert.equal(cases.E4.status, 'failed')
    assert.equal(cases.I6.status, 'passed')
  })

  it('requires browser evidence from the same revision with both viewports and no overflow', () => {
    const base = { ossSha: SHA, surfaces: catalog.browserSurfaces }
    assert.equal(browser().status, 'passed')
    assert.deepEqual(validateBrowserEvidence({ ...browserRecord(), ossSha: 'd'.repeat(40) }, base).problems, ['revision'])
    const phoneless = browserRecord(); phoneless.viewports = phoneless.viewports.filter((row) => row.width !== 360)
    assert.ok(validateBrowserEvidence(phoneless, base).problems.includes('phone_viewport'))
    const overflow = browserRecord(); overflow.viewports[1].checks[0].horizontalOverflow = true
    assert.equal(validateBrowserEvidence(overflow, base).status, 'failed')
    const cases = assessCommercialCases(catalog, greenEvidence(), artifacts, { status: 'not_run', problems: ['no --browser-evidence supplied'] })
    assert.equal(cases.U3.status, 'failed')
    assert.equal(cases.U1.status, 'passed')
  })

  it('reads Node JUnit output fail-closed and refuses remote or relative options', () => {
    const xml = '<testsuites><testsuite><testcase name="a &amp; b" time="0.1"/><testcase name="c"><skipped/></testcase></testsuite></testsuites>'
    const result = junitResult(xml, '/abs/x.test.mjs', 0)
    assert.deepEqual(result.testResults[0].assertionResults, [{ fullName: 'a & b', status: 'passed' }, { fullName: 'c', status: 'skipped' }])
    assert.equal(result.success, false)
    assert.equal(junitResult('', '/abs/x.test.mjs', 0).testResults[0].assertionResults.length, 0)
    assert.throws(() => validateCommercialOptions({ mode: 'production', reportDir: '/tmp/x' }), /only in local mode/)
    assert.throws(() => validateCommercialOptions({ reportDir: 'relative' }), /absolute/)
    assert.throws(() => validateCommercialOptions({ reportDir: '/tmp/x', apiUrl: 'https://api.example.com' }), /refuses remote/)
  })
})
