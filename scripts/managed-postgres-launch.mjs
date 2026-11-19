/**
 * [COMP:platform/managed-postgres-launch] Local database branch selection and
 * the managed PostgreSQL child for `scripts/launch.mjs`.
 * Spec: docs/architecture/platform/deployment.md → "Local database runtime".
 *
 * Kept out of launch.mjs because the launcher boots the product on import;
 * these functions are unit-tested in scripts/__tests__/managed-postgres-launch.test.mjs.
 *
 *   DATABASE_URL set                            → external (unchanged)
 *   USEBRIAN_LOCAL_DATABASE unset | embedded    → embedded PGlite (default)
 *   USEBRIAN_LOCAL_DATABASE=managed-postgres    → managed native PostgreSQL
 *
 * The managed branch is explicit and isolated. It never falls back to PGlite.
 * An existing embedded brain is transferred only when the user also sets
 * USEBRIAN_MANAGED_POSTGRES_TRANSFER=1 (existing-brain transfer,
 * portable-brain-restore.md); otherwise it refuses with
 * MANAGED_NATIVE_TRANSFER_REQUIRED and the brain is not touched.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MANAGED_POSTGRES_SELECTION = 'managed-postgres'
/** Platforms with a release pin in packages/api/src/db/managed-postgres/release.ts. */
export const MANAGED_POSTGRES_QUALIFIED_PLATFORMS = Object.freeze(['darwin-arm64'])
const SERVER_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']

/** libpq client input (`PGHOST`, `PGOPTIONS`, ...); `PG_...` product settings are not. */
export function isLibpqEnvironmentKey(key) {
  return /^PG[A-Z][A-Z0-9_]*$/.test(key)
}

/**
 * Decide the local database branch before any child starts. Throws an
 * actionable error for an unknown or conflicting explicit choice.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ platform: string, arch: string }} host
 */
export function resolveLocalDatabaseSelection(env, { platform, arch }) {
  const requested = (env.USEBRIAN_LOCAL_DATABASE ?? '').trim()
  const external = Boolean(env.DATABASE_URL)
  if (requested && requested !== 'embedded' && requested !== MANAGED_POSTGRES_SELECTION) {
    throw new Error(`USEBRIAN_LOCAL_DATABASE must be "embedded" or "${MANAGED_POSTGRES_SELECTION}" (got "${requested}")`)
  }
  if (requested !== MANAGED_POSTGRES_SELECTION) return external ? { kind: 'external' } : { kind: 'embedded' }
  if (external) throw new Error(`USEBRIAN_LOCAL_DATABASE=${MANAGED_POSTGRES_SELECTION} conflicts with DATABASE_URL; choose one database`)
  if (!MANAGED_POSTGRES_QUALIFIED_PLATFORMS.includes(`${platform}-${arch}`)) {
    throw new Error(`Managed local PostgreSQL is not qualified on ${platform}-${arch}; unset USEBRIAN_LOCAL_DATABASE to keep the embedded brain`)
  }
  const artifactDirectory = env.USEBRIAN_MANAGED_POSTGRES_ARTIFACT?.trim()
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) {
    throw new Error('USEBRIAN_MANAGED_POSTGRES_ARTIFACT must be the absolute path of the installed managed PostgreSQL artifact')
  }
  const transfer = (env.USEBRIAN_MANAGED_POSTGRES_TRANSFER ?? '').trim()
  if (transfer && transfer !== '0' && transfer !== '1') {
    throw new Error(`USEBRIAN_MANAGED_POSTGRES_TRANSFER must be "1" to transfer an existing embedded brain, or unset (got "${transfer}")`)
  }
  return { kind: MANAGED_POSTGRES_SELECTION, artifactDirectory, transfer: transfer === '1' }
}

/**
 * Point API/doc-sync children at the managed cluster: owner DSN for system
 * work, `app_user` DSN for RLS-subject work. An inherited
 * `PG_SINGLE_CONNECTION=1` would alias the app pool to the owner pool, and
 * ambient libpq variables would alter sessions, so both are removed.
 * Mutates and returns `env`.
 * @param {Record<string, string | undefined>} env
 * @param {{ ownerUrl: string, appUrl: string }} urls
 */
export function applyManagedDatabaseEnv(env, { ownerUrl, appUrl }) {
  if (typeof ownerUrl !== 'string' || typeof appUrl !== 'string' || ownerUrl === appUrl) throw new Error('Managed PostgreSQL requires distinct owner and application DSNs')
  for (const key of Object.keys(env)) if (isLibpqEnvironmentKey(key) || key === 'PG_SINGLE_CONNECTION') delete env[key]
  env.DATABASE_URL = ownerUrl
  env.DATABASE_URL_APP = appUrl
  return env
}

/** The managed child gets OS essentials only: no DSNs, preload flags or libpq input. */
export function managedServerEnvironment(source) {
  const result = {}
  for (const key of SERVER_ENV_KEYS) if (typeof source[key] === 'string') result[key] = source[key]
  return result
}

/**
 * Spawn the composition entry and wait for its authenticated ready message.
 * Resolves `{ urls, port, systemId, id, pid, stop(timeoutMs) }`; DSNs are held
 * only in memory and passed to child environments, never logged.
 * Rejects with the child's error code (for example
 * `MANAGED_NATIVE_TRANSFER_REQUIRED`, or `MANAGED_NATIVE_TRANSFER_REFUSED`
 * when an explicit transfer refused before its pointer switch) when startup refuses.
 */
export function startManagedLocalDatabase({
  root,
  profileDirectory,
  legacyBrainDirectory,
  artifactDirectory,
  transfer = false,
  env = process.env,
  onExit = () => {},
  readyTimeoutMs = 20 * 60_000,
  stdio = 'inherit',
}) {
  const apiDirectory = join(root, 'packages/api')
  const loader = createRequire(join(apiDirectory, 'package.json')).resolve('tsx')
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(loader).href, join(apiDirectory, 'scripts/managed-postgres-server.ts'), JSON.stringify({ profileDirectory, legacyBrainDirectory, artifactDirectory, ...(transfer === true ? { transfer: true } : {}) })],
    { cwd: apiDirectory, env: managedServerEnvironment(env), stdio: ['ignore', stdio, stdio, 'ipc'] },
  )
  let ready = false
  let stopRequested = false
  let lostReason = null
  let exitInfo = null
  let resolveExit
  const exited = new Promise((accept) => { resolveExit = accept })
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => {
      if (ready) return
      reject(new Error(`Managed PostgreSQL did not become ready within ${readyTimeoutMs} ms`))
      child.kill('SIGTERM')
    }, readyTimeoutMs)
    child.on('message', (message) => {
      if (message?.type === 'ready' && !ready) {
        ready = true
        clearTimeout(timer)
        const urls = Object.freeze({ ownerUrl: message.ownerUrl, appUrl: message.appUrl })
        accept(Object.freeze({
          urls,
          port: message.port,
          systemId: message.systemId,
          id: message.id,
          pid: child.pid,
          recoveredInitialization: message.recoveredInitialization === true,
          /** Non-secret receipt of the source-compiled installation authentication. */
          installation: message.installation ?? null,
          /** Non-secret existing-brain transfer outcome, or null when none ran. */
          transfer: message.transfer ?? null,
          exited,
          /** Fenced stop; resolves with the child's exit or `{ timedOut: true }`. */
          stop: async (timeoutMs = 20_000) => {
            if (exitInfo) return exitInfo
            stopRequested = true
            if (child.connected) child.send('stop')
            else child.kill('SIGTERM')
            return Promise.race([exited, new Promise((done) => setTimeout(() => done({ timedOut: true }), timeoutMs))])
          },
        }))
      } else if (message?.type === 'failed' && !ready) {
        clearTimeout(timer)
        reject(Object.assign(new Error(message.message), { code: message.code ?? undefined }))
      } else if (message?.type === 'lost') {
        lostReason = message.message
      }
    })
    child.on('error', (error) => { clearTimeout(timer); if (!ready) reject(error) })
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal, lost: lostReason, requested: stopRequested }
      resolveExit(exitInfo)
      if (!ready) {
        clearTimeout(timer)
        reject(new Error(`Managed PostgreSQL exited during startup (${signal ?? code})`))
        return
      }
      onExit(exitInfo)
    })
  })
}
