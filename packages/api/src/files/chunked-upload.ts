/**
 * Direct-to-storage multipart upload orchestration for large durable files.
 *
 * API requests carry only metadata. The browser PUTs exact 8 MiB parts to
 * signed backend URLs, then this service verifies and assembles them while
 * holding at most one part in process memory.
 *
 * [COMP:files/chunked-upload]
 */

import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  AccessContext,
  FilesContext,
  WorkspaceFile,
  WorkspaceFilesStore,
} from '@use-brian/core'
import type { WorkspaceAuditStore } from '../db/workspace-audit-store.js'
import type {
  WorkspaceFileUpload,
  WorkspaceFileUploadsStore,
} from '../db/workspace-file-uploads-store.js'
import {
  MAX_BYTES_PER_WORKSPACE,
  type FilesClientResolver,
} from './files-api.js'
import { buildStorageKey, buildStorageUri } from './gcs-client.js'

export const CHUNKED_UPLOAD_PART_BYTES = 8 * 1024 * 1024
export const MAX_CHUNKED_UPLOAD_BYTES = 1024 * 1024 * 1024
export const CHUNKED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000

export type ChunkedUploadErrorKind =
  | 'invalid'
  | 'too_large'
  | 'not_found'
  | 'expired'
  | 'busy'
  | 'incomplete'
  | 'conflict'
  | 'quota_exceeded'

export class ChunkedUploadError extends Error {
  constructor(
    readonly kind: ChunkedUploadErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'ChunkedUploadError'
  }
}

export type ChunkedUploadPart = {
  index: number
  offset: number
  sizeBytes: number
  url: string
}

export type ChunkedUploadStart = {
  uploadId: string
  fileId: string
  chunkSizeBytes: number
  expiresAt: string
  parts: ChunkedUploadPart[]
}

export type ChunkedFileUploadService = {
  start(
    ctx: FilesContext,
    input: { fileName: string; mime: string; sizeBytes: number },
  ): Promise<ChunkedUploadStart>
  complete(ctx: FilesContext, uploadId: string): Promise<WorkspaceFile>
  abort(ctx: FilesContext, uploadId: string): Promise<void>
  sweepExpired(): Promise<number>
}

export type CreateChunkedFileUploadServiceDeps = {
  resolver: FilesClientResolver
  filesStore: WorkspaceFilesStore
  uploadsStore: WorkspaceFileUploadsStore
  auditStore: WorkspaceAuditStore
  now?: () => Date
}

function accessCtx(ctx: FilesContext): AccessContext {
  return {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    assistantId: ctx.assistantId ?? ctx.userId,
    assistantKind: ctx.assistantKind ?? 'standard',
    clearance: ctx.clearance,
    compartments: ctx.compartments,
  }
}

function safeFileName(raw: string): string {
  const name = raw.trim().split(/[\\/]/).pop()?.trim() ?? ''
  if (!name || name === '.' || name === '..' || name.includes('\0')) {
    throw new ChunkedUploadError('invalid', 'fileName is invalid')
  }
  return name
}

export function chunkedUploadPartKey(upload: Pick<WorkspaceFileUpload, 'workspaceId' | 'id'>, index: number): string {
  return `${upload.workspaceId}/.uploads/${upload.id}/${String(index).padStart(6, '0')}`
}

function expectedPartSize(upload: Pick<WorkspaceFileUpload, 'sizeBytes' | 'chunkSizeBytes' | 'partCount'>, index: number): number {
  if (index < upload.partCount - 1) return upload.chunkSizeBytes
  return upload.sizeBytes - upload.chunkSizeBytes * (upload.partCount - 1)
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505')
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(values[index])
    }
  })
  await Promise.all(workers)
  return results
}

export function createChunkedFileUploadService(
  deps: CreateChunkedFileUploadServiceDeps,
): ChunkedFileUploadService {
  const now = deps.now ?? (() => new Date())

  async function getOwned(ctx: FilesContext, uploadId: string): Promise<WorkspaceFileUpload> {
    const upload = await deps.uploadsStore.get(ctx.userId, uploadId)
    if (!upload || upload.workspaceId !== ctx.workspaceId || upload.actingUserId !== ctx.userId) {
      throw new ChunkedUploadError('not_found', 'Upload not found')
    }
    return upload
  }

  async function deleteParts(upload: WorkspaceFileUpload): Promise<void> {
    const gcs = await deps.resolver.forUri(upload.workspaceId, upload.storageUri)
    const indexes = Array.from({ length: upload.partCount }, (_, index) => index)
    await mapConcurrent(indexes, 8, async (index) => {
      await gcs.deleteBlob(chunkedUploadPartKey(upload, index))
    })
    await deps.uploadsStore.markPartsDeletedSystem(upload.id)
  }

  async function repairCompleted(ctx: FilesContext, upload: WorkspaceFileUpload): Promise<WorkspaceFile | null> {
    const file = await deps.filesStore.getById(accessCtx(ctx), upload.fileId)
    if (!file) return null
    await deps.uploadsStore.markCompleted(ctx.userId, upload.id)
    void deleteParts(upload).catch((err) => {
      console.warn(`[chunked-upload] part cleanup failed for completed upload ${upload.id}:`, err)
    })
    return file
  }

  return {
    async start(ctx, input) {
      if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
        throw new ChunkedUploadError('invalid', 'sizeBytes must be a positive integer')
      }
      if (input.sizeBytes > MAX_CHUNKED_UPLOAD_BYTES) {
        throw new ChunkedUploadError('too_large', 'File exceeds the 1 GiB upload limit')
      }
      const name = safeFileName(input.fileName)
      const path = `/uploads/${name}`
      const ac = accessCtx(ctx)
      if (await deps.filesStore.getByPath(ac, path)) {
        throw new ChunkedUploadError('conflict', 'A file with that name already exists')
      }

      const resolved = await deps.resolver.forWorkspace(ctx.workspaceId)
      if (!resolved.byo) {
        const currentBytes = await deps.filesStore.sumSizeBytes(ac)
        if (currentBytes + input.sizeBytes > MAX_BYTES_PER_WORKSPACE) {
          throw new ChunkedUploadError('quota_exceeded', 'Workspace storage quota exceeded')
        }
      }

      const uploadId = randomUUID()
      const fileId = randomUUID()
      const partCount = Math.ceil(input.sizeBytes / CHUNKED_UPLOAD_PART_BYTES)
      const expiresAt = new Date(now().getTime() + CHUNKED_UPLOAD_TTL_MS)
      const upload = await deps.uploadsStore.create(ctx.userId, {
        id: uploadId,
        workspaceId: ctx.workspaceId,
        actingUserId: ctx.userId,
        assistantId: ctx.assistantId ?? null,
        fileId,
        path,
        name,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        chunkSizeBytes: CHUNKED_UPLOAD_PART_BYTES,
        partCount,
        storageUri: buildStorageUri(
          resolved.bucket,
          ctx.workspaceId,
          fileId,
          resolved.uriScheme,
        ),
        quotaExempt: resolved.byo ?? false,
        expiresAt,
      })

      try {
        const indexes = Array.from({ length: partCount }, (_, index) => index)
        const parts = await mapConcurrent(indexes, 16, async (index) => ({
          index,
          offset: index * CHUNKED_UPLOAD_PART_BYTES,
          sizeBytes: expectedPartSize(upload, index),
          url: await resolved.gcs.signedWriteUrl(chunkedUploadPartKey(upload, index), {
            contentType: 'application/octet-stream',
            ttlSec: Math.ceil(CHUNKED_UPLOAD_TTL_MS / 1000),
          }),
        }))
        return {
          uploadId,
          fileId,
          chunkSizeBytes: CHUNKED_UPLOAD_PART_BYTES,
          expiresAt: expiresAt.toISOString(),
          parts,
        }
      } catch (err) {
        await deps.uploadsStore.markAborted(ctx.userId, uploadId).catch(() => undefined)
        throw err
      }
    },

    async complete(ctx, uploadId) {
      let upload = await getOwned(ctx, uploadId)
      const repaired = await repairCompleted(ctx, upload)
      if (repaired) return repaired
      if (upload.status === 'aborted') {
        throw new ChunkedUploadError('not_found', 'Upload not found')
      }
      if (upload.expiresAt.getTime() <= now().getTime()) {
        await this.abort(ctx, uploadId)
        throw new ChunkedUploadError('expired', 'Upload expired')
      }

      const claimed = await deps.uploadsStore.claim(ctx.userId, uploadId)
      if (!claimed) {
        upload = await getOwned(ctx, uploadId)
        const recovered = await repairCompleted(ctx, upload)
        if (recovered) return recovered
        throw new ChunkedUploadError('busy', 'Upload is already being completed')
      }
      upload = claimed

      const gcs = await deps.resolver.forUri(upload.workspaceId, upload.storageUri)
      const indexes = Array.from({ length: upload.partCount }, (_, index) => index)
      let finalWritten = false
      let fileCreated = false
      try {
        const stats = await mapConcurrent(indexes, 8, (index) =>
          gcs.statBlob(chunkedUploadPartKey(upload, index)),
        )
        for (let index = 0; index < stats.length; index += 1) {
          if (!stats[index] || stats[index]?.sizeBytes !== expectedPartSize(upload, index)) {
            throw new ChunkedUploadError('incomplete', `Upload part ${index + 1} is missing or incomplete`)
          }
        }

        const ac = accessCtx(ctx)
        if (await deps.filesStore.getByPath(ac, upload.path)) {
          throw new ChunkedUploadError('conflict', 'A file with that name already exists')
        }
        if (!upload.quotaExempt) {
          const currentBytes = await deps.filesStore.sumSizeBytes(ac)
          if (currentBytes + upload.sizeBytes > MAX_BYTES_PER_WORKSPACE) {
            throw new ChunkedUploadError('quota_exceeded', 'Workspace storage quota exceeded')
          }
        }

        const source = Readable.from((async function* () {
          for (const index of indexes) {
            const part = await gcs.readBlob(chunkedUploadPartKey(upload, index))
            if (!part || part.bytes.length !== expectedPartSize(upload, index)) {
              throw new ChunkedUploadError('incomplete', `Upload part ${index + 1} changed during assembly`)
            }
            yield part.bytes
          }
        })())
        const finalKey = buildStorageKey(upload.workspaceId, upload.fileId)
        await pipeline(source, gcs.writeStream(finalKey, {
          mime: upload.mime,
          metadata: {
            workspaceId: upload.workspaceId,
            createdByUserId: upload.actingUserId,
            createdByAssistantId: upload.assistantId ?? undefined,
            mime: upload.mime,
          },
        }))
        finalWritten = true

        const file = await deps.filesStore.create(ctx.userId, {
          id: upload.fileId,
          workspaceId: upload.workspaceId,
          path: upload.path,
          parentPath: '/uploads',
          name: upload.name,
          mime: upload.mime,
          sizeBytes: upload.sizeBytes,
          storageUri: upload.storageUri,
          title: upload.name,
          sensitivity: 'internal',
          createdByUserId: upload.actingUserId,
          createdByAssistantId: upload.assistantId,
        })
        fileCreated = true
        await deps.uploadsStore.markCompleted(ctx.userId, upload.id)
        void deps.auditStore.append({
          workspaceId: upload.workspaceId,
          actorUserId: upload.actingUserId,
          eventType: 'file.created',
          subjectId: file.id,
          details: {
            path: file.path,
            mime: file.mime,
            size_bytes: file.sizeBytes,
            ...(upload.assistantId ? { assistant_id: upload.assistantId } : {}),
            upload_transport: 'chunked',
          },
        })
        void deleteParts(upload).catch((err) => {
          console.warn(`[chunked-upload] part cleanup failed for ${upload.id}:`, err)
        })
        return file
      } catch (err) {
        if (finalWritten && !fileCreated) {
          await gcs.deleteBlob(buildStorageKey(upload.workspaceId, upload.fileId)).catch((deleteErr) => {
            console.warn(`[chunked-upload] final-object rollback failed for ${upload.id}:`, deleteErr)
          })
        }
        if (!fileCreated) {
          await deps.uploadsStore.resetPending(ctx.userId, upload.id).catch(() => undefined)
        }
        if (isUniqueViolation(err)) {
          throw new ChunkedUploadError('conflict', 'A file with that name already exists')
        }
        throw err
      }
    },

    async abort(ctx, uploadId) {
      const upload = await getOwned(ctx, uploadId)
      if (upload.status === 'completed') return
      await deleteParts(upload)
      await deps.uploadsStore.markAborted(ctx.userId, uploadId)
    },

    async sweepExpired() {
      const [expired, completed] = await Promise.all([
        deps.uploadsStore.listExpiredSystem(),
        deps.uploadsStore.listCompletedWithPartsSystem(),
      ])
      let cleaned = 0
      for (const upload of [...expired, ...completed]) {
        try {
          await deleteParts(upload)
          if (upload.status !== 'completed') {
            await deps.uploadsStore.markAbortedSystem(upload.id)
          }
          cleaned += 1
        } catch (err) {
          console.warn(`[chunked-upload] expiry cleanup failed for ${upload.id}:`, err)
        }
      }
      return cleaned
    },
  }
}
