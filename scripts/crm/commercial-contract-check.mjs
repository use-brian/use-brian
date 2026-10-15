/**
 * Fail-closed local acceptance for CRM commercial operations (R/C/I/G/A/E/U).
 * Reuses the owned local PostgreSQL fixture and the association harness's
 * per-assertion assessment; the association catalog is untouched. Every case
 * passes only when its suites ran green, its named assertions exist and
 * passed, and its declared artifacts (released invoice bytes, cutover
 * evidence, browser evidence) are present and hashed into the report.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Verification
 * [COMP:crm/commercial-assurance]
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { cleanRuntimeEnvironment, createLocalFixture, validateAmbientDatabase } from './local-fixture.mjs'
import { assessSuite, command, revision } from './brian-contract-check.mjs'
import { inspectDatabase } from '../operations/recovery-common.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const catalogPath = join(root, 'scripts/crm/fixtures/commercial-assurance.json')
const erpFixturePath = join(root, 'scripts/crm/fixtures/professional-services-erp.v1.json')
export const COMMERCIAL_CASES = ['R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6',
  'A1', 'A2', 'A3', 'E1', 'E2', 'E3', 'E4', 'U1', 'U2', 'U3']
const packages = { database: 'packages/api', api: 'packages/api', core: 'packages/core', web: 'apps/app-web', scripts: 'scripts/crm' }
const hash = (value) => createHash('sha256').update(value).digest('hex')
const jsonFile = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

export function validateCommercialCatalog(catalog) {
  const fail = (message) => { throw new Error(`Invalid commercial acceptance catalog: ${message}`) }
  if (catalog?.schemaVersion !== 1) fail('schemaVersion')
  if (JSON.stringify(Object.keys(catalog.caseDescriptions ?? {})) !== JSON.stringify(COMMERCIAL_CASES)) fail('case list')
  if (!Number.isInteger(catalog.groupTimeoutSeconds) || catalog.groupTimeoutSeconds < 1 || catalog.groupTimeoutSeconds > 3600) fail('timeout')
  if (!Array.isArray(catalog.suites) || !catalog.suites.length) fail('suites')
  const files = new Set()
  for (const suite of catalog.suites) {
    const prefix = packages[suite.group]
    const pattern = suite.group === 'scripts' ? /^[\w/.-]+\.test\.mjs$/ : /^[\w/.[\]-]+\.test\.tsx?$/
    if (!prefix || typeof suite.file !== 'string' || !suite.file.startsWith(prefix + '/') || !pattern.test(suite.file) || suite.file.split('/').includes('..')
      || files.has(suite.file) || !Array.isArray(suite.cases) || !suite.cases.length || suite.cases.some((id) => !COMMERCIAL_CASES.includes(id))
      || (suite.group === 'database') !== suite.file.endsWith('.integration.test.ts')) fail(`suite ${suite.file}`)
    files.add(suite.file)
  }
  for (const id of COMMERCIAL_CASES) {
    const suites = catalog.suites.filter((suite) => suite.cases.includes(id)).map((suite) => suite.file)
    if (!suites.length) fail(`case ${id} has no suite`)
    const requirements = catalog.assertions?.[id]
    if (!Array.isArray(requirements) || !requirements.length) fail(`case ${id} has no assertion requirement`)
    for (const requirement of requirements) {
      const targets = requirement.files ?? [requirement.file]
      if (!targets.length || targets.some((file) => !suites.includes(file)) || typeof requirement.pattern !== 'string') fail(`case ${id} assertion requirement`)
      new RegExp(requirement.pattern, requirement.flags ?? '')
    }
  }
  for (const [id, artifacts] of Object.entries(catalog.artifacts ?? {})) {
    if (!COMMERCIAL_CASES.includes(id) || !Array.isArray(artifacts) || artifacts.some((name) => !/^[\w.-]+$/.test(name))) fail(`artifacts ${id}`)
  }
  return catalog
}

/** Node's JUnit reporter output as the same shape the Vitest JSON reporter produces. */
export function junitResult(xml, absoluteFile, exitCode) {
  const assertionResults = []
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /\bname="([^"]*)"/.exec(match[1])?.[1] ?? ''
    const body = match[3] ?? ''
    const status = /<failure\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed'
    assertionResults.push({ fullName: name.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), status })
  }
  const failed = exitCode !== 0 || assertionResults.some((row) => row.status !== 'passed')
  return { success: !failed, testResults: [{ name: absoluteFile, status: failed ? 'failed' : 'passed', assertionResults }] }
}

/** A U3 browser record: the same code revision, both viewports, every surface passed with a screenshot hash. */
export function validateBrowserEvidence(evidence, { ossSha, surfaces }) {
  const problems = []
  if (evidence?.schema !== 'crm-commercial-browser-v1') problems.push('schema')
  if (!ossSha || evidence?.ossSha !== ossSha) problems.push('revision')
  const viewports = Array.isArray(evidence?.viewports) ? evidence.viewports : []
  for (const [label, test] of [['desktop', (width) => width >= 1200], ['phone', (width) => width === 360]]) {
    const viewport = viewports.find((row) => test(row.width))
    if (!viewport) { problems.push(`${label}_viewport`); continue }
    for (const surface of surfaces) {
      const check = viewport.checks?.find((row) => row.surface === surface)
      if (!check || check.status !== 'passed' || !/^[a-f0-9]{64}$/.test(check.screenshotSha256 ?? '') || check.horizontalOverflow !== false) problems.push(`${label}:${surface}`)
    }
  }
  return { status: problems.length ? 'failed' : 'passed', problems }
}

/** Per case: every suite passed, every assertion requirement matched passing assertions, every artifact present. */
export function assessCommercialCases(catalog, evidence, artifacts, browser) {
  return Object.fromEntries(COMMERCIAL_CASES.map((id) => {
    const suites = catalog.suites.filter((suite) => suite.cases.includes(id))
    const rows = suites.map((suite) => ({ file: suite.file, status: evidence[suite.file]?.status ?? 'not_run', reason: evidence[suite.file]?.reason }))
    const problems = rows.filter((row) => row.status !== 'passed').map((row) => `${row.file}:${row.status}${row.reason ? `:${row.reason}` : ''}`)
    const matched = []
    for (const requirement of catalog.assertions[id]) {
      const pattern = new RegExp(requirement.pattern, requirement.flags ?? '')
      const found = (requirement.files ?? [requirement.file]).flatMap((file) => (evidence[file]?.assertions ?? []).filter((row) => pattern.test(row.name ?? '')))
      if (found.length < (requirement.minimum ?? 1)) problems.push(`assertions:${requirement.pattern}:${found.length}`)
      if (found.some((row) => row.status !== 'passed')) problems.push(`assertions_not_passed:${requirement.pattern}`)
      matched.push(...found.map((row) => row.name))
    }
    for (const name of catalog.artifacts?.[id] ?? []) if (!artifacts[name]) problems.push(`artifact_missing:${name}`)
    if (id === 'U3' && browser?.status !== 'passed') problems.push(`browser_evidence:${(browser?.problems ?? ['missing']).join(',')}`)
    const blocked = rows.some((row) => row.status === 'blocked')
    const status = !problems.length ? 'passed' : blocked ? 'blocked' : rows.every((row) => row.status === 'not_run') ? 'not_run' : 'failed'
    return [id, { description: catalog.caseDescriptions[id], status, problems, assertions: matched, evidence: rows }]
  }))
}

export function validateCommercialOptions(options) {
  if ((options.mode ?? 'local') !== 'local') throw new Error('The commercial contract check runs only in local mode against an owned fixture.')
  if (!options.reportDir || !isAbsolute(options.reportDir)) throw new Error('Supply an absolute new --report-dir')
  if (options.browserEvidence && !isAbsolute(options.browserEvidence)) throw new Error('--browser-evidence must be an absolute path')
  for (const key of ['apiUrl', 'workspaceId', 'tokenEnv', 'tokenFile']) if (options[key] !== undefined) throw new Error('Local mode refuses remote credentials and targets')
  return { ...options, mode: 'local' }
}

async function runVitestGroup(group, catalog, env, reportDir, evidence) {
  const suites = catalog.suites.filter((suite) => suite.group === group)
  if (!suites.length) return
  const cwd = join(root, packages[group]), before = new Map()
  for (const suite of suites) {
    try { before.set(suite.file, hash(await readFile(join(root, suite.file)))) } catch { evidence[suite.file] = { status: 'failed', reason: 'missing_source', assertions: [] } }
  }
  const selected = suites.filter((suite) => before.has(suite.file))
  if (!selected.length) return
  const resultPath = join(reportDir, `${group}.json`), logPath = join(reportDir, `${group}.log`)
  const args = ['exec', 'vitest', 'run', ...(group === 'database' ? ['--config', 'vitest.integration.config.ts'] : []), '--maxWorkers=1', '--fileParallelism=false',
    '--reporter=json', '--outputFile', resultPath, ...selected.map((suite) => relative(cwd, join(root, suite.file)))]
  const execution = await command('pnpm', args, { cwd, env, timeoutMs: catalog.groupTimeoutSeconds * 1000 })
  await writeFile(logPath, execution.output, { mode: 0o600 })
  let result = null
  try { result = JSON.parse(await readFile(resultPath, 'utf8')) } catch {}
  for (const suite of selected) {
    const after = hash(await readFile(join(root, suite.file)))
    evidence[suite.file] = { ...assessSuite(suite, result, execution.code), ...(before.get(suite.file) !== after ? { status: 'failed', reason: 'suite_changed_during_run' } : {}),
      sourceHash: before.get(suite.file), exitCode: execution.code, timedOut: execution.timedOut, report: `${group}.json`, log: `${group}.log` }
  }
}

async function runScriptSuites(catalog, env, reportDir, evidence) {
  for (const suite of catalog.suites.filter((row) => row.group === 'scripts')) {
    const file = join(root, suite.file), name = suite.file.split('/').pop().replace(/\.test\.mjs$/, '')
    let before
    try { before = hash(await readFile(file)) } catch { evidence[suite.file] = { status: 'failed', reason: 'missing_source', assertions: [] }; continue }
    const junit = join(reportDir, `scripts-${name}.xml`)
    const execution = await command(process.execPath, ['--test', '--test-reporter=junit', `--test-reporter-destination=${junit}`, file], { cwd: root, env, timeoutMs: 300_000 })
    await writeFile(join(reportDir, `scripts-${name}.log`), execution.output, { mode: 0o600 })
    let xml = ''
    try { xml = await readFile(junit, 'utf8') } catch {}
    const result = junitResult(xml, file, execution.code)
    evidence[suite.file] = { ...assessSuite(suite, result, execution.code), ...(before !== hash(await readFile(file)) ? { status: 'failed', reason: 'suite_changed_during_run' } : {}),
      sourceHash: before, exitCode: execution.code, timedOut: execution.timedOut, report: `scripts-${name}.xml` }
  }
}

async function collectArtifacts(reportDir) {
  const directory = join(reportDir, 'artifacts'), artifacts = {}
  let names = []
  try { names = await readdir(directory) } catch { return artifacts }
  for (const name of names) {
    const info = await stat(join(directory, name))
    if (info.isFile() && info.size > 0) artifacts[name] = { sha256: hash(await readFile(join(directory, name))), bytes: info.size }
  }
  return artifacts
}

export async function runCommercialAcceptance(rawOptions) {
  const options = validateCommercialOptions(rawOptions)
  validateAmbientDatabase(process.env)
  const catalogBytes = await readFile(catalogPath), catalog = validateCommercialCatalog(JSON.parse(catalogBytes))
  await mkdir(options.reportDir, { mode: 0o700 }) // an existing destination always fails
  await mkdir(join(options.reportDir, 'artifacts'), { mode: 0o700 })
  const evidence = {}
  const report = { schema: 'brian-crm-commercial-assurance-v1', mode: 'local', startedAt: new Date().toISOString(),
    catalogHash: hash(catalogBytes), erpFixtureHash: hash(await readFile(erpFixturePath)),
    source: { oss: await revision(root), platform: await revision(resolve(root, '..')) }, database: null, artifacts: {}, browser: null, engineering: null }
  let fixture, runtimeFailure
  try {
    const build = await command('pnpm', ['--filter', '@use-brian/core...', 'build'], { timeoutMs: 300_000 })
    await writeFile(join(options.reportDir, 'build.log'), build.output, { mode: 0o600 })
    if (build.code) throw new Error('Shared/core build failed; see build.log. Refusing stale compiled code.')
    try {
      fixture = await createLocalFixture({ pgBin: options.pgBin, migrationDirs: [], walArchive: false })
      const client = new pg.Client({ connectionString: fixture.env.DATABASE_URL })
      try {
        await client.connect()
        const { identity, migrations, schemaHash, extensions } = await inspectDatabase(client)
        const files = []
        for (const name of migrations) { try { files.push({ name, sha256: hash(await readFile(join(root, 'packages/api/migrations', name))) }) } catch {} }
        report.database = { postgresVersion: identity.postgres_version, migrations, schemaHash, extensions, migrationFiles: files, migrationManifestHash: hash(JSON.stringify(files)) }
      } finally { await client.end() }
    } catch (error) {
      report.database = { status: 'blocked', reason: String(error.message), remedy: 'Install PostgreSQL 18 with pgvector and pg_trgm; rerun with --pg-bin /path/to/postgresql18/bin and a new report directory.' }
      for (const suite of catalog.suites.filter((row) => row.group === 'database')) evidence[suite.file] = { status: 'blocked', reason: 'database_prerequisite', assertions: [] }
    }
    const env = { ...(fixture?.env ?? cleanRuntimeEnvironment(process.env)), BRIAN_ASSURANCE_REPORT_DIR: options.reportDir }
    if (report.database?.schemaHash) await runVitestGroup('database', catalog, env, options.reportDir, evidence)
    for (const group of ['api', 'core', 'web']) await runVitestGroup(group, catalog, env, options.reportDir, evidence)
    await runScriptSuites(catalog, env, options.reportDir, evidence)
    if (options.browserEvidence) {
      try {
        const raw = await readFile(options.browserEvidence)
        await copyFile(options.browserEvidence, join(options.reportDir, 'artifacts', 'browser-evidence.json'))
        report.browser = validateBrowserEvidence(JSON.parse(raw), { ossSha: report.source.oss?.sha, surfaces: catalog.browserSurfaces })
      } catch (error) { report.browser = { status: 'failed', problems: [`unreadable:${error.message}`] } }
    } else report.browser = { status: 'not_run', problems: ['no --browser-evidence supplied'] }
  } catch (error) {
    runtimeFailure = { status: 'failed', reason: String(error.message) }
  } finally {
    if (fixture) try { await fixture.dispose() } catch { runtimeFailure = { status: 'failed', reason: 'Owned fixture cleanup failed; inspect local fixture logs.' } }
  }
  report.artifacts = await collectArtifacts(options.reportDir)
  const cases = assessCommercialCases(catalog, evidence, report.artifacts, report.browser)
  const states = Object.values(cases).map((row) => row.status)
  report.engineering = { status: runtimeFailure ? 'failed' : states.every((state) => state === 'passed') ? 'passed' : states.includes('failed') ? 'failed' : states.includes('blocked') ? 'blocked' : 'not_run', cases }
  if (runtimeFailure) report.runtimeFailure = runtimeFailure
  report.suites = evidence
  report.completedAt = new Date().toISOString()
  report.sourceAfter = { oss: await revision(root), platform: await revision(resolve(root, '..')) }
  await jsonFile(join(options.reportDir, 'report.json'), report)
  const lines = ['# CRM commercial assurance evidence', '', `Engineering: **${report.engineering.status}**. Local evidence only; production rollout is not certified.`, '',
    `OSS revision: ${report.source.oss?.sha ?? 'unavailable'} (dirty: ${report.source.oss?.dirty ?? 'unknown'}). Catalog ${report.catalogHash.slice(0, 12)}.`, '',
    '| Case | Status | Problems |', '| --- | --- | --- |',
    ...Object.entries(cases).map(([id, row]) => `| ${id} | ${row.status} | ${row.problems.join('; ') || '-'} |`), '',
    '| Artifact | SHA-256 | Bytes |', '| --- | --- | --- |', ...Object.entries(report.artifacts).map(([name, row]) => `| ${name} | ${row.sha256} | ${row.bytes} |`), '']
  await writeFile(join(options.reportDir, 'report.md'), lines.join('\n'), { mode: 0o600 })
  return report
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: commercial-contract-check.mjs --mode local --report-dir /new/private/report [--pg-bin /postgres18/bin] [--browser-evidence /abs/browser-evidence.json]\nRuns every R/C/I/G/A/E/U case against an owned PostgreSQL 18 fixture. Exits nonzero unless every case passed.')
    return
  }
  const names = { '--mode': 'mode', '--report-dir': 'reportDir', '--pg-bin': 'pgBin', '--browser-evidence': 'browserEvidence' }
  const options = {}
  while (args.length) {
    const name = args.shift(), value = args.shift()
    if (!names[name] || !value || value.startsWith('--') || options[names[name]] !== undefined) throw new Error('Unknown, duplicate or empty option; see --help')
    options[names[name]] = value
  }
  const report = await runCommercialAcceptance(options)
  console.log(JSON.stringify({ engineering: report.engineering.status, report: join(options.reportDir, 'report.json') }))
  if (report.engineering.status !== 'passed') process.exitCode = 1
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1 })
