/**
 * Two-phase existing-brain transfer proof on a disposable embedded brain.
 * Phase 1 (fixtures/embedded-brain-source.mjs) builds a superuser-owned PGlite
 * brain at 8273 populated through the real API and runtime writers. Phase 2 runs
 * the exact launcher seam (`resolveLocalDatabaseSelection` →
 * `startManagedLocalDatabase` → composition entry) and crashes it at each
 * failure point before proving the completed transfer through the real API with
 * the JWT minted before the transfer: per-table row counts and record digests
 * equal to the embedded source, owner/member sign-in, refresh, stored keys, the
 * current source-bound head authentication and one fixed-20 chat with the registry guard
 * on its witness fast path. Skips without
 * USEBRIAN_MANAGED_POSTGRES_TEST_ARTIFACT. Optional:
 * USEBRIAN_TRANSFER_TEST_PGLITE_TEMPLATE (pristine 8273 brain to copy instead of
 * a 30-minute build) and USEBRIAN_MANAGED_TRANSFER_TEST_RECEIPT (receipt path).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { managedClientConfig, treeDigest, type ManagedPostgresArtifact } from '../index.js'
import { disposeProfiles, nativeArtifactDirectory, nativeEnabled, newProfile, pinnedArtifact, repoRoot } from './native-fixture.js'

const describeNative = nativeEnabled ? describe : describe.skip
const sleep = (ms: number) => new Promise((accept) => setTimeout(accept, ms))
const loader = () => pathToFileURL(createRequire(join(repoRoot, 'apps/api/package.json')).resolve('tsx')).href
const fixture = join(repoRoot, 'packages/api/src/application-platform/__tests__/fixtures/embedded-brain-source.mjs')

type Urls = { ownerUrl: string; appUrl: string }
type Handle = { urls: Urls; port: number; systemId: string; id: string; pid: number; transfer: { transferId: string; phase: string; manifestSha256: string; receiptPath: string; sidecarPath: string } | null
  installation: { functions: number; sourceDefinitionDigest: string; localContractDigest: string } | null; stop: (timeoutMs?: number) => Promise<{ code?: number | null; timedOut?: boolean }> }
type Launch = {
  resolveLocalDatabaseSelection: (env: NodeJS.ProcessEnv, host: { platform: string; arch: string }) => { kind: string; artifactDirectory?: string; transfer?: boolean }
  startManagedLocalDatabase: (options: Record<string, unknown>) => Promise<Handle>
  applyManagedDatabaseEnv: (env: Record<string, string | undefined>, urls: Urls) => Record<string, string | undefined>
}
type SourceState = {
  owner: { userId: string; accessToken: string; refreshToken: string }; member: { userId: string; accessToken: string }; workspaceId: string; sessionId: string; assistantId: string; memberId: string; leaseToken: string
  embedded: { sessionOpen: number; history: number }; texts: { question: string; answer: string }
  providerKey: string; brainKey: { id: string; plaintext: string }; memories: { shared: string; personal: string }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept))
  const { port } = server.address() as { port: number }
  await new Promise<void>((accept) => server.close(() => accept()))
  return port
}
async function waitFor<T>(what: string, probe: () => Promise<T | undefined | null | false>, timeoutMs: number, everyMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe().catch(() => undefined)
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what)
    await sleep(everyMs)
  }
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T
const exists = (path: string) => stat(path).then(() => true, () => false)
type Digests = Record<string, { class: string; rows: number; sha256: string }>
type Roster = { tables: Record<string, { class: string }> }
type Restore = { portableTableDigests: (input: { ownerClient: pg.Client; roster: Roster; sourceProfile?: string }) => Promise<Digests>; loadPortableRoster: () => Promise<Roster> }
type Embedded = {
  loadCohortRoster: () => Promise<Roster>
  openEmbeddedSource: (input: { directory: string; socketDirectory: string }) => Promise<{ connect: () => Promise<pg.Client>; close: () => Promise<void> }>
}
const conversationStore = (file: string) => pathToFileURL(join(repoRoot, 'packages/api/scripts/conversation-store', file)).href
const fileSha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
/** Spawn a fixture receiving phase on the managed DSNs and return its IPC state. */
function fixturePhase(phase: string, urls: Urls, env: Record<string, string>, input: Record<string, unknown>, stdio: number): Promise<Record<string, unknown>> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--import', loader(), fixture, '--phase', phase], {
      cwd: join(repoRoot, 'packages/api'), stdio: ['ignore', stdio, stdio, 'ipc'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'C', DATABASE_URL: urls.ownerUrl, DATABASE_URL_APP: urls.appUrl, ...env },
    })
    child.once('message', (message: { type: string; state?: Record<string, unknown>; message?: string }) => (message.type === 'written' && message.state ? accept(message.state) : reject(new Error(message.message))))
    child.once('exit', (code) => reject(new Error(phase + ' exited ' + code)))
    child.send(input)
  })
}

describeNative('[COMP:platform/managed-postgres-transfer] existing embedded brain → managed PostgreSQL', () => {
  let artifact: ManagedPostgresArtifact
  let launch: Launch
  let configDir = '', profile = '', brain = ''
  let source: SourceState
  let original: Awaited<ReturnType<typeof treeDigest>>
  let sourceDigests: Digests
  const apis: ChildProcess[] = []
  const receipt: Record<string, unknown> = { test: 'transfer.native', started: new Date().toISOString(), matrix: [] as unknown[] }
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
    USEBRIAN_LOCAL_DATABASE: 'managed-postgres', USEBRIAN_MANAGED_POSTGRES_ARTIFACT: nativeArtifactDirectory,
  }
  let log: Awaited<ReturnType<typeof open>>

  const boot = (transfer: boolean) => {
    const selection = launch.resolveLocalDatabaseSelection({ ...env, ...(transfer ? { USEBRIAN_MANAGED_POSTGRES_TRANSFER: '1' } : {}) }, { platform: process.platform, arch: process.arch })
    expect(selection.transfer).toBe(transfer)
    return launch.startManagedLocalDatabase({
      root: repoRoot, profileDirectory: profile, legacyBrainDirectory: brain, artifactDirectory: selection.artifactDirectory,
      transfer: selection.transfer, env, stdio: log.fd,
    })
  }
  const compositionPid = () => {
    const line = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')
      .find((entry) => entry.includes('managed-postgres-server.ts') && entry.includes(profile))
    return line ? Number(line.trim().split(/\s+/)[0]) : undefined
  }
  const journal = () => json<{ id: string; phase: string; anchor?: { manifestSha256: string; checkpointSha256: string } }>(join(profile, 'transfer', 'journal.json'))
  const stage = async (at = profile) => {
    const entries = await readdir(join(at, 'clusters')).catch(() => [] as string[])
    return entries.length === 1 ? join(at, 'clusters', entries[0]) : undefined
  }
  const stageQuery = async <R>(user: 'brian_bootstrap' | 'brian_owner', database: string, text: string, at = profile): Promise<R[]> => {
    const directory = (await stage(at))!
    const state = await json<{ bootstrapPassword: string; ownerPassword: string; data: string }>(join(directory, 'stage.json'))
    const port = Number((await readFile(join(state.data, 'postmaster.pid'), 'utf8')).split('\n')[3])
    const url = new URL(`postgres://127.0.0.1:${port}/${database}`)
    url.username = user
    url.password = user === 'brian_bootstrap' ? state.bootstrapPassword : state.ownerPassword
    // Bounded connect retry: each attempt keeps the managed 1 s connection timeout,
    // retried for up to 15 s, so a loaded host cannot turn a reachable stage into a
    // false failure while an unreachable one still fails promptly and by name.
    const started = Date.now()
    for (let attempt = 1; ; attempt++) {
      const client = new pg.Client(managedClientConfig(url.href))
      try { await client.connect() } catch (error) {
        await client.end().catch(() => {})
        const elapsed = Date.now() - started
        if (elapsed >= 15_000) throw new Error(`stage ${directory} (port ${port}) unreachable after ${attempt} connect attempts in ${elapsed} ms: ${(error as Error).message}`)
        await sleep(250)
        continue
      }
      try { return (await client.query(text)).rows as R[] } finally { await client.end() }
    }
  }

  beforeAll(async () => {
    artifact = await pinnedArtifact()
    launch = (await import(pathToFileURL(join(repoRoot, 'scripts/managed-postgres-launch.mjs')).href)) as Launch
    const root = await newProfile('transfer')
    configDir = join(root, 'config')
    profile = join(configDir, 'managed-postgres')
    brain = join(configDir, 'brain')
    // Phase 1: the embedded source brain, written by the product itself.
    const template = process.env.USEBRIAN_TRANSFER_TEST_PGLITE_TEMPLATE?.trim()
    const started = Date.now()
    await new Promise<void>((accept, reject) => {
      const child = spawn(process.execPath, ['--import', loader(), fixture, '--config', configDir, ...(template ? ['--template', template] : [])],
        { cwd: repoRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'C', USER: process.env.USER }, stdio: 'inherit' })
      child.once('exit', (code) => (code === 0 ? accept() : reject(new Error('embedded source fixture failed ' + code))))
    })
    source = await json<SourceState>(join(configDir, 'source-state.json'))
    original = await treeDigest(brain)
    log = await open(join(root, 'runtime.log'), 'a', 0o600)
    // Independent source side of the equality proof: a byte copy of the brain
    // (never the original) opened by the embedded engine, digested with the
    // archive's canonical form under the reviewed 8273 cohort roster.
    const restore = (await import(conversationStore('portable-restore.mjs'))) as Restore
    const embedded = (await import(conversationStore('pglite-portable-source.mjs'))) as Embedded
    const copy = join(root, 'digest-copy'), socket = await mkdtemp(join(tmpdir(), 'ubdg-'))
    await chmod(socket, 0o700)
    await cp(brain, copy, { recursive: true, errorOnExist: true, preserveTimestamps: true })
    try {
      const served = await embedded.openEmbeddedSource({ directory: copy, socketDirectory: socket })
      try {
        const client = await served.connect()
        try { sourceDigests = await restore.portableTableDigests({ ownerClient: client, roster: await embedded.loadCohortRoster(), sourceProfile: 'embedded-superuser' }) }
        finally { await client.end() }
      } finally { await served.close() }
    } finally { await rm(copy, { recursive: true, force: true }); await rm(socket, { recursive: true, force: true }) }
    expect(await treeDigest(brain)).toEqual(original)
    const populated = Object.entries(sourceDigests).filter(([, digest]) => digest.rows > 0)
    receipt.source = { builtMs: Date.now() - started, fromTemplate: Boolean(template), tree: original, embedded: source.embedded,
      ledger: '8273 cohort, owner postgres (superuser)',
      tables: { roster: Object.keys(sourceDigests).length, populated: populated.length, rows: populated.reduce((n, [, digest]) => n + digest.rows, 0) } }
  }, 3_600_000)

  afterAll(async () => {
    for (const api of apis) if (api.exitCode === null) api.kill('SIGKILL')
    await log?.close()
    const leftovers = await disposeProfiles(artifact)
    receipt.instancesLeftAfterDisposal = leftovers
    receipt.finished = new Date().toISOString()
    const path = process.env.USEBRIAN_MANAGED_TRANSFER_TEST_RECEIPT?.trim()
    if (path) await writeFile(path, JSON.stringify(receipt, null, 2) + '\n')
    expect(leftovers).toEqual([])
  }, 600_000)

  it('refuses by default and never reads the embedded brain', async () => {
    await expect(boot(false)).rejects.toMatchObject({ code: 'MANAGED_NATIVE_TRANSFER_REQUIRED' })
    expect(await treeDigest(brain)).toEqual(original)
    expect(await exists(join(profile, 'active.json'))).toBe(false)
    expect(await exists(join(profile, 'transfer'))).toBe(false)
  }, 300_000)

  it('crashes before the switch leave the embedded brain the store, unchanged, and leave no admitted half-state', async () => {
    const cases: { name: string; when: () => Promise<boolean>; after: () => Promise<Record<string, unknown>> }[] = [
      {
        name: 'before-import',
        when: async () => (await journal()).phase === 'exported',
        after: async () => ({ phase: (await journal()).phase }),
      },
      {
        name: 'during-import',
        // The cohort import's transaction holds an xid on the stage database.
        when: async () => (await journal()).phase === 'importing' && (await stageQuery<{ n: number }>('brian_bootstrap', 'postgres',
          "SELECT count(*)::int n FROM pg_stat_activity WHERE datname='usebrian' AND application_name='usebrian-managed-postgres' AND backend_xid IS NOT NULL AND query NOT ILIKE '%pg_current_xact_id%'"))[0].n > 0,
        after: async () => {
          // The killed client's transaction rolls back: nothing imported is committed.
          await waitFor('import rollback', async () => (await stageQuery<{ n: number }>('brian_bootstrap', 'postgres',
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname='usebrian' AND backend_xid IS NOT NULL"))[0].n === 0, 60_000)
          const committed = (await stageQuery<{ sessions: number; workspaces: number }>('brian_owner', 'usebrian',
            'SELECT (SELECT count(*) FROM sessions)::int sessions,(SELECT count(*) FROM workspaces)::int workspaces'))[0]
          expect(committed).toEqual({ sessions: 0, workspaces: 0 })
          // The unpublished stage imported with autovacuum held off (8268 race rule).
          const autovacuum = (await stageQuery<{ autovacuum: string }>('brian_bootstrap', 'postgres', 'SHOW autovacuum'))[0].autovacuum
          expect(autovacuum).toBe('off')
          return { phase: (await journal()).phase, committedAfterCrash: committed, stageAutovacuum: autovacuum }
        },
      },
      {
        name: 'after-import-before-switch',
        when: async () => (await journal()).phase === 'receiving',
        after: async () => {
          const imported = (await stageQuery<{ sessions: number }>('brian_owner', 'usebrian', 'SELECT count(*)::int sessions FROM sessions WHERE id=\'' + source.sessionId + '\''))[0]
          expect(imported.sessions).toBe(1)
          const autovacuum = (await stageQuery<{ autovacuum: string }>('brian_bootstrap', 'postgres', 'SHOW autovacuum'))[0].autovacuum
          expect(autovacuum).toBe('off')
          return { phase: (await journal()).phase, importedButUnpublished: true, stageAutovacuum: autovacuum }
        },
      },
    ]
    let previousStage: string | undefined
    for (const failure of cases) {
      const started = Date.now()
      const pending = boot(true)
      pending.catch(() => {})
      // A boot that settles before the crash point fails the case at once with its reason.
      await Promise.race([waitFor(failure.name, failure.when, 1_800_000, 50),
        pending.then(() => { throw new Error(failure.name + ': boot completed before the crash point') },
          (error: Error) => { throw new Error(failure.name + ': boot refused before the crash point: ' + error.message) })])
      const pid = await waitFor('composition pid', async () => compositionPid(), 10_000)
      process.kill(pid, 'SIGKILL')
      await expect(pending).rejects.toThrow()
      const current = await stage()
      // An earlier attempt's stage was discarded before this attempt began.
      if (previousStage) expect(current).not.toBe(previousStage)
      previousStage = current
      const detail = await failure.after()
      expect(await exists(join(profile, 'active.json'))).toBe(false)
      expect(await treeDigest(brain)).toEqual(original)
      ;(receipt.matrix as unknown[]).push({ crash: failure.name, ms: Date.now() - started, ...detail, pointerPublished: false, originalUnchanged: true })
    }
  }, 7_200_000)

  it('transfers, switches atomically and preserves identity, sign-in and stored key material', async () => {
    const started = Date.now()
    let handle = await boot(true)
    const transferMs = Date.now() - started
    let stopped = false
    try {
    const finalJournal = await journal()
    expect(handle.transfer).toMatchObject({ phase: 'finalized', transferId: finalJournal.id, manifestSha256: finalJournal.anchor!.manifestSha256 })
    expect(finalJournal.phase).toBe('finalized')
    // Original byte-identical; sidecar next to it; archive and key removed.
    expect(await treeDigest(brain)).toEqual(original)
    const sidecar = await json<Record<string, unknown>>(handle.transfer!.sidecarPath)
    expect(handle.transfer!.sidecarPath).toBe(brain + '.managed-transfer.json')
    expect(sidecar).toMatchObject({ transferId: finalJournal.id, archiveManifestSha256: finalJournal.anchor!.manifestSha256, originalTreeSha256: original.sha256 })
    const transferReceipt = await json<Record<string, unknown>>(handle.transfer!.receiptPath)
    expect(transferReceipt).toMatchObject({ originalUnchanged: true, managed: { id: handle.id, systemId: handle.systemId } })
    expect(await exists(join(profile, 'transfer', finalJournal.id))).toBe(false)

    // Shipped head, ordinary owner, current source authentication.
    const migrationsDir = join(repoRoot, 'packages/api/migrations')
    const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
    const authenticator = (await import(conversationStore('installation-release.mjs'))) as
      { currentReleaseSource: (head: string) => Promise<{ sourceDigest: string; functions: number }>
        authenticateConversationInstallation: (client: pg.Client) => Promise<{ functions: number; sourceDefinitionDigest: string; localContractDigest: string; witnessCurrent: boolean }> }
    const reviewed = await authenticator.currentReleaseSource(files.at(-1)!)
    expect(handle.installation?.functions).toBe(reviewed.functions)
    expect(handle.installation).toMatchObject({ witnessCurrent: true })
    expect(handle.installation?.sourceDefinitionDigest).toBe(reviewed.sourceDigest)
    const owner = new pg.Client(managedClientConfig(handle.urls.ownerUrl))
    await owner.connect()
    let ledger: string[], role: Record<string, unknown>, witness: number, targetDigests: Digests, leaseToken: string | null
    try {
      ledger = (await owner.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name')).rows.map((row) => row.name)
      role = (await owner.query('SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user')).rows[0]
      witness = (await owner.query<{ n: number }>('SELECT count(*)::int n FROM native_turn_contract_witness')).rows[0].n
      leaseToken = (await owner.query<{ t: string | null }>('SELECT last_turn_lease_token::text t FROM sessions WHERE id=$1', [source.sessionId])).rows[0].t
      // Target side of the equality proof, before any request touches the brain.
      const restore = (await import(conversationStore('portable-restore.mjs'))) as Restore
      targetDigests = await restore.portableTableDigests({ ownerClient: owner, roster: await restore.loadPortableRoster() })
    } finally { await owner.end() }
    expect(ledger).toEqual(files)
    // The forward step applied exactly the shipped files after the 8273 cohort.
    expect(ledger.filter((name) => name > '8273_conversation_requirement_conversion.sql')).toEqual(files.filter((name) => name > '8273_conversation_requirement_conversion.sql'))
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false })
    expect(witness).toBe(1)
    // The released source lease survives the cohort import (8063 stamp suspended as an origin stamp).
    expect(source.leaseToken).toMatch(/^[0-9a-f-]{36}$/)
    expect(leaseToken).toBe(source.leaseToken)
    // The hold was lifted before the switch: the published instance serves with
    // autovacuum on and no ALTER SYSTEM entry for it remains.
    const published = (await stageQuery<{ autovacuum: string; entries: number }>('brian_bootstrap', 'postgres',
      "SELECT current_setting('autovacuum') AS autovacuum,(SELECT count(*)::int FROM pg_file_settings WHERE name='autovacuum') AS entries"))[0]
    expect(published).toEqual({ autovacuum: 'on', entries: 0 })
    receipt.publishedAutovacuum = published
    const chain = {
      count: files.length, head: files.at(-1), ledgerSha256: sha(ledger.join('\n')),
      vectorSha256: sha((await Promise.all(files.map(async (name) => name + ':' + (await fileSha(join(migrationsDir, name)))))).join('\n')),
      m8274: await fileSha(join(migrationsDir, '8274_inputtable_executable_contracts.sql')),
      m8275: await fileSha(join(migrationsDir, '8275_joint_native_preparation_acquisition.sql')),
      m8276: await fileSha(join(migrationsDir, '8276_registry_guard_successor.sql')),
      m8277: await fileSha(join(migrationsDir, '8277_durable_turn_completions.sql')),
      m8278: await fileSha(join(migrationsDir, '8278_page_closure_adapter.sql')),
      m8280: await fileSha(join(migrationsDir, '8280_query_domain_visibility.sql')),
    }
    // Every roster table: durable and rebound facts equal the embedded source
    // exactly (rows and record digest); installation-derived tables are the
    // target's own; the 8276 witness and the 8277 completion header exist only on
    // the target (the header is created empty by the forward migration).
    const tables = Object.keys(targetDigests)
    expect(tables.filter((name) => !sourceDigests[name]).sort()).toEqual([
      'conversation_envelope_backfill_checkpoint', 'conversation_envelopes', 'conversation_legacy_history_enrollments',
      'conversation_message_quarantine', 'conversation_participants', 'conversation_settings_transitions',
      'conversation_visibility_audit', 'conversation_visibility_notices', 'native_turn_completions', 'native_turn_contract_witness',
    ])
    expect(Object.keys(sourceDigests).filter((name) => !targetDigests[name])).toEqual([])
    expect(targetDigests.native_turn_completions).toMatchObject({ class: 'durable', rows: 0 })
    const facts = tables.filter((name) => sourceDigests[name] && ['durable', 'rebound'].includes(targetDigests[name].class))
    const mismatched = facts.filter((name) => sourceDigests[name].rows !== targetDigests[name].rows || sourceDigests[name].sha256 !== targetDigests[name].sha256)
    expect(mismatched).toEqual([])
    const populatedFacts = facts.filter((name) => targetDigests[name].rows > 0)
    for (const name of ['users', 'auth_sessions', 'workspaces', 'workspace_members', 'sessions', 'session_messages', 'memories', 'brain_keys']) expect(populatedFacts).toContain(name)
    // 8285 retired FORCE RLS on these: the cohort source and import use the system policy path,
    // the head target is read as owner. Each holds product-written rows, equal on both sides.
    const retiredForce = ['page_link_aliases', 'realtime_thread_targets', 'task_candidates', 'task_rules', 'task_tombstones', 'workspace_brand_versions', 'workspace_brands', 'workspace_link_aliases']
    for (const name of retiredForce) {
      expect(sourceDigests[name].rows, name).toBeGreaterThan(0)
      expect(targetDigests[name]).toMatchObject({ rows: sourceDigests[name].rows, sha256: sourceDigests[name].sha256 })
    }
    receipt.retiredForceRls = { writers: (source as unknown as { forcedTables?: unknown }).forcedTables ?? null,
      tables: Object.fromEntries(retiredForce.map((name) => [name, { source: sourceDigests[name], target: targetDigests[name] }])) }
    const equality = {
      tables: tables.length, compared: facts.length, equal: facts.length - mismatched.length, populated: populatedFacts.length,
      rows: populatedFacts.reduce((n, name) => n + targetDigests[name].rows, 0),
      populatedTables: Object.fromEntries(populatedFacts.map((name) => [name, { rows: targetDigests[name].rows, sha256: targetDigests[name].sha256 }])),
      derived: Object.fromEntries(tables.filter((name) => !facts.includes(name)).map((name) => [name, { class: targetDigests[name].class, sourceRows: sourceDigests[name]?.rows ?? null, targetRows: targetDigests[name].rows }])),
    }
    receipt.proven = { installation: handle.installation, chain, equality, ownerRole: role, witnessRows: witness }

    let observerBootstrapUrl: string | undefined
    const observerFile = process.env.USEBRIAN_MANAGED_TRANSFER_SQL_OBSERVER?.trim()
    if (observerFile) {
      const observer = await json<{ artifactManifestSha256: string; postgresSha256: string; module: string; moduleSha256: string; externalShare: string }>(observerFile)
      expect(await fileSha(join(nativeArtifactDirectory, 'manifest.json'))).toBe(observer.artifactManifestSha256)
      expect(await fileSha(join(nativeArtifactDirectory, 'bin/postgres'))).toBe(observer.postgresSha256)
      expect(await fileSha(observer.module)).toBe(observer.moduleSha256)
      for (const path of [observer.module, observer.externalShare]) expect(path).toMatch(/^\/[a-zA-Z0-9_/.@-]+$/)
      const identity = [handle.id, handle.systemId]
      // Only this owned fixture configuration changes. No release artifact file
      // or product role grant changes; the exact same managed brain restarts.
      for (const statement of [
        `ALTER SYSTEM SET shared_preload_libraries='${observer.module}'`,
        "ALTER SYSTEM SET pg_stat_statements.track='all'",
        'ALTER SYSTEM SET pg_stat_statements.max=100000',
        `ALTER SYSTEM SET extension_control_path='${observer.externalShare}:$system'`,
      ]) await stageQuery('brian_bootstrap', 'postgres', statement)
      expect((await handle.stop()).code).toBe(0)
      handle = await boot(false)
      expect([handle.id, handle.systemId]).toEqual(identity)
      expect(handle.transfer).toBeNull()
      await stageQuery('brian_bootstrap', 'usebrian', 'CREATE EXTENSION pg_stat_statements')
      const actual = (await stageQuery('brian_bootstrap', 'usebrian', `SELECT version(),current_setting('shared_preload_libraries') AS preload,
       current_setting('extension_control_path') AS control_path,current_setting('pg_stat_statements.track') AS track`))[0]
      const directory = (await stage())!
      const state = await json<{ bootstrapPassword: string }>(join(directory, 'stage.json'))
      const url = new URL(handle.urls.ownerUrl);url.username = 'brian_bootstrap';url.password = state.bootstrapPassword
      observerBootstrapUrl = url.href
      receipt.nestedObserver = { ...observer, actual,
        scope: 'External measurement-only preload after completed transfer; measures transferred fixed20 HTTP turn, not transfer export/import/publication work',
        configuredAt: new Date().toISOString(), rolesUnchanged: role,
        artifactManifestUnchanged: await fileSha(join(nativeArtifactDirectory, 'manifest.json')) === observer.artifactManifestSha256 }
    }

    // The JWT minted on the embedded brain opens the same workspace chat, now with history.
    const config = await json<{ jwtSecret: string; llmProviderKeyEncryptionKey: string }>(join(configDir, 'config.json'))
    const apiPort = await freePort(), apiUrl = `http://127.0.0.1:${apiPort}`
    const apiEnv = launch.applyManagedDatabaseEnv({
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, NODE_ENV: 'development', USEBRIAN_EDITION: 'oss',
      USEBRIAN_OWNER_NAME: 'Fixture Owner', JWT_SECRET: config.jwtSecret, LLM_PROVIDER_KEY_ENCRYPTION_KEY: config.llmProviderKeyEncryptionKey,
      USEBRIAN_SINGLE_PROCESS: '1', LOCAL_FILES_DIR: join(configDir, 'files'), PORT: String(apiPort), API_URL: apiUrl, APP_URL: 'http://127.0.0.1:9', PUBLIC_API_URL: '',
    }, handle.urls)
    const api = spawn(process.execPath, ['--import', loader(), join(repoRoot, 'apps/api/src/index.ts'), '--admin-only', '--no-workers'],
      { cwd: configDir, env: apiEnv as NodeJS.ProcessEnv, stdio: ['ignore', log.fd, log.fd] })
    apis.push(api)
    const authed = (path: string) => fetch(apiUrl + path, { headers: { authorization: 'Bearer ' + source.owner.accessToken } })
    await waitFor('API on the managed brain', async () => {
      if (api.exitCode !== null) throw new Error('API exited during boot')
      return (await authed('/api/workspaces')).status === 200
    }, 240_000, 1000)
    const opened = await authed('/api/sessions/' + source.sessionId)
    expect(opened.status).toBe(200)
    const body = (await opened.json()) as { id?: string }
    expect(body.id).toBe(source.sessionId)
    const history = await authed('/api/sessions/' + source.sessionId + '/messages')
    const historyText = await history.text()
    expect(history.status).toBe(200)
    expect(historyText).toContain(source.texts.question)
    expect(historyText).toContain(source.texts.answer)
    expect([401, 403, 404]).toContain((await fetch(apiUrl + '/api/sessions/' + source.sessionId)).status)
    // The owner's pre-transfer refresh token renews the same device.
    const refreshed = await fetch(apiUrl + '/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: source.owner.refreshToken }) })
    expect(refreshed.status).toBe(200)
    const renewed = (await refreshed.json()) as { accessToken?: string }
    expect(typeof renewed.accessToken).toBe('string')
    expect((await fetch(apiUrl + '/api/workspaces', { headers: { authorization: 'Bearer ' + renewed.accessToken } })).status).toBe(200)
    // The member's own device sign-in, minted on the embedded brain, still works.
    const memberWorkspaces = await fetch(apiUrl + '/api/workspaces', { headers: { authorization: 'Bearer ' + source.member.accessToken } })
    expect(memberWorkspaces.status).toBe(200)
    const listed = (await memberWorkspaces.json()) as Array<{ id: string }> | { workspaces: Array<{ id: string }> }
    expect((Array.isArray(listed) ? listed : listed.workspaces).map((workspace) => workspace.id)).toContain(source.workspaceId)
    const tampered = source.member.accessToken.slice(0, -2) + (source.member.accessToken.endsWith('a') ? 'bb' : 'aa')
    expect([401, 403]).toContain((await fetch(apiUrl + '/api/workspaces', { headers: { authorization: 'Bearer ' + tampered } })).status)
    api.kill('SIGTERM')
    await Promise.race([new Promise((accept) => api.once('exit', accept)), sleep(15_000).then(() => api.kill('SIGKILL'))])

    // Stored key material is present and usable through the product stores.
    const keys = await fixturePhase('verify', handle.urls, { LLM_PROVIDER_KEY_ENCRYPTION_KEY: config.llmProviderKeyEncryptionKey },
      { workspaceId: source.workspaceId, providerKey: source.providerKey, brainKey: source.brainKey.plaintext }, log.fd)
    expect(keys).toEqual({ providerKeyMatches: true, brainKeyWorkspace: source.workspaceId, brainKeyScope: 'read', alteredKeyRefused: true })

    // One fixed-20 chat on the transferred conversation, as the pre-transfer
    // owner sign-in. Function statistics are enabled for the two runtime roles by
    // the disposable bootstrap only for this measurement, then reset.
    const trackRoles = (value: 'all' | null) => stageQuery('brian_bootstrap', 'usebrian',
      ['brian_owner', 'app_user'].map((name) => value ? `ALTER ROLE ${name} SET track_functions='${value}'` : `ALTER ROLE ${name} RESET track_functions`).join(';'))
    await trackRoles('all')
    let chat: Record<string, unknown>
    try {
      chat = await fixturePhase('chat', handle.urls, {}, { accessToken: source.owner.accessToken, jwtSecret: config.jwtSecret, sessionId: source.sessionId,
        assistantId: source.assistantId, workspaceId: source.workspaceId, question: source.texts.question,
        ...(observerBootstrapUrl ? { observerBootstrapUrl } : {}) }, log.fd)
    } finally { await trackRoles(null) }
    receipt.chat = chat
    expect(chat).toMatchObject({ status: 200, errorEvent: false, textFrames: 20, receivedExact: true, providerSawTransferredHistory: true, savedReply: true,
      helpersCurrent: { before: true, after: true }, sql: { overflow: { statements: 0, fingerprints: 0, frames: 0 } } })
    expect((chat.sql as { statements: number }).statements).toBeGreaterThan(0)
    if (observerFile) {
      expect(chat.nestedSql).toMatchObject({ measured: true })
      expect((chat.nestedSql as { nested: { calls: number } }).nested.calls).toBeGreaterThan(0)
    }
    const calls = chat.functionCalls as Record<string, number>
    // Every fence ran fresh (guard calls per chat) and took the witness fast
    // path: the full conversion comparator never ran during the chat.
    expect(calls['native_turn_helpers_current()']).toBeGreaterThan(0)
    expect(calls['native_conversation_conversion_contract()']).toBe(0)
    const afterChat = new pg.Client(managedClientConfig(handle.urls.ownerUrl))
    await afterChat.connect()
    let headAfterChat: Awaited<ReturnType<typeof authenticator.authenticateConversationInstallation>>
    try { headAfterChat = await authenticator.authenticateConversationInstallation(afterChat) } finally { await afterChat.end() }
    expect(headAfterChat).toMatchObject({ functions: reviewed.functions, witnessCurrent: true, sourceDefinitionDigest: handle.installation!.sourceDefinitionDigest, localContractDigest: handle.installation!.localContractDigest })

    // Cold restart: same managed brain, no second transfer.
    expect((await handle.stop()).code).toBe(0)
    stopped = true
    const cold = await boot(true)
    expect([cold.id, cold.systemId]).toEqual([handle.id, handle.systemId])
    expect(cold.transfer).toBeNull()
    expect((await journal()).id).toBe(finalJournal.id)
    expect((await cold.stop()).code).toBe(0)
    receipt.transfer = {
      ms: transferMs, transferId: finalJournal.id, anchor: finalJournal.anchor, receipt: transferReceipt, sidecar,
      managed: { id: handle.id, systemId: handle.systemId }, ledger: { applied: ledger.length, last: ledger.at(-1), sha256: sha(ledger.join('\n')) },
      installation: handle.installation, ownerRole: role, witnessRows: witness, chain, equality,
      api: { preTransferJwt: { sessionOpen: 200, history: 200, containsTranscript: true }, embeddedBefore: source.embedded, unauthenticatedRefused: true,
        ownerRefresh: 200, memberSignIn: 200, tamperedMemberTokenRefused: true },
      keys, chat, headAfterChat, coldRestart: { sameIdentity: true, secondTransfer: false },
    }
    } finally { if (!stopped) await handle.stop().catch(() => {}) }
  }, 3_600_000)

  // Loaded-host repetition of fresh transfers (USEBRIAN_TRANSFER_TEST_REPEAT=N):
  // each one samples the stage while it migrates, imports and proves (stage
  // phase 'migrating') and must see autovacuum off, then on once published.
  const repeat = Number(process.env.USEBRIAN_TRANSFER_TEST_REPEAT ?? '0')
  it.skipIf(!(Number.isInteger(repeat) && repeat > 0))('repeats consecutive fresh transfers with autovacuum held off until the switch', async () => {
    const runs: Record<string, unknown>[] = []
    for (let index = 0; index < repeat; index++) {
      const directory = join(configDir, 'repeat-' + index), repeatProfile = join(directory, 'managed-postgres')
      await mkdir(directory)
      const started = Date.now()
      const selection = launch.resolveLocalDatabaseSelection({ ...env, USEBRIAN_MANAGED_POSTGRES_TRANSFER: '1' }, { platform: process.platform, arch: process.arch })
      const pending = launch.startManagedLocalDatabase({ root: repoRoot, profileDirectory: repeatProfile, legacyBrainDirectory: brain,
        artifactDirectory: selection.artifactDirectory, transfer: true, env, stdio: log.fd })
      let settled = false
      pending.then(() => { settled = true }, () => { settled = true })
      const samples: Record<string, number> = {}
      while (!settled) {
        try {
          const directoryOfStage = await stage(repeatProfile)
          const phase = directoryOfStage ? (await json<{ phase: string }>(join(directoryOfStage, 'stage.json'))).phase : undefined
          if (phase === 'migrating') {
            const value = (await stageQuery<{ autovacuum: string }>('brian_bootstrap', 'postgres', 'SHOW autovacuum', repeatProfile))[0].autovacuum
            samples[value] = (samples[value] ?? 0) + 1
          }
        } catch { /* stage not reachable yet */ }
        await sleep(250)
      }
      const handle = await pending
      try {
        expect(handle.transfer).toMatchObject({ phase: 'finalized' })
        const owner = new pg.Client(managedClientConfig(handle.urls.ownerUrl))
        await owner.connect()
        let after: string
        try { after = (await owner.query<{ autovacuum: string }>('SHOW autovacuum')).rows[0].autovacuum } finally { await owner.end() }
        expect(samples.on ?? 0).toBe(0)
        expect(samples.off ?? 0).toBeGreaterThan(0)
        expect(after).toBe('on')
        runs.push({ run: index + 1, ms: Date.now() - started, transferId: handle.transfer!.transferId, migratingSamples: samples, publishedAutovacuum: after,
          functions: handle.installation?.functions, witnessCurrent: (handle.installation as { witnessCurrent?: boolean } | null)?.witnessCurrent })
      } finally { await handle.stop() }
      await rm(directory, { recursive: true, force: true })
      receipt.repeat = runs
    }
    expect(runs).toHaveLength(repeat)
    expect(await treeDigest(brain)).toEqual(original)
  }, Math.max(1, repeat) * 1_200_000)

  it('a crash after the switch restarts on the managed brain without another transfer', async () => {
    const before = await journal()
    const handle = await boot(true)
    expect(handle.transfer).toBeNull()
    process.kill(handle.pid, 'SIGKILL')
    await sleep(500)
    const adopted = await boot(true)
    expect([adopted.id, adopted.systemId, adopted.port]).toEqual([handle.id, handle.systemId, handle.port])
    expect(adopted.transfer).toBeNull()
    expect((await journal())).toMatchObject({ id: before.id, phase: 'finalized' })
    expect(await treeDigest(brain)).toEqual(original)
    expect((await adopted.stop()).code).toBe(0)
    ;(receipt.matrix as unknown[]).push({ crash: 'after-switch', adoptedSamePostmaster: true, secondTransfer: false, originalUnchanged: true })
  }, 1_800_000)
})
