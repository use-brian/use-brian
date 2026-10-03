import { Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessContext, FilesContext, WorkspaceFile, WorkspaceFilesStore } from '@use-brian/core'
import type {
  CreateWorkspaceFileUpload,
  WorkspaceFileUpload,
  WorkspaceFileUploadsStore,
} from '../../db/workspace-file-uploads-store.js'
import { buildAccessPredicate } from '../../db/access-predicate.js'
import { runWithAgentAccess } from '../../db/agent-access-context.js'
import type { GcsFilesClient } from '../gcs-client.js'
import {
  CHUNKED_UPLOAD_PART_BYTES,
  ChunkedUploadError,
  chunkedUploadPartKey,
  createChunkedFileUploadService,
} from '../chunked-upload.js'

function fakeGcs(): GcsFilesClient & { blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>()
  return {
    blobs,
    async writeBlob(key, bytes) { blobs.set(key, bytes) },
    async appendBlob() { throw new Error('unused') },
    async readBlob(key) {
      const bytes = blobs.get(key)
      return bytes ? { bytes, mime: 'application/octet-stream', metadata: { workspaceId: 'ws-1', mime: 'application/octet-stream' } } : null
    },
    async statBlob(key) {
      const bytes = blobs.get(key)
      return bytes ? { sizeBytes: bytes.length, mime: 'application/octet-stream', updatedAt: null } : null
    },
    async deleteBlob(key) { blobs.delete(key) },
    async signedReadUrl(key) { return `https://storage.example/${key}` },
    async signedWriteUrl(key) { return `https://storage.example/${key}?write=1` },
    writeStream(key) {
      const chunks: Buffer[] = []
      return new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk))
          callback()
        },
        final(callback) {
          blobs.set(key, Buffer.concat(chunks))
          callback()
        },
      })
    },
  }
}

function fakeUploadsStore(): WorkspaceFileUploadsStore & { rows: Map<string, WorkspaceFileUpload> } {
  const rows = new Map<string, WorkspaceFileUpload>()
  return {
    rows,
    async create(_userId, input: CreateWorkspaceFileUpload) {
      const timestamp = new Date()
      const row: WorkspaceFileUpload = {
        ...input,
        status: 'pending',
        completedAt: null,
        partsDeletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      rows.set(row.id, row)
      return row
    },
    async get(userId, id) {
      const row = rows.get(id)
      return row?.actingUserId === userId ? row : null
    },
    async claim(_userId, id) {
      const row = rows.get(id)
      if (!row || row.status !== 'pending') return null
      row.status = 'assembling'
      return row
    },
    async resetPending(_userId, id) {
      const row = rows.get(id)
      if (row?.status === 'assembling') row.status = 'pending'
    },
    async markCompleted(_userId, id) {
      const row = rows.get(id)
      if (row) {
        row.status = 'completed'
        row.completedAt = new Date()
      }
    },
    async markAborted(_userId, id) {
      const row = rows.get(id)
      if (row && row.status !== 'completed') row.status = 'aborted'
    },
    async markAbortedSystem(id) {
      const row = rows.get(id)
      if (row && row.status !== 'completed') row.status = 'aborted'
    },
    async markPartsDeletedSystem(id) {
      const row = rows.get(id)
      if (row) row.partsDeletedAt = new Date()
    },
    async listExpiredSystem() {
      return [...rows.values()].filter((row) =>
        row.status !== 'completed' && row.status !== 'aborted' && row.expiresAt.getTime() <= Date.now())
    },
    async listCompletedWithPartsSystem() {
      return [...rows.values()].filter((row) => row.status === 'completed' && !row.partsDeletedAt)
    },
  }
}

function fakeFilesStore(): WorkspaceFilesStore & { rows: Map<string, WorkspaceFile> } {
  const rows = new Map<string, WorkspaceFile>()
  return {
    rows,
    async create(_userId, input) {
      const timestamp = new Date()
      const row = {
        id: input.id!, workspaceId: input.workspaceId, path: input.path,
        parentPath: input.parentPath, name: input.name, title: input.title ?? null,
        summary: input.summary ?? null, mime: input.mime, sizeBytes: input.sizeBytes,
        tags: input.tags ?? [], relatedIds: input.relatedIds ?? [], storageUri: input.storageUri,
        sensitivity: input.sensitivity ?? 'internal', metadata: input.metadata ?? {},
        userId: input.userId ?? null, assistantId: input.assistantId ?? null,
        source: input.source ?? 'user', sourceEpisodeId: input.sourceEpisodeId ?? null,
        verifiedByUserId: null, verifiedAt: null, validFrom: timestamp, validTo: null,
        supersededBy: null, retractedAt: null, retractedReason: null, retractedBy: null,
        createdByUserId: input.createdByUserId ?? null,
        createdByAssistantId: input.createdByAssistantId ?? null,
        createdAt: timestamp, updatedAt: timestamp,
      } satisfies WorkspaceFile
      rows.set(row.id, row)
      return row
    },
    async getById(ctx, id) {
      const row = rows.get(id)
      return row?.workspaceId === ctx.workspaceId ? row : null
    },
    async getByPath(ctx, path) {
      return [...rows.values()].find((row) => row.workspaceId === ctx.workspaceId && row.path === path) ?? null
    },
    async sumSizeBytes(ctx) {
      return [...rows.values()].filter((row) => row.workspaceId === ctx.workspaceId)
        .reduce((sum, row) => sum + row.sizeBytes, 0)
    },
    async updateMeta() { return null },
    async updateSize() { return null },
    async delete() { return false },
    async listByPath() { return [] },
    async searchByText() { return [] },
    async listIndexRanked() { return [] },
    async supersede() { return null },
    async getHistory() { return [] },
    async retractByStorageBucketSystem() { return 0 },
  }
}

describe('[COMP:files/chunked-upload] durable direct upload', () => {
  const ctx = {
    workspaceId: 'ws-1',
    userId: 'user-1',
    assistantId: 'assistant-1',
    assistantKind: 'primary' as const,
    clearance: 'internal' as const,
    compartments: [],
  }
  let gcs: ReturnType<typeof fakeGcs>
  let uploads: ReturnType<typeof fakeUploadsStore>
  let files: ReturnType<typeof fakeFilesStore>

  beforeEach(() => {
    gcs = fakeGcs()
    uploads = fakeUploadsStore()
    files = fakeFilesStore()
  })

  function service(storageLimitBytesFor?: (workspaceId: string) => Promise<number>) {
    return createChunkedFileUploadService({
      resolver: {
        async forWorkspace() { return { gcs, bucket: 'bucket', byo: false } },
        async forUri() { return gcs },
      },
      filesStore: {...files, async finalizeUpload(actor,input,id,access) {
        const file=await files.create(actor,input,access)
        await uploads.markCompleted(actor,id)
        return file
      }},
      uploadsStore: uploads,
      auditStore: { append: vi.fn(), list: vi.fn() },
      ...(storageLimitBytesFor ? { storageLimitBytesFor } : {}),
    })
  }

  const human = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
  }
  const assistantId = '33333333-3333-4333-8333-333333333333'
  const projectId = '44444444-4444-4444-8444-444444444444'

  it.each([
    { label: 'human recording', extra: {}, kind: 'primary', visibility: [] },
    { label: 'scoped human', extra: { scopeAssistantId: assistantId }, kind: 'primary', visibility: [assistantId] },
    { label: 'default standard assistant', extra: { assistantId }, kind: 'standard', visibility: undefined },
    { label: 'explicit standard assistant', extra: { assistantId, assistantKind: 'standard' as const }, kind: 'standard', visibility: undefined },
    { label: 'explicit app assistant', extra: { assistantId, assistantKind: 'app' as const }, kind: 'app', visibility: undefined },
    { label: 'explicit primary assistant', extra: { assistantId, assistantKind: 'primary' as const }, kind: 'primary', visibility: undefined },
  ])('keeps $label SQL access safe through start, complete and repair', async ({ extra, kind, visibility }) => {
    const caller: FilesContext = { ...human, ...extra }
    const contexts: AccessContext[] = []
    const inspect = (access: AccessContext) => {
      contexts.push(access)
      expect(access).toMatchObject({ ...human, assistantId: caller.assistantId ?? '', assistantKind: kind })
      expect(access.visibilityAssistantIds).toEqual(visibility)
      const predicate = buildAccessPredicate(access)
      expect(predicate.params.flat()).not.toContain('')
      const base = '(workspace_id IS NULL OR workspace_id = $1) AND (user_id IS NULL OR user_id = $2)'
      if (visibility !== undefined) {
        expect(predicate.sql).toBe(`${base} AND TRUE AND (assistant_id IS NULL OR assistant_id = ANY($3::uuid[]))`)
        expect(predicate.params).toEqual([human.workspaceId, human.userId, visibility])
      } else if (kind !== 'primary') {
        expect(predicate.sql).toBe(`${base} AND (assistant_id IS NULL OR assistant_id = $3)`)
        expect(predicate.params).toEqual([human.workspaceId, human.userId, assistantId])
      } else {
        expect(predicate.sql).toBe(base)
        expect(predicate.params).toEqual([human.workspaceId, human.userId])
      }
    }
    const sumSizeBytes = files.sumSizeBytes.bind(files)
    vi.spyOn(files, 'sumSizeBytes').mockImplementation(async (access) => {
      inspect(access)
      return sumSizeBytes(access)
    })
    for (const method of ['getByPath', 'getById'] as const) {
      const original = files[method].bind(files)
      // All read entry points build the actual production predicate, not a
      // fake store's workspace-only approximation of assistant visibility.
      vi.spyOn(files, method).mockImplementation(async (access: AccessContext, value: string) => {
        inspect(access)
        return original(access, value)
      })
    }
    const create = vi.spyOn(files, 'create')
    const admit = vi.spyOn(uploads, 'create')
    const uploader = service()
    const started = await uploader.start(caller, { fileName: 'recording.webm', mime: 'audio/webm', sizeBytes: 3 })
    expect(contexts).toHaveLength(2)
    expect(admit.mock.calls[0][1].assistantId).toBe(caller.assistantId ?? null)
    inspect(admit.mock.calls[0][1].access!)
    const upload = uploads.rows.get(started.uploadId)!
    gcs.blobs.set(chunkedUploadPartKey(upload, 0), Buffer.from([1, 2, 3]))
    const file = await uploader.complete(caller, started.uploadId)
    expect(contexts).toHaveLength(6)
    inspect(create.mock.calls[0][2]!)
    expect(file.createdByUserId).toBe(human.userId)
    expect(file.createdByAssistantId).toBeNull()
    await expect(uploader.complete(caller, started.uploadId)).resolves.toEqual(file)
    expect(contexts).toHaveLength(8)
  })

  it('preserves supplied scope axes and intersects ambient read restrictions', async () => {
    const caller: FilesContext = {
      ...human, scopeAssistantId: assistantId, clearance: 'confidential',
      compartments: ['team-a', 'team-b'], mutationCompartments: ['team-b'], projectIds: [projectId],
    }
    files.getByPath = async (access) => {
      expect(access).toMatchObject({
        clearance: caller.clearance, compartments: caller.compartments,
        mutationCompartments: caller.mutationCompartments, projectIds: caller.projectIds,
        visibilityAssistantIds: [assistantId],
      })
      const predicate = buildAccessPredicate(access)
      expect(predicate.params).toEqual([human.workspaceId, human.userId, 'internal', ['team-a'], [], []])
      expect(predicate.sql).toContain('sensitivity_rank(sensitivity) <= sensitivity_rank($3)')
      expect(predicate.sql).toContain('compartments <@ $4::text[]')
      expect(predicate.sql).toContain('project_ids <@ $5::uuid[]')
      expect(predicate.sql).toContain('(assistant_id IS NULL OR assistant_id = ANY($6::uuid[]))')
      return null
    }
    await runWithAgentAccess({
      ...human, clearance: 'internal', compartments: ['team-a'], projectIds: [],
      visibilityAssistantIds: ['55555555-5555-4555-8555-555555555555'],
    }, () => service().start(caller, { fileName: 'recording.webm', mime: 'audio/webm', sizeBytes: 3 }))
  })

  // The open boot's default resolver: a self-host's bucket is its own, so the
  // gate must accept an infinite limit rather than treat it as "unknown plan".
  it('accepts an unlimited storage resolver (the self-host default) without a quota gate', async () => {
    const GIB = 1024 * 1024 * 1024
    files.sumSizeBytes = async () => 500 * GIB
    const selfHost = service(async () => Number.POSITIVE_INFINITY)
    const started = await selfHost.start(ctx, {
      fileName: 'archive.pdf', mime: 'application/pdf', sizeBytes: 9 * GIB,
    })
    expect(started.uploadId).toBeTruthy()
    await expect(
      selfHost.start(ctx, { fileName: 'too-big.pdf', mime: 'application/pdf', sizeBytes: 11 * GIB }),
    ).rejects.toMatchObject({ kind: 'too_large', message: 'File exceeds the 10 GiB upload limit' })
  })

  it('gates start() on the injected plan-derived storage limit', async () => {
    const GIB = 1024 * 1024 * 1024
    files.sumSizeBytes = async () => 21 * GIB
    const proUploader = service(async () => 20 * GIB)
    await expect(
      proUploader.start(ctx, { fileName: 'big.mov', mime: 'video/quicktime', sizeBytes: 1024 }),
    ).rejects.toMatchObject({ kind: 'quota_exceeded' })
    const maxUploader = service(async () => 200 * GIB)
    const started = await maxUploader.start(ctx, {
      fileName: 'big.mov', mime: 'video/quicktime', sizeBytes: 1024,
    })
    expect(started.uploadId).toBeTruthy()
  })

  it('verifies exact parts, stream-assembles the final object, and removes staging bytes', async () => {
    const uploader = service()
    const sizeBytes = CHUNKED_UPLOAD_PART_BYTES + 3
    const started = await uploader.start(ctx, {
      fileName: 'catalog.pdf',
      mime: 'application/pdf',
      sizeBytes,
    })
    const upload = uploads.rows.get(started.uploadId)!
    gcs.blobs.set(chunkedUploadPartKey(upload, 0), Buffer.alloc(CHUNKED_UPLOAD_PART_BYTES, 1))
    gcs.blobs.set(chunkedUploadPartKey(upload, 1), Buffer.from([2, 3, 4]))

    const file = await uploader.complete(ctx, started.uploadId)

    expect(file).toMatchObject({ id: started.fileId, path: '/uploads/catalog.pdf', sizeBytes })
    expect(gcs.blobs.get(`ws-1/${started.fileId}`)).toHaveLength(sizeBytes)
    await vi.waitFor(() => {
      expect(gcs.blobs.has(chunkedUploadPartKey(upload, 0))).toBe(false)
      expect(gcs.blobs.has(chunkedUploadPartKey(upload, 1))).toBe(false)
      expect(upload.partsDeletedAt).toBeInstanceOf(Date)
    })
    expect(upload.status).toBe('completed')
  })

  it('does not create a workspace file when a part has the wrong size', async () => {
    const uploader = service()
    const started = await uploader.start(ctx, {
      fileName: 'catalog.pdf',
      mime: 'application/pdf',
      sizeBytes: CHUNKED_UPLOAD_PART_BYTES + 1,
    })
    const upload = uploads.rows.get(started.uploadId)!
    gcs.blobs.set(chunkedUploadPartKey(upload, 0), Buffer.alloc(3))
    gcs.blobs.set(chunkedUploadPartKey(upload, 1), Buffer.alloc(1))

    await expect(uploader.complete(ctx, started.uploadId)).rejects.toMatchObject({
      kind: 'incomplete',
    } satisfies Partial<ChunkedUploadError>)
    expect(files.rows.size).toBe(0)
    expect(upload.status).toBe('pending')
  })
})
