import { connectorsStub, connectorInstanceId, binding } from './connector-helper.js'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { FilesApi, FilesContext, WorkspaceFile } from '@use-brian/core'
import { applyOfficeSuggestion, snapshotToYDoc, yDocToSnapshot, type OfficeCommand, type SpreadsheetSnapshot } from '@use-brian/office-model'
import type { OfficeArtifactRow } from '../../db/office-artifacts.js'
import type { OfficeLiveSnapshot } from '../../db/office-live.js'
import type { ResolvedOfficeAccess } from '../../office/access.js'
import type { StructuredExtractionJob, StructuredExtractionStore } from '../../db/structured-document-extractions.js'
import { createServer } from 'node:http'
import { createStructuredOcrClient } from '../client.js'
import { createStructuredExtractionWorker } from '../worker.js'
import { createStructuredDocumentRuntime } from '../runtime.js'
import type { StructuredFillProposalInput } from '../../db/structured-fill-proposals.js'
import { recordsFixture, cellRef, entityRef } from './fixtures.js'

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

// Only fictional, public fixture data; real Node HTTP transport, no OCR or DB.
it('[COMP:api/structured-documents] carries PDF evidence through a leased worker to human live acceptance', async () => {
  const ctx: FilesContext = { userId: uid(1), workspaceId: uid(2), assistantId: uid(3), assistantKind: 'standard', clearance: 'confidential', compartments: ['team-a', 'team-b'], projectIds: ['project-a', 'project-b'] }
  const pdf = Buffer.concat([Buffer.from('%PDF-fictional\n'), Buffer.from([0, 255, 128, 13, 10])])
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
  const missing = (reference: string) => ({ ok: false as const, error: { kind: 'not_found' as const, reference } })
  const files: FilesApi = {
    stat: async (_ctx, ref) => { const b = blobs.get(ref) ?? [...blobs.values()].find(b => b.file.path === ref); return b ? { ok: true, value: structuredClone(b.file) } : missing(ref) },
    readBytes: async (_ctx, ref) => { const b = blobs.get(ref); return b ? { ok: true, value: structuredClone(b) } : missing(ref) },
    writeBytes: async (ctx, input) => {
      const output = { ...file(uid(100 + blobs.size), input.bytes, input.mime), path: input.path,
        sensitivity: input.sensitivity!, compartments: ctx.writeCompartments!, projectIds: ctx.writeProjectIds! }
      blobs.set(output.id, { file: output, bytes: new Uint8Array(input.bytes) })
      return { ok: true, value: structuredClone(output) }
    },
    write: vi.fn(), append: vi.fn(), read: vi.fn(), search: vi.fn(), setMeta: vi.fn(), delete: vi.fn(),
  }
  let job: StructuredExtractionJob
  let clock = date().getTime(), nextAttempt = clock
  const copy = () => structuredClone(job)
  const store: StructuredExtractionStore = {
    async prepare(input) {
      job = { ...input, id: uid(7), status: 'prepared', remoteJobId: null, recordsFileId: null, recordsSha256: null, documentId: null, imageFiles: [], pageNumbers: [], archivedBytes: 0, errorCode: null, leaseToken: null, leaseExpiresAt: null, createdAt: date(), updatedAt: date() }
      return copy()
    },
    async get(user, id) { return job && user === job.userId && id === job.id ? copy() : null },
    async enqueue(user, id) { if (!await store.get(user, id)) return null; if (job.status === 'prepared') job.status = 'queued'; return copy() },
    async claim(user, token, ms) {
      if (!job || user !== job.userId || !['queued', 'submitting', 'running', 'archiving'].includes(job.status) || nextAttempt > clock || (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > clock)) return null
      job.leaseToken = token; job.leaseExpiresAt = new Date(clock + ms); return copy()
    },
    async update(user, id, token, expected, patch) {
      if (!await store.get(user, id) || token !== job.leaseToken || expected !== job.status || !job.leaseExpiresAt || job.leaseExpiresAt.getTime() <= clock) return null
      const { retryMs, ...fields } = patch
      Object.assign(job, structuredClone(fields))
      if (retryMs !== undefined) nextAttempt = clock + retryMs
      if (retryMs !== undefined || ['completed', 'failed', 'cancelled'].includes(job.status)) { job.leaseToken = null; job.leaseExpiresAt = null }
      return copy()
    },
    fail: (user, id, token, state, errorCode) => store.update(user, id, token, state, { status: 'failed', errorCode }),
    complete: (user, id, token) => store.update(user, id, token, 'archiving', { status: 'completed' }),
  }
  const artifact: OfficeArtifactRow = { id: uid(8), workspaceId: uid(2), family: 'spreadsheet', mode: 'artifact', title: 'Fictional', creatorUserId: uid(1), ownerUserId: uid(1), templateVersionId: null, headVersionId: uid(11), headVersion: 3, capabilityVersion: 1, sensitivity: 'internal', compartments: ['team-a'], projectIds: ['project-a'], defaultWorkspaceRole: 'comment', lifecycleState: 'active', updatedAt: date() }
  const access: ResolvedOfficeAccess = { artifactId: artifact.id, workspaceId: uid(2), role: 'comment', workspaceRole: 'member', lifecycleState: 'active', canView: true, canComment: true, canEdit: false, canRestore: false, canDeletePermanently: false, canElevate: false, canManageSharing: false }
  const live: OfficeLiveSnapshot = { snapshot: snapshot(), seq: 4, baseVersion: 3, canonicalHash: 'fictional-hash' }
  if (live.snapshot.family !== 'spreadsheet') throw new Error('spreadsheet required')
  live.snapshot.worksheets[0]!.cells.push(
    { id: uid(13), address: 'A2', valueType: 'string', value: null, style: {}, locked: false },
    { id: uid(14), address: 'A3', valueType: 'string', value: 'locked sentinel', style: {}, locked: true },
    { id: uid(15), address: 'A4', valueType: 'string', value: 'unselected sentinel', style: {}, locked: false },
  )
  const doc = snapshotToYDoc(live.snapshot)
  const before = yDocToSnapshot(doc)
  let saved: (StructuredFillProposalInput & { id: string; threadId: string }) | null = null
  const raw = Buffer.from(JSON.stringify(records)), remote = uid(7).replaceAll('-', '')
  const requests: { method: string; url: string; authorization?: string; contentType?: string; body: Buffer }[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, contentType: req.headers['content-type'], body: Buffer.concat(chunks) })
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== 'Bearer fictional-token') { res.writeHead(401); res.end(); return }
    if (req.method === 'POST' && req.url === '/mcp') {
      const rpc = JSON.parse(Buffer.concat(chunks).toString())
      if (!('id' in rpc)) { res.writeHead(202); res.end(); return }
      let result: unknown
      if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fictional', version: '1' } }
      else if (rpc.method === 'tools/call') {
        const name = rpc.params.name
        if (name !== 'ocr_capabilities' && req.headers['x-ocr-scope'] !== 'd'.repeat(64)) { res.writeHead(403); res.end(); return }
        const value = name === 'ocr_capabilities' ? { protocol: 'ocr-evidence/1', version: '1.1', busy: false, maxPdfBytes: 15728640, maxPages: 10 }
          : name === 'ocr_start' ? { id: rpc.params.arguments.uploadId }
          : name === 'ocr_status' ? { status: 'completed' }
          : name === 'ocr_records' ? { path: `/transfer/${remote}/records`, sha256: sha(raw), sizeBytes: raw.length }
          : { path: `/transfer/${remote}/page-1.png`, sha256: sha(png), sizeBytes: png.length }
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
      } else { res.writeHead(400); res.end(); return }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    } else if (req.url?.startsWith('/transfer/') && req.headers['x-ocr-scope'] !== 'd'.repeat(64)) { res.writeHead(403); res.end() }
    else if (req.method === 'PUT' && req.url === `/transfer/${remote}`) res.end(JSON.stringify({ uploadId: remote }))
    else if (req.url === `/transfer/${remote}/records`) res.end(raw)
    else if (req.url === `/transfer/${remote}/page-1.png`) { res.setHeader('Content-Type', 'image/png'); res.end(png) }
    else { res.statusCode = 405; res.end('{}') }
  })
  let runtime: ReturnType<typeof createStructuredDocumentRuntime> | undefined
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback bind failed')
    const configuration = { baseUrl: `http://127.0.0.1:${address.port}/mcp`, token: 'fictional-token', scope: 'd'.repeat(64) }
    const client = createStructuredOcrClient(configuration) // No fetchFn: exercise actual directFetch.
    const pendingActors = vi.fn(async () => [ctx.userId])
    runtime = createStructuredDocumentRuntime({ connectors: connectorsStub(client), files, store, tools: new Map(),
      resolveContext: async () => structuredClone(ctx), resolvePolicy: async () => 'allow',
      getOffice: async () => ({ artifact, access, live }), pendingActors,
      proposals: {
        async save(input) { saved = { ...structuredClone(input), id: uid(20), threadId: uid(21) }; return { id: saved.id, threadId: saved.threadId } },
        async get(user, id) { return saved && saved.userId === user && saved.id === id ? structuredClone(saved) : null },
      },
    })
    const { service } = runtime
    const worker = createStructuredExtractionWorker({ store, files, resolveClient: service.resolveClient, authorize: service.authorize })
    await expect(service.prepare(ctx, { fileId: source.id, connectorInstanceId })).resolves.toMatchObject({ status: 'prepared', pdfSha256: sha(pdf) })
    expect(requests.filter(r => r.method === 'PUT')).toHaveLength(0)
    const preflightRequests = requests.length
    expect(blobs.size).toBe(1)
    expect(await worker.runOnce(ctx.userId)).toBe(false)
    // Explicit human confirmation invokes start; preparation alone cannot dispatch.
    await expect(service.start(ctx, { extractionId: uid(7) })).resolves.toMatchObject({ status: 'queued' })
    expect(requests).toHaveLength(preflightRequests)
    for (const state of ['running', 'archiving', 'archiving', 'archiving', 'completed']) {
      expect(await worker.runOnce(ctx.userId)).toBe(true)
      expect(job!.status, job!.errorCode ?? 'worker status').toBe(state)
      expect(job!.leaseToken).toBeNull()
      clock += 5_000 // Advance only the adapter's deterministic scheduling clock.
    }
    expect(await worker.runOnce(ctx.userId)).toBe(false)
    expect(pendingActors).not.toHaveBeenCalled() // Runtime timers were never started.
    const operations = requests.filter(r => r.method === 'POST' && r.url === '/mcp').map(r => JSON.parse(r.body.toString())).filter(r => r.method === 'tools/call')
    expect(operations.map(r => r.params.name)).toEqual(['ocr_capabilities', 'ocr_start', 'ocr_status', 'ocr_records', 'ocr_source_page'])
    expect(operations[1].params.arguments).toEqual({ uploadId: remote })
    expect(requests.every(r => r.authorization === 'Bearer fictional-token')).toBe(true)
    const upload = requests.find(r => r.method === 'PUT')!
    expect(upload.url).toBe(`/transfer/${remote}`)
    expect(upload.contentType).toBe('application/pdf')
    expect(upload.body).toEqual(pdf)
    const networkRequests = requests.length
    expect(job!.recordsSha256).toBe(sha(raw))
    expect(job!.imageFiles).toEqual([{ page: 1, fileId: expect.any(String), sha256: sha(png), sizeBytes: png.length }])
    expect(Buffer.from(blobs.get(job!.recordsFileId!)!.bytes)).toEqual(raw)
    expect(blobs.get(job!.imageFiles[0]!.fileId)!.bytes).toEqual(png)
    await expect(service.read(ctx, { extractionId: uid(7), view: 'records' })).resolves.toMatchObject({ complete: true, data: records.records })
    await expect(service.read(ctx, { extractionId: uid(7), view: 'entities' })).resolves.toMatchObject({ complete: true, data: records.entities })
    const mappings = [
      { targetId: uid(9), source: cellRef, meaning: 'Identifier', reason: 'Selected identifier' },
      { targetId: uid(13), source: entityRef, meaning: 'Name', reason: 'Selected name' },
    ]
    await expect(service.propose(ctx, { extractionId: uid(7), artifactId: artifact.id, expectedVersion: 3, mappings: [Object.assign({}, mappings[0]!, { value: 'injected' })] })).rejects.toThrow()
    expect(saved).toBeNull()
    const suggestion = await service.propose(ctx, { extractionId: uid(7), artifactId: artifact.id, expectedVersion: 3, mappings })
    expect(suggestion).toMatchObject({ status: 'suggested', requiresHumanReview: true, preview: [
      { rawText: '00123', proposedValue: '00123', valueType: 'string' },
      { rawText: 'Fictional Ltd', proposedValue: 'Fictional Ltd', valueType: 'string' },
    ] })
    expect(live.snapshot).toEqual(before)
    expect(yDocToSnapshot(doc)).toEqual(before)
    const proposal = saved! as StructuredFillProposalInput & { id: string }
    const retained = structuredClone(proposal)
    expect(proposal.lineage).toMatchObject({ mappings: mappings.map(m => ({ source: m.source })), pdfSha256: sha(pdf), recordsSha256: sha(raw) })
    const command = proposal.command as OfficeCommand
    access.canEdit = true
    await expect(runtime.verifySuggestion(ctx.userId, proposal.id, command)).resolves.toBe(true)
    const accepted = applyOfficeSuggestion(doc, command, proposal.id)
    const expected = structuredClone(before)
    if (expected.family !== 'spreadsheet') throw new Error('spreadsheet required')
    expected.worksheets[0]!.cells[0]!.value = '00123'
    expected.worksheets[0]!.cells[1]!.value = 'Fictional Ltd'
    expect(accepted).toEqual(expected)
    expect(applyOfficeSuggestion(doc, command, proposal.id)).toEqual(accepted)
    expect(yDocToSnapshot(doc)).toEqual(accepted)
    expect(saved).toEqual(retained)
    expect(blobs.size).toBe(3)
    expect(requests).toHaveLength(networkRequests) // Evidence/acceptance use durable archives, not remote OCR.
  } finally {
    runtime?.stop()
    doc.destroy()
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  }
})
