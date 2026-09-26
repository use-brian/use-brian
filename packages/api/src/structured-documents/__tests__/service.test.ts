import { connectorsStub, connectorInstanceId, binding } from './connector-helper.js'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { FilesApi, FilesContext, WorkspaceFile } from '@use-brian/core'
import type { SpreadsheetSnapshot } from '@use-brian/office-model'
import type { OfficeArtifactRow } from '../../db/office-artifacts.js'
import type { OfficeLiveSnapshot } from '../../db/office-live.js'
import type { ResolvedOfficeAccess } from '../../office/access.js'
import type { StructuredExtractionJob, StructuredExtractionStore } from '../../db/structured-document-extractions.js'
import { StructuredOcrError, type StructuredOcrClient } from '../client.js'
import { createStructuredOcrConnectorResolver, type StructuredOcrConnectorResolver } from '../connector.js'
import type { ConnectorInstance } from '../../db/connector-instance-store.js'
import type { WorkspaceToolPolicyStore } from '../../db/workspace-tool-policy-store.js'
import { createStructuredDocumentService, SavedPrincipalSchema, StructuredDocumentServiceError } from '../service.js'
import { recordsFixture, cellRef } from './fixtures.js'

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
function fixture(resolverFactory?: (client: StructuredOcrClient) => StructuredOcrConnectorResolver) {
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
  if (resolverFactory) {
    const resolver = resolverFactory(client)
    connectors.list.mockImplementation(resolver.list)
    connectors.resolve.mockImplementation(resolver.resolve)
  }
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

describe('[COMP:api/structured-documents] authorized service', () => {
  const secret = 'fictional-token-sentinel https://fictional.invalid/private PDF-text-sentinel SELECT private_column FROM fictional_table'
  async function safeFailure(operation: Promise<unknown>, code: string) {
    const error = await operation.then(() => { throw new Error('Expected rejection') }, error => error)
    expect(error).toBeInstanceOf(StructuredDocumentServiceError)
    expect(error).toMatchObject({ code, message: expect.any(String) })
    expect(`${error.message} ${JSON.stringify(error)}`).not.toMatch(/fictional-token-sentinel|fictional\.invalid|PDF-text-sentinel|SELECT|private_column|fictional_table/)
  }
  it.each(['stat', 'readBytes'] as const)('sanitizes unexpected source %s errors before resolver, health or persistence', async method => {
    const f = fixture()
    f.files[method].mockRejectedValue(new Error(secret))
    await safeFailure(f.prepare(), 'source_storage_unavailable')
    expect(f.connectors.resolve).not.toHaveBeenCalled()
    expect(f.client.health).not.toHaveBeenCalled()
    expect(f.store.prepare).not.toHaveBeenCalled()
    expect(f.saveProposal).not.toHaveBeenCalled()
    expect(f.client.submit).not.toHaveBeenCalled()
  })
  it('retains explicit source access denial before connector resolution', async () => {
    const f = fixture(); f.blobs.clear()
    await safeFailure(f.prepare(), 'access_denied')
    expect(f.connectors.resolve).not.toHaveBeenCalled()
    expect(f.client.health).not.toHaveBeenCalled()
    expect(f.store.prepare).not.toHaveBeenCalled()
  })
  it.each([
    ['42P01', 'extraction_schema_missing'], ['42703', 'extraction_schema_missing'],
    ['08006', 'extraction_store_unavailable'], ['23505', 'extraction_store_unavailable'],
  ])('sanitizes prepare SQL %s after health without starting OCR', async (sqlCode, code) => {
    const f = fixture()
    f.store.prepare.mockRejectedValue(Object.assign(new Error(secret), { code: sqlCode, detail: secret, query: secret, values: [secret] }))
    await safeFailure(f.prepare(), code)
    expect(f.client.health).toHaveBeenCalledOnce()
    expect(f.store.prepare).toHaveBeenCalledOnce()
    expect(f.client.submit).not.toHaveBeenCalled()
    expect(f.store.enqueue).not.toHaveBeenCalled()
    expect(f.files.writeBytes).not.toHaveBeenCalled()
  })
  it.each([
    ['connector_health_approval_required', 'connector_health_approval_required'],
    ['connector_policy_blocked', 'connector_policy_blocked'], ['connector_unavailable', 'connector_unavailable'],
    ['invalid_configuration', 'connector_configuration_invalid'], ['connector_binding_changed', 'connector_changed'],
    ['connector_context_missing', 'invalid_context'], ['connector_limit_exceeded', 'connector_limit_exceeded'],
    ['fictional_unknown', 'connector_unavailable'],
  ])('maps resolver %s to safe service %s without flattening', async (nativeCode, code) => {
    const f = fixture()
    const error = new StructuredOcrError(nativeCode); error.message = secret
    f.connectors.resolve.mockRejectedValue(error)
    await safeFailure(f.prepare(), code)
    expect(f.client.health).not.toHaveBeenCalled()
    expect(f.store.prepare).not.toHaveBeenCalled()
    expect(f.client.submit).not.toHaveBeenCalled()
  })
  it('keeps health network failures unavailable and never persists or uploads', async () => {
    const f = fixture()
    f.client.health.mockRejectedValue(new Error(secret))
    await safeFailure(f.prepare(), 'unavailable')
    expect(f.store.prepare).not.toHaveBeenCalled()
    expect(f.client.submit).not.toHaveBeenCalled()
  })
  it('retains known service errors and keeps unknown resume resolver errors connector-required', async () => {
    const f = fixture()
    f.connectors.resolve.mockRejectedValue(new StructuredDocumentServiceError('connector_policy_blocked'))
    await safeFailure(f.prepare(), 'connector_policy_blocked')
    f.connectors.resolve.mockRejectedValue(new Error(secret))
    await safeFailure(f.prepare(), 'operation_failed')
    f.connectors.resolve.mockReset()
    f.connectors.resolve.mockResolvedValue({ client: f.client, binding, label: 'Fictional OCR' })
    await f.prepare()
    f.connectors.resolve.mockRejectedValue(new StructuredOcrError('connector_policy_blocked'))
    await safeFailure(f.service.start(f.ctx, { extractionId: uid(7) }), 'connector_policy_blocked')
    f.connectors.resolve.mockRejectedValue(new Error(secret))
    await safeFailure(f.service.start(f.ctx, { extractionId: uid(7) }), 'connector_required')
    expect(f.store.enqueue).not.toHaveBeenCalled()
  })
  it.each(['absent', 'allow', 'block'] as const)('integrates real resolver policy %s with service preflight; listing is not approval', async policy => {
    const getPolicy = vi.fn(async (...args: unknown[]) => policy === 'absent' ? null : { policy: args[2] === 'ocr_start' && policy === 'block' ? 'block' : 'allow' })
    const createClient = vi.fn<(client: StructuredOcrClient) => StructuredOcrClient>(client => client)
    const f = fixture(client => createStructuredOcrConnectorResolver({
      instanceStore: {
        listByWorkspaceSystem: async () => [{ id: connectorInstanceId, scope: 'workspace', workspaceId: uid(2), provider: 'fictional-provider', label: 'Fictional OCR', custom: true, connected: true, credentialsType: 'bearer', healthStatus: 'ok', url: 'https://fictional.invalid/mcp', compartments: ['team-a'], projectIds: ['project-a'] } as ConnectorInstance],
        getAuthCredentialsSystem: async () => ({ type: 'bearer', token: 'fictional-token-sentinel' }),
      },
      grantStore: { listForTargetSystem: async () => [] },
      assistantStore: { isEnabled: async () => true },
      workspacePolicyStore: { getPolicy } as unknown as WorkspaceToolPolicyStore,
      createClient: () => createClient(client),
    }))
    await expect(f.service.listConnectors(f.ctx)).resolves.toMatchObject({ connectors: [{ connectorInstanceId }] })
    expect(getPolicy).not.toHaveBeenCalled()
    expect(f.client.health).not.toHaveBeenCalled()
    if (policy === 'allow') {
      const result = await f.prepare()
      expect(result).toMatchObject({ status: 'prepared' })
      expect(JSON.stringify(result)).not.toMatch(/fictional-token-sentinel|fictional\.invalid|%PDF-fictional/)
      expect(f.client.health).toHaveBeenCalledOnce()
      expect(f.store.prepare).toHaveBeenCalledOnce()
    } else {
      await safeFailure(f.prepare(), policy === 'absent' ? 'connector_health_approval_required' : 'connector_policy_blocked')
      expect(createClient).not.toHaveBeenCalled()
      expect(f.client.health).not.toHaveBeenCalled()
      expect(f.store.prepare).not.toHaveBeenCalled()
    }
    expect(f.client.submit).not.toHaveBeenCalled()
    expect(f.files.writeBytes).not.toHaveBeenCalled()
  })
  it('lists only after refreshing the principal, preserves context scope and rejects oversized catalogs', async () => {
    const f = fixture()
    f.setLiveContext({ ...f.ctx, compartments: ['team-a'], projectIds: [] })
    await expect(f.service.listConnectors(f.ctx)).resolves.toMatchObject({ connectors: [{ connectorInstanceId }], scopeEvidence: { sensitivity: 'confidential', compartments: ['team-a'], projectIds: [] } })
    expect(f.connectors.list).toHaveBeenCalledWith(expect.objectContaining({ compartments: ['team-a'], projectIds: [] }))
    expect(f.client.health).not.toHaveBeenCalled()
    f.connectors.list.mockResolvedValue(Array.from({ length: 101 }, () => ({ connectorInstanceId, label: 'x' })))
    await expect(f.service.listConnectors(f.ctx)).rejects.toMatchObject({ code: 'connector_limit_exceeded' })
  })
  it('authorizes source before connector access; saves binding and declares the fixed ASK approval scope', async () => {
    const denied = fixture(); denied.source.userId = denied.ctx.userId
    await expect(denied.prepare()).rejects.toThrow()
    expect(denied.connectors.resolve).not.toHaveBeenCalled()
    const f = fixture(); const result = await f.prepare()
    expect(f.job().context.connector).toEqual(binding)
    expect(result.approval).toMatchObject({ connectorInstanceId, connectorLabel: 'Fictional OCR', operations: ['PDF upload', 'ocr_start', 'ocr_status', 'ocr_records', 'ocr_source_page'] })
    expect(result.approval.scope).toContain('ASK')
    await f.service.start(f.ctx, { extractionId: uid(7) })
    expect(f.connectors.resolve).toHaveBeenLastCalledWith(f.ctx, uid(4), connectorInstanceId, binding)
  })
  it('requires new preflight for unbound jobs or revoked bindings before enqueue, but archive reads need no connector', async () => {
    const f = fixture(); await f.prepare()
    f.connectors.resolve.mockRejectedValue(new Error('revoked token-secret'))
    await expect(f.service.start(f.ctx, { extractionId: uid(7) })).rejects.toMatchObject({ code: 'connector_required' })
    expect(f.store.enqueue).not.toHaveBeenCalled()
    delete f.job().context.connector
    await expect(f.service.start(f.ctx, { extractionId: uid(7) })).rejects.toMatchObject({ code: 'connector_required' })
    f.archive()
    await expect(f.service.read(f.ctx, { extractionId: uid(7) })).resolves.toMatchObject({ complete: true })
    expect(f.connectors.resolve).toHaveBeenCalledTimes(2)
  })
  it('preflights only health and exact durable PDF bytes, recording explicit principal/version and cost', async () => {
    const f = fixture()
    const result = await f.prepare()
    expect(result).toMatchObject({ extractionId: uid(7), status: 'prepared', pdfSha256: sha(Buffer.from('%PDF-fictional')), cost: { maximumPages: 10, ocrLlmCall: false }, scopeEvidence: { sensitivity: 'internal', compartments: ['team-a'], projectIds: ['project-a'] } })
    expect(SavedPrincipalSchema.parse(f.job().context.principal)).toEqual(f.ctx)
    expect(f.job().context.sourceVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(f.client.health).toHaveBeenCalledOnce()
    expect(f.client.submit).not.toHaveBeenCalled()
    expect(f.files.writeBytes).not.toHaveBeenCalled()
  })
  it.each(['assistantId', 'workspaceId', 'clearance', 'compartments', 'projectIds'] as const)('fails closed for absent principal %s', async key => {
    const f = fixture(); delete f.ctx[key]
    await expect(f.prepare()).rejects.toMatchObject({ code: 'invalid_context' })
    expect(f.store.prepare).not.toHaveBeenCalled()
  })
  it('permits explicit universe, but never broadens saved or current read scopes', async () => {
    const f = fixture(); f.ctx.compartments = null; f.ctx.projectIds = null; f.setLiveContext({ ...f.ctx })
    await f.prepare()
    f.setLiveContext({ ...f.ctx, compartments: ['team-a', 'team-c'], projectIds: ['project-a'] })
    const narrow = { ...f.ctx, compartments: ['team-a'], projectIds: ['project-a', 'project-b'] }
    await f.service.read(narrow, { extractionId: uid(7) })
    expect(f.files.stat.mock.lastCall![0]).toMatchObject({ compartments: ['team-a'], projectIds: ['project-a'] })
    const a = fixture(); await a.prepare(); a.setLiveContext({ ...a.ctx, compartments: null, projectIds: null })
    await expect(a.service.authorize(a.job())).resolves.toMatchObject({ compartments: ['team-a', 'team-b'], projectIds: ['project-a', 'project-b'] })
    a.setLiveContext({ ...a.ctx, compartments: [] })
    await expect(a.service.authorize(a.job())).rejects.toMatchObject({ code: 'access_denied' })
  })
  it.each(['userId', 'assistantId'] as const)('rejects partitioned sources before byte read/upload (%s)', async key => {
    const f = fixture(); f.source[key] = uid(1)
    await expect(f.prepare()).rejects.toMatchObject({ code: 'private_source' })
    expect(f.files.readBytes).not.toHaveBeenCalled(); expect(f.client.health).not.toHaveBeenCalled()
  })
  it('rejects oversized, wrong MIME/signature, inactive PDFs and incompatible health', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.source.sizeBytes = 15 * 1024 * 1024 + 1 },
      (f: ReturnType<typeof fixture>) => { f.source.mime = 'text/plain' },
      (f: ReturnType<typeof fixture>) => { f.blobs.get(uid(4))!.bytes[0] = 0 },
      (f: ReturnType<typeof fixture>) => { f.source.retractedAt = date() },
    ]) { const f = fixture(); mutate(f); await expect(f.prepare()).rejects.toThrow(); expect(f.store.prepare).not.toHaveBeenCalled() }
    const f = fixture(); f.client.health.mockRejectedValue(new Error('vendor token-secret'))
    await expect(f.prepare()).rejects.toMatchObject({ code: 'unavailable' })
  })
  it('starts idempotently without uploading, and confines jobs to initiating user/workspace/assistant', async () => {
    const f = fixture(); await f.prepare()
    await expect(f.service.start(f.ctx, { extractionId: uid(7) })).resolves.toMatchObject({ status: 'queued' })
    await expect(f.service.start(f.ctx, { extractionId: uid(7) })).resolves.toMatchObject({ status: 'queued' })
    expect(f.client.submit).not.toHaveBeenCalled()
    for (const key of ['userId', 'workspaceId', 'assistantId'] as const) {
      await expect(f.service.read({ ...f.ctx, [key]: uid(98) }, { extractionId: uid(7) })).rejects.toMatchObject({ code: 'access_denied' })
    }
  })
  it('accepts indexing metadata updates between prepare/start and distinct stat/read snapshots', async () => {
    const f = fixture()
    // Return independent snapshots so the stat/read comparison really sees the update.
    f.files.stat.mockImplementation(async (_ctx, id) => ({ ok: true, value: structuredClone(f.blobs.get(id)!.file) }))
    f.files.readBytes.mockImplementation(async (_ctx, id) => {
      const blob = f.blobs.get(id)!
      blob.file.updatedAt = new Date(blob.file.updatedAt.getTime() + 1000)
      blob.file.metadata = { ...blob.file.metadata, indexing: { status: 'complete' }, embedding: { status: 'complete' } }
      return { ok: true, value: { file: structuredClone(blob.file), bytes: blob.bytes } }
    })
    await f.prepare()
    f.source.updatedAt = new Date('2025-02-01')
    await expect(f.service.start(f.ctx, { extractionId: uid(7) })).resolves.toMatchObject({ status: 'queued' })
    await expect(f.service.authorize(f.job())).resolves.toEqual(f.ctx)
    f.archive()
    await expect(f.service.evidence(f.ctx, uid(7))).resolves.toMatchObject({ job: { status: 'completed' } })
  })
  it('fails closed for legacy fingerprint snapshots and requires fresh prepare', async () => {
    const f = fixture(); await f.prepare()
    const file = f.source
    f.job().context.sourceVersion = createHash('sha256').update(JSON.stringify({
      id: file.id, workspaceId: file.workspaceId, storageUri: file.storageUri, mime: file.mime,
      sizeBytes: file.sizeBytes, updatedAt: file.updatedAt.toISOString(), validFrom: file.validFrom.toISOString(),
      scope: { sensitivity: file.sensitivity, compartments: file.compartments, projectIds: file.projectIds },
    })).digest('hex')
    await expect(f.service.start(f.ctx, { extractionId: uid(7) })).rejects.toMatchObject({ code: 'source_changed' })
    await expect(f.service.authorize(f.job())).rejects.toMatchObject({ code: 'source_changed' })
    expect(f.store.enqueue).not.toHaveBeenCalled()
    await f.prepare()
    await expect(f.service.start(f.ctx, { extractionId: uid(7) })).resolves.toMatchObject({ status: 'queued' })
  })
  const sourceChanges: [string, Partial<WorkspaceFile>, string][] = [
    ['storage URI', { storageUri: 'gs://other/source.pdf' }, 'source_changed'],
    ['validFrom', { validFrom: new Date('2025-02-01') }, 'source_changed'],
    ['sensitivity', { sensitivity: 'confidential' }, 'source_changed'],
    ['Team', { compartments: ['team-b'] }, 'source_changed'],
    ['Project', { projectIds: ['project-b'] }, 'source_changed'],
    ['size', { sizeBytes: 15 }, 'invalid_pdf'],
    ['MIME', { mime: 'text/plain' }, 'invalid_pdf'],
    ['file ID', { id: uid(90) }, 'access_denied'],
    ['workspace', { workspaceId: uid(90) }, 'access_denied'],
    ['validTo', { validTo: date() }, 'access_denied'],
    ['retraction', { retractedAt: date() }, 'access_denied'],
    ['supersession', { supersededBy: uid(90) }, 'access_denied'],
    ['user partition', { userId: uid(1) }, 'private_source'],
    ['assistant partition', { assistantId: uid(3) }, 'private_source'],
  ]
  it.each(sourceChanges)('rejects changed %s before enqueue', async (_name, patch, code) => {
    const f = fixture(); await f.prepare()
    Object.assign(f.source, patch)
    await expect(f.service.start(f.ctx, { extractionId: uid(7) })).rejects.toMatchObject({ code })
    expect(f.store.enqueue).not.toHaveBeenCalled()
  })
  it('rejects same-length changed PDF bytes before enqueue', async () => {
    const f = fixture(); await f.prepare()
    f.blobs.get(uid(4))!.bytes[5] = 88
    await expect(f.service.start(f.ctx, { extractionId: uid(7) })).rejects.toMatchObject({ code: 'source_changed' })
    expect(f.store.enqueue).not.toHaveBeenCalled()
  })
  it.each(['prepare/start', 'stat/read'])('rejects an effective local-directory locator change during %s', async timing => {
    const f = fixture()
    const localDirectory = { connectorInstanceId, relativePath: 'original.pdf', fingerprint: 'unchanged', readOnly: true }
    f.source.metadata = { localDirectory }
    await f.prepare()
    if (timing === 'stat/read') {
      f.files.stat.mockImplementation(async () => ({ ok: true, value: structuredClone(f.source) }))
      f.files.readBytes.mockImplementation(async () => {
        localDirectory.relativePath = 'replacement.pdf'
        return { ok: true, value: f.blobs.get(uid(4))! }
      })
    } else localDirectory.relativePath = 'replacement.pdf'
    // URI, bytes and all other fields stay identical.
    await expect(f.service.start(f.ctx, { extractionId: uid(7) })).rejects.toMatchObject({ code: 'source_changed' })
    expect(f.store.enqueue).not.toHaveBeenCalled()
  })
  it('rejects changed source bytes/version/scope and live revocation on every evidence read', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.blobs.get(uid(4))!.bytes[5] = 88 },
      (f: ReturnType<typeof fixture>) => { f.source.validFrom = new Date('2025-02-01') },
      (f: ReturnType<typeof fixture>) => { f.source.compartments = ['team-a', 'team-b'] },
      (f: ReturnType<typeof fixture>) => { f.setLiveContext({ ...f.ctx, clearance: 'public' }) },
      (f: ReturnType<typeof fixture>) => { f.setLiveContext({ ...f.ctx, projectIds: [] }) },
    ]) { const f = fixture(); await f.prepare(); f.archive(); mutate(f); await expect(f.service.evidence(f.ctx, uid(7))).rejects.toThrow() }
  })
  it('returns bounded pages with explicit totals, continuation, notes, coverage and durable manifest', async () => {
    const f = fixture(); await f.prepare(); f.archive()
    const first = await f.service.read(f.ctx, { extractionId: uid(7), view: 'records', limit: 1 })
    expect(first).toMatchObject({ complete: true, total: 1, offset: 0, nextOffset: null, data: f.records.records,
      documentNotes: f.records.document_notes, warnings: f.records.issues, coverage: { numericCandidates: 1, unresolved: 0 }, manifest: { sourceFileId: uid(4), recordsFileId: uid(5), imageFiles: [{ page: 1, fileId: uid(6) }] } })
    expect(JSON.stringify(first)).not.toContain('remoteJobId')
    expect(JSON.stringify(first)).not.toContain('storageUri')
    const empty = await f.service.read(f.ctx, { extractionId: uid(7), view: 'records', offset: 1 })
    expect(empty).toMatchObject({ total: 1, offset: 1, nextOffset: null, data: [] })
    await expect(f.service.read(f.ctx, { extractionId: uid(7), view: 'records', offset: 2 })).rejects.toMatchObject({ code: 'invalid_request' })
  })
  it('returns explicit noncomplete status, never empty evidence success', async () => {
    const f = fixture(); await f.prepare()
    await expect(f.service.read(f.ctx, { extractionId: uid(7) })).resolves.toMatchObject({ complete: false, status: 'prepared' })
    await expect(f.service.read(f.ctx, { extractionId: uid(7), view: 'records' })).rejects.toMatchObject({ code: 'not_complete' })
    await expect(f.propose()).rejects.toMatchObject({ code: 'not_complete' })
  })
  it('rejects missing/changed/under-scoped records and images, and incomplete manifests', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.blobs.delete(uid(5)) },
      (f: ReturnType<typeof fixture>) => { f.blobs.get(uid(5))!.bytes[0] = 0 },
      (f: ReturnType<typeof fixture>) => { f.blobs.get(uid(5))!.file.sensitivity = 'public' },
      (f: ReturnType<typeof fixture>) => { f.blobs.get(uid(6))!.file.projectIds = [] },
      (f: ReturnType<typeof fixture>) => { f.blobs.get(uid(6))!.bytes[8] = 0 },
      (f: ReturnType<typeof fixture>) => { f.job().imageFiles = [] },
      (f: ReturnType<typeof fixture>) => { f.job().pageNumbers = [2] },
      (f: ReturnType<typeof fixture>) => { f.blobs.get(uid(5))!.file.retractedAt = date() },
    ]) { const f = fixture(); await f.prepare(); f.archive(); mutate(f); await expect(f.service.evidence(f.ctx, uid(7))).rejects.toThrow(); expect(f.saveProposal).not.toHaveBeenCalled() }
  })
  it('reports oversized results rather than truncating warnings/context', async () => {
    const f = fixture(); await f.prepare(); f.records.limitations = ['x'.repeat(70_000)]; f.archive()
    await expect(f.service.read(f.ctx, { extractionId: uid(7) })).rejects.toMatchObject({ code: 'result_too_large' })
  })
  it('uses real records resolution + Office binder, saves only a suggestion and deterministic retry payload', async () => {
    const f = fixture(); await f.prepare(); f.archive()
    const before = structuredClone(f.live.snapshot)
    const first = await f.propose(); const second = await f.propose()
    expect(first).toMatchObject({ proposalId: uid(20), requiresHumanReview: true, status: 'suggested', preview: [{ rawText: '00123', proposedValue: '00123', valueType: 'string' }] })
    expect(second).toEqual(first)
    const payload = f.saveProposal.mock.calls[0]![0]
    expect(f.saveProposal.mock.calls[1]![0]).toEqual(payload)
    expect(payload).toMatchObject({ expectedSeq: 4, baseVersionId: uid(11), extractionId: uid(7), assistantId: uid(3), targetIds: [uid(9)], command: { kind: 'batch', commands: [{ kind: 'setSpreadsheetCell', value: '00123' }] }, lineage: { pdfSha256: f.job().pdfSha256, recordsSha256: f.job().recordsSha256, mappings: [{ source: cellRef }] } })
    expect(payload.body).toContain(f.job().pdfSha256)
    expect(payload.body).toContain('NOT an approved fact')
    expect(f.live.snapshot).toEqual(before)
    expect(f.files.writeBytes).not.toHaveBeenCalled(); expect(f.client.submit).not.toHaveBeenCalled()
  })
  it('requires current comment authority, compatible destination scopes and exact live/head versions', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.access.canComment = false },
      (f: ReturnType<typeof fixture>) => { f.artifact.sensitivity = 'public' },
      (f: ReturnType<typeof fixture>) => { f.artifact.compartments = [] },
      (f: ReturnType<typeof fixture>) => { f.artifact.projectIds = [] },
      (f: ReturnType<typeof fixture>) => { f.artifact.projectIds = ['project-a', 'not-granted'] },
      (f: ReturnType<typeof fixture>) => { f.artifact.lifecycleState = 'archived' },
      (f: ReturnType<typeof fixture>) => { f.artifact.mode = 'template' },
      (f: ReturnType<typeof fixture>) => { f.artifact.workspaceId = uid(99) },
      (f: ReturnType<typeof fixture>) => { f.artifact.headVersion = 4 },
      (f: ReturnType<typeof fixture>) => { f.live.baseVersion = 4 },
    ]) { const f = fixture(); await f.prepare(); f.archive(); mutate(f); await expect(f.propose()).rejects.toThrow(); expect(f.saveProposal).not.toHaveBeenCalled() }
  })
  it('includes archive high-water in proposal destination and tool result gates', async () => {
    const f = fixture(); await f.prepare(); f.archive()
    f.blobs.get(uid(5))!.file.compartments = ['team-a', 'team-b']
    await expect(f.propose()).rejects.toMatchObject({ code: 'destination_denied' })
    f.artifact.compartments.push('team-b')
    await expect(f.propose()).resolves.toMatchObject({ scopeEvidence: { compartments: ['team-a', 'team-b'] } })
  })
  it('rejects unsafe source mapping, formulas/locked or non-active-sheet targets, and free model values', async () => {
    for (const kind of ['conflict', 'formula', 'locked', 'inactive', 'model-value']) {
      const f = fixture(); await f.prepare()
      if (kind === 'conflict') f.records.records[0]!.cells[0]!.flags.push('conflicting_source_text')
      if (f.live.snapshot.family !== 'spreadsheet') throw new Error('fixture')
      if (kind === 'formula') f.live.snapshot.worksheets[0]!.cells[0]!.formula = '1+1'
      if (kind === 'locked') f.live.snapshot.worksheets[0]!.cells[0]!.locked = true
      if (kind === 'inactive') f.live.snapshot.activeSheetId = uid(99)
      if (kind === 'model-value') Object.assign(f.mapping, { value: 'invented' })
      f.archive(); await expect(f.propose()).rejects.toThrow(); expect(f.saveProposal).not.toHaveBeenCalled()
    }
  })
  it('sanitizes dependency errors and handles raced proposal persistence visibly', async () => {
    const f = fixture(); await f.prepare(); f.archive()
    f.saveProposal.mockRejectedValue(new Error('database token-secret vendor-body'))
    await expect(f.propose()).rejects.toMatchObject({ code: 'operation_failed', message: 'The operation could not be completed safely. Retry after checking source access and extraction status.' })
    f.saveProposal.mockResolvedValue(null as never)
    await expect(f.propose()).rejects.toMatchObject({ code: 'proposal_conflict' })
    expect(f.client.submit).not.toHaveBeenCalled()
  })
  it('does not re-enqueue failed/uncertain or cancelled extractions', async () => {
    const f = fixture(); await f.prepare()
    for (const status of ['failed', 'cancelled'] as const) {
      f.job().status = status
      await expect(f.service.start(f.ctx, { extractionId: uid(7) })).rejects.toMatchObject({ code: 'restart_required' })
    }
    expect(f.store.enqueue).not.toHaveBeenCalled()
    expect(f.client.submit).not.toHaveBeenCalled()
  })
  it('does not treat malformed destination scope arrays as universe grants', async () => {
    const f = fixture(); await f.prepare(); f.archive()
    f.artifact.compartments = null as never
    await expect(f.propose()).rejects.toMatchObject({ code: 'destination_denied' })
    expect(f.saveProposal).not.toHaveBeenCalled()
  })
  it('includes continuation for non-final pages without pretending extraction is complete evidence selection', async () => {
    const f = fixture(); await f.prepare()
    f.records.entities.push({ ...f.records.entities[0]!, id: 'e2' })
    f.archive()
    await expect(f.service.read(f.ctx, { extractionId: uid(7), view: 'entities', limit: 1 })).resolves.toMatchObject({ total: 2, nextOffset: 1, offset: 0 })
    await expect(f.service.read(f.ctx, { extractionId: uid(7), view: 'entities', limit: 1, offset: 1 })).resolves.toMatchObject({ total: 2, nextOffset: null, offset: 1 })
  })

})
