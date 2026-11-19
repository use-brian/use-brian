#!/usr/bin/env node
/** Same-binary collector compatibility and per-release inventory on one fixed20 case. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fingerprint } from '../../import-graph.mjs'
import { profileReleases } from './release-profile.mjs'
const opts = {}
for (let i = 2; i < process.argv.length; i++) {
  const key = { '--oss-root': 'root', '--pg-bin': 'pgBin', '--collector': 'collector', '--out': 'out' }[process.argv[i]]
  if (!key || !process.argv[i + 1]) throw new Error('Supply --oss-root, --pg-bin, --collector and --out')
  opts[key] = resolve(process.argv[++i])
}
if (Object.keys(opts).length !== 4 || existsSync(opts.out)) throw new Error('Explicit paths and a new output directory required')
const pnpm = spawnSync('pnpm', ['--version']).status === 0 ? 'pnpm' : join(dirname(process.execPath), 'pnpm')
const packageManager = spawnSync(pnpm, ['--version'], { encoding: 'utf8' })
if (packageManager.status !== 0) throw new Error('pnpm unavailable; supply its bin directory in PATH')
mkdirSync(opts.out, { recursive: true })
const trace = join(opts.out, 'query-inventory.jsonl'), hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const trees = ['packages/api/src', 'packages/api/scripts', 'packages/api/migrations', 'packages/core/src', 'packages/core/dist',
  'packages/agent-runtime/src', 'packages/agent-runtime/dist', 'packages/shared/dist', 'packages/channels/dist',
  'packages/brian-app/dist', 'packages/brian-kb/dist', 'packages/doc-model/dist', 'packages/office-model/dist', 'scripts/crm']
const files = ['package.json', 'packages/api/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/api/tsconfig.json',
  'packages/api/vitest.integration.config.ts', 'tsconfig.base.json']
const inputs = () => ({ ...Object.fromEntries(trees.map(p => [p, fingerprint(join(opts.root, p))])),
  ...Object.fromEntries(files.map(p => [p, hash(join(opts.root, p))])) })
const migrationInputs = () => readdirSync(join(opts.root, 'packages/api/migrations')).filter(name => name.endsWith('.sql')).sort()
  .map(name => ({ name, sha256: hash(join(opts.root, 'packages/api/migrations', name)) }))
const migrationManifest = migrationInputs()
const dependencyManifestPath = join(opts.out, 'dependency-manifest.json')
writeFileSync(dependencyManifestPath, JSON.stringify({ inputs: inputs(), migrations: migrationManifest,
  node: process.version, pnpm: packageManager.stdout.trim() }, null, 2) + '\n', { mode: 0o600 })
const releaseOwners = ['admit_native_turn_conversation_records', 'capture_native_turn_conversation_record', 'capture_conversation_evidence']
const releaseManifest = result => result.queryWork.reduce((counts, row) => {
  for (const owner of releaseOwners) if (row.shape.includes(`${owner}(`)) counts[owner] += row.calls
  return counts
}, Object.fromEntries(releaseOwners.map(owner => [owner, 0])))
const record = { requestedAt: new Date().toISOString(), root: opts.root, sourceStart: inputs(),
  binarySha256: hash(join(opts.pgBin, 'postgres')), collectorSha256: hash(opts.collector),
  dependencyManifestSha256: hash(dependencyManifestPath),
  cases: {}, physicalPermissionCoverageComplete: false,
  scope: 'Matched fixed20 empty-private/legacy HTTP turns through the numbered native readers. Hook compatibility and separate execution, planning and rewrite inventories.' }
const save = () => writeFileSync(join(opts.out, 'receipt.json'), JSON.stringify(record, null, 2) + '\n')
async function runFixture({ enabled, createLocalFixture, fixtureCommandEnvironment }) {
  const mode = enabled ? 'on' : 'off'
  const cell = record.cases[mode] = { fixtureStartedAt: new Date().toISOString(), collectorEnabled: enabled }
  const reportPath = join(opts.out, `chat-${mode}.json`)
  let fixture
  save()
  try {
    fixture = await createLocalFixture({ pgBin: opts.pgBin, ordinaryOwner: true, statementStatistics: true,
      executorProbe: { library: opts.collector, output: trace, capture: enabled } })
    cell.fixtureReadyAt = new Date().toISOString()
    const log = createWriteStream(join(opts.out, `vitest-${mode}.log`))
    const child = spawn(pnpm, ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts',
      'src/application-platform/__tests__/chat-architecture-cost.integration.test.ts', '--maxWorkers=1',
      '-t', "'empty-private' / 'legacy' / sample"], { cwd: join(opts.root, 'packages/api'),
      env: fixtureCommandEnvironment({}, { ...fixture.env, BRIAN_CHAT_COST_OUTPUT: reportPath,
        BRIAN_CHAT_COST_NATIVE_READERS: '1', BRIAN_CHAT_COST_CALLERS: '1', BRIAN_CHAT_COST_PRIMITIVE_ATTESTATION: '1',
        ...(enabled ? { BRIAN_CHAT_COST_PRIMITIVE_OUTPUT: trace } : {}) }), stdio: ['ignore', 'pipe', 'pipe'] })
    cell.testStartedAt = new Date().toISOString(); cell.childPid = child.pid; save()
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000)
    try { cell.exitCode = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) }) }
    finally { clearTimeout(timer); await new Promise(accept => log.end(accept)) }
    cell.testFinishedAt = new Date().toISOString()
    if (cell.exitCode !== 0) throw new Error(`The collector-${mode} HTTP fixture did not pass`)
    const { results, attestation, roles } = JSON.parse(readFileSync(reportPath, 'utf8'))
    const result = results?.[0]
    if (results.length !== 1 || result?.verified !== true || result.outputEvents !== 20
      || !/^[0-9a-f]{64}$/.test(result.receivedTextSha256) || result.receivedTextSha256 !== result.savedTextSha256) {
      throw new Error(`The collector-${mode} fixture did not verify 20 received frames and the saved reply`)
    }
    if (roles?.application?.name !== 'app_user' || roles.application.superuser !== false || roles.application.bypass !== false
      || roles?.system?.name !== 'assurance_owner' || roles.system.superuser !== false || roles.system.bypass !== false
      || !Array.isArray(attestation?.installedMigrations) || !Array.isArray(attestation.releaseRoutines)
      || !releaseOwners.every(owner => attestation.releaseRoutines.some(routine => routine.signature.startsWith(`${owner}(`)))) {
      throw new Error(`The collector-${mode} fixture lacks installed release or deployment role attestation`)
    }
    if (JSON.stringify(attestation.installedMigrations) !== JSON.stringify(migrationManifest.map(item => item.name))) {
      throw new Error(`The collector-${mode} installed migrations differ from the supplied file roster`)
    }
    cell.chatSha256 = hash(reportPath)
    cell.receivedTextSha256 = result.receivedTextSha256
    cell.foreground = result.queries
    cell.releaseCalls = releaseManifest(result)
    cell.releaseRoutines = attestation.releaseRoutines
    cell.installedMigrations = { count: attestation.installedMigrations.length, head: attestation.installedMigrations.at(-1) }
    return reportPath
  } finally {
    if (fixture) { await fixture.dispose(); cell.fixtureDisposed = !existsSync(fixture.directory) }
    save()
  }
}
try {
  const { createLocalFixture, fixtureCommandEnvironment } = await import(pathToFileURL(join(opts.root, 'scripts/crm/local-fixture.mjs')).href)
  await runFixture({ enabled: false, createLocalFixture, fixtureCommandEnvironment })
  const onReport = await runFixture({ enabled: true, createLocalFixture, fixtureCommandEnvironment })
  record.sameDeliveredAndSavedBytes = record.cases.off.receivedTextSha256 === record.cases.on.receivedTextSha256
  record.sameReleaseManifest = JSON.stringify(record.cases.off.releaseRoutines) === JSON.stringify(record.cases.on.releaseRoutines)
    && JSON.stringify(record.cases.off.releaseCalls) === JSON.stringify(record.cases.on.releaseCalls)
  const profile = await profileReleases(onReport, trace)
  const profilePath = join(opts.out, 'release-profile.json')
  writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 })
  record.releaseProfile = { matched: profile.matched, observed: profile.observed, sha256: hash(profilePath) }
  const lines = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
  const end = lines.findIndex((line) => line.windowEnd)
  const window = end < 0 ? [] : lines.slice(0, end)
  const queries = window.filter(row => !row.phase || row.phase === 'execution')
  const preparation = window.filter(row => row.phase === 'planning' || row.phase === 'rewrite')
  record.window = end < 0 ? null : lines[end]
  record.inventory = { records: queries.length, traceSha256: hash(trace),
    preparation: Object.fromEntries(['planning', 'rewrite'].map(phase => [phase, preparation.filter(row => row.phase === phase).length])),
    observedUnits: [...new Set(window.flatMap((r) => r.counters.map((c) => c.kind)))].sort(),
    executedNodes: [...new Set(queries.flatMap((r) => r.executedNodes.map((n) => `${n.node}:${n.tag}:${n.am ?? 'none'}`)))].sort(),
    overflowingRecords: window.filter((r) => r.overflow).length,
    unsupportedNodeQueries: queries.filter((r) => r.executedNodes.some((n) => n.calibrated !== true)).length,
    gaps: ['Unsupported executed access methods, JIT and inventory-only nodes', 'Uninstrumented opaque helpers and planner elisions outside the measured folds', 'Permission rule attribution within ordinary planner and executor callbacks'] }
  if (!record.sameDeliveredAndSavedBytes || !record.sameReleaseManifest || !profile.matched || !queries.length || !preparation.length || end < 0) process.exitCode = 1
} catch (error) { record.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  record.finishedAt = new Date().toISOString()
  record.sourceEnd = inputs(); record.sourceInputsUnchanged = JSON.stringify(record.sourceStart) === JSON.stringify(record.sourceEnd)
    && JSON.stringify(migrationManifest) === JSON.stringify(migrationInputs())
  if (!record.sourceInputsUnchanged) process.exitCode = 1
  save()
}
console.log(JSON.stringify({ out: opts.out, exitCode: process.exitCode ?? 0, records: record.inventory?.records,
  releaseProfile: record.releaseProfile, failure: record.failure }))
