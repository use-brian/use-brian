/**
 * [COMP:platform/managed-postgres] Composition entry for the managed local
 * PostgreSQL runtime. Spec: docs/architecture/platform/database-schema.md →
 * "Managed local PostgreSQL runtime"; launcher contract:
 * docs/architecture/platform/deployment.md → "Local database runtime".
 *
 * Spawned by `use-brian/scripts/managed-postgres-launch.mjs` as a private IPC
 * child. It supplies the source-owned installers (open migration chain, the
 * canonical `app_user` installer, the source-compiled installation
 * authenticator), starts the cluster, and reports the owner/app DSNs over IPC
 * only. It owns the lifecycle lease for as long as it runs and performs the
 * fenced stop on `stop`, SIGTERM/SIGINT or launcher disconnect.
 *
 * argv[2]: JSON `{ profileDirectory, legacyBrainDirectory, artifactDirectory, transfer? }`.
 *
 * With `transfer: true` (launcher: USEBRIAN_LOCAL_DATABASE=managed-postgres and
 * USEBRIAN_MANAGED_POSTGRES_TRANSFER=1) a non-empty embedded brain is moved by
 * the existing-brain transfer ([COMP:platform/managed-postgres-transfer],
 * portable-brain-restore.md → "Existing-brain transfer"): export of a staged copy
 * at the 8273 cohort, cohort import into the fresh stage before the first later
 * migration, shipped forward migration, receiving proof on a probe clone and
 * admission, then publication and finalization. Any refusal before publication
 * leaves the embedded brain the store (MANAGED_NATIVE_TRANSFER_REFUSED).
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { isLibpqEnvironmentKey, managedClientConfig } from '../src/db/managed-postgres/environment.js'
import { managedPostgresRelease } from '../src/db/managed-postgres/release.js'
import { resolveManagedPostgresArtifact } from '../src/db/managed-postgres/artifact.js'
import { canonicalProfile, startManagedPostgres, type ManagedAdmissionUrls, type ManagedPostgres, type ManagedPostgresOptions } from '../src/db/managed-postgres/runtime.js'
import { discardManagedTransferWork, finalizeManagedTransfer, prepareManagedTransfer, readTransferKey, transferRefusal, treeDigest, type ManagedTransferPlan } from '../src/db/managed-postgres/transfer.js'
import type { ManagedQueryable } from '../src/db/managed-postgres/types.js'
import { runMigrations } from './migrate.js'

/** Non-secret receipt of the last source-compiled installation authentication. */
type InstallationReceipt = { format: number; sourceDefinitionDigest: string; functions: number; localContractDigest: string }
/** Non-secret transfer outcome reported to the launcher. */
type TransferStatus = { transferId: string; phase: string; manifestSha256?: string; receiptPath: string; sidecarPath: string }

type Message =
  | { type: 'ready'; id: string; systemId: string; port: number; ownerUrl: string; appUrl: string; recoveredInitialization: boolean; installation: InstallationReceipt | null; transfer: TransferStatus | null }
  | { type: 'failed'; code: string | null; message: string }
  | { type: 'lost'; message: string }
  | { type: 'stopped' }
  | { type: 'stop-failed'; message: string }

// Ambient libpq input must not reach any session an injected installer opens.
for (const key of Object.keys(process.env)) {
  if (isLibpqEnvironmentKey(key) || key === 'PG_SINGLE_CONNECTION') delete process.env[key]
}

function send(message: Message): Promise<void> {
  return new Promise((accept) => {
    if (!process.send || !process.connected) { accept(); return }
    process.send(message, undefined, {}, () => accept())
  })
}

function parseConfig(raw: string | undefined) {
  const value = JSON.parse(raw ?? 'null') as Record<string, unknown> | null
  const keys = ['profileDirectory', 'legacyBrainDirectory', 'artifactDirectory'] as const
  if (!value || !keys.every((key) => typeof value[key] === 'string' && (value[key] as string).startsWith('/'))) {
    throw Object.assign(new Error('Managed PostgreSQL server requires absolute profile, legacy brain and artifact paths'), { code: 'MANAGED_POSTGRES_CONFIG' })
  }
  if (value.transfer !== undefined && typeof value.transfer !== 'boolean') {
    throw Object.assign(new Error('Managed PostgreSQL transfer selection must be a boolean'), { code: 'MANAGED_POSTGRES_CONFIG' })
  }
  return value as Record<(typeof keys)[number], string> & { transfer?: boolean }
}

let managed: ManagedPostgres | undefined
let exiting: Promise<void> | undefined

function stopAndExit(code: number): Promise<void> {
  return (exiting ??= (async () => {
    let exitCode = code
    if (managed) {
      try { await managed.stop(); await send({ type: 'stopped' }) } catch (error) {
        exitCode = exitCode || 1
        await send({ type: 'stop-failed', message: (error as Error).message })
        console.error('[managed-postgres] stop refused:', (error as Error).message)
      }
    }
    process.exit(exitCode)
  })())
}

async function main() {
  if (!process.send) throw Object.assign(new Error('Managed PostgreSQL server must be started by the launcher over IPC'), { code: 'MANAGED_POSTGRES_CONFIG' })
  const config = parseConfig(process.argv[2])
  const release = managedPostgresRelease()
  if (!release) throw Object.assign(new Error(`Managed PostgreSQL is not qualified on ${process.platform}-${process.arch}`), { code: 'MANAGED_POSTGRES_UNSUPPORTED_PLATFORM' })
  const artifact = await resolveManagedPostgresArtifact(config.artifactDirectory, release.manifestSha256)
  const roles = (await import(new URL('../../../scripts/crm/runtime-role.mjs', import.meta.url).href)) as {
    prepareRuntimeRole: (client: ManagedQueryable) => Promise<void>
    activateRuntimeRole: (client: ManagedQueryable, options: { password: string }) => Promise<void>
  }
  const authentication = (await import(new URL('./conversation-store/installation-release.mjs', import.meta.url).href)) as {
    authenticateConversationInstallation: (client: ManagedQueryable) => Promise<InstallationReceipt>
  }
  let installation: InstallationReceipt | null = null
  const base: ManagedPostgresOptions = {
    directory: config.profileDirectory,
    legacyBrainDirectory: config.legacyBrainDirectory,
    artifact,
    // Open edition only: an inherited MIGRATION_DIRS must not select hosted SQL.
    migrate: async (ownerUrl) => { await runMigrations({ databaseUrl: ownerUrl, migrationDirs: [] }) },
    prepareRuntimeRole: roles.prepareRuntimeRole,
    activateRuntimeRole: roles.activateRuntimeRole,
    authenticateInstallation: async (client) => { installation = await authentication.authenticateConversationInstallation(client) },
    onOwnershipLost: (error) => {
      void send({ type: 'lost', message: error.message }).then(() => process.exit(75))
    },
  }
  let transfer: TransferStatus | null = null
  if (config.transfer) {
    await canonicalProfile(config.profileDirectory)
    const composed = await composeTransfer(config, base, () => installation)
    managed = await startManagedPostgres(composed.options).catch(async (error: Error & { code?: string }) => {
      if (composed.plan.kind !== 'attempt') throw error
      await discardManagedTransferWork(composed.plan.paths)
      if (error.code === 'MANAGED_NATIVE_TRANSFER_REFUSED') throw error
      throw transferRefusal('managed_transfer_target_refused', error.message, error)
    })
    if (composed.plan.kind !== 'none') {
      const finalized = await finalizeManagedTransfer({ journal: composed.journal(), paths: composed.plan.paths, managed: { id: managed.id, systemId: managed.systemId } })
      transfer = { transferId: finalized.id, phase: finalized.phase, manifestSha256: finalized.anchor?.manifestSha256, receiptPath: composed.plan.paths.receipt, sidecarPath: composed.plan.paths.sidecar }
    }
  } else managed = await startManagedPostgres(base)
  await send({
    type: 'ready',
    id: managed.id,
    systemId: managed.systemId,
    port: managed.port,
    ownerUrl: managed.ownerUrl,
    appUrl: managed.appUrl,
    recoveredInitialization: managed.recoveredInitialization,
    installation,
    transfer,
  })
}

type Restore = typeof import('./conversation-store/portable-restore.mjs')
type Embedded = typeof import('./conversation-store/pglite-portable-source.mjs')
const PROBE_DATABASE = 'usebrian_transfer_probe'

/** Wire the injected export, cohort import, forward receipt, receiving proof and admission. */
async function composeTransfer(
  config: { profileDirectory: string; legacyBrainDirectory: string },
  base: ManagedPostgresOptions,
  headAuthentication: () => InstallationReceipt | null,
): Promise<{ plan: ManagedTransferPlan; options: ManagedPostgresOptions; journal: () => Parameters<typeof finalizeManagedTransfer>[0]['journal'] }> {
  const restore = (await import(new URL('./conversation-store/portable-restore.mjs', import.meta.url).href)) as Restore
  const embedded = (await import(new URL('./conversation-store/pglite-portable-source.mjs', import.meta.url).href)) as Embedded
  const plan = await prepareManagedTransfer({
    profile: config.profileDirectory,
    legacyBrainDirectory: config.legacyBrainDirectory,
    exportSource: (input) => embedded.exportEmbeddedBrain(input),
  })
  if (plan.kind !== 'attempt') return { plan, options: base, journal: () => (plan.kind === 'finalize' ? plan.journal : null!) }
  const { paths, journal } = plan
  const anchor = journal.anchor!
  const cohort = embedded.embeddedTransferCohort
  const roster = await embedded.loadCohortRoster()
  const key = await readTransferKey(paths)
  const observations = JSON.parse(await readFile(paths.observations, 'utf8')) as {
    users: string[]; reads: Record<string, { rows: number; sha256: string }>; sessions: { sessionId: string; actorUserId: string }[]
  }
  const exportReceipt = JSON.parse(await readFile(join(paths.archive, 'receipt.json'), 'utf8')) as { transactionHorizon: string }
  let importReceipt: Awaited<ReturnType<Restore['importPortableBrain']>> | null = null
  const owner = async <T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client(managedClientConfig(url) as pg.ClientConfig)
    await client.connect()
    try { return await run(client) } finally { await client.end() }
  }
  const importCohort = async (ownerUrl: string) => {
    await plan.advance('importing')
    importReceipt = await owner(ownerUrl, async (client) => {
      await client.query("SET statement_timeout=0")
      await restore.advanceTransactionHorizon(client, exportReceipt.transactionHorizon)
      return restore.importPortableBrain({
        ownerClient: client, archiveDirectory: paths.archive, key, expectedManifestSha256: anchor.manifestSha256,
        erasureCheckpoint: { path: paths.checkpoint, expectedSha256: anchor.checkpointSha256 },
        roster, releaseThrough: cohort.through, authenticate: embedded.authenticateCohortTarget, extensionTransitions: cohort.extensionTransitions,
      })
    })
    await plan.advance('imported', { importReceiptSha256: importReceipt.receiptSha256 })
  }
  const options: ManagedPostgresOptions = {
    ...base,
    // The cohort import runs on the fresh stage at exactly the cohort ledger,
    // before the first later shipped migration; the runner then continues.
    migrate: async (ownerUrl) => {
      let imported = false
      await runMigrations({
        databaseUrl: ownerUrl, migrationDirs: [],
        beforeApply: async ({ file }) => { if (!imported && file > cohort.through) { await importCohort(ownerUrl); imported = true } },
      })
      if (!imported) await importCohort(ownerUrl)
    },
    transfer: {
      id: journal.id,
      admit: async (urls) => {
        const imported = importReceipt
        if (!imported) throw transferRefusal('managed_transfer_import_missing')
        const authenticated = headAuthentication()
        if (!authenticated) throw transferRefusal('managed_transfer_head_unauthenticated')
        const forward = await owner(urls.ownerUrl, async (client) => {
          await finishReceivingEnvelopeBackfill(client)
          return restore.recordForwardMigration({ ownerClient: client, importReceipt: imported, authentication: authenticated })
        })
        await plan.advance('forwarded', { forwardMigrationSha256: forward.receiptSha256 })
        await plan.advance('receiving')
        const proven = await receivingProof(urls, observations)
        const proof = { status: proven.status, importReceiptSha256: imported.receiptSha256, forwardMigrationSha256: forward.receiptSha256, checks: proven.checks }
        if (proven.status !== 'passed') {
          const failed = proven.checks.filter((check) => !check.passed).map((check) => check.name + (check.detail ? ' ' + check.detail : ''))
          throw transferRefusal('managed_transfer_receiving_proof_failed', failed.slice(0, 5).join('; '))
        }
        // The original must still be the exported bytes, or the copy is stale.
        if ((await treeDigest(config.legacyBrainDirectory)).sha256 !== journal.source.sha256) throw transferRefusal('managed_transfer_source_changed', 'the embedded brain changed after its export; retry the transfer')
        const admission = await owner(urls.ownerUrl, (client) => restore.admitRestoredInstallation({ ownerClient: client, importReceipt: imported, receivingProof: proof, forwardMigration: forward }))
        const receivingProofSha256 = admission.receivingProofSha256
        await plan.advance('admitted', {
          receivingProofSha256,
          admission: { activation: admission.activation, importReceiptSha256: admission.importReceiptSha256, forwardMigrationSha256: forward.receiptSha256,
            receivingProofSha256, localContractDigest: admission.authentication.localContractDigest, checks: proven.checks.length },
        })
      },
    },
  }
  return { plan, options, journal: () => plan.journal }
}

/** Repair the imported roster before the target can serve any protected reads.
 * Each owner call commits one bounded page and a durable cursor. */
async function finishReceivingEnvelopeBackfill(client: pg.Client): Promise<void> {
  const installed = (await client.query<{ installed: boolean }>(`SELECT
    to_regprocedure('public.advance_conversation_envelope_backfill(integer)') IS NOT NULL installed`)).rows[0]?.installed
  if (installed !== true) return
  for (;;) {
    const { done, scanned, busy } = (await client.query<{
      value: { done?: boolean; scanned?: number; busy?: boolean }
    }>('SELECT public.advance_conversation_envelope_backfill($1) AS value', [100])).rows[0]?.value ?? {}
    if (busy || typeof done !== 'boolean' || typeof scanned !== 'number' || !Number.isSafeInteger(scanned)
      || scanned < 0 || scanned > 100 || (!done && scanned === 0))
      throw transferRefusal('managed_transfer_envelope_backfill_unavailable')
    if (done === true) return
  }
}

/** Real-runtime receiving checks on a disposable clone; the clone is always dropped. */
async function receivingProof(urls: ManagedAdmissionUrls, observations: {
  users: string[]; reads: Record<string, { rows: number; sha256: string }>; sessions: { sessionId: string; actorUserId: string }[]
}): Promise<{ status: string; checks: { name: string; passed: boolean; detail?: string }[] }> {
  const admin = new pg.Client(managedClientConfig(urls.bootstrapAdminUrl) as pg.ClientConfig)
  await admin.connect()
  const probe = (url: string) => { const next = new URL(url); next.pathname = '/' + PROBE_DATABASE; return next.href }
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DATABASE} WITH (FORCE)`)
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`CREATE DATABASE ${PROBE_DATABASE} TEMPLATE usebrian OWNER brian_owner`); break } catch (error) {
        // Autovacuum may briefly hold the template; anything else refuses.
        if ((error as { code?: string }).code !== '55006' || attempt >= 50) throw error
        await new Promise((accept) => setTimeout(accept, 200))
      }
    }
    const child = spawn(process.execPath, [...process.execArgv, new URL('./conversation-store/portable-receiving-proof.ts', import.meta.url).pathname], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'C', NODE_ENV: 'production',
        DATABASE_URL: probe(urls.ownerUrl), DATABASE_URL_APP: probe(urls.appUrl) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    const result = await new Promise<{ status: string; checks: { name: string; passed: boolean; detail?: string }[] }>((accept, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('receiving proof timed out')) }, 15 * 60_000)
      child.once('message', (message: { type: string; result?: { status: string; checks: { name: string; passed: boolean; detail?: string }[] }; message?: string }) => {
        clearTimeout(timer)
        if (message.type === 'result' && message.result) accept(message.result)
        else reject(new Error('receiving proof failed: ' + (message.message ?? 'no result')))
      })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`receiving proof exited (${code})`)) })
      child.send({ users: observations.users, sessions: observations.sessions, expectedReads: observations.reads, followUpText: 'Fictional follow-up after the transfer.' })
    })
    await new Promise((accept) => (child.exitCode === null ? child.once('exit', accept) : accept(undefined)))
    return result
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DATABASE} WITH (FORCE)`).catch(() => {})
    await admin.end()
  }
}

process.on('message', (message) => { if (message === 'stop') void stopAndExit(0) })
process.on('disconnect', () => { void stopAndExit(0) })
process.on('SIGTERM', () => { void stopAndExit(0) })
process.on('SIGINT', () => { void stopAndExit(0) })

main().catch(async (error: Error & { code?: string }) => {
  console.error('[managed-postgres] startup refused:', error.message)
  await send({ type: 'failed', code: error.code ?? null, message: error.message })
  process.exit(error.code === 'MANAGED_NATIVE_TRANSFER_REQUIRED' || error.code === 'MANAGED_NATIVE_TRANSFER_REFUSED' ? 78 : 1)
})
