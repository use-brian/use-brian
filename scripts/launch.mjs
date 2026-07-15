#!/usr/bin/env node
/**
 * One-command local boot for sidanclaw (oss-local-brain-wedge.md §12.7).
 *
 * `pnpm start` — the whole single-player product on ONE GEMINI_API_KEY:
 *   1. load/prompt GEMINI_API_KEY + generate JWT_SECRET, persisted under
 *      ~/.sidanclaw/config.json (nothing else is required).
 *   2. build the workspace packages (turbo-cached; the apps run from source via
 *      tsx / next dev).
 *   3. start the embedded PGLite brain server (pg-wire socket on :54329) and wait
 *      until it accepts connections - it migrates open-schema-v1 on first boot.
 *   4. start the api (:4000), doc-sync sidecar (:8080), app-web (:3003), and
 *      local Discord Gateway connector (:8090), all pointed at the local API;
 *      single-process event buses.
 *   5. open the browser straight into an authenticated session as the local
 *      owner (/auth/local-session auto-provisions one Personal workspace — no
 *      /login, no /teams, no "dev" identity).
 *
 * The Postgres container is the code-identical escape hatch: set DATABASE_URL to
 * a real postgres:// string and the brain server step is skipped.
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, platform, arch, userInfo } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline/promises'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_DIR = join(homedir(), '.sidanclaw')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const BRAIN_DIR = join(CONFIG_DIR, 'brain')

// Load sidanclaw/.env into process.env BEFORE any env read below, so `pnpm
// start` honors it the same way the standalone migrate + doc-sync paths
// already do (both dotenv.config this exact file). Without this the launcher
// only saw real shell vars, so a DATABASE_URL in .env was silently ignored and
// the embedded-vs-external decision (useEmbedded, below) never reacted to it.
// Self-contained (no dotenv dependency at the repo root): shell env always
// wins (we never overwrite an already-set var), full-line and inline `#`
// comments are stripped from unquoted values, and quoted values keep their
// contents verbatim so a DATABASE_URL/password containing `#` survives.
function loadDotEnv(path) {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    if (key in process.env) continue // shell wins; never override an existing var
    let val = m[2]
    const quote = val[0]
    if (quote === '"' || quote === "'") {
      const end = val.indexOf(quote, 1)
      val = end === -1 ? val.slice(1) : val.slice(1, end)
      if (quote === '"') val = val.replace(/\\n/g, '\n')
    } else {
      val = val.replace(/(^|\s)#.*$/, '').trim() // drop inline comment (`#` at start or after space)
    }
    process.env[key] = val
  }
}
loadDotEnv(join(ROOT, '.env'))

// The embedded brain uses a distinctive high port so it never collides with a
// developer's local Postgres on the default 5432 (verified failure mode).
const PORTS = { pglite: 54329, api: 4000, docSync: 8080, appWeb: 3003, discordConnector: 8090 }

// ── config (the only required input is GEMINI_API_KEY) ─────────────
mkdirSync(CONFIG_DIR, { recursive: true })
const config = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {}
let geminiKey = process.env.GEMINI_API_KEY || config.geminiApiKey
// The single-player owner identity — shown in the app, no login. Local config
// is the source of truth; prompt once (default the OS username) and persist.
let ownerName = process.env.SIDANCLAW_OWNER_NAME || config.ownerName
if (!geminiKey || !ownerName) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  if (!geminiKey) {
    geminiKey = (await rl.question('Enter your GEMINI_API_KEY (https://aistudio.google.com/apikey): ')).trim()
    if (!geminiKey) { rl.close(); console.error('A GEMINI_API_KEY is required to boot. Exiting.'); process.exit(1) }
  }
  if (!ownerName) {
    const fallback = (userInfo().username || 'You').trim()
    ownerName = (await rl.question(`What should I call you? [${fallback}]: `)).trim() || fallback
  }
  rl.close()
}
const jwtSecret = config.jwtSecret || randomBytes(32).toString('hex')
// Shared secret for the API <-> doc-sync internal routes (both directions:
// API -> doc-sync `/internal/apply`, and doc-sync -> API `/internal/ingest-page`
// for the auto-on-save brain ingest). Generated + persisted like JWT_SECRET so
// both child processes get the same value; without it the auto-ingest enqueue
// is gated off and the API endpoint refuses.
const docSyncSecret = config.docSyncSecret || randomBytes(32).toString('hex')
// Shared API <-> Discord Gateway bridge secret. The local launcher owns both
// processes, so generate and persist it rather than requiring another setup
// value. An explicit DISCORD_CONNECTOR_SECRET overrides this for an external
// bridge deployment.
const discordConnectorSecret = process.env.DISCORD_CONNECTOR_SECRET || config.discordConnectorSecret || randomBytes(32).toString('hex')
// AES-GCM key that encrypts connector OAuth refresh-tokens / PATs at rest in
// `connector_instance.credentials`. Without it the api boots with a null
// credential key and `/api/connectors/:provider/store-credentials` returns 503,
// so connectors (Google Calendar, GitHub, Notion, ...) can't be connected.
// Base64 of 32 random bytes -- the format `loadChannelCredentialKey` decodes.
// Generated + persisted like the other secrets so it survives restarts.
const channelCredentialKey = config.channelCredentialKey || randomBytes(32).toString('base64')
writeFileSync(
  CONFIG_FILE,
  JSON.stringify({ ...config, geminiApiKey: geminiKey, jwtSecret, docSyncSecret, discordConnectorSecret, channelCredentialKey, ownerName }, null, 2),
)

// External-store escape hatch: a real Postgres URL skips the embedded brain.
const useEmbedded = !process.env.DATABASE_URL
const databaseUrl = process.env.DATABASE_URL || `postgres://localhost:${PORTS.pglite}/postgres`
const useLocalDiscordConnector = !process.env.DISCORD_CONNECTOR_URL

const env = {
  ...process.env,
  NODE_ENV: 'development',
  GEMINI_API_KEY: geminiKey,
  JWT_SECRET: jwtSecret,
  DATABASE_URL: databaseUrl,
  SIDANCLAW_SINGLE_PROCESS: '1',
  // API <-> doc-sync internal auth + the base URL doc-sync POSTs back to for the
  // auto-on-save brain ingest. 127.0.0.1 (not localhost) avoids the IPv6 ::1
  // resolution that the api's IPv4 listener refuses.
  DOC_SYNC_SECRET: docSyncSecret,
  // Encrypts connector credentials at rest (see generation note above).
  CHANNEL_CREDENTIAL_KEY: channelCredentialKey,
  DISCORD_CONNECTOR_URL: process.env.DISCORD_CONNECTOR_URL || `http://127.0.0.1:${PORTS.discordConnector}`,
  DISCORD_CONNECTOR_SECRET: discordConnectorSecret,
  API_INTERNAL_URL: `http://127.0.0.1:${PORTS.api}`,
  // The embedded brain is one PGLite instance with a single shared session;
  // concurrent pool connections clobber its unnamed prepared statement. Force
  // client.ts onto a single serialized connection (see its SINGLE_CONNECTION
  // note + oss-local-brain-wedge.md §12.4). The external-Postgres escape hatch
  // leaves it unset — a real Postgres isolates statements per connection.
  ...(useEmbedded ? { PG_SINGLE_CONNECTION: '1' } : {}),
  // This is the single-player open edition: app-web hides hosted-only surfaces
  // (billing, teammates) and shows the upgrade affordance instead. The flag
  // defaults to the full hosted edition when unset, so only the local launcher
  // opts into 'oss'.
  NEXT_PUBLIC_SIDANCLAW_EDITION: 'oss',
  // Server-side edition mirror (the api gates the local-owner session on this)
  // + the owner's display name, both consumed by /auth/local-session.
  SIDANCLAW_EDITION: 'oss',
  SIDANCLAW_OWNER_NAME: ownerName,
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
// Next 16 defaults to Turbopack, which HARD-REQUIRES the native @next/swc
// binding for this platform (it crashes on boot with "native bindings are not
// available" when only the WASM fallback loaded). That happens when node_modules
// was populated on a different OS/arch and copied over (e.g. a Linux-built tree
// synced to a Mac) rather than freshly `pnpm install`ed here. Detect the missing
// native binding and fall back to Next's webpack mode, which runs on the WASM
// swc bindings. A healthy install keeps Turbopack. Override with SIDANCLAW_WEBPACK.
function nextHasNativeSwc() {
  const a = arch()
  const p = platform()
  const pkgs =
    p === 'linux' ? [`@next/swc-linux-${a}-gnu`, `@next/swc-linux-${a}-musl`]
    : p === 'win32' ? [`@next/swc-win32-${a}-msvc`]
    : [`@next/swc-${p}-${a}`]
  try {
    // pnpm nests the @next/swc-* optional deps under `next`, not where app-web
    // can reach them — resolve relative to next's own package, not app-web's.
    const appReq = createRequire(join(ROOT, 'apps/app-web/package.json'))
    const nextReq = createRequire(appReq.resolve('next/package.json'))
    return pkgs.some((pkg) => {
      try { nextReq.resolve(`${pkg}/package.json`); return true } catch { return false }
    })
  } catch {
    // Can't even resolve `next` — don't second-guess; keep the default (Turbopack).
    return true
  }
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
const forceWebpack = process.env.SIDANCLAW_WEBPACK === '1' || !nextHasNativeSwc()
if (forceWebpack) {
  console.log('[launch] native @next/swc binding for this platform not found — starting app-web with webpack (run `pnpm install` to restore Turbopack).')
  run('app-web', 'pnpm', ['--filter', 'app-web', 'exec', 'next', 'dev', '--webpack', '--port', String(PORTS.appWeb)])
} else {
  run('app-web', 'pnpm', ['--filter', 'app-web', 'dev'])
}

// Wait for BOTH the api (:4000) and app-web (:3003) before opening the browser.
// The entry URL immediately proxies to the api's /auth/local-session, and the
// api binds its port only after its workers + tool registry finish booting
// (well after app-web's ~200ms dev-server start). Waiting on app-web alone
// raced that startup and 500'd local-session with ECONNREFUSED.
await Promise.all([
  waitForPort(PORTS.api, 'api', 120_000),
  waitForPort(PORTS.appWeb, 'app-web', 120_000),
])
if (useLocalDiscordConnector) {
  console.log(`[launch] starting Discord Gateway connector (:${PORTS.discordConnector}) ...`)
  run('discord-connector', 'pnpm', ['--filter', '@sidanclaw/discord-connector', 'exec', 'tsx', 'src/index.ts'], {
    PORT: String(PORTS.discordConnector),
    SIDANCLAW_API_URL: `http://127.0.0.1:${PORTS.api}`,
  })
  await waitForPort(PORTS.discordConnector, 'Discord Gateway connector')
}
const entryUrl = `http://localhost:${PORTS.appWeb}/api/auth/local-session`
const discordStatus = useLocalDiscordConnector ? ` · discord :${PORTS.discordConnector}` : ' · discord external'
console.log(`\n[launch] sidanclaw is up. Opening ${entryUrl}\n  (api :${PORTS.api} · doc-sync :${PORTS.docSync} · app-web :${PORTS.appWeb}${discordStatus})\n  Ctrl-C to stop everything.\n`)
openBrowser(entryUrl)
