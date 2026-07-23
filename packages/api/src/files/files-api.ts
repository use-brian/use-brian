/**
 * Files API orchestration — stitches the GCS bytes layer
 * (`gcs-client.ts`) and the workspace_files index store
 * (`packages/api/src/db/workspace-files-store.ts`) into the `FilesApi`
 * the chat tools call. Owns:
 *   - quota enforcement (MAX_BYTES_PER_WORKSPACE)
 *   - GCS-then-DB ordering on writes (with best-effort blob rollback on
 *     DB failure)
 *   - audit emission via `workspace_audit_store`
 *   - id-or-path resolution
 *
 * See docs/architecture/features/files.md.
 */

import { randomUUID } from 'node:crypto'
import type {
  AccessContext,
  FilesApi,
  FilesContext,
  FilesError,
  FilesReadBytesResult,
  FilesReadResult,
  FilesResult,
  FilesSearchParams,
  FilesWriteParams,
  WorkspaceFile,
  WorkspaceFileIndexRow,
  WorkspaceFileMetaPatch,
  WorkspaceFilesStore,
} from '@use-brian/core'
import type { GcsFilesClient } from './gcs-client.js'
import { buildStorageKey, buildStorageUri, type StorageUriScheme } from './gcs-client.js'
import type { WorkspaceAuditStore } from '../db/workspace-audit-store.js'

/**
 * Per-workspace resolution of the bytes-layer client. The default
 * (app-bucket) resolver is byte-identical to the historical singleton; the
 * bring-your-own-storage overlay supplies a resolver that points a workspace
 * at its own GCS bucket under its own service-account key. See
 * docs/plans/byo-google-storage.md and docs/architecture/features/files.md.
 *
 * Lives in `packages/api` (not core) because it references `GcsFilesClient`,
 * which is a bytes-layer type — core depends on api, not the reverse.
 */
export type ResolvedFilesClient = {
  gcs: GcsFilesClient
  /** Bucket name for `storage_uri` composition on writes. */
  bucket: string
  /**
   * URI scheme for `storage_uri` composition on writes: `gs` for GCS buckets
   * (default), `s3` for S3-compatible buckets. Cosmetic for routing (reads
   * match by bucket name) but keeps each file's origin backend legible.
   */
  uriScheme?: StorageUriScheme
  /**
   * True when this workspace writes to its OWN (BYO) bucket. Lifts the
   * platform soft quota (their bucket, their bill). Default resolver: false.
   */
  byo?: boolean
}

export type FilesClientResolver = {
  /** Client + bucket a workspace's NEW writes should target. */
  forWorkspace(workspaceId: string): Promise<ResolvedFilesClient>
  /**
   * Client for an EXISTING file, routed by the bucket recorded in its
   * `storage_uri` — so files written before a BYO switch still resolve to
   * the bucket they actually live in. `workspaceId` lets a BYO resolver fetch
   * the right credentials for that workspace's own bucket.
   */
  forUri(workspaceId: string, storageUri: string): Promise<GcsFilesClient>
}

/**
 * The historical behavior: one app client + one env bucket for every
 * workspace. Used directly in open core / OSS and as the fallback the BYO
 * resolver delegates to when a workspace has no binding.
 */
export function createSingletonFilesClientResolver(
  gcs: GcsFilesClient,
  bucket: string,
  uriScheme?: StorageUriScheme,
): FilesClientResolver {
  return {
    async forWorkspace() {
      return { gcs, bucket, ...(uriScheme ? { uriScheme } : {}), byo: false }
    },
    async forUri(_workspaceId: string, _storageUri: string) {
      return gcs
    },
  }
}

/**
 * Build an `AccessContext` from a `FilesContext`. The visibility-double
 * predicate compares `assistant_id` for equality, so callers without an
 * assistant set get the userId echoed in — workspace-shared rows
 * (`assistant_id IS NULL`) still match. Same shape WU-4.2b uses
 * elsewhere for non-chat callers.
 */
function accessCtx(ctx: FilesContext): AccessContext {
  return {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    assistantId: ctx.assistantId ?? ctx.userId,
    assistantKind: ctx.assistantKind ?? 'standard',
    clearance: ctx.clearance,
  }
}

/** 1 GB soft cap per workspace. Bumpable via env in a future ticket. */
export const MAX_BYTES_PER_WORKSPACE = 1024 * 1024 * 1024

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}

/** Normalize an absolute-or-leading-slash workspace path to a canonical form. */
function normalizePath(path: string): string {
  const trimmed = path.trim()
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.replace(/\/+/g, '/').replace(/\/+$/, '') || '/'
}

function deriveParentPath(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx)
}

function deriveName(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

const EXTENSION_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  xml: 'application/xml',
  js: 'application/javascript',
  ts: 'application/typescript',
  py: 'text/x-python',
}

function inferMime(name: string, fallback: string | undefined): string {
  if (fallback && fallback.length > 0) return fallback
  const dot = name.lastIndexOf('.')
  if (dot === -1 || dot === name.length - 1) return 'text/plain'
  const ext = name.slice(dot + 1).toLowerCase()
  return EXTENSION_MIME[ext] ?? 'text/plain'
}

function err<T>(error: FilesError): FilesResult<T> {
  return { ok: false, error }
}

function ok<T>(value: T): FilesResult<T> {
  return { ok: true, value }
}

export type CreateFilesApiDeps = {
  store: WorkspaceFilesStore
  auditStore: WorkspaceAuditStore
} & (
  | {
      /** Per-workspace bytes-client resolver (BYO-aware). */
      resolver: FilesClientResolver
      gcs?: never
      bucket?: never
    }
  | {
      /**
       * Legacy single-client form. Internally wrapped in a singleton
       * resolver — kept so existing call sites and tests pass `{ gcs, bucket }`
       * unchanged.
       */
      gcs: GcsFilesClient
      /** GCS bucket name for storage_uri composition. */
      bucket: string
      resolver?: never
    }
)

export function createFilesApi(deps: CreateFilesApiDeps): FilesApi {
  const { store, auditStore } = deps
  const resolver: FilesClientResolver =
    deps.resolver ?? createSingletonFilesClientResolver(deps.gcs, deps.bucket)

  async function resolveByIdOrPath(
    ctx: FilesContext,
    idOrPath: string,
  ): Promise<WorkspaceFile | null> {
    const ac = accessCtx(ctx)
    if (isUuid(idOrPath)) {
      return store.getById(ac, idOrPath)
    }
    return store.getByPath(ac, normalizePath(idOrPath))
  }

  function logAudit(
    ctx: FilesContext,
    eventType: 'file.created' | 'file.appended' | 'file.meta_updated' | 'file.deleted',
    file: { id: string; path: string; mime?: string; sizeBytes?: number },
    extra?: Record<string, unknown>,
  ): void {
    void auditStore.append({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      eventType,
      subjectId: file.id,
      details: {
        path: file.path,
        ...(file.mime ? { mime: file.mime } : {}),
        ...(file.sizeBytes !== undefined ? { size_bytes: file.sizeBytes } : {}),
        ...(ctx.assistantId ? { assistant_id: ctx.assistantId } : {}),
        ...(extra ?? {}),
      },
    })
  }

  /**
   * Shared create path for both `write` (UTF-8 text) and `writeBytes` (raw
   * binary). Owns quota → GCS-then-DB ordering → blob rollback → audit. The
   * only difference between the two public methods is how the `bytes`/`mime`
   * are derived before they reach here.
   */
  async function persist(
    ctx: FilesContext,
    p: {
      path: string
      bytes: Buffer
      mime: string
      title?: string | null
      summary?: string | null
      tags?: string[]
      sensitivity?: FilesWriteParams['sensitivity']
    },
  ): Promise<FilesResult<WorkspaceFile>> {
    const path = normalizePath(p.path)
    const parentPath = deriveParentPath(path)
    const name = deriveName(path)
    const { mime, bytes } = p

    const ac = accessCtx(ctx)
    const existing = await store.getByPath(ac, path)
    if (existing) {
      return err({ kind: 'conflict', path })
    }

    const { gcs, bucket, byo, uriScheme } = await resolver.forWorkspace(ctx.workspaceId)

    // Soft quota guards bytes that sit in OUR bucket on OUR bill. When a
    // workspace writes to its own BYO bucket, the cap does not apply.
    if (!byo) {
      const currentBytes = await store.sumSizeBytes(ac)
      if (currentBytes + bytes.length > MAX_BYTES_PER_WORKSPACE) {
        return err({
          kind: 'quota_exceeded',
          currentBytes,
          limitBytes: MAX_BYTES_PER_WORKSPACE,
          attemptedBytes: bytes.length,
        })
      }
    }

    const fileId = randomUUID()
    const storageKey = buildStorageKey(ctx.workspaceId, fileId)
    const storageUri = buildStorageUri(bucket, ctx.workspaceId, fileId, uriScheme)

    await gcs.writeBlob(storageKey, bytes, {
      workspaceId: ctx.workspaceId,
      createdByUserId: ctx.userId,
      createdByAssistantId: ctx.assistantId ?? undefined,
      mime,
    })

    let row: WorkspaceFile
    try {
      row = await store.create(ctx.userId, {
        id: fileId,
        workspaceId: ctx.workspaceId,
        path,
        parentPath,
        name,
        mime,
        sizeBytes: bytes.length,
        storageUri,
        title: p.title ?? null,
        summary: p.summary ?? null,
        tags: p.tags,
        sensitivity: p.sensitivity,
        createdByUserId: ctx.userId,
        createdByAssistantId: ctx.assistantId ?? null,
      })
    } catch (dbErr) {
      // Best-effort blob rollback. If this fails, the bucket's 30-day
      // soft-delete lifecycle eventually reclaims the object.
      try {
        await gcs.deleteBlob(storageKey)
      } catch (rollbackErr) {
        console.warn(
          `[files-api] write rollback failed for key=${storageKey} after DB insert failure:`,
          rollbackErr,
        )
      }
      throw dbErr
    }

    logAudit(ctx, 'file.created', { id: row.id, path: row.path, mime: row.mime, sizeBytes: row.sizeBytes })
    return ok(row)
  }

  return {
    async write(ctx, params): Promise<FilesResult<WorkspaceFile>> {
      const name = deriveName(normalizePath(params.path))
      return persist(ctx, {
        path: params.path,
        bytes: Buffer.from(params.content, 'utf-8'),
        mime: inferMime(name, params.mime),
        title: params.title,
        summary: params.summary,
        tags: params.tags,
        sensitivity: params.sensitivity,
      })
    },

    async writeBytes(ctx, params): Promise<FilesResult<WorkspaceFile>> {
      return persist(ctx, {
        path: params.path,
        bytes: Buffer.from(params.bytes),
        mime: params.mime,
        title: params.title,
        summary: params.summary,
        tags: params.tags,
        sensitivity: params.sensitivity,
      })
    },

    async append(ctx, idOrPath, content): Promise<FilesResult<WorkspaceFile>> {
      const file = await resolveByIdOrPath(ctx, idOrPath)
      if (!file) return err({ kind: 'not_found', reference: idOrPath })

      const addBytes = Buffer.from(content, 'utf-8')
      const { byo } = await resolver.forWorkspace(ctx.workspaceId)
      if (!byo) {
        const currentBytes = await store.sumSizeBytes(accessCtx(ctx))
        if (currentBytes + addBytes.length > MAX_BYTES_PER_WORKSPACE) {
          return err({
            kind: 'quota_exceeded',
            currentBytes,
            limitBytes: MAX_BYTES_PER_WORKSPACE,
            attemptedBytes: addBytes.length,
          })
        }
      }

      const gcs = await resolver.forUri(ctx.workspaceId, file.storageUri)
      const storageKey = buildStorageKey(ctx.workspaceId, file.id)
      await gcs.appendBlob(storageKey, addBytes)

      const newSize = file.sizeBytes + addBytes.length
      const updated = await store.updateSize(ctx.userId, ctx.workspaceId, file.id, newSize)
      if (!updated) {
        // Pathological: row vanished mid-append. The GCS append already
        // happened; we leave it for the soft-delete lifecycle.
        return err({ kind: 'not_found', reference: idOrPath })
      }

      logAudit(ctx, 'file.appended', {
        id: updated.id,
        path: updated.path,
        sizeBytes: updated.sizeBytes,
      }, { added_bytes: addBytes.length })
      return ok(updated)
    },

    async stat(ctx, idOrPath): Promise<FilesResult<WorkspaceFile>> {
      // Metadata only — no blob fetch. Backs `sendFile`'s gates.
      const file = await resolveByIdOrPath(ctx, idOrPath)
      if (!file) return err({ kind: 'not_found', reference: idOrPath })
      return ok(file)
    },

    async read(ctx, idOrPath): Promise<FilesResult<FilesReadResult>> {
      const file = await resolveByIdOrPath(ctx, idOrPath)
      if (!file) return err({ kind: 'not_found', reference: idOrPath })

      const gcs = await resolver.forUri(ctx.workspaceId, file.storageUri)
      const blob = await gcs.readBlob(buildStorageKey(ctx.workspaceId, file.id))
      if (!blob) {
        // Row exists but bytes are missing — orphaned row. Surface as
        // not_found; ops can investigate via storage_uri.
        return err({ kind: 'not_found', reference: idOrPath })
      }
      return ok({ file, content: blob.bytes.toString('utf-8') })
    },

    async readBytes(ctx, idOrPath): Promise<FilesResult<FilesReadBytesResult>> {
      // Byte-preserving read — the read mirror of `writeBytes`. Backs
      // outbound document delivery (adapter-pattern.md → "Outbound documents").
      const file = await resolveByIdOrPath(ctx, idOrPath)
      if (!file) return err({ kind: 'not_found', reference: idOrPath })

      const gcs = await resolver.forUri(ctx.workspaceId, file.storageUri)
      const blob = await gcs.readBlob(buildStorageKey(ctx.workspaceId, file.id))
      if (!blob) {
        return err({ kind: 'not_found', reference: idOrPath })
      }
      return ok({ file, bytes: blob.bytes })
    },

    async search(ctx, params: FilesSearchParams): Promise<WorkspaceFileIndexRow[]> {
      return store.searchByText(accessCtx(ctx), {
        query: params.query,
        tag: params.tag,
        parentPath: params.parentPath ? normalizePath(params.parentPath) : undefined,
        limit: params.limit,
      })
    },

    async setMeta(ctx, idOrPath, patch: WorkspaceFileMetaPatch): Promise<FilesResult<WorkspaceFile>> {
      const file = await resolveByIdOrPath(ctx, idOrPath)
      if (!file) return err({ kind: 'not_found', reference: idOrPath })

      const updated = await store.updateMeta(ctx.userId, ctx.workspaceId, file.id, patch)
      if (!updated) return err({ kind: 'not_found', reference: idOrPath })

      logAudit(ctx, 'file.meta_updated', { id: updated.id, path: updated.path }, {
        fields: Object.keys(patch),
      })
      return ok(updated)
    },

    async delete(ctx, idOrPath): Promise<FilesResult<{ id: string; path: string }>> {
      const file = await resolveByIdOrPath(ctx, idOrPath)
      if (!file) return err({ kind: 'not_found', reference: idOrPath })

      const deleted = await store.delete(ctx.userId, ctx.workspaceId, file.id)
      if (!deleted) return err({ kind: 'not_found', reference: idOrPath })

      try {
        const gcs = await resolver.forUri(ctx.workspaceId, file.storageUri)
        await gcs.deleteBlob(buildStorageKey(ctx.workspaceId, file.id))
      } catch (gcsErr) {
        console.warn(
          `[files-api] delete: GCS deleteBlob failed for ${file.id} (row already deleted):`,
          gcsErr,
        )
      }

      logAudit(ctx, 'file.deleted', { id: file.id, path: file.path })
      return ok({ id: file.id, path: file.path })
    },
  }
}
