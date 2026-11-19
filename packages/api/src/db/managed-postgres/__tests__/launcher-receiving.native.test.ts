/**
 * Launcher branch → managed PostgreSQL → real API entry → JWT-authenticated
 * chat persistence, on a disposable profile. Uses the exact functions
 * `scripts/launch.mjs` calls (selection, managed child, DSN/env composition),
 * the real composition entry (full open migration chain, canonical `app_user`
 * installer, source-compiled installation authentication) and the real
 * `apps/api/src/index.ts` process (`--admin-only --no-workers`: no provider,
 * dotenv or workers). Skips without USEBRIAN_MANAGED_POSTGRES_TEST_ARTIFACT.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { managedClientConfig, type ManagedPostgresArtifact } from '../index.js'
import { disposeProfiles, nativeArtifactDirectory, nativeEnabled, newProfile, pinnedArtifact, repoRoot } from './native-fixture.js'

const describeNative = nativeEnabled ? describe : describe.skip
const sleep = (ms: number) => new Promise((accept) => setTimeout(accept, ms))

type Urls = { ownerUrl: string; appUrl: string }
type Installation = { format: number; sourceDefinitionDigest: string; functions: number; localContractDigest: string }
type Handle = { urls: Urls; port: number; systemId: string; id: string; pid: number; installation: Installation | null; exited: Promise<unknown>; stop: (timeoutMs?: number) => Promise<{ code?: number | null; timedOut?: boolean }> }
type Launch = {
  resolveLocalDatabaseSelection: (env: NodeJS.ProcessEnv, host: { platform: string; arch: string }) => { kind: string; artifactDirectory?: string }
  startManagedLocalDatabase: (options: Record<string, unknown>) => Promise<Handle>
  applyManagedDatabaseEnv: (env: Record<string, string | undefined>, urls: Urls) => Record<string, string | undefined>
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept))
  const { port } = server.address() as { port: number }
  await new Promise<void>((accept) => server.close(() => accept()))
  return port
}

async function bootstrapQuery<R>(profile: string, port: number, text: string): Promise<R[]> {
  const state = JSON.parse(await readFile(join(profile, 'active.json'), 'utf8')) as { bootstrapPassword: string }
  const url = new URL(`postgres://127.0.0.1:${port}/postgres`)
  url.username = 'brian_bootstrap'
  url.password = state.bootstrapPassword
  const client = new pg.Client(managedClientConfig(url.href))
  await client.connect()
  try { return (await client.query(text)).rows as R[] } finally { await client.end() }
}

describeNative('[COMP:platform/managed-postgres-launch] launcher branch → API on managed PostgreSQL', () => {
  let artifact: ManagedPostgresArtifact
  const apis: ChildProcess[] = []
  beforeAll(async () => { artifact = await pinnedArtifact() })
  afterAll(async () => {
    for (const api of apis) if (api.exitCode === null) api.kill('SIGKILL')
    expect(await disposeProfiles(artifact)).toEqual([])
  }, 300_000)

  it('serves JWT-authenticated chat over owner/app DSNs and keeps it across a launcher crash and a cold restart', async () => {
    const launch = (await import(pathToFileURL(join(repoRoot, 'scripts/managed-postgres-launch.mjs')).href)) as Launch
    const configDir = await newProfile('launcher')
    const profileDirectory = join(configDir, 'managed-postgres')
    const log = await open(join(configDir, 'runtime.log'), 'a', 0o600)
    const inherited: Record<string, string | undefined> = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
      // Inherited state the managed branch must override or drop.
      PG_SINGLE_CONNECTION: '1', PGOPTIONS: '-c usebrian.sentinel=leaked', PGAPPNAME: 'usebrian-sentinel-app',
      USEBRIAN_LOCAL_DATABASE: 'managed-postgres', USEBRIAN_MANAGED_POSTGRES_ARTIFACT: nativeArtifactDirectory,
    }
    const selection = launch.resolveLocalDatabaseSelection(inherited, { platform: process.platform, arch: process.arch })
    // Without USEBRIAN_MANAGED_POSTGRES_TRANSFER the selection never transfers an embedded brain.
    expect(selection).toEqual({ kind: 'managed-postgres', artifactDirectory: nativeArtifactDirectory, transfer: false })
    const boot = () => launch.startManagedLocalDatabase({
      root: repoRoot, profileDirectory, legacyBrainDirectory: join(configDir, 'brain'),
      artifactDirectory: selection.artifactDirectory, env: inherited, stdio: log.fd,
    })

    // Launcher-persisted identity (config.json) shared by every restart.
    const jwtSecret = randomBytes(32).toString('hex')
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ jwtSecret }), { mode: 0o600 })
    const filesDir = join(configDir, 'files')
    await mkdir(filesDir)
    const loader = pathToFileURL(createRequire(join(repoRoot, 'apps/api/package.json')).resolve('tsx')).href
    const apiPort = await freePort()
    const apiUrl = `http://127.0.0.1:${apiPort}`

    async function startApi(urls: Urls) {
      const env = launch.applyManagedDatabaseEnv({
        ...inherited, NODE_ENV: 'development', USEBRIAN_EDITION: 'oss', USEBRIAN_OWNER_NAME: 'Fixture Owner',
        JWT_SECRET: JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')).jwtSecret,
        DATABASE_URL: 'postgres://localhost:54329/postgres', USEBRIAN_SINGLE_PROCESS: '1', LOCAL_FILES_DIR: filesDir,
        PORT: String(apiPort), API_URL: apiUrl, APP_URL: 'http://127.0.0.1:9', PUBLIC_API_URL: '',
      }, urls)
      expect(env.PG_SINGLE_CONNECTION).toBeUndefined()
      expect(Object.keys(env).filter((key) => /^PG[A-Z]/.test(key))).toEqual([])
      expect(new URL(env.DATABASE_URL!).username).toBe('brian_owner')
      expect(new URL(env.DATABASE_URL_APP!).username).toBe('app_user')
      const api = spawn(process.execPath, ['--import', loader, join(repoRoot, 'apps/api/src/index.ts'), '--admin-only', '--no-workers'],
        { cwd: configDir, env: env as NodeJS.ProcessEnv, stdio: ['ignore', log.fd, log.fd] })
      apis.push(api)
      const deadline = Date.now() + 240_000
      for (;;) {
        if (api.exitCode !== null) throw new Error(`API exited during boot (${api.exitCode}); see ${join(configDir, 'runtime.log')}`)
        try {
          const response = await fetch(`${apiUrl}/auth/local-session`, { method: 'POST' })
          if (response.status === 200) return { api, owner: (await response.json()) as { accessToken: string } }
          if (response.status === 403) throw new Error('local-session disabled')
        } catch (error) { if ((error as Error).message === 'local-session disabled') throw error }
        if (Date.now() > deadline) throw new Error('API did not become ready')
        await sleep(1000)
      }
    }
    async function stopApi(api: ChildProcess) {
      if (api.exitCode !== null) return
      api.kill('SIGTERM')
      await Promise.race([new Promise((accept) => api.once('exit', accept)), sleep(15_000).then(() => api.kill('SIGKILL'))])
    }
    const authed = (token: string, path: string, init: RequestInit = {}) =>
      fetch(`${apiUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })

    // First boot: full open chain, authentication, isolated identities.
    const migrationsDir = join(repoRoot, 'packages/api/migrations')
    const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
    const migrationFiles = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
    const migrationVector = async () => createHash('sha256').update((await Promise.all(migrationFiles.map(async (name) => name + ':' + (await sha(join(migrationsDir, name)))))).join('\n')).digest('hex')
    const authenticator = join(repoRoot, 'packages/api/scripts/conversation-store/installation-release.mjs')
    const sourceBefore = { migrations: await migrationVector(), migrationCount: migrationFiles.length, m8274: await sha(join(migrationsDir, '8274_inputtable_executable_contracts.sql')), authenticator: await sha(authenticator) }
    // The expected receipt comes from the current source authenticator, not a literal.
    const current = (await import(pathToFileURL(authenticator).href)) as { currentReleaseSource: (head: string) => Promise<{ sourceDigest: string; functions: number }> }
    const reviewed = await current.currentReleaseSource(migrationFiles.at(-1)!)
    const first = await boot()
    expect(first.installation?.functions).toBe(reviewed.functions)
    expect(first.installation?.sourceDefinitionDigest).toBe(reviewed.sourceDigest)
    const ownerClient = new pg.Client(managedClientConfig(first.urls.ownerUrl))
    await ownerClient.connect()
    const ledger = (await ownerClient.query<{ name: string }>('SELECT name FROM public._migrations ORDER BY name')).rows.map((row) => row.name)
    const ownerRole = (await ownerClient.query<Record<string, unknown>>("SELECT session_user, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, (SELECT datdba = (SELECT oid FROM pg_roles WHERE rolname = session_user) FROM pg_database WHERE datname = current_database()) AS owns_database FROM pg_roles WHERE rolname = session_user")).rows[0]
    await ownerClient.end()
    expect(ledger).toEqual(migrationFiles)
    expect(ledger).toEqual(expect.arrayContaining(['8274_inputtable_executable_contracts.sql', '8275_joint_native_preparation_acquisition.sql', '8276_registry_guard_successor.sql']))
    // 8276 records the registry-guard witness; the head authenticator reports it current.
    expect(first.installation).toMatchObject({ witnessCurrent: true })
    // Superuser-owned installations do not apply 8274: the owner is ordinary.
    expect(ownerRole).toEqual({ session_user: 'brian_owner', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, owns_database: true })
    let { api, owner } = await startApi(first.urls)
    const workspaces = (await (await authed(owner.accessToken, '/api/workspaces')).json()) as Array<{ id: string }> | { workspaces: Array<{ id: string }> }
    const workspaceId = (Array.isArray(workspaces) ? workspaces : workspaces.workspaces)[0]?.id
    expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/)
    const created = await authed(owner.accessToken, '/api/sessions/workspace', { method: 'POST', body: JSON.stringify({ workspaceId }) })
    expect(created.status).toBe(201)
    const sessionId = ((await created.json()) as { id: string }).id
    expect((await authed(owner.accessToken, `/api/sessions/${sessionId}`)).status).toBe(200)
    expect([401, 403, 404]).toContain((await fetch(`${apiUrl}/api/sessions/${sessionId}`)).status)
    const roles = await bootstrapQuery<{ usename: string; application_name: string }>(profileDirectory, first.port,
      "SELECT DISTINCT usename, application_name FROM pg_stat_activity WHERE datname='usebrian' ORDER BY usename")
    const names = roles.map((row) => row.usename)
    expect(names).toContain('brian_owner')
    expect(names).toContain('app_user')
    expect(roles.some((row) => row.application_name === 'usebrian-sentinel-app')).toBe(false)

    // Launcher crash: the managed child dies, the postmaster survives, the next
    // launcher adopts the exact instance and the old JWT still reads the chat.
    await stopApi(api)
    process.kill(first.pid, 'SIGKILL')
    await first.exited
    const adopted = await boot()
    expect([adopted.id, adopted.systemId, adopted.port]).toEqual([first.id, first.systemId, first.port])
    expect(adopted.installation?.localContractDigest).toBe(first.installation?.localContractDigest)
    ;({ api } = await startApi(adopted.urls))
    expect((await authed(owner.accessToken, `/api/sessions/${sessionId}`)).status).toBe(200)
    await stopApi(api)
    expect((await adopted.stop()).code).toBe(0)

    // Cold restart through the fenced stop: same brain, same sign-in.
    const cold = await boot()
    expect([cold.id, cold.systemId]).toEqual([first.id, first.systemId])
    ;({ api } = await startApi(cold.urls))
    const reread = await authed(owner.accessToken, `/api/sessions/${sessionId}`)
    expect(reread.status).toBe(200)
    const body = (await reread.json()) as { id?: string; session?: { id: string } }
    expect(body.id ?? body.session?.id).toBe(sessionId)
    await stopApi(api)
    expect((await cold.stop()).code).toBe(0)
    await log.close()
    const sourceAfter = { migrations: await migrationVector(), migrationCount: migrationFiles.length, m8274: await sha(join(migrationsDir, '8274_inputtable_executable_contracts.sql')), authenticator: await sha(authenticator) }
    expect(sourceAfter).toEqual(sourceBefore)
    const receiptPath = process.env.USEBRIAN_MANAGED_POSTGRES_TEST_RECEIPT?.trim()
    if (receiptPath) {
      await writeFile(receiptPath, JSON.stringify({
        test: 'launcher-receiving.native', finished: new Date().toISOString(), passed: true,
        artifactManifestSha256: artifact.manifestSha256, source: sourceBefore, sourceUnchanged: true,
        ledger: { applied: ledger.length, first: ledger[0], last: ledger.at(-1) },
        installation: first.installation, ownerRole,
        identity: { id: first.id, systemId: first.systemId, firstPort: first.port, adoptedSamePostmaster: true, coldRestartSameIdentity: true },
        chat: { workspaceSession: 'created 201, read 200 with launcher JWT; unauthenticated read refused', survivedLauncherCrash: true, survivedColdRestart: true },
        dsn: { owner: 'brian_owner', app: 'app_user', inheritedSingleConnectionRemoved: true, libpqSentinelRemoved: true, apiSessionsSeen: names },
      }, null, 2))
    }
  }, 1_800_000)

  it('refuses an existing embedded brain through the launcher and leaves it unchanged', async () => {
    const launch = (await import(pathToFileURL(join(repoRoot, 'scripts/managed-postgres-launch.mjs')).href)) as Launch
    const configDir = await newProfile('launcher-legacy')
    const brain = join(configDir, 'brain')
    await mkdir(brain)
    await writeFile(join(brain, 'PG_VERSION'), '17\n')
    await writeFile(join(brain, 'existing'), 'existing brain bytes')
    const log = await open(join(configDir, 'runtime.log'), 'a', 0o600)
    await expect(launch.startManagedLocalDatabase({
      root: repoRoot, profileDirectory: join(configDir, 'managed-postgres'), legacyBrainDirectory: brain,
      artifactDirectory: nativeArtifactDirectory, env: process.env, stdio: log.fd,
    })).rejects.toMatchObject({ code: 'MANAGED_NATIVE_TRANSFER_REQUIRED' })
    await log.close()
    expect((await readdir(brain)).sort()).toEqual(['PG_VERSION', 'existing'])
    expect(await readFile(join(brain, 'existing'), 'utf8')).toBe('existing brain bytes')
  }, 300_000)
})
