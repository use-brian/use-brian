#!/usr/bin/env node
/**
 * M6 whole-system qualification orchestrator.
 * Plan: brian-platform docs/plans/oss-chat-m6-qualification-plan.md.
 *
 * Runs the existing harnesses and repository gates, one step at a time, and
 * writes one receipt JSON per step. It never measures anything itself and
 * never fakes a result: a step whose environment is missing is recorded as
 * `skipped` with the reason; a harness that exits zero without writing its
 * output is recorded as `error`, not as a pass.
 *
 *   node scripts/testing/m6/run-matrix.mjs --list
 *   node scripts/testing/m6/run-matrix.mjs --profile dry-run --plumbing --out /abs/dir
 *   node scripts/testing/m6/run-matrix.mjs --profile full --out /abs/dir
 *   node scripts/testing/m6/run-matrix.mjs --steps fixed20-oss-counts,admission --scenarios empty-private/legacy
 *   node scripts/testing/m6/collect.mjs --run /abs/dir
 *
 * Options:
 *   --profile dry-run|full|<group>   step selection (default dry-run); groups: fixed20, baseline,
 *                                    model, imports, browser, desktop, transfer, gates
 *   --steps a,b                      explicit step ids (overrides --profile)
 *   --out DIR                        run directory (default $TMPDIR/brian-m6-<time>)
 *   --pg-bin DIR                     PostgreSQL 18 bin directory (default: pg_config on PATH)
 *   --scenarios s1,s2                fixed-20 scenario filter, e.g. empty-private/legacy
 *   --warm-samples N                 samples for the warm step (default 31, the harness maximum)
 *   --cold                           add the cold-database step (fixed20-oss-cold, row A7) to the selection
 *   --cold-samples N                 cluster restarts per scenario in the cold step (default 3)
 *   --plumbing                       mark every receipt "plumbing proof, not a qualification result"
 *   --allow-destructive              run journeys that kill the shared API (restart, restart2)
 *   --timeout-scale X                multiply every step timeout
 *
 * Environment read by optional steps (never required for the dry run):
 *   M5_CHROME, PLAYWRIGHT_MODULE, M5_WORK_DIR, M5_APP, M5_API   browser journeys (running stack)
 *   USEBRIAN_MANAGED_POSTGRES_TEST_ARTIFACT                    transfer and launcher proofs
 *   USEBRIAN_TRANSFER_TEST_PGLITE_TEMPLATE                     optional pristine 8273 brain
 *
 * Databases: every database step creates its own disposable ordinary-owner
 * PostgreSQL 18 cluster through scripts/crm/local-fixture.mjs on a random
 * loopback port and disposes it afterwards, including on failure and SIGINT.
 * No ambient or personal database is ever used.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { FIXED20_SCENARIOS, HARNESSES, ROWS } from './matrix.mjs'
import { checkQuiescence } from './quiescence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const OSS = resolve(HERE, '../../..')
const PLATFORM_CANDIDATE = resolve(OSS, '..')
const API_PKG = join(OSS, 'packages/api')
const TOOL = 'use-brian/scripts/testing/m6/run-matrix.mjs'
const MIN = 60_000

// ── Environment probes ─────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 20_000, cwd: opts.cwd, env: opts.env ?? process.env })
  return { ok: r.status === 0, status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || (r.error ? String(r.error.message) : '') }
}

function isPlatformRoot(dir) {
  const ws = join(dir, 'pnpm-workspace.yaml')
  return existsSync(ws) && readFileSync(ws, 'utf8').includes('use-brian/packages/*')
}

async function freePort() {
  const server = createServer()
  return new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => accept(port)) })
  })
}

async function reachable(url, timeoutMs = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: r.status < 500, status: r.status }
  } catch (error) { return { ok: false, error: String(error.cause?.code ?? error.message) } }
}

export async function probeEnvironment(opts) {
  const p = {}
  const [major, minor] = process.versions.node.split('.').map(Number)
  p.node = { ok: major > 22 || (major === 22 && minor >= 15), detail: process.version, need: 'Node >= 22.15 (module.registerHooks for the trace hook)' }
  const pnpm = run('pnpm', ['--version'])
  p.pnpm = { ok: pnpm.ok, detail: pnpm.ok ? pnpm.out : pnpm.err }
  const platform = isPlatformRoot(PLATFORM_CANDIDATE)
  p.platform = { ok: platform, detail: platform ? PLATFORM_CANDIDATE : 'standalone OSS clone: platform gates and hosted entries unavailable' }

  let pgBin = opts.pgBin
  if (!pgBin) { const c = run('pg_config', ['--bindir']); if (c.ok) pgBin = c.out }
  const pgVersion = pgBin ? run(join(pgBin, 'postgres'), ['--version']) : { ok: false, err: 'no pg_config on PATH and no --pg-bin' }
  const pg18 = pgVersion.ok && /PostgreSQL\) 18\./.test(pgVersion.out)
  let extensions = []
  let statStatements = false
  if (pg18) {
    const share = run(join(pgBin, 'pg_config'), ['--sharedir']).out
    const lib = run(join(pgBin, 'pg_config'), ['--pkglibdir']).out
    extensions = ['vector', 'pg_trgm'].filter(name => existsSync(join(share, 'extension', `${name}.control`)))
    statStatements = ['pg_stat_statements.dylib', 'pg_stat_statements.so'].some(name => existsSync(join(lib, name)))
  }
  p.pg18 = { ok: pg18 && extensions.length === 2, pgBin: pgBin ?? null, detail: pg18 ? `${pgVersion.out}; extensions ${extensions.join(',') || 'none'}` : (pgVersion.out || pgVersion.err), need: 'PostgreSQL 18 with pgvector and pg_trgm' }
  p.pgStatStatements = { ok: pg18 && statStatements, detail: statStatements ? 'pg_stat_statements library present' : 'pg_stat_statements library missing', need: 'pg_stat_statements for nested-statement counts' }

  const dists = ['packages/core/dist', 'packages/agent-runtime/dist'].map(path => [path, existsSync(join(OSS, path))])
  p.packageDist = { ok: dists.every(([, ok]) => ok), detail: Object.fromEntries(dists), need: 'built core and agent-runtime dist (the fixed-20 harness fingerprints them)' }
  const entry = join(OSS, 'apps/api/dist/index.js')
  p.apiDist = existsSync(entry)
    ? { ok: true, detail: `apps/api/dist/index.js built ${statSync(entry).mtime.toISOString()} (staleness against source is not checked; rebuild before a qualifying run)` }
    : { ok: false, detail: 'apps/api/dist/index.js missing: pnpm --filter @use-brian/api-open build' }

  const xcode = run('xcodebuild', ['-version'])
  p.xcode = { ok: xcode.ok, detail: xcode.ok ? xcode.out.split('\n')[0] : (xcode.err.split('\n')[0] || 'xcodebuild unavailable'), need: 'full Xcode selected (build:siri)' }

  const chrome = process.env.M5_CHROME
  p.chrome = { ok: Boolean(chrome && existsSync(chrome)), detail: chrome ? (existsSync(chrome) ? chrome : `M5_CHROME not found: ${chrome}`) : 'M5_CHROME unset', need: 'Chrome (for Testing) executable' }
  let playwright = process.env.PLAYWRIGHT_MODULE
  if (!playwright) { try { playwright = createRequire(join(OSS, 'apps/app-web/package.json')).resolve('playwright-core') } catch { playwright = undefined } }
  p.playwright = { ok: Boolean(playwright && existsSync(playwright.replace(/^file:\/\//, ''))), module: playwright ?? null, detail: playwright ?? 'playwright-core not resolvable from app-web and PLAYWRIGHT_MODULE unset (it is not a repository dependency)' }
  const api = process.env.M5_API ?? 'http://127.0.0.1:4100'
  const app = process.env.M5_APP ?? 'http://localhost:3003'
  const work = process.env.M5_WORK_DIR
  const [apiHealth, appHealth] = await Promise.all([reachable(`${api}/health`), reachable(app)])
  const fixtures = Boolean(work && existsSync(join(work, 'fixtures.json')))
  p.stack = { ok: apiHealth.ok && appHealth.ok && fixtures, api, app, workDir: work ?? null,
    detail: `api ${api} ${apiHealth.ok ? 'up' : `down (${apiHealth.error ?? apiHealth.status})`}; app ${app} ${appHealth.ok ? 'up' : `down (${appHealth.error ?? appHealth.status})`}; fixtures.json ${fixtures ? 'present' : 'missing (run m5-qualification-fixtures.mjs)'}`,
    need: 'a running local stack with the scripted provider and M5 fixtures (M5 README "To repeat a journey")' }

  const artifact = process.env.USEBRIAN_MANAGED_POSTGRES_TEST_ARTIFACT?.trim()
  p.transferArtifact = { ok: Boolean(artifact && existsSync(artifact)), detail: artifact ? (existsSync(artifact) ? artifact : `missing: ${artifact}`) : 'USEBRIAN_MANAGED_POSTGRES_TEST_ARTIFACT unset', need: 'an installed managed PostgreSQL artifact matching the release pin' }
  p.desktopDriver = { ok: false, detail: 'no maintained packaged-UI journey driver exists in the repository (offline-acceptance-bootstrap.mjs is a fault harness entry, not a journey driver; the packaged UI needs a CDP or computer-use driver)' }
  return p
}

// ── Source identity ──────────────────────────────────────────────────────

function sha256(text) { return createHash('sha256').update(text).digest('hex') }

export function sourceIdentity(dir) {
  const head = run('git', ['-C', dir, 'rev-parse', 'HEAD'])
  if (!head.ok) return { dir, git: false }
  const diff = spawnSync('git', ['-C', dir, 'diff', 'HEAD', '--binary', '--ignore-submodules=all'], { maxBuffer: 1 << 30 })
  if (diff.status !== 0) throw new Error(`cannot fingerprint tracked source in ${dir}`)
  const listing = spawnSync('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (listing.status !== 0) throw new Error(`cannot fingerprint untracked source in ${dir}`)
  const untracked = listing.stdout.split('\0').filter(Boolean).sort()
  // Content, not timestamps: same-size edits and restored mtimes must change
  // the frozen-source identity. Preserve symlink identity without following it.
  const untrackedContent = untracked.map(path => {
    const absolute = join(dir, path), stat = lstatSync(absolute)
    return [path, stat.mode, stat.isSymbolicLink() ? `link:${readlinkSync(absolute)}` : sha256(readFileSync(absolute))]
  })
  return { dir, git: true, head: head.out, dirty: (diff.stdout?.length ?? 0) > 0 || untracked.length > 0,
    diffSha256: sha256(diff.stdout ?? Buffer.alloc(0)), untrackedFiles: untracked.length, untrackedSha256: sha256(JSON.stringify(untrackedContent)) }
}

// ── Step execution ───────────────────────────────────────────────────────

function sanitizedEnvKeys(env) { return Object.keys(env).sort() }

function execCommand(ctx, step, cmd, args, { cwd, env, timeoutMs, logName }) {
  const log = join(ctx.out, 'logs', `${logName ?? step.id}.log`)
  return new Promise((accept) => {
    const started = Date.now()
    const stream = createWriteStream(log)
    stream.write(`$ (cwd ${cwd}) ${cmd} ${args.join(' ')}\n`)
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    ctx.activeChildren.add(child)
    let timedOut = false
    const kill = (signal) => { try { process.kill(-child.pid, signal) } catch { /* gone */ } }
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 15_000).unref() }, timeoutMs)
    child.stdout.pipe(stream, { end: false })
    child.stderr.pipe(stream, { end: false })
    child.on('error', (error) => stream.write(`\n[m6] spawn error: ${error.message}\n`))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      ctx.activeChildren.delete(child)
      stream.end(`\n[m6] exit ${code ?? signal} after ${Date.now() - started} ms${timedOut ? ' (timed out)' : ''}\n`)
      accept({ exitCode: code, signal, timedOut, durationMs: Date.now() - started, log, command: { cwd, argv: [cmd, ...args], envKeys: sanitizedEnvKeys(env) } })
    })
  })
}

async function withFixture(ctx, { statementStatistics = false, migrationDirs = [], prepareTemplate = false }, fn) {
  const { createLocalFixture } = await import(pathToFileURL(join(ctx.ossRoot ?? OSS, 'scripts/crm/local-fixture.mjs')).href)
  const started = Date.now()
  const fixture = await createLocalFixture({ pgBin: ctx.probes.pg18.pgBin, ordinaryOwner: true, statementStatistics, migrationDirs, prepareTemplate })
  ctx.activeFixtures.add(fixture)
  const marker = JSON.parse(readFileSync(fixture.env.BRIAN_ASSURANCE_FIXTURE, 'utf8'))
  const fixtureInfo = { provisionMs: Date.now() - started, port: marker.port, statementStatistics,
    ...(fixture.statistics ? { statistics: fixture.statistics } : {}), migrationDirs, profile: 'ordinary owner (assurance_owner), runtime app_user, NOSUPERUSER/NOBYPASSRLS' }
  try { return await fn(fixture, fixtureInfo) }
  finally {
    ctx.activeFixtures.delete(fixture)
    const disposeStarted = Date.now()
    await fixture.dispose()
    fixtureInfo.disposed = true
    fixtureInfo.disposeMs = Date.now() - disposeStarted
  }
}

function vitestArgs(test, vitestJson, { integration = true, pattern } = {}) {
  return ['exec', 'vitest', 'run', ...(integration ? ['--config', 'vitest.integration.config.ts'] : []),
    test.replace(/^packages\/api\//, ''), '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${vitestJson}`,
    ...(pattern ? ['-t', pattern] : [])]
}

/** Vitest renders it.each string fields quoted: "'empty-private' / 'legacy' / sample +0". */
function fixed20Pattern(wanted) {
  if (!wanted || wanted.length === FIXED20_SCENARIOS.length) return undefined
  return wanted.map(s => { const [scenario, model] = s.split('/'); return `'${scenario}' / '${model}' / sample` }).join('|')
}

/** Vitest inside a fresh fixture, harness output captured at `outputEnv`. */
function vitestStep({ test, integration = true, outputEnv, outputName, extraEnv = () => ({}), pattern, statementStatistics = false, migrationDirs, timeoutMs, needs }) {
  return {
    needs: ['pnpm', 'pg18', ...(statementStatistics ? ['pgStatStatements'] : []), ...(needs ?? [])],
    timeoutMs,
    async run(ctx, step) {
      const dirs = typeof migrationDirs === 'function' ? migrationDirs(ctx) : (migrationDirs ?? [])
      return withFixture(ctx, { statementStatistics, migrationDirs: dirs }, async (fixture, fixtureInfo) => {
        const output = join(ctx.rawDir(step.id), outputName)
        const vitestJson = join(ctx.rawDir(step.id), 'vitest.json')
        const env = { ...fixture.env, ...(outputEnv ? { [outputEnv]: output } : {}), ...extraEnv(ctx, step) }
        const args = vitestArgs(test, vitestJson, { integration, pattern: typeof pattern === 'function' ? pattern(ctx) : pattern })
        const result = await execCommand(ctx, step, 'pnpm', args, { cwd: API_PKG, env, timeoutMs: step.timeoutMs })
        return { ...result, fixture: fixtureInfo, outputs: { harness: outputEnv ? output : null, vitest: vitestJson } }
      })
    },
  }
}

function fixed20Step({ edition = 'oss', samples = 1, fragments, staleRoom = false, tool, scenarios, timeoutMin }) {
  return vitestStep({
    test: HARNESSES.fixed20, outputEnv: 'BRIAN_CHAT_COST_OUTPUT', outputName: 'chat-cost.json', statementStatistics: true,
    migrationDirs: edition === 'hosted' ? (ctx) => [join(ctx.platformRoot, 'packages/api-platform/migrations')] : [],
    needs: ['packageDist', ...(edition === 'hosted' ? ['platform'] : [])],
    timeoutMs: timeoutMin * MIN,
    extraEnv: (ctx) => ({
      BRIAN_CHAT_COST_SAMPLES: String(typeof samples === 'function' ? samples(ctx) : samples),
      ...(fragments ? { BRIAN_CHAT_COST_FRAGMENTS: String(fragments) } : {}),
      ...(staleRoom ? { BRIAN_CHAT_COST_STALE_ROOM: '1' } : {}),
      ...(tool ? { BRIAN_CHAT_COST_TOOL: tool } : {}),
    }),
    pattern: (ctx) => fixed20Pattern(scenarios ?? ctx.scenarios),
  })
}

export const SCALING_CELLS = [
  ...[10, 100, 1000].map(messages => ({ cell: `messages:${messages}`, messages, dependencies: 1 })),
  ...[1, 10, 100].map(dependencies => ({ cell: `dependencies:${dependencies}`, messages: 10, dependencies })),
]

export function scalingStep({ interaction = true } = {}) {
  return { needs: ['pnpm', 'pg18', 'pgStatStatements', 'packageDist'], timeoutMs: 120 * MIN,
    async run(ctx, step) {
      return withFixture(ctx, { statementStatistics: true, prepareTemplate: true }, async (fixture, fixtureInfo) => {
        const root = ctx.ossRoot ?? OSS
        const { cloneLocalFixture } = await import(pathToFileURL(join(root, 'scripts/crm/local-fixture.mjs')).href)
        const raw = ctx.rawDir(step.id), results = [], cells = []
        const tests = { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, success: true }
        let last, durationMs = 0, failed = false
        const planned = [...SCALING_CELLS, ...(interaction ? [{ cell: 'interaction:1000x100', messages: 1000, dependencies: 100 }] : [])]
        for (const cell of planned) {
          const clone = await cloneLocalFixture(fixture.env), label = cell.cell.replace(':', '-')
          try {
            const harness = join(raw, `${label}.json`), vitest = join(raw, `${label}-vitest.json`)
            last = await execCommand(ctx, step, 'pnpm', vitestArgs(HARNESSES.fixed20, vitest), { cwd: join(root, 'packages/api'),
              env: { ...clone.env, BRIAN_CHAT_COST_OUTPUT: harness, BRIAN_CHAT_COST_MESSAGES: String(cell.messages),
                BRIAN_CHAT_COST_DEPENDENCIES: String(cell.dependencies), BRIAN_CHAT_COST_SAMPLES: '1' },
              timeoutMs: 20 * MIN, logName: `${step.id}-${label}` })
            durationMs += last.durationMs; failed ||= last.exitCode !== 0
            const counts = existsSync(vitest) ? JSON.parse(readFileSync(vitest, 'utf8')) : null
            for (const key of ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests']) tests[key] += counts?.[key] ?? 0
            tests.success &&= counts?.success === true
            const output = existsSync(harness) ? JSON.parse(readFileSync(harness, 'utf8')) : null
            for (const result of output?.results ?? []) results.push({ ...result, scalingCell: cell.cell })
            cells.push({ ...cell, exitCode: last.exitCode, log: last.log, harness: output ? harness : null })
          } finally { await clone.dispose() }
        }
        const harness = join(raw, 'scaling.json'), vitest = join(raw, 'vitest.json')
        writeFileSync(harness, JSON.stringify({ cells, results, definition: 'six independent axes from A9: retained-message axis at one distinct dependency; dependency axis at ten retained messages; additional 1000 retained x 100 actual dependencies interaction control. This is not the full Cartesian grid. Canonical writers/readers, no raw transcript or fabricated provenance. Seeding excluded from measured HTTP turn.' }, null, 2) + '\n')
        writeFileSync(vitest, JSON.stringify(tests, null, 2) + '\n')
        return { ...last, exitCode: failed ? 1 : 0, durationMs, fixture: fixtureInfo, outputs: { harness, vitest } }
      })
    },
  }
}

export const COLD_DEFINITION = 'cold: the owned fixture cluster is restarted (fast shutdown, new postmaster on the same data directory and port) immediately before a new vitest process runs the scenario, so the measured request meets empty shared buffers, new backends with empty catalog, relation and plan caches, a fresh API connection pool and a first request in a fresh Node process. The OS page cache is not flushed (that needs elevated privileges), and the sample\'s own fixture setup (users, workspace, session rows) runs on the restarted cluster before the measured request. warm: the second sample in the same process, after the cold one.'

/**
 * Row A7: one restart of the owned cluster per cold sample, then a separate
 * vitest process with two samples of one scenario (sample 0 cold, sample 1
 * warm). The merged harness output tags every result `coldPhase` and keeps
 * the restart index; vitest counts are summed across invocations.
 */
function fixed20ColdStep({ timeoutMin }) {
  return {
    needs: ['pnpm', 'pg18', 'pgStatStatements', 'packageDist'],
    timeoutMs: timeoutMin * MIN,
    async run(ctx, step) {
      return withFixture(ctx, { statementStatistics: true }, async (fixture, fixtureInfo) => {
        const raw = ctx.rawDir(step.id)
        const deadline = Date.now() + step.timeoutMs
        const restarts = [], results = []
        const tests = { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true }
        let last = null, durationMs = 0
        run: for (const scenario of ctx.scenarios ?? FIXED20_SCENARIOS) {
          for (let restart = 0; restart < ctx.coldSamples; restart++) {
            const label = `${scenario.replace('/', '--')}-r${restart}`
            const restartStarted = Date.now()
            await fixture.restart()
            const restartMs = Date.now() - restartStarted
            const output = join(raw, `chat-cost-${label}.json`), vitestJson = join(raw, `vitest-${label}.json`)
            last = await execCommand(ctx, step, 'pnpm', vitestArgs(HARNESSES.fixed20, vitestJson, { pattern: fixed20Pattern([scenario]) }), {
              cwd: API_PKG, env: { ...fixture.env, BRIAN_CHAT_COST_OUTPUT: output, BRIAN_CHAT_COST_SAMPLES: '2' },
              timeoutMs: Math.max(1_000, deadline - Date.now()), logName: `${step.id}-${label}` })
            durationMs += last.durationMs
            const counts = existsSync(vitestJson) ? JSON.parse(readFileSync(vitestJson, 'utf8')) : null
            for (const key of Object.keys(tests)) if (key !== 'success') tests[key] += counts?.[key] ?? 0
            tests.success &&= counts?.success === true
            const harness = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null
            for (const r of harness?.results ?? []) results.push({ ...r, restart, coldPhase: r.sample === 0 ? 'cold' : 'warm' })
            restarts.push({ scenario, restart, restartMs, exitCode: last.exitCode, timedOut: last.timedOut, log: last.log, output: harness ? output : null })
            if (last.timedOut || last.exitCode !== 0) break run
          }
        }
        const vitest = join(raw, 'vitest.json'), harness = join(raw, 'chat-cost.json')
        writeFileSync(vitest, JSON.stringify(tests, null, 2) + '\n')
        if (results.length) writeFileSync(harness, JSON.stringify({ tool: TOOL, cold: { definition: COLD_DEFINITION, samplesPerScenario: ctx.coldSamples, restarts }, results }, null, 2) + '\n')
        return { ...last, durationMs, fixture: { ...fixtureInfo, restarts: restarts.length }, outputs: { harness, vitest } }
      })
    },
  }
}

function commandStep({ cmd, args, cwd, needs = [], timeoutMin, okExitCodes = [0], outputs = {}, env }) {
  return {
    needs, timeoutMs: timeoutMin * MIN,
    async run(ctx, step) {
      const resolved = Object.fromEntries(Object.entries(outputs).map(([k, name]) => [k, join(ctx.rawDir(step.id), name)]))
      const a = typeof args === 'function' ? await args(ctx, resolved) : args
      const c = typeof cwd === 'function' ? cwd(ctx) : cwd
      const e = typeof env === 'function' ? await env(ctx, resolved) : (env ?? process.env)
      const result = await execCommand(ctx, step, typeof cmd === 'function' ? cmd(ctx) : cmd, a, { cwd: c, env: e, timeoutMs: step.timeoutMs })
      return { ...result, okExitCodes, outputs: resolved }
    },
  }
}

const skipAlways = (reason) => ({ needs: ['desktopDriver'], timeoutMs: 0, staticReason: reason, async run() { throw new Error('unreachable') } })

// ── Step registry ────────────────────────────────────────────────────────

const JOURNEYS = ['new-chat-reload', 'composer-accept', 'stop', 'network-loss', 'question', 'switch', 'approval', 'room', 'uploads', 'workbench-stop', 'identity', 'dock']

function browserStep(journey, width, destructive = false) {
  return {
    needs: ['chrome', 'playwright', 'stack'], destructive, timeoutMs: (destructive ? 20 : 12) * MIN,
    async run(ctx, step) {
      const env = { ...process.env, M5_CHROME: process.env.M5_CHROME, PLAYWRIGHT_MODULE: ctx.probes.playwright.module,
        M5_API: ctx.probes.stack.api, M5_APP: ctx.probes.stack.app, M5_WORK_DIR: ctx.probes.stack.workDir }
      const outRoot = ctx.rawDir(step.id)
      const result = await execCommand(ctx, step, process.execPath, [join(OSS, 'apps/app-web/scripts/m5-controller-qualification-browser.mjs'), journey, String(width), outRoot],
        { cwd: join(OSS, 'apps/app-web/scripts'), env, timeoutMs: step.timeoutMs })
      return { ...result, outputs: { harness: join(outRoot, `${journey}-${width}`, 'result.json') } }
    },
  }
}

export const STEPS = {
  'fixed20-oss-counts': { group: 'fixed20', estimate: '3 to 6 min (fixture 1 to 3 min, then about 10 s per scenario)', ...fixed20Step({ timeoutMin: 30 }) },
  'fixed20-hosted-counts': { group: 'fixed20', estimate: '3 to 6 min', ...fixed20Step({ edition: 'hosted', timeoutMin: 30 }) },
  'fixed20-oss-warm': { group: 'fixed20', estimate: '15 to 30 min (186 turns)', ...fixed20Step({ samples: (ctx) => ctx.warmSamples, timeoutMin: 90 }) },
  'fixed20-oss-frag-20': { group: 'fixed20', estimate: '3 to 6 min', ...fixed20Step({ fragments: 20, timeoutMin: 30 }) },
  'fixed20-oss-frag-200': { group: 'fixed20', estimate: '3 to 6 min', ...fixed20Step({ fragments: 200, timeoutMin: 30 }) },
  'fixed20-oss-frag-2000': { group: 'fixed20', estimate: '3 to 8 min', ...fixed20Step({ fragments: 2000, timeoutMin: 40 }) },
  'fixed20-oss-stale-room': { group: 'fixed20', estimate: '3 to 5 min', ...fixed20Step({ staleRoom: true, scenarios: ['shared-room/legacy', 'shared-room/department-v2'], timeoutMin: 30 }) },
  'fixed20-oss-cold': { group: 'fixed20', estimate: 'fixture 1 to 3 min, then about 20 to 40 s per restart (3 restarts per scenario by default: 18 vitest processes for 6 scenarios)', ...fixed20ColdStep({ timeoutMin: 60 }) },
  'fixed20-oss-lookup': { group: 'fixed20', estimate: '10 to 20 min (fixture, then the warm samples of each scenario; the p50 latency budget needs >=20 warm samples)', ...fixed20Step({ tool: 'lookup', samples: (ctx) => ctx.warmSamples, timeoutMin: 90 }) },
  'fixed20-scaling': { group: 'fixed20', estimate: 'one migrated template and six serial owned clones; canonical seeding included separately, up to 20 min per cell', ...scalingStep() },
  'doc-thread-32': { group: 'baseline', estimate: '10 to 60 min (fixture, then 32 dock turns whose cost grows with the thread)', ...vitestStep({ test: HARNESSES.docThread, outputEnv: 'BRIAN_DOC_THREAD_OUTPUT', outputName: 'doc-thread.json', extraEnv: () => ({ BRIAN_DOC_THREAD_TURNS: '32' }), timeoutMs: 240 * MIN }) },
  admission: { group: 'baseline', estimate: '3 to 6 min (9 requests)', ...vitestStep({ test: HARNESSES.admission, outputEnv: 'BRIAN_TURN_ADMISSION_OUTPUT', outputName: 'turn-admission.json', extraEnv: () => ({}), timeoutMs: 30 * MIN }) },
  'model-calls': { group: 'model', estimate: '3 to 6 min (13 turns)', ...vitestStep({ test: HARNESSES.routing, outputEnv: 'BRIAN_TURN_ROUTING_OUTPUT', outputName: 'turn-routing.json', extraEnv: () => ({}), timeoutMs: 30 * MIN }) },
  'import-graph-chat': { group: 'imports', estimate: 'under 1 min', ...commandStep({
    cmd: process.execPath, cwd: OSS, timeoutMin: 10, okExitCodes: [0, 1], outputs: { harness: 'import-graph-chat.json' },
    args: (ctx, o) => [join(OSS, 'scripts/testing/import-graph.mjs'), '--entry-set', 'chat', '--label', 'm6', '--out', o.harness, ...(ctx.platformRoot ? [] : ['--no-platform'])] }) },
  'import-graph-m4': { group: 'imports', estimate: 'under 1 min', needs: ['platform'], ...commandStep({
    cmd: process.execPath, cwd: OSS, timeoutMin: 10, needs: ['platform'], outputs: { harness: 'import-graph-m4.json' },
    args: (ctx, o) => [join(OSS, 'scripts/testing/import-graph.mjs'), '--entry-set', 'm4-measure', '--label', 'm6', '--out', o.harness, '--report-only'] }) },
  'codemod-verify': { group: 'imports', estimate: 'under 1 min', ...commandStep({
    cmd: process.execPath, cwd: OSS, timeoutMin: 10, okExitCodes: [0, 1], outputs: { harness: 'codemod-verify.json' },
    args: (ctx, o) => [join(OSS, 'scripts/testing/runtime-importer-codemod.mjs'), 'verify', '--core-root', '--json', o.harness] }) },
  'runtime-trace-oss': { group: 'imports', estimate: '2 to 4 min (fixture plus boot)', ...traceStep(false) },
  'runtime-trace-oss-workers': { group: 'imports', estimate: '2 to 4 min', ...traceStep(true) },
  ...Object.fromEntries(JOURNEYS.flatMap(j => [390, 1440].map(w => [`browser-${j}-${w}`, { group: 'browser', estimate: j === 'question' ? '3 to 5 min' : '1 to 4 min', ...browserStep(j, w) }]))),
  'browser-restart-1440': { group: 'browser', estimate: '5 to 20 min (kills the shared API)', ...browserStep('restart', 1440, true) },
  'browser-restart2-1440': { group: 'browser', estimate: '5 to 20 min (kills the shared API)', ...browserStep('restart2', 1440, true) },
  'desktop-package': { group: 'desktop', estimate: '10 to 25 min', ...commandStep({ cmd: 'pnpm', args: ['--filter', '@use-brian/app-desktop', 'package'], cwd: (ctx) => ctx.platformRoot ?? OSS, needs: ['pnpm', 'xcode'], timeoutMin: 60 }) },
  ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'companion'].map(j => [`desktop-journey-${j}`, { group: 'desktop', estimate: 'unknown (no driver)', ...skipAlways('packaged journey') }])),
  'desktop-unit': { group: 'desktop', estimate: '1 to 3 min', ...commandStep({ cmd: 'pnpm', args: ['--filter', '@use-brian/app-desktop', 'exec', 'vitest', 'run'], cwd: (ctx) => ctx.platformRoot ?? OSS, needs: ['pnpm'], timeoutMin: 20 }) },
  transfer: { group: 'transfer', estimate: '10 min with a pristine 8273 template, about 40 min without (30-minute brain build)', ...nativeStep(HARNESSES.transfer, 'transfer-receipt.json', 90) },
  'launcher-receiving': { group: 'transfer', estimate: '3 to 8 min', ...nativeStep(HARNESSES.launcher, null, 40) },
  'gate-test': { group: 'gates', estimate: '16 to 40 min (45 turbo tasks; 16m18s with 21 cached in an earlier receipt)', ...platformGate(['test'], 120) },
  'gate-smoke': { group: 'gates', estimate: 'under 1 min', ...platformGate(['smoke'], 10) },
  'gate-check': { group: 'gates', estimate: '2 to 5 min', ...platformGate(['check'], 30) },
  'gate-check-subset': { group: 'gates', estimate: 'under 1 min', ...platformGate(['check', '--only=copy-emdash,agent-guidance'], 10) },
  'gate-verify-api-deploy': { group: 'gates', estimate: '4 to 10 min', ...platformGate(['verify:api-deploy'], 45) },
  'gate-api-open': { group: 'gates', estimate: '3 to 8 min', ...platformGate(['--filter', '@use-brian/api-open', 'test'], 30) },
  'gate-department-isolation': { group: 'gates', estimate: '60 to 120 min serial (11 shards of the full profile, about 10 min each in CI)', ...commandStep({
    cmd: process.execPath, cwd: OSS, needs: ['pg18'], timeoutMin: 240, outputs: { harness: 'department-isolation.json' },
    args: (ctx, o) => [join(OSS, 'scripts/test-department-isolation.mjs'), '--pg-bin', ctx.probes.pg18.pgBin, '--report', o.harness] }) },
}

function traceStep(workers) {
  return {
    needs: ['pg18', 'apiDist', 'node'], timeoutMs: 15 * MIN,
    async run(ctx, step) {
      return withFixture(ctx, {}, async (fixture, fixtureInfo) => {
        const output = join(ctx.rawDir(step.id), 'chat-import-receipt.json')
        const port = await freePort()
        mkdirSync(join(ctx.rawDir(step.id), 'trace'), { recursive: true })
        const env = { ...fixture.env, BRIAN_M6_STEP: step.id }
        const args = [join(OSS, 'scripts/testing/chat-import-receipt.mjs'), '--out', output, '--label', `m6-${workers ? 'workers' : 'no-workers'}`,
          '--database-url', fixture.adminUrl, '--port', String(port), '--trace-dir', join(ctx.rawDir(step.id), 'trace'), ...(workers ? ['--workers'] : [])]
        const result = await execCommand(ctx, step, process.execPath, args, { cwd: OSS, env, timeoutMs: step.timeoutMs })
        // Exit 3 is the driver's own "incomplete receipt" code (skeleton turn and probes).
        return { ...result, okExitCodes: [0], partialExitCodes: [3], fixture: fixtureInfo, outputs: { harness: output } }
      })
    },
  }
}

function nativeStep(test, receiptName, timeoutMin) {
  return {
    needs: ['pnpm', 'transferArtifact'], timeoutMs: timeoutMin * MIN,
    async run(ctx, step) {
      const receipt = receiptName ? join(ctx.rawDir(step.id), receiptName) : null
      const vitestJson = join(ctx.rawDir(step.id), 'vitest.json')
      const env = { ...process.env, ...(receipt ? { USEBRIAN_MANAGED_TRANSFER_TEST_RECEIPT: receipt } : {}) }
      const args = ['exec', 'vitest', 'run', test.replace(/^packages\/api\//, ''), '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${vitestJson}`]
      const result = await execCommand(ctx, step, 'pnpm', args, { cwd: API_PKG, env, timeoutMs: step.timeoutMs })
      return { ...result, outputs: { harness: receipt, vitest: vitestJson } }
    },
  }
}

function platformGate(args, timeoutMin) {
  return commandStep({ cmd: 'pnpm', args, cwd: (ctx) => ctx.platformRoot, needs: ['pnpm', 'platform'], timeoutMin })
}

export const PROFILES = {
  'dry-run': ['fixed20-oss-counts', 'admission', 'import-graph-chat', 'import-graph-m4', 'codemod-verify', 'runtime-trace-oss', 'gate-smoke', 'gate-check-subset'],
  full: Object.keys(STEPS).filter(id => id !== 'gate-check-subset'),
}

// ── Status classification (never optimistic) ─────────────────────────────

function vitestCounts(path) {
  if (!path || !existsSync(path)) return null
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    return { total: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, skipped: (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0), success: j.success }
  } catch { return null }
}

function classify(result) {
  const harness = result.outputs?.harness
  const harnessWritten = harness ? existsSync(harness) : null
  const tests = vitestCounts(result.outputs?.vitest)
  if (result.timedOut) return { status: 'timeout', reason: 'step exceeded its timeout and was terminated', harnessWritten, tests }
  const ok = (result.okExitCodes ?? [0]).includes(result.exitCode)
  const partial = (result.partialExitCodes ?? []).includes(result.exitCode)
  if (!ok && !partial) return { status: 'failed', reason: `exit ${result.exitCode ?? result.signal}`, harnessWritten, tests }
  if (harness && !harnessWritten) return { status: 'error', reason: 'command succeeded but the harness wrote no output (skipped suite or early exit); not counted', harnessWritten, tests }
  if (tests && tests.passed === 0) return { status: 'error', reason: `no test passed (${tests.skipped} skipped of ${tests.total}); not counted`, harnessWritten, tests }
  if (partial) return { status: 'partial', reason: `exit ${result.exitCode}: the harness reports an incomplete receipt`, harnessWritten, tests }
  return { status: 'completed', reason: result.exitCode === 0 ? 'exit 0' : `exit ${result.exitCode} (a measured violation, recorded by the harness)`, harnessWritten, tests }
}

// ── Main ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { profile: 'dry-run', plumbing: false, allowDestructive: false, warmSamples: 31, coldSamples: 3, timeoutScale: 1 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = () => { const value = argv[++i]; if (value === undefined) throw new Error(`missing value for ${a}`); return value }
    if (a === '--list') o.list = true
    else if (a === '--profile') o.profile = v()
    else if (a === '--steps') o.steps = v().split(',').filter(Boolean)
    else if (a === '--out') o.out = resolve(v())
    else if (a === '--pg-bin') o.pgBin = resolve(v())
    else if (a === '--scenarios') o.scenarios = v().split(',').filter(Boolean)
    else if (a === '--warm-samples') o.warmSamples = Number(v())
    else if (a === '--cold') o.cold = true
    else if (a === '--cold-samples') o.coldSamples = Number(v())
    else if (a === '--plumbing') o.plumbing = true
    else if (a === '--allow-destructive') o.allowDestructive = true
    else if (a === '--timeout-scale') o.timeoutScale = Number(v())
    else if (a === '--barrier-before') o.barrierBefore = v()
    else if (a === '--barrier-file') o.barrierFile = resolve(v())
    else if (a === '--resume') o.resume = true
    else if (a === '--quiescence-dir') o.quiescenceDir = resolve(v())
    else if (a === '--freeze-id') o.freezeId = v()
    else if (a === '--quiescence-owners') o.quiescenceOwners = v().split(',').filter(Boolean)
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (o.scenarios) for (const s of o.scenarios) if (!FIXED20_SCENARIOS.includes(s)) throw new Error(`unknown scenario ${s}; expected one of ${FIXED20_SCENARIOS.join(', ')}`)
  if (!Number.isInteger(o.warmSamples) || o.warmSamples < 2 || o.warmSamples > 31) throw new Error('--warm-samples must be 2 to 31 (the harness range; sample 0 is warm-up)')
  if (!Number.isInteger(o.coldSamples) || o.coldSamples < 1 || o.coldSamples > 31) throw new Error('--cold-samples must be 1 to 31 (one cluster restart each)')
  if (Boolean(o.barrierBefore) !== Boolean(o.barrierFile)) throw new Error('--barrier-before and --barrier-file must be supplied together')
  if (o.barrierBefore && !STEPS[o.barrierBefore]) throw new Error(`unknown barrier step ${o.barrierBefore}`)
  if ([o.quiescenceDir, o.freezeId, o.quiescenceOwners].some(Boolean) && ![o.quiescenceDir, o.freezeId, o.quiescenceOwners].every(Boolean)) throw new Error('--quiescence-dir, --freeze-id and --quiescence-owners must be supplied together')
  return o
}

export function selectSteps(o) {
  const withCold = (ids) => o.cold && !ids.includes('fixed20-oss-cold') ? [...ids, 'fixed20-oss-cold'] : ids
  if (o.steps) { for (const id of o.steps) if (!STEPS[id]) throw new Error(`unknown step ${id}`); return withCold(o.steps) }
  if (PROFILES[o.profile]) return withCold(PROFILES[o.profile])
  const group = Object.keys(STEPS).filter(id => STEPS[id].group === o.profile)
  if (!group.length) throw new Error(`unknown profile or group ${o.profile}`)
  return withCold(group)
}

function rowsFor(id) { return ROWS.filter(row => row.steps.includes(id)).map(row => row.id) }

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.help) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return 0 }
  if (o.list) {
    for (const [id, step] of Object.entries(STEPS)) console.log(`${id.padEnd(30)} ${step.group.padEnd(9)} rows ${rowsFor(id).join(',').padEnd(12)} needs ${(step.needs ?? []).join(',') || '-'}; ${step.estimate}`)
    return 0
  }
  const ids = selectSteps(o)
  const out = o.out ?? join(tmpdir(), `brian-m6-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const manifestPath = join(out, 'run.json')
  const previous = o.resume && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
  if (o.resume && !previous) throw new Error('--resume requires an existing --out run directory')
  if (!o.resume && existsSync(manifestPath)) throw new Error('run directory already has run.json; use --resume to retain its receipts')
  if (previous && (JSON.stringify(previous.steps) !== JSON.stringify(ids) || previous.profile !== (o.steps ? 'explicit' : o.profile))) throw new Error('--resume must select exactly the original profile and steps')
  for (const sub of ['steps', 'raw', 'logs']) mkdirSync(join(out, sub), { recursive: true })
  const probes = await probeEnvironment(o)
  const ctx = {
    out, probes, plumbing: o.plumbing, scenarios: o.scenarios, warmSamples: o.warmSamples, coldSamples: o.coldSamples,
    platformRoot: probes.platform.ok ? PLATFORM_CANDIDATE : null,
    activeChildren: new Set(), activeFixtures: new Set(),
    rawDir: (id) => { const d = join(out, 'raw', id); mkdirSync(d, { recursive: true }); return d },
  }
  let interrupted = false
  const onSignal = (signal) => {
    if (interrupted) return
    interrupted = true
    console.error(`[m6] ${signal}: stopping the active step; fixtures are disposed by their owners`)
    for (const child of ctx.activeChildren) { try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ } }
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const identityNow = { oss: sourceIdentity(OSS), platform: ctx.platformRoot ? sourceIdentity(ctx.platformRoot) : null }
  const identityStart = previous?.source?.start ?? identityNow
  const manifest = previous ?? {
    tool: TOOL, schema: 1, runId: `m6-${Date.now().toString(36)}`, profile: o.steps ? 'explicit' : o.profile, steps: ids,
    plumbing: o.plumbing, qualificationNote: o.plumbing ? 'plumbing proof, not a qualification result' : 'candidate qualification run (see collect.mjs verdict rules)',
    startedAt: new Date().toISOString(), node: process.version, options: { scenarios: o.scenarios ?? null, warmSamples: o.warmSamples, coldSamples: o.coldSamples, cold: Boolean(o.cold), allowDestructive: o.allowDestructive, timeoutScale: o.timeoutScale,
      barrierBefore: o.barrierBefore ?? null, barrierFile: o.barrierFile ?? null },
    probes, source: { start: identityStart },
  }
  if (previous) {
    manifest.resumptions ??= []
    manifest.resumptions.push({ at: new Date().toISOString(), source: identityNow, probes,
      reason: 'resume retains every finished receipt; only interrupted/unstarted steps execute' })
    delete manifest.finishedAt
    manifest.interrupted = false
  }
  writeFileSync(join(out, 'run.json'), JSON.stringify(manifest, null, 2) + '\n')

  for (const id of ids) {
    const existingPath = join(out, 'steps', `${id}.json`)
    if (previous && existsSync(existingPath)) {
      const existing = JSON.parse(readFileSync(existingPath, 'utf8'))
      if (existing.finishedAt && existing.reason !== 'run interrupted before this step' && existing.status !== 'interrupted') {
        console.error(`[m6] ${id}: retained ${existing.status} (${existing.reason})`)
        continue
      }
    }
    if (!interrupted && id === o.barrierBefore) {
      const barrier = { before: id, file: o.barrierFile, waitingAt: new Date().toISOString(), releasedAt: null }
      manifest.barrier = barrier
      writeFileSync(join(out, 'run.json'), JSON.stringify(manifest, null, 2) + '\n')
      console.error(`[m6] waiting before ${id}: create ${o.barrierFile} after other timed workloads stop`)
      while (!interrupted && !existsSync(o.barrierFile)) await delay(500)
      barrier.releasedAt = interrupted ? null : new Date().toISOString()
      writeFileSync(join(out, 'run.json'), JSON.stringify(manifest, null, 2) + '\n')
    }
    const step = { id, ...STEPS[id], timeoutMs: Math.round((STEPS[id].timeoutMs ?? 0) * o.timeoutScale) }
    const receipt = { tool: TOOL, schema: 1, stepId: id, group: step.group, rows: rowsFor(id), plumbing: o.plumbing,
      ...(o.plumbing ? { note: 'plumbing proof, not a qualification result' } : {}), estimate: step.estimate, startedAt: new Date().toISOString() }
    const timedWindow = ['fixed20-oss-warm', 'fixed20-oss-lookup'].includes(id)
    const handshake = timedWindow && o.quiescenceDir ? checkQuiescence({ dir: o.quiescenceDir, freezeId: o.freezeId, owners: o.quiescenceOwners }) : null
    const missing = (step.needs ?? []).filter(need => !probes[need]?.ok)
    if (interrupted) Object.assign(receipt, { status: 'skipped', reason: 'run interrupted before this step' })
    else if (timedWindow && !handshake?.controlledTaskWorkload) Object.assign(receipt, { status: 'skipped', reason: `timed window requires verified task-owned quiescence: ${handshake?.errors.join('; ') ?? 'no handshake supplied'}`,
      measurementConditions: { qualifiesControlledLoad: false, reason: 'No valid fresh owner/process/disposal handshake before measurement', start: handshake } })
    else if (step.staticReason) Object.assign(receipt, { status: 'skipped', reason: `${step.staticReason}: ${probes.desktopDriver.detail}`, missing: ['desktopDriver'] })
    else if (missing.length) Object.assign(receipt, { status: 'skipped', reason: missing.map(need => `${need}: ${probes[need].detail}`).join('; '), missing })
    else if (step.destructive && !o.allowDestructive) Object.assign(receipt, { status: 'skipped', reason: 'kills the shared API; pass --allow-destructive on a dedicated stack' })
    else {
      console.error(`[m6] ${id}: running (${step.estimate})`)
      try {
        const result = await step.run(ctx, step)
        Object.assign(receipt, classify(result), { exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs, command: result.command,
          log: result.log, outputs: result.outputs, ...(result.fixture ? { fixture: result.fixture } : {}) })
      } catch (error) {
        Object.assign(receipt, { status: 'error', reason: `orchestrator could not run the step: ${error.message.split('\n')[0]}` })
      }
      if (interrupted && receipt.status !== 'completed') receipt.status = 'interrupted'
      if (handshake) {
        const end = checkQuiescence({ dir: o.quiescenceDir, freezeId: o.freezeId, owners: o.quiescenceOwners, maxAgeMs: step.timeoutMs + 15 * MIN })
        const stable = JSON.stringify(handshake.acknowledgements) === JSON.stringify(end.acknowledgements)
        receipt.measurementConditions = { qualifiesControlledLoad: end.controlledTaskWorkload && stable,
          reason: end.controlledTaskWorkload && stable ? 'Owner-declared task workload quiet with stable process/disposal receipts; unrelated background load not excluded' : 'Owner workload set or acknowledgement changed during measurement',
          start: handshake, end, interval: { start: receipt.startedAt, end: new Date().toISOString() } }
      }
    }
    receipt.finishedAt = new Date().toISOString()
    writeFileSync(join(out, 'steps', `${id}.json`), JSON.stringify(receipt, null, 2) + '\n')
    console.error(`[m6] ${id}: ${receipt.status} (${receipt.reason})`)
  }
  manifest.finishedAt = new Date().toISOString()
  manifest.source.end = { oss: sourceIdentity(OSS), platform: ctx.platformRoot ? sourceIdentity(ctx.platformRoot) : null }
  const same = (a, b) => a && b && a.head === b.head && a.diffSha256 === b.diffSha256 && a.untrackedSha256 === b.untrackedSha256
  manifest.source.unchangedDuringRun = { oss: same(identityStart.oss, manifest.source.end.oss), platform: identityStart.platform ? same(identityStart.platform, manifest.source.end.platform) : null }
  manifest.interrupted = interrupted
  writeFileSync(join(out, 'run.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.error(`[m6] run directory: ${out}`)
  return interrupted ? 130 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code }, error => { console.error(error.message); process.exitCode = 2 })
}

export { classify, parseArgs }
