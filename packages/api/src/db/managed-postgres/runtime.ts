/**
 * [COMP:platform/managed-postgres] Source-owned staged native cluster lifetime.
 * Spec: docs/architecture/platform/database-schema.md → "Managed local
 * PostgreSQL runtime".
 *
 * `startManagedPostgres` selects or creates the profile's one canonical
 * cluster, starts it through the kernel fence, authenticates the instance,
 * claims the lifecycle lease, prepares `brian_owner`/`usebrian`/`app_user`,
 * runs the injected source-owned migration and installation authentication,
 * and only then publishes the canonical pointer. Unrecognized state refuses;
 * it never becomes an empty replacement. Migration, role installation and
 * catalog authentication are injected so this module imports no API runtime.
 *
 * An explicit `transfer` (existing-brain transfer, transfer.ts) lets a
 * non-empty legacy brain proceed: its stage is marked, the injected `admit`
 * must pass before the pointer is published, an unpublished marked stage left
 * by a crash is stopped through the fence and discarded (never admitted), and a
 * refused attempt stops its own server before returning.
 *
 * Autovacuum rule: an unpublished stage runs with autovacuum held off for the
 * whole migration chain, any transfer import, forward step and receiving proof;
 * the hold is lifted before the pointer switch, and a published instance always
 * serves with autovacuum on. Applied migration 8268 compares a registry's
 * complete `pg_class` row, including planner statistics that a concurrent
 * autoanalyze rewrites in place, across its own transaction.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import pg from 'pg'
import { managedPostgresBinaries, verifyManagedPostgresArtifact, type ManagedPostgresArtifact } from './artifact.js'
import { authenticateNativeControl, prepareNativeControl, readNativeDisposition, requestNativeStop } from './control.js'
import { managedClientConfig } from './environment.js'
import { acquireManagedFence, type ManagedFence, type ManagedNativeAction } from './fence.js'
import { authenticateManagedInstance, readControlSystemIdentifier, readManagedPostmaster, type ManagedInstance } from './instance.js'
import type { ManagedClient, ManagedClientConstructor, ManagedQueryable } from './types.js'

export interface ManagedPostgresOptions {
  /** Canonical absolute profile directory (created 0700 when absent). */
  directory: string
  /** Legacy embedded brain; non-empty without a managed pointer refuses. */
  legacyBrainDirectory: string
  artifact: ManagedPostgresArtifact
  Client?: ManagedClientConstructor
  migrate: (ownerUrl: string) => Promise<void>
  prepareRuntimeRole: (client: ManagedQueryable) => Promise<void>
  activateRuntimeRole: (client: ManagedQueryable, options: { password: string }) => Promise<void>
  authenticateInstallation: (client: ManagedQueryable) => Promise<void>
  onOwnershipLost: (error: Error) => void
  onStopPrepared?: (instance: ManagedInstance) => Promise<void>
  onBeforeStopExec?: (instance: ManagedInstance, executor: { executorPid: number | undefined }) => Promise<void>
  onBeforeNativeAction?: (event: { action: ManagedNativeAction; executorPid: number | undefined; stage: string }) => Promise<void>
  /** Existing-brain transfer attempt; absent means a non-empty legacy brain refuses. */
  transfer?: ManagedTransferAttempt
}

/** URLs handed to a transfer admission before publication. */
export interface ManagedAdmissionUrls {
  readonly ownerUrl: string
  readonly appUrl: string
  /** `brian_bootstrap` on the maintenance database (clone/drop a probe database). */
  readonly bootstrapAdminUrl: string
  readonly port: number
}

export interface ManagedTransferAttempt {
  /** Attempt identity recorded in the stage marker. */
  readonly id: string
  /** Receiving proof and admission; throwing withholds publication. */
  readonly admit: (urls: ManagedAdmissionUrls) => Promise<void>
}

const TRANSFER_MARKER = 'transfer-stage.json'

export interface ManagedPostgres {
  readonly id: string
  readonly systemId: string
  readonly instance: ManagedInstance
  readonly port: number
  /** `brian_owner` DSN: migrations and trusted system work (`DATABASE_URL`). */
  readonly ownerUrl: string
  /** `app_user` DSN: RLS-subject runtime (`DATABASE_URL_APP`). */
  readonly appUrl: string
  /** Resolves when lifecycle ownership is lost; the owner must stop serving. */
  readonly ownershipLost: Promise<Error>
  readonly stop: () => Promise<void>
  readonly recoveredInitialization: boolean
}

type Phase = 'allocated' | 'initialized' | 'migrating' | 'ready'
interface ManagedState {
  format: 3
  initializationComplete: boolean
  id: string
  phase: Phase
  artifactManifestSha256: string
  stage: string
  data: string
  bootstrapPassword: string
  ownerPassword: string
  appPassword: string
  systemId?: string
  applicationCreated?: boolean
  runtimePrepared?: boolean
  controlPrepared?: boolean
  interruptedInitializations?: number
  lastInstance?: ManagedInstance
}

const LOCK_CLASS = 2080134311
const ROLE_FLAGS = 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT'
const PHASES: readonly Phase[] = ['allocated', 'initialized', 'migrating', 'ready']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sleep = (ms: number) => new Promise((accept) => setTimeout(accept, ms))
const secret = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const unavailable = (error: unknown) => {
  const e = error as { code?: string; message?: string } | undefined
  return ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', '57P01', '57P02', '57P03'].includes(e?.code ?? '') || e?.message === 'timeout expired'
}
const fatalStart = (error: unknown) => {
  const code = (error as { code?: string } | undefined)?.code
  return code === 'MANAGED_INSTANCE_IDENTITY_CHANGED' || code === 'MANAGED_POSTGRES_ARTIFACT_REFUSED'
}

async function json<T>(path: string): Promise<T> {
  if ((await stat(path)).size > 65536) throw new Error('Managed native state is too large')
  return JSON.parse(await readFile(path, 'utf8')) as T
}
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function lexists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
async function writeExclusive(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(typeof value === 'string' ? value : JSON.stringify(value)); await file.sync() } finally { await file.close() }
}
async function saveState(state: ManagedState): Promise<void> {
  const temporary = join(state.stage, 'state-' + randomUUID() + '.json')
  await writeExclusive(temporary, state)
  await rename(temporary, join(state.stage, 'stage.json'))
  await syncDirectory(state.stage)
}
function databaseUrl(user: string, password: string, port: number, database = 'usebrian'): string {
  const result = new URL(`postgres://127.0.0.1:${port}/${database}`)
  result.username = user
  result.password = password
  return result.href
}
async function connect(Client: ManagedClientConstructor, url: string): Promise<ManagedClient> {
  const client = new Client(managedClientConfig(url))
  try { await client.connect(); return client } catch (error) { await client.end(); throw error }
}
async function using<T>(Client: ManagedClientConstructor, url: string, run: (client: ManagedClient) => Promise<T>): Promise<T> {
  const client = await connect(Client, url)
  try { return await run(client) } finally { await client.end() }
}
/**
 * Hold (false) or lift (true) autovacuum on the stage through the bootstrap
 * lease: ALTER SYSTEM plus a reload, then wait until this session reports the
 * value and, when holding, until no autovacuum worker is still running.
 */
export async function setStageAutovacuum(lease: ManagedQueryable, enabled: boolean, timeoutMs = 30_000): Promise<void> {
  await lease.query(enabled ? 'ALTER SYSTEM RESET autovacuum' : 'ALTER SYSTEM SET autovacuum = off')
  await lease.query('SELECT pg_reload_conf()')
  const want = enabled ? 'on' : 'off'
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = (await lease.query<{ value: string; workers: number }>(
      "SELECT current_setting('autovacuum') AS value,(SELECT count(*)::integer FROM pg_stat_activity WHERE backend_type='autovacuum worker') AS workers")).rows[0]
    if (row?.value === want && (enabled || row.workers === 0)) return
    if (Date.now() >= deadline) throw new Error(`Managed native stage autovacuum did not become ${want}`)
    await sleep(100)
  }
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const address = server.address()
  const value = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((accept, reject) => server.close((error) => (error ? reject(error) : accept())))
  return value
}
async function release(fence: ManagedFence | undefined): Promise<void> {
  if (fence?.held) await fence.release()
}

/** The profile and every parent must already be canonical; no symlink may redirect it. */
export async function canonicalProfile(directory: string): Promise<string> {
  const requested = resolve(directory)
  let ancestor = requested
  while (!(await lexists(ancestor))) ancestor = dirname(ancestor)
  if ((await realpath(ancestor)) !== ancestor) throw new Error('Managed native profile must use a canonical path; symlinked parent refused')
  await mkdir(requested, { recursive: true, mode: 0o700 })
  const profile = await realpath(requested)
  const info = await lstat(profile)
  if (profile !== requested || !info.isDirectory()) throw new Error('Managed native profile must use a canonical path; symlinked parent refused')
  if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error('Managed native profile ownership or permissions are unsafe')
  return profile
}

async function validateState(state: ManagedState, profile: string, artifact: ManagedPostgresArtifact, { published = false } = {}): Promise<void> {
  const clusters = join(profile, 'clusters')
  const validSystem = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
  if (
    state?.format !== 3 || typeof state.id !== 'string' || !UUID.test(state.id) || !PHASES.includes(state.phase) ||
    typeof state.stage !== 'string' || dirname(state.stage) !== clusters || state.data !== join(state.stage, 'data') ||
    state.artifactManifestSha256 !== artifact.manifestSha256 ||
    !(['bootstrapPassword', 'ownerPassword', 'appPassword'] as const).every((key) => secret(state[key]))
  ) throw new Error('Managed native state requires a source-authorized recovery; original data retained')
  if (typeof state.initializationComplete !== 'boolean' || (state.phase !== 'allocated' && state.initializationComplete !== true)) throw new Error('Managed native initialization receipt is missing')
  for (const key of ['applicationCreated', 'runtimePrepared', 'controlPrepared'] as const) {
    if (state[key] !== undefined && typeof state[key] !== 'boolean') throw new Error('Managed native completion flag is invalid')
  }
  if (state.interruptedInitializations !== undefined && (!Number.isInteger(state.interruptedInitializations) || state.interruptedInitializations < 0 || state.interruptedInitializations > 2)) {
    throw new Error('Managed native recovery count is invalid')
  }
  if (state.phase === 'allocated' && (state.systemId !== undefined || state.applicationCreated || state.runtimePrepared || state.controlPrepared)) throw new Error('Managed native allocated phase is invalid')
  if (state.phase !== 'allocated' && !validSystem(state.systemId)) throw new Error('Managed native system identity is missing')
  if (state.phase === 'initialized' && (state.applicationCreated || state.runtimePrepared)) throw new Error('Managed native initialized phase is invalid')
  if ((state.phase === 'migrating' || state.phase === 'ready') && (state.applicationCreated !== true || state.controlPrepared !== true)) throw new Error('Managed native application creation receipt is missing')
  if (state.phase === 'ready' && state.runtimePrepared !== true) throw new Error('Managed native runtime preparation receipt is missing')
  if (published) {
    const last = state.lastInstance
    if (
      state.phase !== 'ready' || !last || last.systemId !== state.systemId || last.dataDirectory !== state.data ||
      !Number.isSafeInteger(last.pid) || last.pid < 1 || typeof last.startedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(last.startedAt) || !Number.isFinite(Date.parse(last.startedAt))
    ) throw new Error('Managed native published identity is incomplete; refusing bootstrap fallback')
  }
  if ((await realpath(state.stage)) !== state.stage || (await json<{ id?: string }>(join(state.stage, 'ownership.json'))).id !== state.id) {
    throw new Error('Managed native stage identity changed')
  }
  if ((await exists(state.data)) && (await realpath(state.data)) !== state.data) throw new Error('Managed native data path was redirected')
}

async function selectState(
  profile: string, legacyBrainDirectory: string, artifact: ManagedPostgresArtifact, transfer?: ManagedTransferAttempt,
): Promise<{ state: ManagedState; published: boolean; recovered: boolean; discard: boolean }> {
  const clusters = join(profile, 'clusters')
  const pointer = join(profile, 'active.json')
  await mkdir(clusters, { recursive: true, mode: 0o700 })
  if ((await realpath(clusters)) !== clusters) throw new Error('Managed native cluster root was redirected')
  if (await exists(pointer)) {
    const state = await json<ManagedState>(pointer)
    await validateState(state, profile, artifact, { published: true })
    return { state, published: true, recovered: false, discard: false }
  }
  // Existing embedded content needs the explicit authenticated transfer. Without
  // it the brain is neither read nor replaced by an empty native brain.
  const legacy = (await exists(legacyBrainDirectory)) && (await readdir(legacyBrainDirectory)).length > 0
  if (legacy && !transfer) {
    throw Object.assign(new Error('managed_native_transfer_required'), { code: 'MANAGED_NATIVE_TRANSFER_REQUIRED' })
  }
  const entries = await readdir(clusters)
  if (entries.length) {
    if (entries.length !== 1 || !entries[0].startsWith('cluster-')) throw new Error('Managed native state exists without its canonical pointer; all clusters retained')
    const stage = join(clusters, entries[0])
    // An unpublished transfer stage was never admitted: it is disposable. Any
    // other unpublished stage keeps the existing refusal and recovery rules.
    const marker = (await exists(join(stage, TRANSFER_MARKER))) ? await json<{ transferId?: unknown }>(join(stage, TRANSFER_MARKER)) : null
    const marked = marker !== null
    if (transfer && legacy && !marked) throw new Error('Managed native state exists without its canonical pointer; all clusters retained')
    if (await exists(join(stage, 'publication-intent.json')) && !marked) throw new Error('Managed native canonical pointer is missing; original cluster retained')
    const state = await json<ManagedState>(join(stage, 'stage.json'))
    await validateState(state, profile, artifact)
    // This attempt's own stage continues; an earlier attempt's stage is discarded.
    return { state, published: false, recovered: !(transfer && marker?.transferId === transfer.id), discard: Boolean(transfer && marked && marker.transferId !== transfer.id) }
  }
  const stage = await mkdtemp(join(clusters, 'cluster-'))
  const state: ManagedState = {
    format: 3,
    initializationComplete: false,
    id: randomUUID(),
    phase: 'allocated',
    artifactManifestSha256: artifact.manifestSha256,
    stage,
    data: join(stage, 'data'),
    bootstrapPassword: randomBytes(32).toString('hex'),
    ownerPassword: randomBytes(32).toString('hex'),
    appPassword: randomBytes(32).toString('hex'),
  }
  await writeExclusive(join(stage, 'ownership.json'), { id: state.id })
  if (transfer && legacy) await writeExclusive(join(stage, TRANSFER_MARKER), { transferId: transfer.id })
  await writeExclusive(join(stage, 'stage.json'), state)
  await syncDirectory(stage)
  await syncDirectory(clusters)
  await syncDirectory(profile)
  return { state, published: false, recovered: false, discard: false }
}

async function ensureApplicationDatabase(Client: ManagedClientConstructor, state: ManagedState, instance: ManagedInstance): Promise<void> {
  await using(Client, databaseUrl('brian_bootstrap', state.bootstrapPassword, instance.port, 'postgres'), async (bootstrap) => {
    const role = (await bootstrap.query<Record<string, boolean>>("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,rolreplication,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships FROM pg_roles WHERE rolname='brian_owner'")).rows[0]
    if (!role) {
      if (state.applicationCreated) throw new Error('Managed native owner is missing; original data retained')
      await bootstrap.query(`CREATE ROLE brian_owner ${ROLE_FLAGS} PASSWORD '${state.ownerPassword}'`)
    } else if (Object.values(role).some(Boolean)) throw new Error('Managed native owner authority changed')
    const db = (await bootstrap.query<{ owned: boolean }>("SELECT datdba=(SELECT oid FROM pg_roles WHERE rolname='brian_owner') AS owned FROM pg_database WHERE datname='usebrian'")).rows[0]
    if (!db) {
      if (state.applicationCreated) throw new Error('Managed native database is missing; refusing empty replacement')
      await bootstrap.query('CREATE DATABASE usebrian OWNER brian_owner')
    } else if (db.owned !== true) throw new Error('Managed native database owner changed')
  })
  state.applicationCreated = true
  state.phase = 'migrating'
  await saveState(state)
}

async function prepareApplication(
  Client: ManagedClientConstructor,
  state: ManagedState,
  instance: ManagedInstance,
  prepareRuntimeRole: ManagedPostgresOptions['prepareRuntimeRole'],
): Promise<{ ownerUrl: string; appUrl: string; bootstrapUrl: string }> {
  const bootstrapUrl = databaseUrl('brian_bootstrap', state.bootstrapPassword, instance.port)
  const ownerUrl = databaseUrl('brian_owner', state.ownerPassword, instance.port)
  if (!state.runtimePrepared) {
    await using(Client, bootstrapUrl, async (bootstrap) => {
      if ((await bootstrap.query<{ present: boolean }>("SELECT to_regclass('public._migrations') IS NOT NULL AS present")).rows[0].present) {
        throw new Error('Managed native preparation receipt is missing; original schema retained')
      }
      const count = (await bootstrap.query<{ n: number }>("SELECT count(*)::integer AS n FROM pg_extension WHERE extname IN ('vector','pg_trgm')")).rows[0].n
      if (count === 0) {
        await bootstrap.query('BEGIN;CREATE ROLE brian_extension_installer SUPERUSER NOLOGIN;SET LOCAL ROLE brian_extension_installer;CREATE EXTENSION pg_trgm WITH SCHEMA public;CREATE EXTENSION vector WITH SCHEMA public;RESET ROLE;REASSIGN OWNED BY brian_extension_installer TO brian_owner;DROP ROLE brian_extension_installer;COMMIT')
      } else if (count !== 2) throw new Error('Managed native extension installation is incomplete')
      await prepareRuntimeRole(bootstrap)
    })
    await using(Client, ownerUrl, prepareRuntimeRole)
    state.runtimePrepared = true
    await saveState(state)
  }
  return { ownerUrl, appUrl: databaseUrl('app_user', state.appPassword, instance.port), bootstrapUrl }
}

/** All native actions are executed inside the source-pinned kernel fence. */
export async function startManagedPostgres(options: ManagedPostgresOptions): Promise<ManagedPostgres> {
  const {
    artifact, migrate, prepareRuntimeRole, activateRuntimeRole, authenticateInstallation, onOwnershipLost,
    onStopPrepared = async () => {}, onBeforeStopExec = async () => {}, onBeforeNativeAction = async () => {}, transfer,
  } = options
  if (transfer !== undefined && (typeof transfer?.id !== 'string' || !UUID.test(transfer.id) || typeof transfer.admit !== 'function')) {
    throw new Error('Managed native transfer requires an attempt identity and admission')
  }
  const Client = options.Client ?? (pg.Client as unknown as ManagedClientConstructor)
  managedPostgresBinaries(artifact)
  if (
    !(['directory', 'legacyBrainDirectory'] as const).every((key) => typeof options[key] === 'string' && isAbsolute(options[key])) ||
    ![migrate, prepareRuntimeRole, activateRuntimeRole, authenticateInstallation, onOwnershipLost, onStopPrepared, onBeforeStopExec, onBeforeNativeAction].every((fn) => typeof fn === 'function')
  ) throw new Error('Managed native startup requires its source-owned installers and supervisor')
  // Every byte is re-authenticated before any native executable is spawned.
  await verifyManagedPostgresArtifact(artifact)
  const profile = await canonicalProfile(options.directory)

  let lease: ManagedClient | undefined
  let fence: ManagedFence | undefined
  let stateFence: ManagedFence | undefined
  let state!: ManagedState
  let instance!: ManagedInstance
  let nativeStartAttempts = 0
  // True only when this call found an unpublished stage left by an earlier one.
  let recoveredInitialization: boolean | undefined
  let published = false
  let discardStage = false
  let closing = false
  let lostAuthority = false
  let stopping: Promise<void> | undefined
  let resolveLoss!: (error: Error) => void
  const ownershipLost = new Promise<Error>((accept) => { resolveLoss = accept })
  const lost = (error: Error) => {
    if (lostAuthority) return
    lostAuthority = true
    if (closing) return
    closing = true
    const reason = new Error('Managed native lifecycle ownership lost', { cause: error })
    resolveLoss(reason)
    onOwnershipLost(reason)
  }
  const acquire = async (stage?: string) => {
    await verifyManagedPostgresArtifact(artifact)
    return acquireManagedFence({ artifact, profile, stage, onLost: lost })
  }
  const nativeRun = async (handle: ManagedFence, action: ManagedNativeAction) => {
    await verifyManagedPostgresArtifact(artifact)
    // Identity is authenticated from pg_control before any server start; a
    // substituted or foreign cluster is refused without launching it.
    if (action.startsWith('START ') && state.systemId && (await readControlSystemIdentifier(state.data)) !== state.systemId) {
      throw Object.assign(new Error('Managed PostgreSQL cluster identity changed before start; original data retained'), { code: 'MANAGED_INSTANCE_IDENTITY_CHANGED' })
    }
    await handle.run(action)
  }
  const closeLease = async () => {
    if (!lease) return
    const current = lease
    lease = undefined
    current.removeAllListeners('end')
    current.removeAllListeners('error')
    current.on('error', () => {})
    await current.end()
  }
  const stop = () => (stopping ??= (async () => {
    closing = true
    if (lostAuthority) { await closeLease(); throw new Error('Managed native ownership was lost; successor authority preserved') }
    let stopFence: ManagedFence | undefined
    try {
      stopFence = await acquire(state.stage)
      if (lostAuthority || !lease) throw new Error('Managed native ownership was lost before stop')
      const current = await authenticateManagedInstance(lease, state.data, state.systemId)
      if (current.pid !== instance.pid || current.startedAt !== instance.startedAt) throw new Error('Managed native stop instance changed')
      const held = (await lease.query<{ held: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=${LOCK_CLASS}::oid AND objid=1::oid AND objsubid=2 AND granted) AS held`)).rows[0].held
      if (!held) throw new Error('Managed native stop lease is missing')
      await requestNativeStop(lease, instance, randomUUID())
      await onStopPrepared(Object.freeze({ ...instance }))
      if (lostAuthority || !stopFence.held) throw new Error('Managed native stop lost its authority; disposition retained')
      const final = await authenticateManagedInstance(lease, state.data, state.systemId)
      if (final.pid !== instance.pid || final.startedAt !== instance.startedAt || lostAuthority) throw new Error('Managed native stop identity changed')
      await onBeforeStopExec(Object.freeze({ ...instance }), Object.freeze({ executorPid: stopFence.pid }))
      if (lostAuthority || !stopFence.held) throw new Error('Managed native stop lost authority before its fenced executor')
      // The executor retains the same kernel lock while execing pg_ctl. A
      // successor cannot start a new generation before this action has exited.
      await nativeRun(stopFence, 'STOP')
    } finally {
      await release(stopFence)
      await closeLease()
    }
  })())

  try {
    stateFence = await acquire()
    for (let transition = 0; transition < 12; transition++) {
      if (!stateFence.held || lostAuthority) throw new Error('Managed native state fence was lost')
      const selected = await selectState(profile, resolve(options.legacyBrainDirectory), artifact, transfer)
      state = selected.state
      published = selected.published
      discardStage = selected.discard
      recoveredInitialization ??= selected.recovered
      // A marked transfer stage with no server is removed directly; one with a
      // server is adopted below and stopped through the fence first.
      if (discardStage && (!state.initializationComplete || !(await exists(join(state.data, 'postmaster.pid'))))) {
        await rm(state.stage, { recursive: true, force: true })
        await syncDirectory(join(profile, 'clusters'))
        continue
      }
      fence = await acquire(state.stage)
      if (fence.stageBound !== state.stage || !stateFence.held) throw new Error('Managed native executor stage binding changed')

      if (!state.initializationComplete) {
        if (state.systemId || state.applicationCreated || published) throw new Error('Managed native incomplete initialization has published identity; original data retained')
        if (await exists(join(state.data, 'postmaster.pid'))) throw new Error('Managed native initialization has an active or unknown server; stage retained')
        if ((await exists(state.data)) && (await readdir(state.data)).length) {
          if ((state.interruptedInitializations ?? 0) >= 2) throw new Error('Managed native initialization repeatedly interrupted; all stage data retained')
          await rename(state.data, join(state.stage, 'interrupted-initdb-' + randomUUID()))
          state.interruptedInitializations = (state.interruptedInitializations ?? 0) + 1
          await saveState(state)
        }
        const passwordFile = join(state.stage, 'initdb-password')
        if (await exists(passwordFile)) {
          if ((await readFile(passwordFile, 'utf8')) !== state.bootstrapPassword + '\n') throw new Error('Managed native bootstrap credential file changed')
        } else await writeExclusive(passwordFile, state.bootstrapPassword + '\n')
        await onBeforeNativeAction(Object.freeze({ action: 'INITDB' as const, executorPid: fence.pid, stage: state.stage }))
        if (!fence.held || !stateFence.held) throw new Error('Native initialization lost its source fence')
        await nativeRun(fence, 'INITDB')
        fence = undefined
        state.initializationComplete = true
        await saveState(state)
        continue
      }

      if ((await readFile(join(state.data, 'PG_VERSION'), 'utf8')).trim() !== '18') throw new Error('Managed native data version requires a validated upgrade')
      const passwordFile = join(state.stage, 'initdb-password')
      if (await exists(passwordFile)) {
        if ((await readFile(passwordFile, 'utf8')) !== state.bootstrapPassword + '\n') throw new Error('Managed native staged credentials changed')
        await rm(passwordFile)
        await syncDirectory(state.stage)
      }
      const postmaster = await readManagedPostmaster(state.data)
      if (!postmaster) {
        if (++nativeStartAttempts > 3) throw new Error('Managed native server did not start; original data retained')
        try { await nativeRun(fence, `START ${await availablePort()}`) } catch (error) { if (fatalStart(error) || nativeStartAttempts >= 3) throw error }
        fence = undefined
        continue
      }

      const bootstrapUrl = databaseUrl('brian_bootstrap', state.bootstrapPassword, postmaster.port, 'postgres')
      const deadline = Date.now() + 60_000
      let restartNeeded = false
      for (;;) {
        try {
          lease = await connect(Client, bootstrapUrl)
          instance = await authenticateManagedInstance(lease, state.data, state.systemId)
          break
        } catch (error) {
          await closeLease()
          if (!unavailable(error) || Date.now() >= deadline) throw error
          // A stale PID with no reachable server: only connection-unavailable
          // permits a fenced restart, never a signal to the recorded PID.
          if (nativeStartAttempts < 1) { restartNeeded = true; break }
          await sleep(100)
        }
      }
      if (restartNeeded) {
        nativeStartAttempts++
        try { await nativeRun(fence, `START ${await availablePort()}`) } catch (error) { if (fatalStart(error)) throw error }
        fence = undefined
        continue
      }
      const activeLease = lease!
      await activeLease.query("SET statement_timeout='5s';SET search_path=pg_catalog,pg_temp")
      activeLease.on('error', lost)
      activeLease.on('end', () => lost(new Error('Native lifecycle connection ended')))
      if (!(await activeLease.query<{ claimed: boolean }>(`SELECT pg_try_advisory_lock(${LOCK_CLASS},1) AS claimed`)).rows[0].claimed) {
        closing = true
        throw new Error('Managed native cluster already has an active launcher')
      }
      if ((await readControlSystemIdentifier(state.data)) !== instance.systemId) {
        throw Object.assign(new Error('Managed PostgreSQL control identity differs from the authenticated server'), { code: 'MANAGED_INSTANCE_IDENTITY_CHANGED' })
      }
      if (!state.systemId) {
        state.systemId = instance.systemId
        state.phase = 'initialized'
        await saveState(state)
      }
      const controlExists = (await activeLease.query<{ present: boolean }>("SELECT to_regnamespace('usebrian_native_control') IS NOT NULL AS present")).rows[0].present
      if (!controlExists) {
        if (state.controlPrepared || published) throw new Error('Managed native control state is missing')
        await prepareNativeControl(activeLease, instance)
      }
      await authenticateNativeControl(activeLease)
      state.controlPrepared = true
      await saveState(state)
      const disposition = await readNativeDisposition(activeLease, instance)
      if (disposition.stopping) {
        // A predecessor recorded a stop for this exact instance: finish it
        // before serving rather than adopting a server being stopped.
        closing = true
        await nativeRun(fence, 'STOP')
        fence = undefined
        await closeLease()
        closing = false
        lostAuthority = false
        continue
      }
      if (discardStage) {
        // Crash residue of an unadmitted transfer attempt: stop it through the
        // fence with a durable disposition, remove it, and start over.
        closing = true
        await requestNativeStop(activeLease, instance, randomUUID())
        await nativeRun(fence, 'STOP')
        fence = undefined
        await closeLease()
        closing = false
        lostAuthority = false
        await rm(state.stage, { recursive: true, force: true })
        await syncDirectory(join(profile, 'clusters'))
        continue
      }
      // Unpublished: hold autovacuum for the chain, import and proof. Published:
      // never serve with the hold (an instance left holding it is lifted before serving).
      if (!published) await setStageAutovacuum(activeLease, false)
      else if ((await activeLease.query<{ value: string }>("SELECT current_setting('autovacuum') AS value")).rows[0]?.value !== 'on') await setStageAutovacuum(activeLease, true)
      await ensureApplicationDatabase(Client, state, instance)
      const urls = await prepareApplication(Client, state, instance, prepareRuntimeRole)
      if (published) await using(Client, urls.ownerUrl, authenticateInstallation)
      await migrate(urls.ownerUrl)
      await using(Client, urls.ownerUrl, authenticateInstallation)
      await using(Client, urls.bootstrapUrl, (bootstrap) => activateRuntimeRole(bootstrap, { password: state.appPassword }))
      await using(Client, urls.appUrl, async (app) => {
        const role = (await app.query<Record<string, unknown>>("SELECT session_user,current_user,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,pg_has_role(current_user,'brian_owner','MEMBER') AS owner_member FROM pg_roles WHERE rolname=current_user")).rows[0]
        if (role.session_user !== 'app_user' || role.current_user !== 'app_user' || Object.entries(role).some(([key, value]) => !['session_user', 'current_user'].includes(key) && value)) {
          throw new Error('Managed native application identity is not isolated')
        }
      })
      if (lostAuthority || !fence.held) throw new Error('Managed native authority ended before activation')
      if (!published && transfer) {
        // The transferred brain is published only after its receiving proof and admission.
        await transfer.admit(Object.freeze({
          ownerUrl: urls.ownerUrl, appUrl: urls.appUrl, port: instance.port,
          bootstrapAdminUrl: databaseUrl('brian_bootstrap', state.bootstrapPassword, instance.port, 'postgres'),
        }))
        if (lostAuthority || !fence.held) throw new Error('Managed native authority ended before activation')
      }
      state.phase = 'ready'
      state.lastInstance = { ...instance }
      await saveState(state)
      if (!published) {
        // Lift the stage hold before the pointer switch: the published instance serves with autovacuum on.
        await setStageAutovacuum(activeLease, true)
        const intent = join(state.stage, 'publication-intent.json')
        if (!(await exists(intent))) await writeExclusive(intent, { id: state.id, systemId: state.systemId })
        const descriptor = join(state.stage, 'cluster.json')
        if (!(await exists(descriptor))) await writeExclusive(descriptor, state)
        await syncDirectory(state.stage)
        await syncDirectory(join(profile, 'clusters'))
        await link(descriptor, join(profile, 'active.json'))
        published = true
        await syncDirectory(profile)
      }
      await release(fence)
      fence = undefined
      await release(stateFence)
      stateFence = undefined
      return Object.freeze({
        id: state.id,
        systemId: state.systemId!,
        instance: Object.freeze({ ...instance }),
        port: instance.port,
        ownerUrl: urls.ownerUrl,
        appUrl: urls.appUrl,
        ownershipLost,
        stop,
        recoveredInitialization: recoveredInitialization === true,
      })
    }
    throw new Error('Managed native startup exceeded its bounded recovery transitions')
  } catch (error) {
    closing = true
    try { await release(fence) } finally {
      try { await release(stateFence) } finally {
        // A refused transfer attempt stops its own server; its unpublished
        // stage is discarded by the next attempt and is never served.
        if (transfer && !published && lease && instance && !lostAuthority) await stop().catch(() => closeLease())
        else await closeLease()
      }
    }
    throw error
  }
}
