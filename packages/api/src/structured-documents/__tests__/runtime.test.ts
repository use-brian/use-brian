import { connectorsStub, connectorInstanceId, binding } from './connector-helper.js'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FilesApi, FilesContext, WorkspaceFile } from '@use-brian/core'
import type { OfficeCommand, SpreadsheetSnapshot } from '@use-brian/office-model'
import type { OfficeArtifactRow } from '../../db/office-artifacts.js'
import type { OfficeLiveSnapshot } from '../../db/office-live.js'
import type { ResolvedOfficeAccess } from '../../office/access.js'
import type { StructuredExtractionJob, StructuredExtractionStore } from '../../db/structured-document-extractions.js'
import type { StructuredOcrClient } from '../client.js'
import { createStructuredDocumentService } from '../service.js'
import { createStructuredDocumentRuntime } from '../runtime.js'
import { recordsFixture, cellRef } from './fixtures.js'

// The OCR client uses Node transport, not ambient fetch. Block both transports.
const { networkRequest } = vi.hoisted(() => ({ networkRequest: vi.fn(() => { throw new Error('unexpected network') }) }))
vi.mock('node:http', async importOriginal => ({ ...await importOriginal<typeof import('node:http')>(), request: networkRequest }))
vi.mock('node:https', async importOriginal => ({ ...await importOriginal<typeof import('node:https')>(), request: networkRequest }))

const uid = (n: number) => `49000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const date = () => new Date('2025-01-01T00:00:00.000Z')
function snapshot(): SpreadsheetSnapshot {
  return {
    schemaVersion: 1, capabilityVersion: 1, workspaceId: uid(2), locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: null,
    resources: [], accessibility: { title: 'Synthetic' }, artifactId: uid(8), family: 'spreadsheet', rootId: uid(12), title: 'Synthetic',
    activeSheetId: uid(10), calculationMode: 'automatic', worksheets: [{
      id: uid(10), name: 'Inputs', visibility: 'visible', cells: [{ id: uid(9), address: 'A1', valueType: 'string', value: null, style: {}, locked: false }],
      merges: [], rowDimensions: [], columnDimensions: [], freeze: { rows: 0, columns: 0 }, images: [], validations: [], conditionalFormats: [],
      print: { paperSize: 'A4', orientation: 'portrait', fitToWidth: 1, fitToHeight: 1, margins: { leftIn: 0.7, rightIn: 0.7, topIn: 0.75, bottomIn: 0.75, headerIn: 0.3, footerIn: 0.3 }, horizontalCentered: false, verticalCentered: false, showGridLines: false, showHeadings: false },
    }],
  }
}
function fixture() {
  const ctx: FilesContext = { userId: uid(1), workspaceId: uid(2), assistantId: uid(3), assistantKind: 'standard', clearance: 'confidential', compartments: ['team-a', 'team-b'], projectIds: ['project-a', 'project-b'] }
  let liveContext = structuredClone(ctx)
  const pdf = Buffer.from('%PDF-fictional')
  const records = recordsFixture()
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42])
  const file = (id: string, bytes: Uint8Array, mime: string): WorkspaceFile => ({
    id, workspaceId: uid(2), path: `/fictional/${id}`, parentPath: '/fictional', name: 'fictional', title: null, summary: null,
    mime, sizeBytes: bytes.length, tags: [], relatedIds: [], storageUri: `memory:${id}`, sensitivity: 'internal', compartments: ['team-a'], projectIds: ['project-a'], metadata: {},
    userId: null, assistantId: null, source: 'user', sourceEpisodeId: null, verifiedByUserId: null, verifiedAt: null,
    validFrom: date(), validTo: null, supersededBy: null, retractedAt: null, retractedReason: null, retractedBy: null,
    createdByUserId: uid(1), createdByAssistantId: null, createdAt: date(), updatedAt: date(),
  })
  const source = file(uid(4), pdf, 'application/pdf')
  const blobs = new Map<string, { file: WorkspaceFile; bytes: Uint8Array }>([[source.id, { file: source, bytes: pdf }]])
  const files = {
    stat: vi.fn(async (_ctx: FilesContext, id: string) => blobs.has(id) ? { ok: true as const, value: blobs.get(id)!.file } : { ok: false as const, error: { kind: 'not_found' as const, reference: id } }),
    readBytes: vi.fn(async (_ctx: FilesContext, id: string) => blobs.has(id) ? { ok: true as const, value: blobs.get(id)! } : { ok: false as const, error: { kind: 'not_found' as const, reference: id } }),
    write: vi.fn(), writeBytes: vi.fn(), append: vi.fn(), read: vi.fn(), search: vi.fn(), setMeta: vi.fn(), delete: vi.fn(),
  } satisfies FilesApi
  let job: StructuredExtractionJob | undefined
  const store = {
    prepare: vi.fn(async (input) => {
      job = { ...input, id: uid(7), status: 'prepared', remoteJobId: null, recordsFileId: null, recordsSha256: null, documentId: null, imageFiles: [], pageNumbers: [], archivedBytes: 0, errorCode: null, leaseToken: null, leaseExpiresAt: null, createdAt: date(), updatedAt: date() }
      return job!
    }),
    get: vi.fn(async (_user: string, id: string) => id === job?.id ? job! : null as never),
    enqueue: vi.fn(async () => { if (job?.status === 'prepared') job.status = 'queued'; return job ?? null as never }),
    claim: vi.fn(), update: vi.fn(), fail: vi.fn(), complete: vi.fn(),
  } satisfies StructuredExtractionStore
  const client = { health: vi.fn(async () => ({ version: '1.1' as const, busy: false })), submit: vi.fn(), status: vi.fn(), records: vi.fn(), image: vi.fn() } satisfies StructuredOcrClient
  const artifact: OfficeArtifactRow = { id: uid(8), workspaceId: uid(2), family: 'spreadsheet', mode: 'artifact', title: 'Fictional', creatorUserId: uid(1), ownerUserId: uid(1), templateVersionId: null, headVersionId: uid(11), headVersion: 3, capabilityVersion: 1, sensitivity: 'internal', compartments: ['team-a'], projectIds: ['project-a'], defaultWorkspaceRole: 'comment', lifecycleState: 'active', updatedAt: date() }
  const access: ResolvedOfficeAccess = { artifactId: artifact.id, workspaceId: uid(2), role: 'comment', workspaceRole: 'member', lifecycleState: 'active', canView: true, canComment: true, canEdit: false, canRestore: false, canDeletePermanently: false, canElevate: false, canManageSharing: false }
  const live: OfficeLiveSnapshot = { snapshot: snapshot(), seq: 4, baseVersion: 3, canonicalHash: 'fictional-hash' }
  const getOffice = vi.fn(async () => ({ artifact, access, live }))
  const saveProposal = vi.fn(async (_input: Parameters<Parameters<typeof createStructuredDocumentService>[0]['saveProposal']>[0]) => ({ id: uid(20), threadId: uid(21) }))
  const resolveContext = vi.fn(async () => structuredClone(liveContext))
  const connectors = connectorsStub(client)
  const service = createStructuredDocumentService({ files, store, connectors, resolveContext, getOffice, saveProposal })
  const mapping = { targetId: uid(9), source: cellRef, meaning: 'Account identifier', reason: 'Explicit selected evidence' }
  const propose = () => service.propose(ctx, { extractionId: uid(7), artifactId: uid(8), expectedVersion: 3, mappings: [mapping] })
  const prepare = () => service.prepare(ctx, { fileId: uid(4), connectorInstanceId })
  function archive() {
    const raw = Buffer.from(JSON.stringify(records))
    blobs.set(uid(5), { file: file(uid(5), raw, 'application/json'), bytes: raw })
    blobs.set(uid(6), { file: file(uid(6), png, 'image/png'), bytes: png })
    Object.assign(job!, { status: 'completed', recordsFileId: uid(5), recordsSha256: sha(raw), documentId: records.document.id, pageNumbers: [1], imageFiles: [{ page: 1, fileId: uid(6), sha256: sha(png), sizeBytes: png.length }] })
  }
  return { service, ctx, files, store, client, connectors, source, blobs, records, artifact, access, live, getOffice, saveProposal, resolveContext, prepare, archive, propose, mapping,
    job: () => job!, setLiveContext(value: FilesContext) { liveContext = value } }
}

// Local copy of the service harness: keep the existing suite private/unmodified.
function runtimeFixture() {
  const f = fixture()
  const tools = new Map()
  const pendingActors = vi.fn(async () => [f.ctx.userId])
  const proposals = { save: f.saveProposal, get: vi.fn(async () => {
    const input = f.saveProposal.mock.lastCall?.[0]
    return input ? { ...input, id: uid(20), threadId: uid(21) } : null
  }) }
  const warn = vi.fn()
  const runtime = createStructuredDocumentRuntime({ connectors: f.connectors,
    files: f.files, tools, resolveContext: f.resolveContext, resolvePolicy: async () => 'allow',
    getOffice: f.getOffice, pendingActors, store: f.store, proposals, warn })
  return { ...f, runtime, tools, pendingActors, proposals, warn }
}
async function proposed() {
  const f = runtimeFixture()
  await f.runtime.service.prepare(f.ctx, { fileId: uid(4), connectorInstanceId })
  f.archive()
  await f.runtime.service.propose(f.ctx, { extractionId: uid(7), artifactId: uid(8), expectedVersion: 3, mappings: [f.mapping] })
  f.access.canEdit = true
  const command = structuredClone(f.saveProposal.mock.lastCall![0].command) as OfficeCommand
  return { ...f, command }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('[COMP:api/structured-documents] runtime factory', () => {
  it('registers tools but does not run workers until started; start/stop are idempotent', async () => {
    vi.useFakeTimers()
    const f = runtimeFixture()
    expect([...f.tools.keys()]).toEqual(['listDocumentExtractionConnectors', 'prepareDocumentExtraction', 'startDocumentExtraction', 'readDocumentExtraction', 'proposeOfficeEvidenceFill'])
    expect(f.pendingActors).not.toHaveBeenCalled()
    expect(f.client.health).not.toHaveBeenCalled()
    expect(f.connectors.resolve).not.toHaveBeenCalled()
    try {
      f.runtime.start(); f.runtime.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.store.claim).toHaveBeenCalledTimes(1)
      expect(f.store.claim).toHaveBeenCalledWith(f.ctx.userId, expect.any(String), 120_000)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(f.store.claim).toHaveBeenCalledTimes(2)
      f.runtime.stop(); f.runtime.stop()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(f.store.claim).toHaveBeenCalledTimes(2)
      f.runtime.start(); await vi.advanceTimersByTimeAsync(0)
      expect(f.store.claim).toHaveBeenCalledTimes(3)
      expect(f.connectors.resolve).not.toHaveBeenCalled()
      expect(networkRequest).not.toHaveBeenCalled()
    } finally { f.runtime.stop() }
  })
  it('serializes polling, bounds actor work, and recovers after a failed tick', async () => {
    vi.useFakeTimers()
    const f = runtimeFixture()
    let release!: (actors: string[]) => void
    f.pendingActors.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    try {
      f.runtime.start()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(f.pendingActors).toHaveBeenCalledTimes(1)
      release(Array.from({ length: 25 }, (_, i) => uid(i + 30)))
      await vi.advanceTimersByTimeAsync(0)
      expect(f.store.claim).toHaveBeenCalledTimes(20)
      f.pendingActors.mockRejectedValueOnce(new Error('private failure'))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(f.warn).toHaveBeenCalledExactlyOnceWith()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(f.store.claim).toHaveBeenCalledTimes(21)
    } finally { f.runtime.stop() }
  })
  it('accepts a real source-backed plan without changing the workbook', async () => {
    const f = await proposed(); const before = structuredClone(f.live.snapshot)
    f.connectors.resolve.mockRejectedValue(new Error('connector revoked'))
    f.connectors.resolve.mockClear()
    await expect(f.runtime.verifySuggestion(f.ctx.userId, uid(20), f.command)).resolves.toBe(true)
    expect(f.proposals.get).toHaveBeenCalledWith(f.ctx.userId, uid(20))
    expect(f.live.snapshot).toEqual(before)
    expect(f.connectors.resolve).not.toHaveBeenCalled()
    expect(f.files.writeBytes).not.toHaveBeenCalled()
  })
  it.each(['wrong owner', 'source changed', 'current record hash', 'destination scope', 'stale seq', 'tampered command', 'missing snapshot guard', 'no edit', 'missing proposal'])(
    'rejects %s at acceptance', async failure => {
      const f = await proposed(); let userId = f.ctx.userId
      if (failure === 'wrong owner') userId = uid(99)
      if (failure === 'source changed') f.blobs.get(uid(4))!.bytes[5] = 88
      if (failure === 'current record hash') f.job().recordsSha256 = 'f'.repeat(64)
      if (failure === 'destination scope') f.artifact.compartments = []
      if (failure === 'stale seq') f.live.seq++
      if (failure === 'no edit') f.access.canEdit = false
      if (failure === 'missing proposal') f.proposals.get.mockResolvedValue(null)
      if (f.command.kind !== 'batch') throw new Error('expected source-backed batch')
      if (failure === 'tampered command') Object.assign(f.command.commands[0]!, { value: 'invented' })
      if (failure === 'missing snapshot guard') delete f.command.expectedSnapshotHash
      await expect(f.runtime.verifySuggestion(userId, uid(20), f.command)).resolves.toBe(false)
    })
})
