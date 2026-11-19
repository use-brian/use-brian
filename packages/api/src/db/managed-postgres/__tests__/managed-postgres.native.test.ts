/**
 * Native lifecycle and install controls against the real release-pinned
 * artifact. Converted from the scratch drivers (initdb recovery, native faults,
 * fence race, install controls). Skips unless USEBRIAN_MANAGED_POSTGRES_TEST_ARTIFACT
 * names an installed artifact; see native-fixture.ts.
 */
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { managedClientConfig, readManagedPostmaster, resolveManagedPostgresArtifact, startManagedPostgres, type ManagedPostgresArtifact } from '../index.js'
import type { ManagedQueryable } from '../types.js'
import { disposeProfiles, fixtureOptions, nativeArtifactDirectory, nativeEnabled, newProfile, pinnedArtifact, runtimeRoles, start, testRoot, track } from './native-fixture.js'

const describeNative = nativeEnabled ? describe : describe.skip
const TIMEOUT = 300_000
const sleep = (ms: number) => new Promise((accept) => setTimeout(accept, ms))
const exists = (path: string) => stat(path).then(() => true, () => false)
type Published = { stage: string; data: string; systemId: string; bootstrapPassword: string; id: string }
const published = async (directory: string) => JSON.parse(await readFile(join(directory, 'active.json'), 'utf8')) as Published

async function sql<R>(url: string, text: string, values?: unknown[]): Promise<R[]> {
  const client = new pg.Client(managedClientConfig(url))
  await client.connect()
  try { return (await client.query(text, values)).rows as R[] } finally { await client.end() }
}
function bootstrapUrl(state: Published, port: number): string {
  const url = new URL(`postgres://127.0.0.1:${port}/postgres`)
  url.username = 'brian_bootstrap'
  url.password = state.bootstrapPassword
  return url.href
}

describeNative('[COMP:platform/managed-postgres] native lifecycle on the release-pinned artifact', () => {
  let artifact: ManagedPostgresArtifact
  beforeAll(async () => { artifact = await pinnedArtifact() })
  afterAll(async () => { expect(await disposeProfiles(artifact)).toEqual([]) }, TIMEOUT)

  it('publishes once with isolated owner/app_user sessions, refuses a second live launcher, and restarts with the same identity', async () => {
    const directory = await newProfile('fresh')
    const options = await fixtureOptions(directory, artifact)
    const first = await start(options)
    expect(first.recoveredInitialization).toBe(false)
    const state = await published(directory)
    expect(state.systemId).toBe(first.systemId)
    expect((await stat(join(directory, 'active.json'))).mode & 0o777).toBe(0o600)

    const [owner] = await sql<Record<string, unknown>>(first.ownerUrl, "SELECT session_user, current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
    expect(owner).toEqual({ session_user: 'brian_owner', current_user: 'brian_owner', rolsuper: false, rolbypassrls: false })
    const [app] = await sql<Record<string, unknown>>(first.appUrl, "SELECT session_user, current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
    expect(app).toEqual({ session_user: 'app_user', current_user: 'app_user', rolsuper: false, rolbypassrls: false })
    await expect(sql(first.appUrl, 'SELECT name FROM public._migrations')).rejects.toThrow(/permission denied/)

    await expect(startManagedPostgres(options)).rejects.toThrow(/already has an active launcher/)
    await first.stop()
    expect(await readManagedPostmaster(state.data)).toBeNull()

    const second = await start(options)
    expect([second.id, second.systemId, second.ownerUrl.replace(/:\d+\//, ':/'), second.appUrl.replace(/:\d+\//, ':/')])
      .toEqual([first.id, first.systemId, first.ownerUrl.replace(/:\d+\//, ':/'), first.appUrl.replace(/:\d+\//, ':/')])
    expect(second.instance.startedAt).not.toBe(first.instance.startedAt)
    await second.stop()
  }, TIMEOUT)

  it('refuses a profile behind a symlinked parent without creating anything there', async () => {
    const real = await newProfile('symlink-real')
    const link = join(await testRoot(), `managed-link-${Date.now()}`)
    await symlink(real, link)
    track(link)
    await expect(startManagedPostgres(await fixtureOptions(join(link, 'profile'), artifact))).rejects.toThrow(/canonical path; symlinked parent refused/)
    expect(await readdir(real)).toEqual([])
  }, TIMEOUT)

  it('refuses an artifact reached through a symlinked parent', async () => {
    const link = join(await testRoot(), `managed-artifact-link-${Date.now()}`)
    await symlink(join(nativeArtifactDirectory, '..'), link)
    track(link)
    await expect(pinnedArtifact(join(link, nativeArtifactDirectory.split('/').pop()!))).rejects.toThrow(/canonical path; symlinked parent refused/)
  }, TIMEOUT)

  it('keeps ambient loader and libpq environment out of native children and runtime sessions', async () => {
    const sentinel: Record<string, string> = {
      PGOPTIONS: '-c usebrian.sentinel=leaked', PGAPPNAME: 'usebrian-sentinel-app', PGDATA: '/nonexistent/sentinel-data',
      PGHOST: '/nonexistent', DYLD_INSERT_LIBRARIES: '/nonexistent/sentinel.dylib', DYLD_LIBRARY_PATH: '/nonexistent/sentinel-lib',
      LD_PRELOAD: '/nonexistent/sentinel.so', USEBRIAN_SENTINEL_VALUE: 'sentinel-value-7f3a',
    }
    const saved = Object.fromEntries(Object.keys(sentinel).map((key) => [key, process.env[key]]))
    Object.assign(process.env, sentinel)
    const observed: Array<{ sentinel: string | null; app: string }> = []
    const probe = async (client: ManagedQueryable) => {
      observed.push((await client.query<{ sentinel: string | null; app: string }>("SELECT current_setting('usebrian.sentinel', true) AS sentinel, current_setting('application_name') AS app")).rows[0])
    }
    const roles = await runtimeRoles()
    try {
      const directory = await newProfile('sentinel')
      const managed = await start(await fixtureOptions(directory, artifact, {
        prepareRuntimeRole: async (client) => { await probe(client); await roles.prepareRuntimeRole(client) },
        authenticateInstallation: probe,
      }))
      const environment = execFileSync('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(managed.instance.pid)], { encoding: 'utf8' })
      await managed.stop()
      expect(Object.entries(sentinel).filter(([key, value]) => environment.includes(`${key}=${value}`)).map(([key]) => key)).toEqual([])
      expect(observed.length).toBeGreaterThanOrEqual(3)
      expect(observed.filter((row) => row.sentinel === 'leaked' || row.app === sentinel.PGAPPNAME)).toEqual([])
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
  }, TIMEOUT)

  it('re-verifies the artifact before any native executable runs', async () => {
    const copyRoot = await mkdtemp(join(await testRoot(), 'managed-artifact-copy-'))
    track(copyRoot)
    execFileSync('/bin/cp', ['-pR', nativeArtifactDirectory, join(copyRoot, 'runtime')])
    const copy = await resolveManagedPostgresArtifact(join(copyRoot, 'runtime'), artifact.manifestSha256)
    await appendFile(join(copyRoot, 'runtime/share/postgresql/postgresql.conf.sample'), '\n# changed after verification\n')
    const directory = await newProfile('tamper')
    await expect(startManagedPostgres(await fixtureOptions(directory, copy))).rejects.toThrow(/artifact file changed: share\/postgresql\/postgresql.conf.sample/)
    expect(await readdir(directory)).toEqual([])
  }, TIMEOUT)

  it('refuses a substituted cluster from pg_control before START and reopens the original', async () => {
    const a = await newProfile('identity-a')
    const b = await newProfile('identity-b')
    const first = await start(await fixtureOptions(a, artifact))
    await first.stop()
    const other = await start(await fixtureOptions(b, artifact))
    expect(other.systemId).not.toBe(first.systemId)
    await other.stop()
    const stateA = await published(a)
    const stateB = await published(b)
    await rename(stateA.data, stateA.data + '-retained')
    await rename(stateB.data, stateA.data)
    const logBefore = await readFile(join(stateA.stage, 'postgres.log'), 'utf8')
    await expect(startManagedPostgres(await fixtureOptions(a, artifact))).rejects.toMatchObject({ code: 'MANAGED_INSTANCE_IDENTITY_CHANGED' })
    expect(await exists(join(stateA.data, 'postmaster.pid'))).toBe(false)
    expect(await readFile(join(stateA.stage, 'postgres.log'), 'utf8')).toBe(logBefore)
    await rename(stateA.data, stateB.data)
    await rename(stateA.data + '-retained', stateA.data)
    const reopened = await start(await fixtureOptions(a, artifact))
    expect(reopened.systemId).toBe(first.systemId)
    await reopened.stop()
  }, TIMEOUT)

  it('refuses an existing embedded brain with no managed pointer and leaves it untouched', async () => {
    const directory = await newProfile('legacy')
    const legacy = join(directory, 'original-pglite')
    await mkdir(legacy)
    await writeFile(join(legacy, 'PG_VERSION'), '17\n')
    await writeFile(join(legacy, 'brain-bytes'), 'existing brain')
    await expect(startManagedPostgres(await fixtureOptions(directory, artifact))).rejects.toMatchObject({ code: 'MANAGED_NATIVE_TRANSFER_REQUIRED' })
    expect(await readFile(join(legacy, 'brain-bytes'), 'utf8')).toBe('existing brain')
    expect((await readdir(legacy)).sort()).toEqual(['PG_VERSION', 'brain-bytes'])
    expect(await exists(join(directory, 'active.json'))).toBe(false)
    expect(await readdir(join(directory, 'clusters'))).toEqual([])
  }, TIMEOUT)

  it('recovers a stale PID after postmaster death only through a fenced restart; the obsolete owner cannot stop the successor', async () => {
    const directory = await newProfile('crash')
    const options = await fixtureOptions(directory, artifact)
    const original = await start(options)
    const state = await published(directory)
    process.kill(original.instance.pid, 'SIGKILL')
    await Promise.race([original.ownershipLost, sleep(10_000).then(() => { throw new Error('postmaster loss was not observed') })])
    await expect(original.stop()).rejects.toThrow(/lost/)
    expect(await exists(join(state.data, 'postmaster.pid'))).toBe(true)
    const successor = await start(options)
    expect(successor.systemId).toBe(original.systemId)
    expect(successor.instance.startedAt).not.toBe(original.instance.startedAt)
    await expect(original.stop()).rejects.toThrow(/lost/)
    await successor.stop()
  }, TIMEOUT)

  it('resumes an initdb killed after PG_VERSION with the same stage, identity and credentials', async () => {
    const directory = await newProfile('initdb')
    let event: { executorPid: number | undefined; stage: string } | undefined
    const attempt = startManagedPostgres(await fixtureOptions(directory, artifact, { onBeforeNativeAction: async (value) => { event = value } }))
    attempt.catch(() => {})
    let injected = false
    for (let i = 0; i < 20_000 && !injected; i++) {
      if (event && (await exists(join(event.stage, 'data/PG_VERSION')))) {
        const command = execFileSync('/bin/ps', ['-p', String(event.executorPid), '-o', 'command='], { encoding: 'utf8' })
        if (command.includes('/bin/initdb')) { process.kill(event.executorPid!, 'SIGKILL'); injected = true }
      }
      if (!injected) await sleep(1)
    }
    expect(injected).toBe(true)
    await expect(attempt).rejects.toThrow()
    const stage = event!.stage
    const interrupted = JSON.parse(await readFile(join(stage, 'stage.json'), 'utf8'))
    expect([interrupted.phase, interrupted.initializationComplete]).toEqual(['allocated', false])
    const recovered = await start(await fixtureOptions(directory, artifact))
    expect(recovered.recoveredInitialization).toBe(true)
    expect(recovered.id).toBe(interrupted.id)
    const final = JSON.parse(await readFile(join(stage, 'stage.json'), 'utf8'))
    expect([final.bootstrapPassword, final.ownerPassword, final.appPassword]).toEqual([interrupted.bootstrapPassword, interrupted.ownerPassword, interrupted.appPassword])
    expect((await readdir(stage)).filter((name) => name.startsWith('interrupted-initdb-'))).toHaveLength(1)
    await recovered.stop()
  }, TIMEOUT)

  it('fences a successor behind an in-flight stop after the old lease is lost, then reconciles the durable stop', async () => {
    const directory = await newProfile('race')
    let reached!: () => void
    let resume!: () => void
    const window = new Promise<void>((accept) => { reached = accept })
    const old = await start(await fixtureOptions(directory, artifact, {
      onBeforeStopExec: async () => { reached(); await new Promise<void>((accept) => { resume = accept }) },
    }))
    const stopping = old.stop()
    stopping.catch(() => {})
    await window
    const state = await published(directory)
    await sql(bootstrapUrl(state, old.port), "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=2080134311::oid AND objid=1::oid AND objsubid=2 AND granted")
    let successorReady = false
    const successor = startManagedPostgres(await fixtureOptions(directory, artifact))
    successor.then(() => { successorReady = true }, () => {})
    await sleep(750)
    expect(successorReady).toBe(false)
    resume()
    await expect(stopping).rejects.toThrow(/authority|lost/)
    const next = await successor
    expect(next.id).toBe(old.id)
    expect(next.instance.startedAt).not.toBe(old.instance.startedAt)
    await next.stop()
  }, TIMEOUT)

  it('refuses a missing pointer, malformed published state and a missing application database without replacing the brain', async () => {
    const directory = await newProfile('faults')
    const options = await fixtureOptions(directory, artifact)
    const original = await start(options)
    const state = await published(directory)
    await original.stop()

    const pointer = await readFile(join(directory, 'active.json'))
    await rename(join(directory, 'active.json'), join(directory, 'held-pointer.json'))
    await expect(startManagedPostgres(options)).rejects.toThrow(/canonical pointer is missing/)
    expect(await readdir(join(directory, 'clusters'))).toHaveLength(1)
    await rename(join(directory, 'held-pointer.json'), join(directory, 'active.json'))

    const malformed = JSON.parse(pointer.toString('utf8'))
    delete malformed.applicationCreated
    await writeFile(join(directory, 'malformed.json'), JSON.stringify(malformed), { mode: 0o600 })
    await rename(join(directory, 'active.json'), join(directory, 'held-pointer.json'))
    await rename(join(directory, 'malformed.json'), join(directory, 'active.json'))
    await expect(startManagedPostgres(options)).rejects.toThrow(/receipt is missing|published identity|bootstrap fallback/)
    expect(await exists(join(state.data, 'postmaster.pid'))).toBe(false)
    await rename(join(directory, 'held-pointer.json'), join(directory, 'active.json'))
    expect(await readFile(join(directory, 'active.json'))).toEqual(pointer)

    const running = await start(options)
    await sql(bootstrapUrl(state, running.port), 'ALTER DATABASE usebrian RENAME TO usebrian_retained')
    await running.stop()
    await expect(startManagedPostgres(options)).rejects.toThrow(/database is missing; refusing empty replacement/)
    const adopted = (await readManagedPostmaster(state.data))!
    await sql(bootstrapUrl(state, adopted.port), 'ALTER DATABASE usebrian_retained RENAME TO usebrian')
    const restored = await start(options)
    expect(restored.systemId).toBe(original.systemId)
    expect(restored.instance.pid).toBe(adopted.pid)
    await restored.stop()
  }, TIMEOUT)
})
