import { Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceFile, WorkspaceFilesStore } from '@use-brian/core'
import type {
  CreateWorkspaceFileUpload,
  WorkspaceFileUpload,
  WorkspaceFileUploadsStore,
} from '../../db/workspace-file-uploads-store.js'
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
      filesStore: files,
      uploadsStore: uploads,
      auditStore: { append: vi.fn(), list: vi.fn() },
      ...(storageLimitBytesFor ? { storageLimitBytesFor } : {}),
    })
  }

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
