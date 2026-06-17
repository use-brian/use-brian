#!/usr/bin/env node
/**
 * One-command local boot for sidanclaw (oss-local-brain-wedge.md §12.7).
 *
 * `pnpm start` — the whole single-player product on ONE GEMINI_API_KEY:
 *   1. load/prompt GEMINI_API_KEY + generate JWT_SECRET, persisted under
 *      ~/.sidanclaw/config.json (nothing else is required).
 *   2. build the workspace packages (turbo-cached; the apps run from source via
 *      tsx / next dev).
 *   3. start the embedded PGLite brain server (pg-wire socket on :5432) and wait
 *      until it accepts connections — it migrates open-schema-v1 on first boot.
 *   4. start the api (:4000), the doc-sync sidecar (:8080) and app-web (:3003),
 *      all pointed at the socket via DATABASE_URL; single-process event buses.
 *   5. open the browser straight into an authenticated session (dev-login
 *      auto-provisions one Personal workspace — no /login, no /teams).
 *
 * The Postgres container is the code-identical escape hatch: set DATABASE_URL to
 * a real postgres:// string and the brain server step is skipped.
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_DIR = join(homedir(), '.sidanclaw')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const BRAIN_DIR = join(CONFIG_DIR, 'brain')
// The embedded brain uses a distinctive high port so it never collides with a
// developer's local Postgres on the default 5432 (verified failure mode).
const PORTS = { pglite: 54329, api: 4000, docSync: 8080, appWeb: 3003 }

// ── config (the only required input is GEMINI_API_KEY) ─────────────
mkdirSync(CONFIG_DIR, { recursive: true })
const config = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {}
let geminiKey = process.env.GEMINI_API_KEY || config.geminiApiKey
if (!geminiKey) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  geminiKey = (await rl.question('Enter your GEMINI_API_KEY (https://aistudio.google.com/apikey): ')).trim()
  rl.close()
  if (!geminiKey) { console.error('A GEMINI_API_KEY is required to boot. Exiting.'); process.exit(1) }
}
const jwtSecret = config.jwtSecret || randomBytes(32).toString('hex')
writeFileSync(CONFIG_FILE, JSON.stringify({ ...config, geminiApiKey: geminiKey, jwtSecret }, null, 2))

// External-store escape hatch: a real Postgres URL skips the embedded brain.
const useEmbedded = !process.env.DATABASE_URL
const databaseUrl = process.env.DATABASE_URL || `postgres://localhost:${PORTS.pglite}/postgres`

const env = {
  ...process.env,
  NODE_ENV: 'development',
  GEMINI_API_KEY: geminiKey,
  JWT_SECRET: jwtSecret,
  DATABASE_URL: databaseUrl,
  SIDANCLAW_SINGLE_PROCESS: '1',
  API_URL: `http://localhost:${PORTS.api}`,
  APP_URL: `http://localhost:${PORTS.appWeb}`,
  NEXT_PUBLIC_API_URL: `http://localhost:${PORTS.api}`,
  PORT: String(PORTS.api),
}

// ── helpers ────────────────────────────────────────────────────────
const children = []
function run(label, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...env, ...extraEnv }, stdio: ['ignore', 'inherit', 'inherit'] })
  child.on('exit', (code) => {
    if (!shuttingDown && code) { console.error(`[launch] ${label} exited with code ${code}; shutting down.`); shutdown(1) }
  })
  children.push(child)
  return child
}
function waitForPort(port, label, timeoutMs = 60_000) {
  const start = Date.now()
  return new Promise((resolveReady, reject) => {
    const tick = () => {
      const sock = connect({ port, host: '127.0.0.1' }, () => { sock.end(); resolveReady() })
      sock.on('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) reject(new Error(`${label} did not come up on :${port} within ${timeoutMs}ms`))
        else setTimeout(tick, 400)
      })
    }
    tick()
  })
}
function runOnce(label, cmd, args) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] })
    c.on('exit', (code) => (code ? rej(new Error(`${label} failed (${code})`)) : res()))
  })
}
function openBrowser(url) {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open'
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref()
}
let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) c.kill('SIGTERM')
  setTimeout(() => process.exit(code), 500)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// ── boot sequence ──────────────────────────────────────────────────
console.log('[launch] building workspace packages (turbo-cached)...')
await runOnce('build', 'pnpm', ['exec', 'turbo', 'run', 'build', '--filter=./packages/*'])

if (useEmbedded) {
  console.log(`[launch] starting embedded brain (PGLite) at ${BRAIN_DIR} on :${PORTS.pglite} ...`)
  run('pglite', 'pnpm', ['--filter', '@sidanclaw/api-open', 'exec', 'tsx', 'src/pglite-server.ts'],
    { PGLITE_DATA_DIR: BRAIN_DIR, PGLITE_PORT: String(PORTS.pglite) })
  await waitForPort(PORTS.pglite, 'embedded brain')
  console.log('[launch] brain ready.')
} else {
  console.log('[launch] DATABASE_URL set — using external Postgres (run migrations separately).')
}

console.log('[launch] starting api (:4000), doc-sync (:8080), app-web (:3003) ...')
run('api', 'pnpm', ['--filter', '@sidanclaw/api-open', 'exec', 'tsx', 'src/index.ts'])
run('doc-sync', 'pnpm', ['--filter', '@sidanclaw/doc-sync', 'exec', 'tsx', 'src/index.ts'],
  { PORT: String(PORTS.docSync) })
run('app-web', 'pnpm', ['--filter', 'app-web', 'dev'])

await waitForPort(PORTS.appWeb, 'app-web', 120_000)
const entryUrl = `http://localhost:${PORTS.appWeb}/api/auth/dev-login`
console.log(`\n[launch] sidanclaw is up. Opening ${entryUrl}\n  (api :${PORTS.api} · doc-sync :${PORTS.docSync} · app-web :${PORTS.appWeb})\n  Ctrl-C to stop everything.\n`)
openBrowser(entryUrl)
