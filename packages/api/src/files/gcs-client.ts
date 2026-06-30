/**
 * GCS-backed blob storage for the workspace filesystem primitive
 * (company-brain §10, Q3 Phase A).
 *
 * Owns the bytes layer: write/read/delete/append against
 * `gs://<bucket>/<workspace_id>/<file_id>`. The structural / discovery
 * layer (path, title, summary, tags, search_vector) lives in the
 * `workspace_files` table and is the responsibility of
 * `packages/api/src/db/workspace-files-store.ts`. The file API
 * (`files-api.ts`) stitches the two together.
 *
 * Auth: Application Default Credentials by default. On Cloud Run the
 * service account identity is used automatically; for local dev run
 * `gcloud auth application-default login`. No credentials file is read.
 *
 * Bring-your-own storage (BYO): when explicit `credentials` (a customer
 * service-account key) are passed, the client authenticates *as that SA*
 * against the customer's own bucket instead of ADC. This is the only
 * difference between the app-default client and a per-workspace BYO client;
 * the resolver that decides which to build lives in the (closed) overlay —
 * see docs/plans/byo-google-storage.md and docs/architecture/features/files.md.
 *
 * The client is a thin wrapper around the SDK — a `GcsFilesClient`
 * interface lets tests substitute an in-memory fake (see
 * `packages/api/src/files/__tests__/files-api.test.ts`). Never hit a
 * real bucket from tests.
 */

import { Storage, type Bucket } from '@google-cloud/storage'

export type GcsObjectMetadata = {
  workspaceId: string
  createdByUserId?: string
  createdByAssistantId?: string
  mime: string
}

export type GcsBlob = {
  bytes: Buffer
  mime: string
  metadata: GcsObjectMetadata
}

export type GcsFilesClient = {
  /**
   * Write a blob with workspace-scoped custom metadata. Overwrites any
   * existing object at the same key. The caller is responsible for
   * ordering the GCS write before the DB insert (see `files-api.ts`).
   */
  writeBlob(key: string, bytes: Buffer, metadata: GcsObjectMetadata): Promise<void>

  /**
   * Read-modify-write append. Pulls the existing object, concatenates,
   * writes back. v1 uses a simple round-trip; if append-heavy workloads
   * become real, swap to GCS compose API on a future ticket.
   */
  appendBlob(key: string, bytes: Buffer): Promise<void>

  /** Returns null if the object does not exist (404). */
  readBlob(key: string): Promise<GcsBlob | null>

  /** Idempotent — silent no-op on 404. */
  deleteBlob(key: string): Promise<void>

  /** V4 signed read URL. ttlSec defaults to 1h. */
  signedReadUrl(key: string, ttlSec?: number): Promise<string>

  /**
   * V4 signed WRITE (PUT) URL for direct-to-GCS upload — the client PUTs the
   * bytes straight to GCS so a large recording (100s of MB) never streams
   * through the API process. ttlSec defaults to 1h. Used by the recording
   * upload flow (recording-to-brain). The PUT request must use the same
   * `contentType` if one is bound here.
   */
  signedWriteUrl(key: string, opts?: { contentType?: string; ttlSec?: number }): Promise<string>
}

/**
 * A customer service-account key, parsed from the JSON Google hands out.
 * Only `client_email` is named statically; the signing secret and the rest
 * of the key ride along via the index signature and are passed straight to
 * `new Storage({ credentials })` without ever being referenced by name in
 * our code (so the secret is never logged or destructured).
 */
export type GcsServiceAccountCredentials = {
  client_email: string
  project_id?: string
  [k: string]: unknown
}

export type GcsClientOptions = {
  bucket: string
  projectId?: string
  /**
   * Explicit BYO credentials. When omitted, the client uses Application
   * Default Credentials (the app's own service account) — unchanged behavior.
   */
  credentials?: GcsServiceAccountCredentials
}

export function createGcsFilesClient({ bucket: bucketName, projectId, credentials }: GcsClientOptions): GcsFilesClient {
  const opts: ConstructorParameters<typeof Storage>[0] = {}
  if (projectId) opts.projectId = projectId
  if (credentials) opts.credentials = credentials as unknown as NonNullable<typeof opts.credentials>
  const storage = new Storage(Object.keys(opts).length > 0 ? opts : undefined)
  const bucket: Bucket = storage.bucket(bucketName)

  return {
    async writeBlob(key, bytes, metadata) {
      await bucket.file(key).save(bytes, {
        contentType: metadata.mime,
        metadata: {
          contentType: metadata.mime,
          metadata: {
            'workspace-id': metadata.workspaceId,
            ...(metadata.createdByUserId ? { 'created-by-user-id': metadata.createdByUserId } : {}),
            ...(metadata.createdByAssistantId ? { 'created-by-assistant-id': metadata.createdByAssistantId } : {}),
            mime: metadata.mime,
          },
        },
      })
    },

    async appendBlob(key, bytes) {
      const existing = await this.readBlob(key)
      if (!existing) {
        throw new Error(`gcs: cannot append — blob not found at ${key}`)
      }
      const combined = Buffer.concat([existing.bytes, bytes])
      await bucket.file(key).save(combined, {
        contentType: existing.mime,
        metadata: {
          contentType: existing.mime,
          metadata: {
            'workspace-id': existing.metadata.workspaceId,
            ...(existing.metadata.createdByUserId ? { 'created-by-user-id': existing.metadata.createdByUserId } : {}),
            ...(existing.metadata.createdByAssistantId ? { 'created-by-assistant-id': existing.metadata.createdByAssistantId } : {}),
            mime: existing.mime,
          },
        },
      })
    },

    async readBlob(key) {
      try {
        const file = bucket.file(key)
        const [contents] = await file.download()
        const [meta] = await file.getMetadata()
        const custom = (meta.metadata ?? {}) as Record<string, string | undefined>
        const mime = (typeof meta.contentType === 'string' && meta.contentType) || custom.mime || 'application/octet-stream'
        return {
          bytes: contents,
          mime,
          metadata: {
            workspaceId: custom['workspace-id'] ?? '',
            createdByUserId: custom['created-by-user-id'],
            createdByAssistantId: custom['created-by-assistant-id'],
            mime,
          },
        }
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 404) {
          return null
        }
        throw err
      }
    },

    async deleteBlob(key) {
      try {
        await bucket.file(key).delete()
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 404) {
          return
        }
        throw err
      }
    },

    async signedReadUrl(key, ttlSec = 3600) {
      const [url] = await bucket.file(key).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + ttlSec * 1000,
      })
      return url
    },

    async signedWriteUrl(key, opts) {
      const [url] = await bucket.file(key).getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + (opts?.ttlSec ?? 3600) * 1000,
        ...(opts?.contentType ? { contentType: opts.contentType } : {}),
      })
      return url
    },
  }
}

/** Object key format: `<workspace_id>/<file_id>`. */
export function buildStorageKey(workspaceId: string, fileId: string): string {
  return `${workspaceId}/${fileId}`
}

/** `gs://bucket/<workspace_id>/<file_id>` URI for the workspace_files.storage_uri column. */
export function buildStorageUri(bucket: string, workspaceId: string, fileId: string): string {
  return `gs://${bucket}/${buildStorageKey(workspaceId, fileId)}`
}

/**
 * Extract the bucket name from a `gs://<bucket>/<key>` storage URI. Used to
 * route reads of an existing file to whichever bucket it actually lives in
 * (a workspace that switched to BYO storage still has older files in the app
 * default bucket — each file's own `storage_uri` is authoritative).
 */
export function parseStorageBucket(storageUri: string): string {
  const m = /^gs:\/\/([^/]+)\//.exec(storageUri)
  if (!m) throw new Error(`gcs: cannot parse bucket from storage_uri: ${storageUri}`)
  return m[1]
}
