#!/usr/bin/env node
/** [COMP:tooling/m6-qualification] Real built API/HTTP/import acceptance on
 * a new owned fixture. --live requires the existing explicit spending authority
 * and uses the shared capped transport; default is entirely deterministic. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { receipt } from '../chat-import-receipt.mjs'
import { fingerprint } from '../import-graph.mjs'
import { sourceIdentity } from './run-matrix.mjs'
import { startCappedLiveProvider } from './live-provider.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
function parse(argv) {
  const opts = { root: resolve(HERE, '../../..'), live: false, phase: 'm6', ledger: '/private/tmp/oss-chat-m6-m7-provider-spend.json', populate: false }
  for (let i = 0; i < argv.length; i++) {
    const next = () => { if (!argv[i + 1]) throw new Error(`missing value for ${argv[i]}`); return argv[++i] }
    const arg = argv[i]
    if (arg === '--oss-root') opts.root = resolve(next())
    else if (arg === '--out') opts.out = resolve(next())
    else if (arg === '--pg-bin') opts.pgBin = resolve(next())
    else if (arg === '--phase') opts.phase = next()
    else if (arg === '--ledger') opts.ledger = resolve(next())
    else if (arg === '--credentials-file') opts.credentialsFile = resolve(next())
    else if (arg === '--live') opts.live = true
    else if (arg === '--populate') opts.populate = true
    else if (arg === '--workers') opts.workers = true
    else if (arg === '--idle') opts.idle = true
    else if (arg === '--hosted') opts.hosted = true
    else if (arg === '--local-storage') opts.localStorage = true
    else throw new Error(`unknown argument ${arg}`)
  }
  if (opts.idle && !opts.workers) throw new Error('--idle requires the normal --workers runtime')
  if (opts.localStorage && (!opts.hosted || opts.live)) throw new Error('--local-storage requires a deterministic hosted fixture')
  if (!opts.out) throw new Error('--out is required')
  if (existsSync(opts.out)) throw new Error('output receipt already exists; choose a new path')
  if (opts.credentialsFile && !opts.live) throw new Error('--credentials-file is only read for an explicitly live run')
  return opts
}

async function main(opts) {
  mkdirSync(dirname(opts.out), { recursive: true })
  const { createLocalFixture } = await import(pathToFileURL(join(opts.root, 'scripts/crm/local-fixture.mjs')).href)
  let fixture, provider
  const paths = ['packages/api/src', 'packages/api/dist', 'packages/core/src', 'packages/core/dist', 'packages/agent-runtime/src', 'packages/agent-runtime/dist',
    'packages/shared/src', 'packages/shared/dist', 'apps/api/dist', 'packages/api/migrations',
    ...(opts.hosted ? ['../apps/api/src', '../apps/api/dist', '../packages/api-platform/src', '../packages/api-platform/dist', '../packages/api-platform/migrations'] : [])]
  const hashes = () => Object.fromEntries(paths.map(path => [path, fingerprint(join(opts.root, path))]))
  const result = { tool: 'scripts/testing/m6/run-runtime-acceptance.mjs', startedAt: new Date().toISOString(), live: opts.live,
    scope: opts.live ? 'disposable populated ordinary live-provider turn; not the historical personal-brain turn' : 'disposable ordinary deterministic turn and runtime import delta',
    source: sourceIdentity(opts.root), fingerprints: { start: hashes() },
    driverSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex') }
  try {
    if (opts.live) {
      let key = process.env.DASHSCOPE_API_KEY
      if (!key && opts.credentialsFile) {
        const require = createRequire(join(opts.root, 'packages/api/package.json'))
        const dotenv = await import(pathToFileURL(require.resolve('dotenv')).href)
        key = dotenv.parse(readFileSync(opts.credentialsFile)).DASHSCOPE_API_KEY
      }
      provider = await startCappedLiveProvider({ apiKey: key, ledgerPath: opts.ledger, phase: opts.phase })
    }
    fixture = await createLocalFixture({ pgBin: opts.pgBin, ordinaryOwner: true, statementStatistics: Boolean(opts.idle),
      ...(opts.hosted ? { migrationDirs: [resolve(opts.root, '../packages/api-platform/migrations')] } : {}) })
    const afterReady = opts.idle ? async () => {
      const { assertLocalFixture } = await import(pathToFileURL(join(opts.root, 'scripts/crm/local-fixture.mjs')).href)
      await assertLocalFixture(fixture.env)
      const url = new URL(fixture.adminUrl); url.username = fixture.statistics.observer
      const require = createRequire(join(opts.root, 'packages/api/package.json')), pg = require('pg')
      const observer = new pg.Client({ connectionString: url.href })
      await observer.connect()
      try {
        const identity = (await observer.query('/* m6-observer */ SELECT session_user AS actor,current_database() AS database')).rows[0]
        if (identity.actor !== 'assurance_bootstrap' || identity.database !== url.pathname.slice(1)) throw new Error('Disposable bootstrap observer identity mismatch')
        const { measureSqlWindow } = await import('./sql-observer.mjs')
        return await measureSqlWindow({ client: observer, workload: 'workers-idle-10s', idleMs: 10_000, lockSampleMs: 20 })
      } finally { await observer.end() }
    } : undefined
    result.runtime = await receipt({ hosted: opts.hosted, localStorage: opts.localStorage, afterReady, ossRoot: opts.root, databaseUrl: fixture.adminUrl, env: fixture.env, provider, populate: opts.populate || opts.live, fixtureAuth: true, workers: opts.workers })
    result.status = result.runtime.turn?.status === 'pass' ? 'ordinary-turn-passed' : 'failed'
    result.completeQualification = result.runtime.complete
    result.fingerprints.end = hashes()
    result.productInputsUnchanged = JSON.stringify(result.fingerprints.start) === JSON.stringify(result.fingerprints.end)
    if (!result.productInputsUnchanged) { result.status = 'failed'; result.reason = 'product source/build/migration inputs changed during the acceptance journey' }
  } catch (error) {
    result.status = 'failed'; result.reason = error.message
  } finally {
    await provider?.close()
    if (provider) result.spend = provider.ledger.snapshot()
    if (fixture) { await fixture.dispose(); result.fixtureDisposed = true }
    result.fingerprints.end ??= hashes()
    result.changedInputRoots = paths.filter(path => result.fingerprints.start[path] !== result.fingerprints.end[path])
    result.productInputsUnchanged = result.changedInputRoots.length === 0
    result.finishedAt = new Date().toISOString()
    writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  }
  console.log(JSON.stringify({ status: result.status, live: result.live, completeQualification: result.completeQualification ?? false,
    productInputsUnchanged: result.productInputsUnchanged ?? null, output: opts.out, ...(result.reason ? { reason: result.reason.split('\n')[0] } : {}) }))
  return result.status === 'ordinary-turn-passed' ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(parse(process.argv.slice(2))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
