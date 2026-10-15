/** Versioned, fail-closed engineering evidence. [COMP:crm/assurance-harness] */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { resolve, relative, join, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { createLocalFixture, cleanRuntimeEnvironment, validateAmbientDatabase } from './local-fixture.mjs'
import { inspectDatabase } from '../operations/recovery-common.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const catalogPath = join(root, 'scripts/crm/fixtures/association-assurance.json')
const packages = { database: 'packages/api', api: 'packages/api', core: 'packages/core', shared: 'packages/shared', web: 'apps/app-web' }
const caseIds = ['M1', 'M2', 'M3', 'M4', 'A', 'B', 'C', 'C2', 'D', 'E', 'E2', 'F', 'G', 'G2', 'H', 'I', 'J', 'K']
const hash = value => createHash('sha256').update(value).digest('hex')
const redact = value => String(value).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[redacted database URL]')
  .replace(/sk_(?:crm|intake|brain)_[A-Za-z0-9_-]+/g, '[redacted credential]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
const jsonFile = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

export function validateCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || JSON.stringify(Object.keys(catalog.caseDescriptions ?? {})) !== JSON.stringify(caseIds)
    || !Array.isArray(catalog.suites) || !catalog.suites.length || !Number.isInteger(catalog.groupTimeoutSeconds)
    || catalog.groupTimeoutSeconds < 1 || catalog.groupTimeoutSeconds > 1800) throw new Error('Invalid acceptance catalog')
  const files = new Set()
  for (const suite of catalog.suites) {
    if (!packages[suite.group] || typeof suite.file !== 'string' || !suite.file.startsWith(packages[suite.group] + '/src/')
      || !/^[\w/.[\]-]+\.test\.tsx?$/.test(suite.file) || suite.file.split('/').includes('..') || files.has(suite.file)
      || !Array.isArray(suite.cases) || !suite.cases.length || suite.cases.some(id => !caseIds.includes(id))
      || (suite.group === 'database') !== suite.file.endsWith('.integration.test.ts')) throw new Error('Invalid acceptance suite')
    files.add(suite.file)
  }
  if (caseIds.some(id => !catalog.suites.some(s => s.cases.includes(id)))) throw new Error('Acceptance case has no evidence')
  return catalog
}

/** A runner exit, suite status and every individual assertion must agree. */
export function assessSuite(suite, result, exitCode, ossRoot = root) {
  const matches = result?.testResults?.filter(r => resolve(r.name) === resolve(ossRoot, suite.file)) ?? []
  if (matches.length !== 1) return { status: 'failed', reason: 'missing_or_duplicate_suite', assertions: [] }
  const row = matches[0], assertions = (row.assertionResults ?? []).map(a => ({ name: a.fullName ?? a.title, status: a.status }))
  if (exitCode !== 0 || result.success !== true || row.status !== 'passed' || !assertions.length || assertions.some(a => a.status !== 'passed')) {
    return { status: 'failed', reason: 'failed_or_incomplete_execution', assertions }
  }
  return { status: 'passed', assertions }
}

export function summarize(catalog, evidence) {
  const cases = Object.fromEntries(caseIds.map(id => {
    const required = catalog.suites.filter(s => s.cases.includes(id))
    const rows = required.map(s => ({ file: s.file, ...evidence[s.file] }))
    const states = rows.map(r => r.status ?? 'not_run')
    const status = states.includes('failed') ? 'failed' : states.includes('blocked') ? 'blocked' : states.includes('not_run') ? 'not_run' : 'passed'
    return [id, { description: catalog.caseDescriptions[id], status, evidence: rows }]
  }))
  const states = Object.values(cases).map(c => c.status)
  return { status: states.every(s => s === 'passed') ? 'passed' : states.includes('failed') ? 'failed' : states.includes('blocked') ? 'blocked' : 'not_run', cases }
}

export function validateOptions(options) {
  const mode = options.mode ?? 'local'
  if (!['local', 'remote-qa', 'production'].includes(mode)) throw new Error('Choose local, remote-qa or production mode')
  if (!options.reportDir || !isAbsolute(options.reportDir)) throw new Error('Supply an absolute new --report-dir')
  if (mode === 'local') {
    if (['apiUrl', 'workspaceId', 'tokenEnv', 'tokenFile', 'identityPrefix', 'confirm', 'dedicatedWorkspace'].some(k => options[k] !== undefined)) throw new Error('Local mode refuses remote credentials and targets')
  } else {
    if (options.pgBin || options.migrationDirs?.length) throw new Error('Remote modes refuse database and migration options')
    if (!options.apiUrl || !/^[a-f0-9-]{36}$/i.test(options.workspaceId ?? '') || Boolean(options.tokenEnv) === Boolean(options.tokenFile)) throw new Error('Remote mode needs an explicit origin, workspace and exactly one private token source')
    if (mode === 'remote-qa' && (options.confirm !== true || options.dedicatedWorkspace !== true || !/^assurance-[a-z0-9-]{3,48}$/.test(options.identityPrefix ?? ''))) throw new Error('QA requires --dedicated-workspace --identity-prefix assurance-NAME --confirm')
    if (mode === 'production' && ['confirm', 'dedicatedWorkspace', 'identityPrefix'].some(k => options[k] !== undefined)) throw new Error('Production exposes only read-only catalog qualification')
  }
  return { ...options, mode }
}

/** Shell-free, bounded process group. It cannot kill another test runner. */
export async function command(executable, args, { cwd = root, env = cleanRuntimeEnvironment(process.env), timeoutMs = 60_000 } = {}) {
  return new Promise(accept => {
    const child = spawn(executable, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', timedOut = false, escalation
    const capture = chunk => { output = (output + chunk.toString()).slice(-5_000_000) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    const stop = signal => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal) } catch {} }
    const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); escalation = setTimeout(() => stop('SIGKILL'), 5000) }, timeoutMs)
    child.once('error', () => { clearTimeout(timer); clearTimeout(escalation); accept({ code: 1, output: 'Executable unavailable', timedOut: false }) })
    child.once('close', code => { clearTimeout(timer); clearTimeout(escalation); accept({ code: timedOut ? 124 : code ?? 1, output: redact(output), timedOut }) })
  })
}

export async function revision(cwd) {
  const sha = await command('git', ['rev-parse', 'HEAD'], { cwd })
  if (sha.code) return null
  const status = await command('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd })
  const diff = await command('git', ['diff', 'HEAD', '--binary'], { cwd })
  return { sha: sha.output.trim(), dirty: Boolean(status.output.trim()), statusHash: hash(status.output), trackedDiffHash: hash(diff.output) }
}

export async function remoteQualification(options, { tokenReader, clientFactory } = {}) {
  const valid = validateOptions(options)
  if (valid.mode === 'local') throw new Error('Remote qualification requires a remote mode')
  // Never expose the client's mutation method through this dispatch boundary.
  const api = await import('./manifest-client.mjs')
  const token = await (tokenReader ?? api.readManifestToken)(valid)
  if (!token.startsWith('sk_crm_')) throw new Error('CRM-scoped integration credential required')
  const client = (clientFactory ?? api.createManifestClient)({ apiUrl: valid.apiUrl, workspaceId: valid.workspaceId, mode: 'integration', token, timeoutMs: 15_000 })
  await client.verifyDestination()
  return { status: 'passed', action: 'catalog_read', acceptanceStatus: 'not_run', identityPrefix: valid.identityPrefix ?? null }
}

async function runGroup(group, catalog, env, reportDir, evidence) {
  const suites = catalog.suites.filter(s => s.group === group), cwd = join(root, packages[group])
  const before = new Map()
  for (const suite of suites) {
    try { before.set(suite.file, hash(await readFile(join(root, suite.file)))) }
    catch { evidence[suite.file] = { status: 'failed', reason: 'missing_source', assertions: [] } }
  }
  const selected = suites.filter(s => before.has(s.file))
  if (!selected.length) return
  const resultPath = join(reportDir, `${group}.json`), logPath = join(reportDir, `${group}.log`)
  const args = ['exec', 'vitest', 'run', ...(group === 'database' ? ['--config', 'vitest.integration.config.ts'] : []),
    '--maxWorkers=1', '--fileParallelism=false', '--reporter=json', '--outputFile', resultPath,
    ...selected.map(s => relative(cwd, join(root, s.file)))]
  const execution = await command('pnpm', args, { cwd, env, timeoutMs: catalog.groupTimeoutSeconds * 1000 })
  await writeFile(logPath, execution.output, { mode: 0o600 })
  let result
  try {
    if ((await stat(resultPath)).size > 50_000_000) throw new Error('Evidence too large')
    const raw = redact(await readFile(resultPath, 'utf8'))
    await writeFile(resultPath, raw, { mode: 0o600 })
    result = JSON.parse(raw)
  } catch { result = null }
  for (const suite of selected) {
    const assessment = assessSuite(suite, result, execution.code)
    const after = hash(await readFile(join(root, suite.file)))
    evidence[suite.file] = { ...assessment, ...(before.get(suite.file) !== after ? { status: 'failed', reason: 'suite_changed_during_run' } : {}),
      sourceHash: before.get(suite.file), exitCode: execution.code, timedOut: execution.timedOut, report: `${group}.json`, log: `${group}.log` }
  }
}

export async function runAcceptance(rawOptions) {
  const options = validateOptions(rawOptions)
  if (options.mode === 'local') validateAmbientDatabase(process.env)
  const catalogBytes = await readFile(catalogPath), catalog = validateCatalog(JSON.parse(catalogBytes))
  await mkdir(options.reportDir, { mode: 0o700 }) // existing destinations always fail
  const evidence = {}, startedAt = new Date().toISOString()
  const report = { schema: 'brian-crm-assurance-v1', mode: options.mode, startedAt, fixtureManifestHash: hash(catalogBytes),
    source: { oss: await revision(root), platform: await revision(resolve(root, '..')) }, database: null, recovery: {},
    engineering: null, operational: { status: 'not_run', gates: catalog.ownerGates.map(owner => ({ owner, status: 'not_run', accountablePerson: null, date: null, evidence: null })) } }
  let fixture, runtimeFailure
  try {
    if (options.mode === 'local') {
      const build = await command('pnpm', ['--filter', '@use-brian/core...', 'build'], { timeoutMs: 180_000 })
      await writeFile(join(options.reportDir, 'build.log'), build.output, { mode: 0o600 })
      if (build.code) throw new Error('Shared/core build failed; see build.log. Refusing stale compiled tools.')
      try {
        fixture = await createLocalFixture({ pgBin: options.pgBin, migrationDirs: options.migrationDirs ?? [], walArchive: true })
        const client = new pg.Client({ connectionString: fixture.env.DATABASE_URL })
        try {
          await client.connect()
          const { identity, migrations, schemaHash, extensions } = await inspectDatabase(client)
          report.database = { postgresVersion: identity.postgres_version, migrations, schemaHash, extensions }
          const migrationContents = []
          for (const directory of [join(root, 'packages/api/migrations'), ...(options.migrationDirs ?? [])]) {
            for (const name of migrations) {
              try { migrationContents.push({ name, sha256: hash(await readFile(join(directory, name))) }) } catch {}
            }
          }
          report.database.migrationFiles = migrationContents
          report.database.migrationManifestHash = hash(JSON.stringify(migrationContents))
        } finally { await client.end() }
      } catch (error) {
        report.database = { status: 'blocked', reason: redact(error.message), remedy: 'Install PostgreSQL 18 with pgvector and pg_trgm; rerun with --pg-bin /path/to/postgresql18/bin and a new report directory.' }
        for (const suite of catalog.suites.filter(s => s.group === 'database')) evidence[suite.file] = { status: 'blocked', reason: 'database_prerequisite', assertions: [] }
      }
      const env = { ...(fixture?.env ?? cleanRuntimeEnvironment(process.env)), BRIAN_ASSURANCE_REPORT_DIR: options.reportDir }
      if (report.database?.schemaHash) await runGroup('database', catalog, env, options.reportDir, evidence)
      for (const group of ['api', 'core', 'shared', 'web']) await runGroup(group, catalog, env, options.reportDir, evidence)
      for (const mode of ['logical', 'physical']) {
        try {
          const proof = JSON.parse(await readFile(join(options.reportDir, `${mode}-restore.json`), 'utf8'))
          if (proof.status !== 'passed' || proof.mode !== mode || !/^[a-f0-9]{64}$/.test(proof.manifestSha256)) throw new Error('Incomplete restore evidence')
          report.recovery[mode] = proof
        } catch {
          report.recovery[mode] = { status: 'not_run' }
          const file = catalog.suites.find(s => s.file.endsWith('/crm-recovery.integration.test.ts')).file
          if (evidence[file]?.status === 'passed') evidence[file] = { ...evidence[file], status: 'failed', reason: 'missing_restore_report' }
        }
      }
    } else {
      report.qualification = await remoteQualification(options)
    }
  } catch (error) {
    runtimeFailure = { status: 'failed', reason: options.mode === 'local' ? redact(error.message) : 'Remote qualification failed; verify origin, workspace and scoped credential without publishing secrets.' }
  } finally {
    if (fixture) try { await fixture.dispose() } catch { runtimeFailure = { status: 'failed', reason: 'Owned fixture cleanup failed; inspect local fixture logs before manual recovery.' } }
  }
  report.engineering = summarize(catalog, evidence)
  if (runtimeFailure) { report.engineering.status = 'failed'; report.runtimeFailure = runtimeFailure }
  report.completedAt = new Date().toISOString()
  report.sourceAfter = { oss: await revision(root), platform: await revision(resolve(root, '..')) }
  await jsonFile(join(options.reportDir, 'report.json'), report)
  const lines = ['# CRM assurance evidence', '', `Engineering: **${report.engineering.status}**. Operational readiness: **not_run**.`, '',
    `Mode: ${options.mode}. OSS revision: ${report.source.oss?.sha ?? 'unavailable'}. Dirty checkout: ${report.source.oss?.dirty ?? 'unknown'}.`, '',
    '| Case | Status | Assertion evidence |', '| --- | --- | --- |',
    ...Object.entries(report.engineering.cases).map(([id, row]) => `| ${id} | ${row.status} | ${[...new Set(row.evidence.filter(e => e.report).map(e => `[${e.report}](${e.report})`))].join(', ') || 'Not executed'} |`), '',
    'Individual assertion names, source hashes, migration inventory, recovery manifests and unexecuted owner gates are in [report.json](report.json).',
    'Local reports are engineering evidence only. Keep private logs and fixtures under the approved evidence retention policy.', '']
  await writeFile(join(options.reportDir, 'report.md'), lines.join('\n'), { mode: 0o600 })
  return report
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: brian-contract-check.mjs --mode local --report-dir /new/private/report [--pg-bin /postgres18/bin] [--migration-dir /hosted/migrations]\nRemote catalog qualification only: --mode remote-qa|production --report-dir /new/report --api-url https://api.example.com --workspace-id UUID --token-file /private/token\nQA additionally requires --dedicated-workspace --identity-prefix assurance-NAME --confirm. Remote acceptance remains not_run; no remote mutations, models or live sends. Incomplete engineering evidence exits nonzero.')
    return
  }
  const names = { '--mode': 'mode', '--report-dir': 'reportDir', '--pg-bin': 'pgBin', '--api-url': 'apiUrl', '--workspace-id': 'workspaceId', '--token-env': 'tokenEnv', '--token-file': 'tokenFile', '--identity-prefix': 'identityPrefix' }
  const options = { migrationDirs: [] }
  while (args.length) {
    const name = args.shift()
    if (name === '--confirm' || name === '--dedicated-workspace') { const key = name === '--confirm' ? 'confirm' : 'dedicatedWorkspace'; if (options[key]) throw new Error('Duplicate option'); options[key] = true; continue }
    const value = args.shift()
    if (!value || value.startsWith('--')) throw new Error('Option value required')
    if (name === '--migration-dir') options.migrationDirs.push(resolve(value))
    else if (names[name] && options[names[name]] === undefined) options[names[name]] = value
    else throw new Error('Unknown or duplicate option; see --help')
  }
  const report = await runAcceptance(options)
  console.log(JSON.stringify({ engineering: report.engineering.status, operational: report.operational.status, report: join(options.reportDir, 'report.json') }))
  if (report.engineering.status !== 'passed') process.exitCode = 1
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(error => { console.error(redact(error.message)); process.exitCode = 1 })
