/**
 * Existing-brain transfer control state without native code: opt-in, staged
 * copy, anchors outside the archive, refusal and restart semantics, original
 * byte identity and the sidecar marker. The native two-phase proof lives in
 * transfer.native.test.ts.
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  finalizeManagedTransfer, managedTransferEnabled, prepareManagedTransfer, readTransferJournal, startManagedPostgres, treeDigest,
  type ManagedPostgresArtifact, type ManagedTransferExport,
} from '../index.js'

const temporary: string[] = []
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }) })
async function scratch(prefix: string) {
  const path = await mkdtemp(join(await realpath(tmpdir()), prefix))
  temporary.push(path)
  return path
}
async function legacyBrain(root: string) {
  const brain = join(root, 'brain')
  await mkdir(join(brain, 'base', '1'), { recursive: true })
  await writeFile(join(brain, 'PG_VERSION'), '18\n')
  await writeFile(join(brain, 'base', '1', '1259'), Buffer.from([1, 2, 3, 4]))
  return brain
}
const anchors = { manifestSha256: 'a'.repeat(64), archiveId: 'b'.repeat(32), checkpointSha256: 'c'.repeat(64), records: 2 }
const exporter = (effect: (input: Parameters<ManagedTransferExport>[0]) => Promise<void> = async () => {}): ManagedTransferExport => async (input) => {
  await effect(input)
  await mkdir(input.archiveDirectory, { mode: 0o700 })
  await writeFile(join(input.archiveDirectory, 'manifest.enc'), 'sealed')
  return { ...anchors, release: { through: '8273_conversation_requirement_conversion.sql' }, sourceAuthentication: { functions: 309 }, observations: { users: [], reads: {}, sessions: [] }, observationsSha256: 'd'.repeat(64) }
}

describe('[COMP:platform/managed-postgres-transfer] existing-brain transfer control state', () => {
  it('is opt-in: both the managed branch and the transfer variable are required', () => {
    expect(managedTransferEnabled({})).toBe(false)
    expect(managedTransferEnabled({ USEBRIAN_MANAGED_POSTGRES_TRANSFER: '1' })).toBe(false)
    expect(managedTransferEnabled({ USEBRIAN_LOCAL_DATABASE: 'managed-postgres' })).toBe(false)
    expect(managedTransferEnabled({ USEBRIAN_LOCAL_DATABASE: 'embedded', USEBRIAN_MANAGED_POSTGRES_TRANSFER: '1' })).toBe(false)
    expect(managedTransferEnabled({ USEBRIAN_LOCAL_DATABASE: 'managed-postgres', USEBRIAN_MANAGED_POSTGRES_TRANSFER: 'true' })).toBe(false)
    expect(managedTransferEnabled({ USEBRIAN_LOCAL_DATABASE: 'managed-postgres', USEBRIAN_MANAGED_POSTGRES_TRANSFER: '1' })).toBe(true)
  })

  it('digests a tree by path, mode, size and bytes', async () => {
    const root = await scratch('transfer-digest-')
    const brain = await legacyBrain(root)
    const first = await treeDigest(brain)
    expect(await treeDigest(brain)).toEqual(first)
    await writeFile(join(brain, 'base', '1', '1259'), Buffer.from([1, 2, 3, 5]))
    expect((await treeDigest(brain)).sha256).not.toBe(first.sha256)
  })

  it('exports a staged copy, keeps anchors in control state outside the archive and never touches the original', async () => {
    const root = await scratch('transfer-stage-')
    const brain = await legacyBrain(root)
    const before = await treeDigest(brain)
    let staged = ''
    const plan = await prepareManagedTransfer({
      profile: join(root, 'managed-postgres'), legacyBrainDirectory: brain,
      exportSource: exporter(async (input) => {
        staged = input.sourceDirectory
        expect((await treeDigest(input.sourceDirectory)).sha256).toBe(before.sha256)
        expect(((await stat(input.socketDirectory)).mode & 0o777).toString(8)).toBe('700')
        expect((await stat(join(input.sourceDirectory, '..', 'archive.key'))).size).toBe(32)
      }),
    })
    expect(plan.kind).toBe('attempt')
    if (plan.kind !== 'attempt') return
    expect(plan.journal.phase).toBe('exported')
    expect(plan.journal.anchor).toEqual(anchors)
    const journal = JSON.parse(await readFile(plan.paths.journal, 'utf8'))
    expect(journal.anchor.manifestSha256).toBe(anchors.manifestSha256)
    expect(plan.paths.journal.startsWith(plan.paths.archive)).toBe(false)
    // The engine-opened staged copy is discarded; the original is byte-identical.
    await expect(stat(staged)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await treeDigest(brain)).toEqual(before)
  })

  it('serves a long profile through a short private socket and removes it after export', async () => {
    const root = await scratch('transfer-long-profile-'), brain = await legacyBrain(root)
    const profile = join(root, ...Array.from({ length: 4 }, (_, index) => `long-${index}-${'p'.repeat(45)}`))
    let address = ''
    const before = await treeDigest(brain)
    const plan = await prepareManagedTransfer({ profile, legacyBrainDirectory: brain, exportSource: exporter(async input => {
      address = join(input.socketDirectory, '.s.PGSQL.5432')
      expect(Buffer.byteLength(address)).toBeLessThanOrEqual(100)
      expect(address.startsWith(profile)).toBe(false)
      const server = createServer(client => client.end('fictional transfer'))
      try {
        await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(address, accept) })
        const received = await new Promise<string>((accept, reject) => {
          const client = createConnection(address); let text = ''
          client.on('data', bytes => { text += bytes }); client.once('error', reject); client.once('end', () => accept(text))
        })
        expect(received).toBe('fictional transfer')
      } finally { await new Promise<void>(accept => server.close(() => accept())) }
    }) })
    expect(plan.kind).toBe('attempt')
    await expect(stat(address)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(address, '..'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await treeDigest(brain)).toEqual(before)
  })

  it('does not remove another in-flight transfer socket during unrelated cleanup', async () => {
    const root = await scratch('transfer-socket-isolation-'), brain = await legacyBrain(root)
    let ready!: () => void, release!: () => void, firstDirectory = ''
    const firstReady = new Promise<void>(accept => { ready = accept }), held = new Promise<void>(accept => { release = accept })
    const first = prepareManagedTransfer({ profile: join(root, 'first'), legacyBrainDirectory: brain, exportSource: exporter(async input => {
      firstDirectory = input.socketDirectory; ready(); await held
    }) })
    try {
      await firstReady
      let secondDirectory = ''
      await prepareManagedTransfer({ profile: join(root, 'second'), legacyBrainDirectory: brain, exportSource: exporter(async input => {
        secondDirectory = input.socketDirectory; expect(secondDirectory).not.toBe(firstDirectory)
      }) })
      expect((await stat(firstDirectory)).isDirectory()).toBe(true)
      await expect(stat(secondDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release(); await first }
    await expect(stat(firstDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes the owned socket on export failure and preserves unrelated temp files', async () => {
    const root = await scratch('transfer-socket-refusal-'), brain = await legacyBrain(root)
    const unrelated = join(root, 'unrelated'); await writeFile(unrelated, 'keep')
    let address = ''
    await expect(prepareManagedTransfer({ profile: join(root, 'profile'), legacyBrainDirectory: brain, exportSource: exporter(async input => {
      address = input.socketDirectory; throw new Error('fictional exporter failure')
    }) })).rejects.toMatchObject({ reason: 'managed_transfer_export_refused' })
    await expect(stat(address)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(unrelated, 'utf8')).toBe('keep')
  })

  it.each(['after-marker-open', 'after-marker-partial-write', 'during-export'])('recovers a killed allocation at %s before retrying', async point => {
    const root = await scratch('transfer-socket-crash-'), brain = await legacyBrain(root), profile = join(root, 'profile')
    const script = join(root, 'crash-export.mjs')
    await writeFile(script, `import fs from 'node:fs/promises';import{join,dirname}from'node:path';import{syncBuiltinESMExports}from'node:module';
      const point=${JSON.stringify(point)},profile=${JSON.stringify(profile)},actualOpen=fs.open;
      if(point!=='during-export'){
        fs.open=async(path,...args)=>{const handle=await actualOpen(path,...args);if(String(path).endsWith('/.usebrian-transfer-owner.json')){
          if(point==='after-marker-partial-write'){
            const journal=JSON.parse(await fs.readFile(join(profile,'transfer/journal.json'),'utf8'));
            const pointer=JSON.parse(await fs.readFile(join(profile,'transfer',journal.id,'socket-resource.json'),'utf8'));
            await handle.writeFile(JSON.stringify({...pointer,phase:'ready'}).slice(0,31));await handle.sync();
          }
          process.send({directory:dirname(path)});await new Promise(()=>{});
        }return handle;};syncBuiltinESMExports();
      }
      const{prepareManagedTransfer}=await import(${JSON.stringify(new URL('../transfer.ts', import.meta.url).href)});
      await prepareManagedTransfer({profile:${JSON.stringify(profile)},legacyBrainDirectory:${JSON.stringify(brain)},exportSource:async input=>{
        process.send({directory:input.socketDirectory});await new Promise(()=>{});
      }});`)
    const child = spawn(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    try {
      const directory = await new Promise<string>((accept, reject) => {
        child.once('message', (message: unknown) => {
          const value = message as { directory?: unknown }
          typeof value.directory === 'string' ? accept(value.directory) : reject(new Error('missing socket directory'))
        })
        child.once('error', reject); child.once('exit', code => reject(new Error(`export child exited ${code}`)))
      })
      expect((await stat(directory)).isDirectory()).toBe(true)
      const exited = new Promise<void>(accept => child.once('exit', () => accept()))
      child.kill('SIGKILL'); await exited
      await prepareManagedTransfer({ profile, legacyBrainDirectory: brain, exportSource: exporter() })
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(accept => child.once('exit', () => accept()))
        child.kill('SIGKILL'); await exited
      }
    }
  })

  it('refuses cleanup when the socket ownership marker changes', async () => {
    const root = await scratch('transfer-socket-owner-'), brain = await legacyBrain(root), profile = join(root, 'profile')
    let directory = '', original = ''
    try {
      await expect(prepareManagedTransfer({ profile, legacyBrainDirectory: brain, exportSource: exporter(async input => {
        directory = input.socketDirectory
        const marker = join(directory, '.usebrian-transfer-owner.json')
        original = await readFile(marker, 'utf8')
        const changed = JSON.parse(original); changed.token = '0'.repeat(64)
        await writeFile(marker, JSON.stringify(changed))
        throw new Error('fixture ownership changed')
      }) })).rejects.toMatchObject({ reason: 'managed_transfer_socket_owner_changed' })
      expect((await stat(directory)).isDirectory()).toBe(true)
    } finally {
      if (directory && original) {
        await writeFile(join(directory, '.usebrian-transfer-owner.json'), original)
        await prepareManagedTransfer({ profile, legacyBrainDirectory: brain, exportSource: exporter() })
        await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }
  })

  it('refuses before the switch with the embedded brain unchanged, and restarts from scratch', async () => {
    const root = await scratch('transfer-refuse-')
    const brain = await legacyBrain(root)
    const profile = join(root, 'managed-postgres')
    const before = await treeDigest(brain)
    await expect(prepareManagedTransfer({ profile, legacyBrainDirectory: brain, exportSource: exporter(async () => { throw new Error('engine refused') }) }))
      .rejects.toMatchObject({ code: 'MANAGED_NATIVE_TRANSFER_REFUSED', reason: 'managed_transfer_export_refused' })
    expect((await readTransferJournal(profile))?.phase).toBe('exporting')
    // A concurrent writer to the original during export is a refusal, not a stale copy.
    await expect(prepareManagedTransfer({ profile, legacyBrainDirectory: brain, exportSource: exporter(async () => { await writeFile(join(brain, 'late'), 'x') }) }))
      .rejects.toMatchObject({ reason: 'managed_transfer_source_changed' })
    await rm(join(brain, 'late'))
    expect(await treeDigest(brain)).toEqual(before)
    const plan = await prepareManagedTransfer({ profile, legacyBrainDirectory: brain, exportSource: exporter() })
    expect(plan.kind).toBe('attempt')
    // Only this attempt's work remains next to the journal.
    expect((await readdir(join(profile, 'transfer'))).sort()).toEqual([plan.kind === 'attempt' ? plan.journal.id : '', 'journal.json'].sort())
  })

  it('finalizes an admitted attempt idempotently with a sidecar marker next to the original', async () => {
    const root = await scratch('transfer-final-')
    const brain = await legacyBrain(root)
    const profile = join(root, 'managed-postgres')
    const plan = await prepareManagedTransfer({ profile, legacyBrainDirectory: brain, exportSource: exporter() })
    if (plan.kind !== 'attempt') throw new Error('expected an attempt')
    await expect(finalizeManagedTransfer({ journal: plan.journal, paths: plan.paths, managed: { id: 'm', systemId: '1' } })).rejects.toMatchObject({ reason: 'managed_transfer_not_admitted' })
    await plan.advance('admitted', { importReceiptSha256: 'e'.repeat(64) })
    // A published pointer with an admitted journal is finalized by the next start.
    await writeFile(join(profile, 'active.json'), '{}')
    const next = await prepareManagedTransfer({ profile, legacyBrainDirectory: brain, exportSource: exporter(async () => { throw new Error('must not export again') }) })
    expect(next.kind).toBe('finalize')
    const finalized = await finalizeManagedTransfer({ journal: plan.journal, paths: plan.paths, managed: { id: 'm', systemId: '1' } })
    expect(finalized.phase).toBe('finalized')
    const sidecar = JSON.parse(await readFile(join(root, 'brain.managed-transfer.json'), 'utf8'))
    expect(sidecar).toMatchObject({ transferId: plan.journal.id, archiveManifestSha256: anchors.manifestSha256, originalTreeSha256: plan.journal.source.sha256 })
    expect((await readdir(brain)).sort()).toEqual(['PG_VERSION', 'base'])
    await expect(stat(plan.paths.work)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(plan.paths.receipt, 'utf8'))).toMatchObject({ transferId: plan.journal.id, originalUnchanged: true })
    expect(await finalizeManagedTransfer({ journal: finalized, paths: plan.paths, managed: { id: 'm', systemId: '1' } })).toMatchObject({ phase: 'finalized' })
    expect((await prepareManagedTransfer({ profile, legacyBrainDirectory: brain, exportSource: exporter() })).kind).toBe('none')
  })

  it('refuses a malformed transfer attempt before any native action', async () => {
    const root = await scratch('transfer-options-')
    const artifact = { directory: root, manifestSha256: '0'.repeat(64), files: [], binaries: {} } as unknown as ManagedPostgresArtifact
    await expect(startManagedPostgres({
      directory: join(root, 'p'), legacyBrainDirectory: join(root, 'b'), artifact, migrate: async () => {}, prepareRuntimeRole: async () => {},
      activateRuntimeRole: async () => {}, authenticateInstallation: async () => {}, onOwnershipLost: () => {},
      transfer: { id: 'not-a-uuid', admit: async () => {} },
    })).rejects.toThrow()
  })
})
