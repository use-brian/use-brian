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
import { Readable, Transform, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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

/** Object metadata WITHOUT the bytes — see `statBlob`. */
export type GcsBlobStat = {
  sizeBytes: number
  mime: string
  updatedAt: Date | null
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

  /**
   * Size + content type WITHOUT downloading the object. `readBlob` already
   * fetches this metadata, but only after `file.download()` — unusable for a
   * recording, where the object is hundreds of megabytes and the bytes are
   * deliberately never brought into the process (the whole pipeline streams
   * signed URLs through ffmpeg for exactly this reason).
   *
   * Returns null when the object does not exist.
   */
  statBlob(key: string): Promise<GcsBlobStat | null>

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

  /**
   * Open a resumable GCS write stream for `key`. Lets a producer (a channel
   * connector relaying inbound media, the pull-by-URL fetcher) pipe bytes
   * straight to GCS without ever buffering the whole object in memory — the
   * space-efficient ingress for large channel media. See
   * docs/plans/channel-media-ingest.md. Pair with `streamUrlToGcs` for the
   * pull case.
   */
  writeStream(key: string, opts: { mime: string; metadata?: GcsObjectMetadata }): Writable
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

    async statBlob(key) {
      try {
        const [meta] = await bucket.file(key).getMetadata()
        const custom = (meta.metadata ?? {}) as Record<string, string | undefined>
        // GCS reports `size` as a string (it is an int64).
        const size = typeof meta.size === 'string' ? Number(meta.size) : (meta.size ?? 0)
        return {
          sizeBytes: Number.isFinite(size) ? Number(size) : 0,
          mime:
            (typeof meta.contentType === 'string' && meta.contentType) ||
            custom.mime ||
            'application/octet-stream',
          updatedAt: meta.updated ? new Date(meta.updated) : null,
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

    writeStream(key, opts) {
      return bucket.file(key).createWriteStream({
        resumable: true,
        contentType: opts.mime,
        metadata: {
          contentType: opts.mime,
          metadata: {
            ...(opts.metadata?.workspaceId ? { 'workspace-id': opts.metadata.workspaceId } : {}),
            ...(opts.metadata?.createdByUserId ? { 'created-by-user-id': opts.metadata.createdByUserId } : {}),
            ...(opts.metadata?.createdByAssistantId
              ? { 'created-by-assistant-id': opts.metadata.createdByAssistantId }
              : {}),
            mime: opts.mime,
          },
        },
      })
    },
  }
}

/** Thrown when an inbound media stream exceeds the byte ceiling. The caller maps
 *  this to a "too large, use the upload link" reply rather than a 500. */
export class MediaTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`media stream exceeded ${maxBytes} bytes (saw ${bytes})`)
    this.name = 'MediaTooLargeError'
  }
}

/**
 * Stream a remote URL straight into GCS without ever buffering it — the
 * space-efficient pull-by-URL ingress for channel media (Slack `url_private`,
 * Discord CDN, a self-hosted Telegram Bot API file URL, any cloud link). Bytes
 * flow `fetch(url)` → a byte-counting transform → the GCS write stream, chunk by
 * chunk; the running counter (and a `content-length` pre-check) abort with
 * `MediaTooLargeError` past `maxBytes`, so a hostile/oversized source can't blow
 * memory or storage.
 *
 * `openWrite` is injected (returns the destination `Writable`, e.g.
 * `client.writeStream(key, …)`) so this orchestration unit-tests with an
 * in-memory collector and a fake fetch — no GCS, no network.
 */
export async function streamUrlToGcs(args: {
  url: string
  headers?: Record<string, string>
  openWrite: (mime: string) => Writable
  maxBytes: number
  fetchFn?: typeof fetch
}): Promise<{ bytesWritten: number; mime: string }> {
  const fetchFn = args.fetchFn ?? fetch
  const res = await fetchFn(args.url, args.headers ? { headers: args.headers } : {})
  if (!res.ok || !res.body) {
    throw new Error(`media fetch failed (HTTP ${res.status})`)
  }
  const mime = res.headers.get('content-type') ?? 'application/octet-stream'
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > args.maxBytes) {
    throw new MediaTooLargeError(declared, args.maxBytes)
  }

  let bytesWritten = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytesWritten += chunk.length
      if (bytesWritten > args.maxBytes) {
        cb(new MediaTooLargeError(bytesWritten, args.maxBytes))
        return
      }
      cb(null, chunk)
    },
  })

  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  await pipeline(source, counter, args.openWrite(mime))
  return { bytesWritten, mime }
}

/** Object key format: `<workspace_id>/<file_id>`. */
export function buildStorageKey(workspaceId: string, fileId: string): string {
  return `${workspaceId}/${fileId}`
}

/**
 * Storage-backend URI scheme recorded in `workspace_files.storage_uri`. `gs`
 * for GCS buckets (the default), `s3` for S3-compatible buckets, and `file` for
 * OSS local-directory storage. The scheme is
 * cosmetic for routing (`parseStorageBucket` matches by bucket name), but keeps
 * each file's origin backend legible.
 */
export type StorageUriScheme = 'gs' | 's3' | 'file'

/** `<scheme>://bucket/<workspace_id>/<file_id>` URI for the workspace_files.storage_uri column. */
export function buildStorageUri(
  bucket: string,
  workspaceId: string,
  fileId: string,
  scheme: StorageUriScheme = 'gs',
): string {
  return `${scheme}://${bucket}/${buildStorageKey(workspaceId, fileId)}`
}

/**
 * Extract the backend identifier from a `gs://`, `s3://`, or `file://` storage
 * URI. Used to route reads of an existing file to whichever backend it
 * actually lives in (a workspace that switched to BYO storage still has older
 * files in the app default bucket — each file's own `storage_uri` is
 * authoritative). Scheme-agnostic: routing is by bucket name, not backend.
 */
export function parseStorageBucket(storageUri: string): string {
  const m = /^(?:gs|s3|file):\/\/([^/]+)\//.exec(storageUri)
  if (m) return m[1]
  const fm = /^file:\/\/(.+)\/[^/]+\/[^/]+$/.exec(storageUri)
  if (fm) return fm[1]
  throw new Error(`gcs: cannot parse bucket from storage_uri: ${storageUri}`)
}
