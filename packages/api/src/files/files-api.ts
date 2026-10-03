import type { DerivedWriteEvidence } from '@use-brian/core'
import type { DerivedWorkspaceFilesStore } from '../db/workspace-files-store.js'
/**
 * Files API orchestration — stitches the GCS bytes layer
 * (`gcs-client.ts`) and the workspace_files index store
 * (`packages/api/src/db/workspace-files-store.ts`) into the `FilesApi`
 * the chat tools call. Owns:
 *   - quota enforcement (plan-tiered, STORAGE_LIMIT_BYTES_BY_PLAN)
 *   - GCS-then-DB ordering on writes (with best-effort blob rollback on
 *     DB failure)
 *   - audit emission via `workspace_audit_store`
 *   - id-or-path resolution
 *
 * See docs/architecture/features/files.md.
 */

import { createHash, randomUUID } from 'node:crypto'
import { maxSensitivity, unionScopeRequirements } from '@use-brian/core'
import { assertExecutionResourceScope } from '../db/access-predicate.js'
import { executeWithCurrentAuthority } from '../context-scope/authority-lease.js'
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
import type { WorkspacePlan } from '../db/workspace-store.js'
import { localDirectoryMetadata, storageKeyForWorkspaceFile } from './local-directory-import.js'
import { WEBSITE_MEDIA_PREFIX } from '../db/website-media-store.js'

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
 * Preserve an absent executing assistant for human-only callers (e.g. PDF
 * session assets). AccessContext requires a string, so use its empty sentinel,
 * not the user's ID. The primary-shaped SQL projection avoids casting that
 * sentinel to UUID; the empty visibility ceiling still admits ONLY rows with
 * assistant_id IS NULL, never primary-assistant widening.
 */
function accessCtx(ctx: FilesContext): AccessContext {
  return {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    assistantId: ctx.assistantId ?? '',
    assistantKind: ctx.assistantId ? ctx.assistantKind ?? 'standard' : 'primary',
    // A human scoped write may also see that one assistant's partition, never wider.
    ...(ctx.assistantId ? {} : { visibilityAssistantIds: ctx.scopeAssistantId ? [ctx.scopeAssistantId] : [] }),
    clearance: ctx.clearance,
    compartments: ctx.compartments,
    mutationCompartments: ctx.mutationCompartments,
    projectIds: ctx.projectIds,
  }
}

const GIB = 1024 * 1024 * 1024

/**
 * Durable-storage soft caps by workspace plan (docs/architecture/platform/
 * cost-and-pricing.md → "Storage"). Applies only to bytes in OUR bucket —
 * the check sites exempt BYO-bound workspaces. `enterprise` has no published
 * tier; 200 GB is its floor until a contract says otherwise.
 */
export const STORAGE_LIMIT_BYTES_BY_PLAN: Record<WorkspacePlan, number> = {
  free: 1 * GIB,
  pro: 20 * GIB,
  max_5x: 100 * GIB,
  max_10x: 200 * GIB,
  enterprise: 200 * GIB,
}

/** Free-tier fallback for unknown plans and unwired callers. */
export const DEFAULT_MAX_BYTES_PER_WORKSPACE = STORAGE_LIMIT_BYTES_BY_PLAN.free

export function storageLimitBytesForPlan(plan: string | null | undefined): number {
  return (
    STORAGE_LIMIT_BYTES_BY_PLAN[(plan ?? 'free') as WorkspacePlan] ??
    DEFAULT_MAX_BYTES_PER_WORKSPACE
  )
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}

/**
 * Public website media (`/doc/website-media/`) is written only by the owner/admin media route and the
 * Association service, both as the person (no assistant). Assistant file tools may not add, change or
 * delete it there: that would bypass the owner/admin check and could break a live site.
 */
function assistantInWebsiteMedia(ctx: FilesContext, path: string): boolean {
  return !!ctx.assistantId && `${path}/`.startsWith(WEBSITE_MEDIA_PREFIX)
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

/** Postgres `unique_violation`. Same test the chunked-upload completer uses. */
function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505')
}

export type CreateFilesApiDeps = {
  store: WorkspaceFilesStore & Partial<Pick<DerivedWorkspaceFilesStore, 'createDerived' | 'prepareSessionOwned' | 'createSessionOwned'>>
  auditStore: WorkspaceAuditStore
  /**
   * Plan-derived per-workspace durable-storage cap. Boot wires this to
   * `getWorkspacePlan` → `storageLimitBytesForPlan`; omitting it falls back
   * to the free-tier limit (unit-test convenience, never the boot path).
   */
  storageLimitBytesFor?: (workspaceId: string) => Promise<number>
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

/** A commit acknowledgement can be lost after the successor became visible. */
class FilePublicationUncertainError extends Error {
  readonly code = 'file_publication_uncertain'
  readonly retrySafe = false
  readonly operationMayHaveExecuted = true
  constructor() { super('The file update could not be confirmed. Inspect the file before retrying.') }
}

/** Snapshot primitive fields before I/O, including mutable adapter results. */
export const workspaceFileReadRevision = (file: WorkspaceFile): string => JSON.stringify([
  file.id, file.workspaceId, file.storageUri, file.scopeVersion, file.updatedAt,
  file.userId, file.assistantId, file.sensitivity, file.compartments, file.projectIds,
  file.validTo, file.retractedAt, file.supersededBy,
])

export type DerivedFilesApi = FilesApi & {
  writeDerivedBytes(ctx: FilesContext, params: Parameters<FilesApi['writeBytes']>[1], evidence: DerivedWriteEvidence): ReturnType<FilesApi['writeBytes']>
}

export function createFilesApi(deps: CreateFilesApiDeps): DerivedFilesApi {
  const { store, auditStore } = deps
  const resolver: FilesClientResolver =
    deps.resolver ?? createSingletonFilesClientResolver(deps.gcs, deps.bucket)
  const storageLimitBytesFor =
    deps.storageLimitBytesFor ?? (async () => DEFAULT_MAX_BYTES_PER_WORKSPACE)

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

  // Snapshot primitive fields before I/O: even a mutable adapter must not hide
  // a source or classification change by mutating the same object in place.
  const readRevision = workspaceFileReadRevision

  async function readCurrentBytes(ctx: FilesContext, idOrPath: string): Promise<FilesResult<FilesReadBytesResult>> {
    const unavailable = () => err<FilesReadBytesResult>({ kind: 'not_found', reference: idOrPath })
    const file = await executeWithCurrentAuthority(() => resolveByIdOrPath(ctx, idOrPath))
    if (!file || file.validTo || file.retractedAt || file.supersededBy) return unavailable()
    const revision = readRevision(file)
    const gcs = await resolver.forUri(ctx.workspaceId, file.storageUri)
    const blob = await gcs.readBlob(storageKeyForWorkspaceFile(file))
    if (!blob) return unavailable()
    return executeWithCurrentAuthority(async () => {
      const current = await resolveByIdOrPath(ctx, idOrPath)
      if (!current || readRevision(current) !== revision) return unavailable()
      return ok({ file: current, bytes: blob.bytes })
    })
  }

  function mutationAllowed(ctx: FilesContext, file?: WorkspaceFile, sensitivity: WorkspaceFile['sensitivity'] = file?.sensitivity ?? 'internal'): boolean {
    const access = accessCtx(ctx)
    const source = file ? { ...file, compartments: file.compartments ?? [], projectIds: file.projectIds ?? [] } : undefined
    try {
      if (source) {
        if (file!.validTo || file!.retractedAt || file!.supersededBy) return false
        assertExecutionResourceScope(source, 'read', access)
        assertExecutionResourceScope(source, 'mutation', access)
      }
      assertExecutionResourceScope({ workspaceId: ctx.workspaceId,
        userId: file?.userId ?? null, assistantId: file?.assistantId ?? null,
        sensitivity: maxSensitivity(file?.sensitivity ?? 'public', sensitivity, ctx.writeSensitivity ?? 'public'),
        compartments: unionScopeRequirements(file?.compartments, ctx.writeCompartments),
        projectIds: unionScopeRequirements(file?.projectIds, ctx.writeProjectIds) }, 'mutation', access)
      return true
    } catch (error) {
      if ((error as { code?: string }).code === 'scope_operation_denied') return false
      throw error
    }
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
      sessionOwned?: true
      derivation?: DerivedWriteEvidence
    },
  ): Promise<FilesResult<WorkspaceFile>> {
    // Explicit per-call evidence wins; tool contexts carry a detached snapshot.
    p = { ...p, derivation: p.derivation ?? (ctx.derivation ? structuredClone(ctx.derivation) : undefined) }
    const path = normalizePath(p.path)
    if (path.startsWith('/office/sessions/') && p.sessionOwned !== true) return err({ kind: 'read_only', path })
    if (p.sessionOwned === true && !path.startsWith('/office/sessions/')) return err({ kind: 'read_only', path })
    if (assistantInWebsiteMedia(ctx, path)) return err({ kind: 'read_only', path })
    const parentPath = deriveParentPath(path)
    const name = deriveName(path)
    const { mime, bytes } = p
    if (!p.derivation && !mutationAllowed(ctx, undefined, p.sensitivity ?? 'internal')) return err({ kind: 'read_only', reason: 'scope', path })

    const ac = accessCtx(ctx)
    const existing = await store.getByPath(ac, path)
    if (existing) {
      return err({ kind: 'conflict', path })
    }

    const { gcs, bucket, byo, uriScheme } = await resolver.forWorkspace(ctx.workspaceId)

    // Soft quota guards bytes that sit in OUR bucket on OUR bill. When a
    // workspace writes to its own BYO bucket, the cap does not apply.
    if (!byo) {
      const limitBytes = await storageLimitBytesFor(ctx.workspaceId)
      const currentBytes = await store.sumSizeBytes(ac)
      if (currentBytes + bytes.length > limitBytes) {
        return err({
          kind: 'quota_exceeded',
          currentBytes,
          limitBytes,
          attemptedBytes: bytes.length,
        })
      }
    }

    if (p.derivation && !store.createDerived) throw new Error('scope_evidence_missing')
    const sessionBinding=p.sessionOwned && store.prepareSessionOwned
      ? await store.prepareSessionOwned(ctx.userId,ctx.workspaceId,path,ac) : undefined
    // Session-derived model evidence needs a combined adapter, not an ignored floor.
    if (sessionBinding && p.derivation) throw new Error('scope_evidence_missing')
    const fileId = randomUUID()
    const storageKey = buildStorageKey(ctx.workspaceId, fileId)
    const storageUri = buildStorageUri(bucket, ctx.workspaceId, fileId, uriScheme)

    try {
      await executeWithCurrentAuthority(() => gcs.writeBlob(storageKey, bytes, {
        workspaceId: ctx.workspaceId,
        createdByUserId: ctx.userId,
        createdByAssistantId: ctx.assistantId ?? undefined,
        mime,
      }))
    } catch (error) {
      // No canonical row write has started; this random staging key cannot
      // belong to a committed file even if the storage acknowledgement was lost.
      try { await gcs.deleteBlob(storageKey) } catch { /* storage retention retries orphan cleanup */ }
      throw error
    }

    let row: WorkspaceFile
    try {
      row = await executeWithCurrentAuthority(() => (sessionBinding
        ? (userId: string, input: Parameters<WorkspaceFilesStore['create']>[1], access: AccessContext) => store.createSessionOwned!(userId,input,sessionBinding,access)
        : p.derivation
        ? (userId: string, input: Parameters<WorkspaceFilesStore['create']>[1], access: AccessContext) => store.createDerived!(userId, input, p.derivation!, access)
        : store.create.bind(store))(ctx.userId, {
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
        sensitivity: maxSensitivity(p.sensitivity ?? 'internal', ctx.writeSensitivity ?? 'public'),
        compartments: ctx.writeCompartments,
        projectIds: ctx.writeProjectIds,
        metadata: p.sessionOwned ? { officeSession: true, noIndex: true, contentSha256:createHash('sha256').update(bytes).digest('hex') }
          : path.startsWith('/office/anchors/') ? { noIndex: true } : undefined,
        userId: p.sessionOwned ? ctx.userId : null,
        // Partition only; the row stays human-authored (createdByAssistantId null).
        ...(!ctx.assistantId && ctx.scopeAssistantId ? { assistantId: ctx.scopeAssistantId } : {}),
        createdByUserId: ctx.userId,
        createdByAssistantId: ctx.assistantId ?? null,
      }, ac))
    } catch (dbErr) {
      // Only an explicit constraint/permission refusal proves the INSERT did
      // not commit. An uncertain acknowledgement must retain the staged object.
      const code = (dbErr as { code?: string }).code
      if (typeof code !== 'string' || !(code.startsWith('23') || code === '42501' || code === 'scope_operation_denied' || ['context_not_available','access_policy_conflict','file_admission_provenance_required','access_mode_destination_conflict','pdf_intake_source_changed','pdf_intake_source_unavailable','pdf_intake_asset_changed'].includes(code))) {
        throw new FilePublicationUncertainError()
      }
      try { await gcs.deleteBlob(storageKey) } catch { /* Unpublished orphan: storage retention handles cleanup. */ }
      if (isUniqueViolation(dbErr)) {
        return err({ kind: 'conflict', path })
      }
      if (code === 'scope_operation_denied') return err({ kind: 'read_only', reason: 'scope', path })
      throw dbErr
    }

    logAudit(ctx, 'file.created', { id: row.id, path: row.path, mime: row.mime, sizeBytes: row.sizeBytes })
    return ok(row)
  }

  return {
    async writeDerivedBytes(ctx, params, evidence) {
      // Snapshot this invocation: never retain mutable or ambient provenance.
      return persist(ctx, { ...params, bytes: Buffer.from(params.bytes), derivation: structuredClone(evidence) })
    },
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
        sessionOwned: params.sessionOwned,
      })
    },

    async append(ctx, idOrPath, content): Promise<FilesResult<WorkspaceFile>> {
      const file = await resolveByIdOrPath(ctx, idOrPath)
      if (!file) return err({ kind: 'not_found', reference: idOrPath })
      if (localDirectoryMetadata(file) || assistantInWebsiteMedia(ctx, file.path)) return err({ kind: 'read_only', path: file.path })
      if (!mutationAllowed(ctx, file)) return err({ kind: 'read_only', reason: 'scope', path: file.path })
      if (!file.scopeVersion) return err({ kind: 'conflict', reason: 'changed', path: file.path })

      const addBytes = Buffer.from(content, 'utf-8')
      const target = await resolver.forWorkspace(ctx.workspaceId)
      if (!target.byo) {
        const limitBytes = await storageLimitBytesFor(ctx.workspaceId)
        const currentBytes = await store.sumSizeBytes(accessCtx(ctx))
        if (currentBytes + addBytes.length > limitBytes) return err({
          kind: 'quota_exceeded', currentBytes, limitBytes, attemptedBytes: addBytes.length,
        })
      }
      const source = await resolver.forUri(ctx.workspaceId, file.storageUri)
      const original = await executeWithCurrentAuthority(() => source.readBlob(storageKeyForWorkspaceFile(file)))
      if (!original) return err({ kind: 'not_found', reference: idOrPath })
      if (original.bytes.length !== file.sizeBytes) return err({ kind: 'conflict', reason: 'changed', path: file.path })
      const bytes = Buffer.concat([original.bytes, addBytes])
      const stagedId = randomUUID()
      const storageKey = buildStorageKey(ctx.workspaceId, stagedId)
      const storageUri = buildStorageUri(target.bucket, ctx.workspaceId, stagedId, target.uriScheme)
      await executeWithCurrentAuthority(() => target.gcs.writeBlob(storageKey, bytes, {
        workspaceId: ctx.workspaceId, createdByUserId: ctx.userId,
        createdByAssistantId: ctx.assistantId ?? undefined, mime: file.mime,
      }))

      let updated: WorkspaceFile | null
      try {
        updated = await executeWithCurrentAuthority(() => store.supersede(ctx.userId, ctx.workspaceId, file.id, {
          expectedScopeVersion: file.scopeVersion, editorUserId: ctx.userId,
          editorAssistantId: ctx.assistantId ?? null, storageUri, sizeBytes: bytes.length,
            sensitivity: maxSensitivity(file.sensitivity, ctx.writeSensitivity ?? 'public'),
          compartments: ctx.writeCompartments, projectIds: ctx.writeProjectIds,
        }, accessCtx(ctx)))
      } catch {
        // The commit may have succeeded. Deleting this object could destroy
        // the new current file; leave it for inspection/retention instead.
        throw new FilePublicationUncertainError()
      }
      if (!updated) {
        try { await target.gcs.deleteBlob(storageKey) } catch { /* Unpublished orphan only. */ }
        return err({ kind: 'conflict', reason: 'changed', path: file.path })
      }
      logAudit(ctx, 'file.appended', { id: updated.id, path: updated.path, sizeBytes: updated.sizeBytes },
        { added_bytes: addBytes.length, previous_file_id: file.id })
      return ok(updated)
    },

    async stat(ctx, idOrPath): Promise<FilesResult<WorkspaceFile>> {
      // Metadata only — no blob fetch. Backs `sendFile`'s gates.
      const file = await resolveByIdOrPath(ctx, idOrPath)
      if (!file) return err({ kind: 'not_found', reference: idOrPath })
      return ok(file)
    },

    async read(ctx, idOrPath): Promise<FilesResult<FilesReadResult>> {
      const result = await readCurrentBytes(ctx, idOrPath)
      if (!result.ok) return result
      return ok({ file: result.value.file, content: Buffer.from(result.value.bytes).toString('utf-8') })
    },

    async readBytes(ctx, idOrPath): Promise<FilesResult<FilesReadBytesResult>> {
      return readCurrentBytes(ctx, idOrPath)
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
      if (assistantInWebsiteMedia(ctx, file.path)) return err({ kind: 'read_only', path: file.path })
      if (patch.sensitivity !== undefined && maxSensitivity(file.sensitivity, ctx.writeSensitivity ?? 'public', patch.sensitivity) !== patch.sensitivity) {
        return err({ kind: 'read_only', reason: 'release_required', path: file.path })
      }
      if (!mutationAllowed(ctx, file, patch.sensitivity ?? file.sensitivity)) return err({ kind: 'read_only', reason: 'scope', path: file.path })

      let updated: WorkspaceFile | null
      try {
        updated = await executeWithCurrentAuthority(() => store.updateMeta(ctx.userId, ctx.workspaceId, file.id, {
          ...patch,
          sensitivity: maxSensitivity(file.sensitivity, patch.sensitivity ?? file.sensitivity, ctx.writeSensitivity ?? 'public'),
          inheritCompartments: ctx.writeCompartments,
          inheritProjectIds: ctx.writeProjectIds,
        }, accessCtx(ctx)))
      } catch (error) {
        if ((error as { code?: string })?.code === 'scope_declassification_required') {
          return err({ kind: 'read_only', reason: 'release_required', path: file.path })
        }
        throw error
      }
      if (!updated) return err({ kind: 'not_found', reference: idOrPath })

      logAudit(ctx, 'file.meta_updated', { id: updated.id, path: updated.path }, {
        fields: Object.keys(patch),
      })
      return ok(updated)
    },

    async delete(ctx, idOrPath): Promise<FilesResult<{ id: string; path: string }>> {
      const file = await resolveByIdOrPath(ctx, idOrPath)
      if (!file) return err({ kind: 'not_found', reference: idOrPath })
      if (localDirectoryMetadata(file) || assistantInWebsiteMedia(ctx, file.path)) return err({ kind: 'read_only', path: file.path })
      if (!mutationAllowed(ctx, file)) return err({ kind: 'read_only', reason: 'scope', path: file.path })

      const deleted = await executeWithCurrentAuthority(() => store.delete(ctx.userId, ctx.workspaceId, file.id, accessCtx(ctx)))
      if (!deleted) return err({ kind: 'not_found', reference: idOrPath })

      try {
        const gcs = await resolver.forUri(ctx.workspaceId, file.storageUri)
        await executeWithCurrentAuthority(() => gcs.deleteBlob(storageKeyForWorkspaceFile(file)))
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
