#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createLocalFixture, cleanRuntimeEnvironment, validateAmbientDatabase } from '../crm/local-fixture.mjs'
import { CATALOGUE } from './readiness-catalogue.mjs'
import { aggregate, artifact, captureSource, command, digest, parseVitest, verifyArtifacts } from './readiness-contract.mjs'
import { preparePilotConfig, validateInactiveConfig } from './pilot-config.mjs'
import { inspectRelease } from './release-readiness.mjs'
import { operatorBundle } from './operator-bundle.mjs'

const ossRoot = fileURLToPath(new URL('../../', import.meta.url)), platformRoot = resolve(ossRoot, '..')
const nativeFile = 'packages/api/src/operations-readiness/__tests__/pilot-lanes.integration.test.ts'
const scriptFiles = ['readiness-contract', 'pilot-config', 'release-readiness'].map(n => `scripts/operations/__tests__/${n}.test.mjs`)
const nativeRequirements = CATALOGUE.suites.find(s => s.file === nativeFile).assertions

export function optionsFrom(args) {
  const options = { mode: 'local' }
  const keys = { '--mode': 'mode', '--report-dir': 'reportDir', '--pg-bin': 'pgBin' }
  while (args.length) {
    const key = args.shift(), value = args.shift()
    if (!keys[key] || !value || value.startsWith('--') || options[keys[key]] && key !== '--mode') throw new Error('Supply only --mode local|inspect --report-dir ABSOLUTE-NEW-DIRECTORY [--pg-bin DIR]')
    options[keys[key]] = value
  }
  if (!['local', 'inspect'].includes(options.mode) || !isAbsolute(options.reportDir ?? '')) throw new Error('Use local|inspect and an absolute new report directory')
  return options
}

function junitAssertions(xml) {
  const decode = s => s.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  return [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map(m => ({
    name: decode(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? ''), status: /<(failure|error)\b/.test(m[2] ?? '') ? 'failed' : /<skipped\b/.test(m[2] ?? '') ? 'skipped' : 'passed',
  }))
}

async function runHarness(directory, env, sourceDigest, proofs) {
  const path = 'evidence/harness.xml'
  const execution = await command(process.execPath, ['--test', '--test-reporter=junit', `--test-reporter-destination=${join(directory, path)}`, ...scriptFiles], { cwd: ossRoot, env })
  let xml = await readFile(join(directory, path), 'utf8').catch(() => '')
  // Node's JUnit reporter includes the device hostname. It has no evidentiary role.
  xml = xml.replace(/ hostname="[^"]*"/g, '')
  if (xml) await writeFile(join(directory, path), xml, { mode: 0o600 })
  const assertions = junitAssertions(xml)
  const proof = xml ? await artifact(directory, path) : null
  if (proof) proofs.push(proof)
  return { ...execution, output: undefined, sourceDigest, artifact: proof, assertions,
    status: execution.exitCode === 0 && assertions.length >= 12 && assertions.every(a => a.status === 'passed') ? 'passed' : 'failed', reasons: [] }
}

async function runGroup(files, directory, env, sourceDigest, proofs, label, integration = false) {
  const packagePath = files[0].file.split('/').slice(0, 2).join('/')
  const path = `evidence/${label}.json`, logPath = `evidence/${label}.log`
  const args = ['exec', 'vitest', 'run', ...(integration ? ['--config', 'vitest.integration.config.ts'] : []), '--maxWorkers=1', '--fileParallelism=false',
    '--reporter=json', '--outputFile', join(directory, path), ...files.map(s => s.file.slice(packagePath.length + 1))]
  const execution = await command('pnpm', args, { cwd: join(ossRoot, packagePath), env, timeoutMs: 240_000 })
  await writeFile(join(directory, logPath), execution.output, { mode: 0o600 })
  proofs.push(await artifact(directory, logPath))
  let raw = null, proof = null
  try { raw = JSON.parse(await readFile(join(directory, path), 'utf8')); proof = await artifact(directory, path); proofs.push(proof) } catch {}
  return Object.fromEntries(files.map(s => [s.file, { ...parseVitest(s, raw, execution, sourceDigest, proof), log: logPath }]))
}

async function runNative(directory, env, sourceDigest, proofs, pgBin, receipts) {
  let fixture
  try {
    fixture = await createLocalFixture({ pgBin, env })
    // Never write fixture env/marker/token or URLs to reports.
    const owned = { schema: 'operations-owned-fixture-v1', loopback: true, disposable: true, tokenVerified: true,
      appRole: 'non-superuser/nobypassrls', externalBoundaries: 'fake', realProviderCredentials: false }
    const guardPath = 'evidence/fixture-ownership.json'
    await writeFile(join(directory, guardPath), JSON.stringify(owned, null, 2), { mode: 0o600 }); proofs.push(await artifact(directory, guardPath))
    const integration = CATALOGUE.suites.filter(s => s.file.startsWith('packages/api/') && s.file.endsWith('.integration.test.ts'))
    Object.assign(receipts, await runGroup(integration, directory, { ...fixture.env, BRIAN_OPERATIONS_EVIDENCE_DIR: join(directory, 'evidence') }, sourceDigest, proofs, 'native-api', true))
    try { proofs.push(await artifact(directory, 'evidence/native-counters.json')) } catch {}
    const docs = CATALOGUE.suites.filter(s => s.file.startsWith('apps/doc-sync/'))
    if (docs.length) Object.assign(receipts, await runGroup(docs, directory, fixture.env, sourceDigest, proofs, 'native-doc-sync', true))
    return { ...owned, status: 'executed' }
  } catch (error) {
    // Errors may carry local diagnostic paths but no database URLs or credentials.
    const reason = /PostgreSQL|postgres|pgvector|vector|ENOENT/.test(error.message) ? 'postgres_fixture_unavailable' : 'fixture_execution_failed'
    for (const s of [...CATALOGUE.suites.filter(s => s.file.endsWith('.integration.test.ts')), { file: nativeFile }]) {
      receipts[s.file] ??= { status: 'blocked', reasons: [reason], sourceDigest, assertions: [] }
    }
    return { status: 'blocked', reasons: [reason] }
  } finally { if (fixture) await fixture.dispose() }
}

/** Always writes the operator bundle, including an honest partial result. */
export async function runReadiness(options) {
  options = optionsFrom(['--mode', options.mode ?? 'local', '--report-dir', options.reportDir, ...(options.pgBin ? ['--pg-bin', options.pgBin] : [])])
  validateAmbientDatabase(process.env)
  await mkdir(options.reportDir, { mode: 0o700 }) // atomic refusal of an existing directory
  await mkdir(join(options.reportDir, 'evidence'), { mode: 0o700 })
  const startedAt = new Date().toISOString(), receipts = {}, proofs = []
  const env = { ...cleanRuntimeEnvironment(process.env), NODE_ENV: 'test' }
  const initialSource = await captureSource(ossRoot, platformRoot), before = initialSource.source
  const pilot = preparePilotConfig(); validateInactiveConfig(pilot)
  let harness = null, database = { status: 'not_run' }, runnerError = null
  try {
    harness = await runHarness(options.reportDir, env, before.digest, proofs)
    if (options.mode === 'local' && harness.status === 'passed' && initialSource.status === 'passed') {
      database = await runNative(options.reportDir, env, before.digest, proofs, options.pgBin, receipts)
      const groups = new Map()
      for (const suite of CATALOGUE.suites.filter(s => !s.file.endsWith('.integration.test.ts'))) {
        const group = suite.file.split('/').slice(0, 2).join('/')
        if (!groups.has(group)) groups.set(group, [])
        groups.get(group).push(suite)
      }
      for (const [group, suites] of groups) Object.assign(receipts, await runGroup(suites, options.reportDir, env, before.digest, proofs, group.replaceAll('/', '-')))
    }
  } catch { runnerError = 'bounded_runner_failed'; }
  const finalSource = await captureSource(ossRoot, platformRoot), after = finalSource.source
  if (initialSource.status !== 'passed' || finalSource.status !== 'passed') runnerError = 'source_inventory_unavailable'
  const sourceChanged = before.digest !== after.digest
  const release = await inspectRelease(ossRoot, platformRoot, after)
  const artifactMap = await verifyArtifacts(options.reportDir, proofs)
  const cases = {}
  const harnessCase = id => ({ ...harness, assertions: (harness?.assertions ?? []).filter(a => new RegExp(`\\b${id}\\b`).test(a.name)) })
  for (const id of ['V01', 'V02', 'V09', 'V10', 'V13', 'V14']) cases[id] = harnessCase(id)
  const native = receipts[nativeFile]
  for (const id of ['V03', 'V04', 'V05', 'V07', 'V08', 'V11']) {
    cases[id] = native ? { ...native, assertions: (native.assertions ?? []).filter(a => new RegExp(`\\b${id}\\b`).test(a.name)) }
      : { status: 'not_run', reasons: ['native_scenario_not_run'], assertions: [] }
  }
  // Native schema parsing is required in addition to inactive-data validation.
  if (!(native?.assertions ?? []).some(a => a.name.includes('V09') && a.status === 'passed')) cases.V09 = { status: 'blocked', reasons: ['native_schema_validation_not_run'], assertions: [] }
  cases.V06 = { ...native, status: 'blocked', reasons: ['F07_mailbox_admission_checkpoint_and_duplicate_delivery_suppression_missing'], assertions: (native?.assertions ?? []).filter(a => a.name.includes('V06')) }
  cases.V10 = { ...cases.V10, status: 'blocked', reasons: ['release_route_missing_and_remote_settings_not_checked'] }
  cases.V12 = harnessCase('V12')
  if (options.mode === 'inspect') cases.V14 = { status: 'not_run', reasons: ['local_execution_not_run_in_inspect_mode'], assertions: [] }
  let report = aggregate(CATALOGUE, receipts, after, artifactMap, cases)
  if (report.suites[nativeFile]?.status !== 'passed') {
    for (const id of ['V03', 'V04', 'V05', 'V07', 'V08', 'V09', 'V11', 'V12', 'V14']) {
      report.cases[id] = { ...report.cases[id], status: 'blocked', reasons: [...report.cases[id].reasons, 'native_suite_incomplete'] }
    }
  }
  // These cases require native safety beyond the new narrow integration suite.
  const requires = { V03: ['F05'], V04: ['F04', 'F06'], V05: ['F01', 'F02', 'F04'], V07: ['F01', 'F08', 'F09'], V08: ['F04'], V12: ['F01','F02','F03','F04','F05','F06','F07','F08','F09'] }
  for (const [id, deps] of Object.entries(requires)) {
    const missing = deps.filter(d => report.dependencies[d].status !== 'passed')
    if (missing.length) report.cases[id] = { ...report.cases[id], status: 'blocked', reasons: [...report.cases[id].reasons, ...missing.map(d => `dependency:${d}`)] }
  }
  report.verdicts.codeHarness = harness?.status === 'passed' && !sourceChanged && !runnerError ? 'passed' : 'failed'
  if (sourceChanged) for (const c of Object.values(report.cases)) if (c.status === 'passed') { c.status = 'blocked'; c.reasons.push('source_changed_during_run') }
  report.verdicts.localReadiness = Object.values(report.dependencies).every(d => d.status === 'passed') && Object.values(report.cases).every(c => c.status === 'passed') ? 'ready' : 'not_ready'
  report.exitCode = report.verdicts.localReadiness === 'ready' ? 0 : 1
  report = { ...report, mode: options.mode, startedAt, endedAt: new Date().toISOString(), sourceBeforeDigest: before.digest, sourceChanged,
    fixtureVersion: 'operations-pilot-fixture-v1', fixtureHash: digest(JSON.parse(await readFile(new URL('fixtures/v1-pilot.json', import.meta.url)))),
    nativeRequirements, database, runnerError, artifacts: proofs, harness,
    executionLimits: { childTimeoutMs: 240_000, maxCapturedOutputBytes: 2_000_000, credentialsInherited: false, serverBoot: false } }
  await writeFile(join(options.reportDir, 'inactive-pilot-config.json'), JSON.stringify(pilot, null, 2), { mode: 0o600 })
  await writeFile(join(options.reportDir, 'release-readiness.json'), JSON.stringify(release, null, 2), { mode: 0o600 })
  // The two JSON auxiliaries are themselves integrity-bound in readiness.json.
  report.artifacts.push(await artifact(options.reportDir, 'inactive-pilot-config.json'), await artifact(options.reportDir, 'release-readiness.json'))
  const texts = operatorBundle(report, pilot, release)
  for (const [name, text] of Object.entries(texts)) {
    await writeFile(join(options.reportDir, name), text, { mode: 0o600 })
    report.artifacts.push(await artifact(options.reportDir, name))
  }
  await writeFile(join(options.reportDir, 'readiness.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  return report
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/operations/v1-readiness.mjs --mode local|inspect --report-dir ABSOLUTE-NEW-DIRECTORY [--pg-bin DIR]\nOnly disposable local fixtures; no provider, release or installed activation.')
  else runReadiness(optionsFrom(process.argv.slice(2))).then(r => { console.log(JSON.stringify({ verdicts: r.verdicts, exitCode: r.exitCode })); process.exitCode = r.exitCode })
    .catch(() => { console.error('Readiness failed: invalid options, unsafe ambient target, existing destination or unavailable source inventory.'); process.exitCode = 1 })
}
