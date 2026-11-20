/**
 * [COMP:platform/managed-postgres-transfer] Existing-brain transfer control state.
 * Spec: docs/architecture/platform/portable-brain-restore.md → "Existing-brain
 * transfer"; docs/architecture/platform/database-schema.md → "Managed local
 * PostgreSQL runtime".
 *
 * A non-empty embedded (PGlite) brain moves to the managed runtime only through a
 * staged, authenticated logical copy: byte copy of the brain → portable export of
 * the copy → fresh managed instance → cohort import → shipped forward migration →
 * receiving proof → admission → atomic pointer publication. The original brain
 * directory is never opened, written or moved; its tree digest is checked before
 * the copy, after the export and again at finalization, and a sidecar marker next
 * to it records the receipt. The archive digest anchors live here, in the managed
 * profile's control state (`<profile>/transfer/journal.json`), never inside the
 * archive. Every attempt before publication is disposable: a crash or refusal
 * leaves the embedded brain the active store and the next attempt starts over.
 *
 * This module owns state, ordering and evidence only. The engine driver, export,
 * import, receiving proof and admission are injected by the composition entry.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const MANAGED_TRANSFER_PHASES = ['exporting', 'exported', 'importing', 'imported', 'forwarded', 'receiving', 'admitted', 'finalized'] as const
export type ManagedTransferPhase = (typeof MANAGED_TRANSFER_PHASES)[number]

/** Both variables are required; the default remains refusal. */
export function managedTransferEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env.USEBRIAN_LOCAL_DATABASE?.trim() === 'managed-postgres' && env.USEBRIAN_MANAGED_POSTGRES_TRANSFER?.trim() === '1'
}

export interface TreeDigest {
  readonly sha256: string
  readonly entries: number
  readonly bytes: number
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Content digest of a directory tree: relative path, kind, mode, size and bytes. */
export async function treeDigest(root: string): Promise<TreeDigest> {
  const lines: string[] = []
  let bytes = 0
  const walk = async (relative: string): Promise<void> => {
    const names = (await readdir(join(root, relative))).sort()
    for (const name of names) {
      const path = relative ? join(relative, name) : name
      const info = await lstat(join(root, path))
      const mode = (info.mode & 0o7777).toString(8)
      if (info.isDirectory()) { lines.push(`d ${path} ${mode}`); await walk(path) }
      else if (info.isSymbolicLink()) lines.push(`l ${path} ${await readlink(join(root, path))}`)
      else if (info.isFile()) { bytes += info.size; lines.push(`f ${path} ${mode} ${info.size} ${await fileSha256(join(root, path))}`) }
      else throw transferRefusal('managed_transfer_source_unsupported', `special file ${path}`)
    }
  }
  await walk('')
  return Object.freeze({ sha256: createHash('sha256').update(lines.join('\n')).digest('hex'), entries: lines.length, bytes })
}

export function transferRefusal(reason: string, detail?: string, cause?: unknown): Error {
  return Object.assign(new Error(`managed_native_transfer_refused: ${reason}${detail ? ` (${detail})` : ''}`, cause ? { cause } : undefined), {
    code: 'MANAGED_NATIVE_TRANSFER_REFUSED', reason,
  })
}

export interface ManagedTransferJournal {
  format: 1
  id: string
  phase: ManagedTransferPhase
  legacyBrainDirectory: string
  startedAt: string
  updatedAt: string
  source: TreeDigest
  /** Independent anchors for the sealed archive and erasure checkpoint. */
  anchor?: { manifestSha256: string; checkpointSha256: string; archiveId: string; records: number }
  release?: { through: string }
  sourceAuthentication?: Record<string, unknown>
  observationsSha256?: string
  importReceiptSha256?: string
  forwardMigrationSha256?: string
  receivingProofSha256?: string
  admission?: Record<string, unknown>
  managed?: { id: string; systemId: string }
  finalizedAt?: string
}

export interface ManagedTransferPaths {
  readonly control: string
  readonly journal: string
  readonly receipt: string
  readonly work: string
  readonly key: string
  readonly archive: string
  readonly checkpoint: string
  readonly observations: string
  readonly sidecar: string
}

export function managedTransferPaths(profile: string, legacyBrainDirectory: string, id: string): ManagedTransferPaths {
  const control = join(profile, 'transfer')
  const work = join(control, id)
  return Object.freeze({
    control, journal: join(control, 'journal.json'), receipt: join(control, 'receipt.json'), work,
    key: join(work, 'archive.key'), archive: join(work, 'archive'), checkpoint: join(work, 'erasure-checkpoint.enc'),
    observations: join(work, 'observations.json'),
    // Next to the embedded brain, never inside it.
    sidecar: join(dirname(legacyBrainDirectory), basename(legacyBrainDirectory) + '.managed-transfer.json'),
  })
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
  await syncDirectory(dirname(path))
}
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

const SOCKET_OWNER = '.usebrian-transfer-owner.json'
const SOCKET_POINTER = 'socket-resource.json'
const SOCKET_FILE = '.s.PGSQL.5432'
type SocketResource = { format: 1; owner: string; directory: string; token: string; phase: 'reserved' | 'initializing' | 'ready'; identity: { device: string; inode: string } | null }
function socketResource(value: unknown, work: string): SocketResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw transferRefusal('managed_transfer_socket_owner_changed')
  const resource = value as Partial<SocketResource>
  if (Object.keys(resource).sort().join(',') !== 'directory,format,identity,owner,phase,token' || resource.format !== 1 || resource.owner !== resolve(work) ||
      typeof resource.directory !== 'string' || typeof resource.token !== 'string' || !/^ubs-[a-f0-9]{24}$/.test(basename(resource.directory)) ||
      !/^[a-f0-9]{64}$/.test(resource.token) || resolve(resource.directory) !== resource.directory || Buffer.byteLength(join(resource.directory, SOCKET_FILE)) > 100) {
    throw transferRefusal('managed_transfer_socket_owner_changed')
  }
  if (!['reserved', 'initializing', 'ready'].includes(resource.phase ?? '') || (resource.phase === 'reserved' ? resource.identity !== null :
    !resource.identity || Object.keys(resource.identity).sort().join(',') !== 'device,inode' || !/^\d+$/.test(resource.identity.device) || !/^\d+$/.test(resource.identity.inode))) throw transferRefusal('managed_transfer_socket_owner_changed')
  return resource as SocketResource
}

/** A short address is required on Darwin even when the profile itself is long. */
async function allocateTransferSocket(work: string): Promise<string> {
  let base = await realpath(tmpdir())
  if (Buffer.byteLength(join(base, `ubs-${'0'.repeat(24)}`, SOCKET_FILE)) > 100) base = await realpath('/tmp')
  const resource: SocketResource = { format: 1, owner: resolve(work), directory: join(base, `ubs-${randomBytes(12).toString('hex')}`), token: randomBytes(32).toString('hex'), phase: 'reserved', identity: null }
  if (Buffer.byteLength(join(resource.directory, SOCKET_FILE)) > 100) throw transferRefusal('managed_transfer_socket_path_unsupported')
  // Persist intent before creating a resource outside the attempt directory, so
  // restart cleanup can find it even if export is interrupted immediately.
  await writeAtomic(join(work, SOCKET_POINTER), resource)
  await mkdir(resource.directory, { mode: 0o700 })
  const created = await lstat(resource.directory, { bigint: true })
  resource.phase = 'initializing'; resource.identity = { device: created.dev.toString(), inode: created.ino.toString() }
  await writeAtomic(join(work, SOCKET_POINTER), resource)
  const ready: SocketResource = { ...resource, phase: 'ready' }
  const marker = await open(join(resource.directory, SOCKET_OWNER), 'wx', 0o600)
  try { await marker.writeFile(JSON.stringify(ready)); await marker.sync() } finally { await marker.close() }
  await syncDirectory(resource.directory)
  await writeAtomic(join(work, SOCKET_POINTER), ready)
  return resource.directory
}

/** Never follow a resource symlink or remove another attempt's directory. */
async function cleanupTransferSocket(work: string): Promise<void> {
  const pointer = join(work, SOCKET_POINTER)
  if (!(await exists(pointer))) return
  const pointerState = await lstat(pointer)
  if (!pointerState.isFile() || pointerState.isSymbolicLink() || pointerState.uid !== process.getuid?.() || (pointerState.mode & 0o777) !== 0o600) throw transferRefusal('managed_transfer_socket_owner_changed')
  const resource = socketResource(JSON.parse(await readFile(pointer, 'utf8')), work)
  const directory = await lstat(resource.directory, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
  if (directory) {
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== BigInt(process.getuid?.() ?? -1) || (directory.mode & 0o777n) !== 0o700n) throw transferRefusal('managed_transfer_socket_owner_changed')
    if (resource.identity && (resource.identity.device !== directory.dev.toString() || resource.identity.inode !== directory.ino.toString())) throw transferRefusal('managed_transfer_socket_owner_changed')
    const marker = join(resource.directory, SOCKET_OWNER)
    if (!(await exists(marker))) {
      // Interrupted between mkdir and ownership-marker creation: remove only an
      // empty directory. rmdir refuses any unexpected contents.
      await rmdir(resource.directory)
    } else {
      const markerState = await lstat(marker)
      if (!markerState.isFile() || markerState.isSymbolicLink() || markerState.uid !== process.getuid?.() || (markerState.mode & 0o777) !== 0o600) throw transferRefusal('managed_transfer_socket_owner_changed')
      const contents = await readFile(marker, 'utf8'), entries = await readdir(resource.directory)
      if (resource.phase === 'initializing') {
        // The durable pre-export phase and exact directory identity permit only
        // a prefix of the marker this allocation was about to write. Unknown
        // bytes, sockets or other files still refuse cleanup.
        const expected = JSON.stringify({ ...resource, phase: 'ready' })
        if (!expected.startsWith(contents) || entries.some(name => name !== SOCKET_OWNER)) throw transferRefusal('managed_transfer_socket_owner_changed')
      } else {
        const owner = socketResource(JSON.parse(contents), work)
        if (resource.phase !== 'ready' || JSON.stringify(owner) !== JSON.stringify(resource) || entries.some(name => name !== SOCKET_OWNER && name !== SOCKET_FILE)) throw transferRefusal('managed_transfer_socket_owner_changed')
      }
      await rm(resource.directory, { recursive: true })
    }
  }
  await rm(pointer, { force: true })
}
export async function readTransferJournal(profile: string): Promise<ManagedTransferJournal | null> {
  const path = join(profile, 'transfer', 'journal.json')
  if (!(await exists(path))) return null
  const value = JSON.parse(await readFile(path, 'utf8')) as ManagedTransferJournal
  if (value?.format !== 1 || typeof value.id !== 'string' || !MANAGED_TRANSFER_PHASES.includes(value.phase)) {
    throw transferRefusal('managed_transfer_control_state_invalid')
  }
  return value
}

export async function legacyBrainPresent(legacyBrainDirectory: string): Promise<boolean> {
  return (await exists(legacyBrainDirectory)) && (await readdir(legacyBrainDirectory)).length > 0
}

/** What the composition entry injects to export the staged copy. */
export interface ManagedTransferExport {
  (input: {
    sourceDirectory: string
    archiveDirectory: string
    checkpointPath: string
    socketDirectory: string
    key: Buffer
  }): Promise<{
    manifestSha256: string
    archiveId: string
    checkpointSha256: string
    records: number
    release: { through: string }
    sourceAuthentication: Record<string, unknown>
    observations: unknown
    observationsSha256: string
  }>
}

export type ManagedTransferPlan =
  | { kind: 'none' }
  | { kind: 'finalize'; journal: ManagedTransferJournal; paths: ManagedTransferPaths }
  | { kind: 'attempt'; journal: ManagedTransferJournal; paths: ManagedTransferPaths; advance: (phase: ManagedTransferPhase, fields?: Partial<ManagedTransferJournal>) => Promise<void> }

/**
 * Decide and stage the transfer before the managed runtime starts. With a
 * published pointer the managed brain is already the store: only an admitted,
 * unfinalized attempt is finalized. Without one, any earlier unpublished attempt
 * is discarded and a new attempt exports a fresh byte copy.
 */
export async function prepareManagedTransfer({ profile, legacyBrainDirectory, exportSource, onPhase = async () => {} }: {
  profile: string
  legacyBrainDirectory: string
  exportSource: ManagedTransferExport
  onPhase?: (phase: ManagedTransferPhase, journal: ManagedTransferJournal) => Promise<void>
}): Promise<ManagedTransferPlan> {
  const journal = await readTransferJournal(profile)
  if (await exists(join(profile, 'active.json'))) {
    if (journal && journal.phase === 'admitted') return { kind: 'finalize', journal, paths: managedTransferPaths(profile, legacyBrainDirectory, journal.id) }
    return { kind: 'none' }
  }
  if (!(await legacyBrainPresent(legacyBrainDirectory))) return { kind: 'none' }
  const control = join(profile, 'transfer')
  await mkdir(control, { recursive: true, mode: 0o700 })
  // Unpublished attempts are never admitted state: remove their work (archive,
  // key, staged copy) and start over. The embedded brain stays the store.
  for (const name of await readdir(control)) {
    if (name === 'journal.json' || name === 'receipt.json') continue
    const previous = join(control, name), entry = await lstat(previous)
    if (entry.isDirectory() && !entry.isSymbolicLink()) await cleanupTransferSocket(previous)
    await rm(previous, { recursive: true, force: true })
  }
  const id = randomUUID()
  const paths = managedTransferPaths(profile, legacyBrainDirectory, id)
  const now = new Date().toISOString()
  const before = await treeDigest(legacyBrainDirectory)
  const current: ManagedTransferJournal = { format: 1, id, phase: 'exporting', legacyBrainDirectory, startedAt: now, updatedAt: now, source: before }
  const advance = async (phase: ManagedTransferPhase, fields: Partial<ManagedTransferJournal> = {}) => {
    Object.assign(current, fields, { phase, updatedAt: new Date().toISOString() })
    await writeAtomic(paths.journal, current)
    await onPhase(phase, current)
  }
  await mkdir(paths.work, { mode: 0o700 })
  await advance('exporting')
  const staged = join(paths.work, 'source')
  try {
    await cp(legacyBrainDirectory, staged, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true })
    const copied = await treeDigest(staged)
    if (copied.sha256 !== before.sha256) throw transferRefusal('managed_transfer_source_unstable', 'the embedded brain changed while it was copied; stop every process using it and retry')
    const key = randomBytes(32)
    const keyFile = await open(paths.key, 'wx', 0o600)
    try { await keyFile.writeFile(key); await keyFile.sync() } finally { await keyFile.close() }
    const socketDirectory = await allocateTransferSocket(paths.work)
    const exported = await exportSource({ sourceDirectory: staged, archiveDirectory: paths.archive, checkpointPath: paths.checkpoint, socketDirectory, key })
    const observations = await open(paths.observations, 'wx', 0o600)
    try { await observations.writeFile(JSON.stringify(exported.observations)) } finally { await observations.close() }
    const after = await treeDigest(legacyBrainDirectory)
    if (after.sha256 !== before.sha256) throw transferRefusal('managed_transfer_source_changed', 'the embedded brain changed during export; stop every process using it and retry')
    await advance('exported', {
      anchor: { manifestSha256: exported.manifestSha256, checkpointSha256: exported.checkpointSha256, archiveId: exported.archiveId, records: exported.records },
      release: exported.release, sourceAuthentication: exported.sourceAuthentication, observationsSha256: exported.observationsSha256,
    })
  } catch (error) {
    // A refused attempt keeps no archive, key or copy of the brain; the journal stays for diagnosis.
    await discardManagedTransferWork(paths)
    if ((error as { code?: string }).code === 'MANAGED_NATIVE_TRANSFER_REFUSED') throw error
    throw transferRefusal('managed_transfer_export_refused', (error as Error).message, error)
  } finally {
    // The staged copy was opened read-write by the engine; it is never reused.
    await rm(staged, { recursive: true, force: true })
    await cleanupTransferSocket(paths.work)
  }
  return { kind: 'attempt', journal: current, paths, advance }
}

/** Remove an attempt's archive, key and staged copy (refusal before the switch). */
export async function discardManagedTransferWork(paths: ManagedTransferPaths): Promise<void> {
  await cleanupTransferSocket(paths.work)
  await rm(paths.work, { recursive: true, force: true })
}

export async function readTransferKey(paths: ManagedTransferPaths): Promise<Buffer> {
  const key = await readFile(paths.key)
  if (key.length !== 32) throw transferRefusal('managed_transfer_control_state_invalid', 'archive key')
  return key
}

/**
 * After the pointer is published: prove the original brain is byte-identical,
 * write the sidecar marker and the receipt, and remove the archive and its key.
 * Idempotent; a crash here is finalized by the next start.
 */
export async function finalizeManagedTransfer({ journal, paths, managed }: {
  journal: ManagedTransferJournal
  paths: ManagedTransferPaths
  managed: { id: string; systemId: string }
}): Promise<ManagedTransferJournal> {
  if (journal.phase !== 'admitted' && journal.phase !== 'finalized') throw transferRefusal('managed_transfer_not_admitted')
  const after = await treeDigest(journal.legacyBrainDirectory)
  if (after.sha256 !== journal.source.sha256) {
    // The managed brain is admitted and published; report, never touch the original.
    throw transferRefusal('managed_transfer_original_changed', 'the embedded brain changed after its export; it was kept and not modified by the transfer')
  }
  const finalized: ManagedTransferJournal = { ...journal, phase: 'finalized', managed, finalizedAt: journal.finalizedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() }
  const receipt = {
    schema: 'usebrian-managed-transfer-receipt-v1',
    transferId: finalized.id,
    legacyBrainDirectory: finalized.legacyBrainDirectory,
    originalTree: finalized.source,
    originalUnchanged: true,
    archive: finalized.anchor,
    release: finalized.release,
    importReceiptSha256: finalized.importReceiptSha256,
    forwardMigrationSha256: finalized.forwardMigrationSha256,
    receivingProofSha256: finalized.receivingProofSha256,
    admission: finalized.admission,
    managed,
    finalizedAt: finalized.finalizedAt,
  }
  const receiptSha256 = createHash('sha256').update(JSON.stringify(receipt)).digest('hex')
  await writeAtomic(paths.receipt, { ...receipt, receiptSha256 })
  await writeAtomic(paths.sidecar, {
    schema: 'usebrian-embedded-brain-transferred-v1',
    note: 'This embedded brain was copied to the managed PostgreSQL runtime and is kept unchanged as a rollback copy.',
    transferId: finalized.id, receiptSha256, archiveManifestSha256: finalized.anchor?.manifestSha256,
    erasureCheckpointSha256: finalized.anchor?.checkpointSha256, originalTreeSha256: finalized.source.sha256,
    managedProfile: dirname(paths.control), managed, finalizedAt: finalized.finalizedAt,
  })
  await writeAtomic(paths.journal, finalized)
  // The original brain is the rollback copy; the sealed archive and key are not kept.
  await rm(paths.work, { recursive: true, force: true })
  return finalized
}
