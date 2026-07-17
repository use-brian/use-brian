/**
 * S3-compatible blob storage for the workspace filesystem primitive — the
 * bring-your-own sibling of `gcs-client.ts`. Same bytes-layer contract
 * (`GcsFilesClient`), different backend: AWS S3 or any S3-compatible store
 * (MinIO, Cloudflare R2, Backblaze B2, Wasabi, …).
 *
 * Owns the bytes layer: write/read/delete/append against
 * `s3://<bucket>/<workspace_id>/<file_id>`. The structural / discovery layer
 * (path, title, summary, tags, search_vector) lives in the `workspace_files`
 * table (see `packages/api/src/db/workspace-files-store.ts`); the file API
 * (`files-api.ts`) stitches the two together, and is storage-backend agnostic
 * because both clients satisfy the same `GcsFilesClient` interface.
 *
 * Auth: always bring-your-own. A customer access-key/secret-key pair is passed
 * in explicitly and handed straight to the SDK — there is no ambient/default
 * S3 identity (unlike GCS's ADC path). The secret rides inside the opaque
 * `S3Credentials` object and is never logged.
 *
 * The client is a thin wrapper around `@aws-sdk/client-s3` — the returned
 * `GcsFilesClient` lets tests substitute an in-memory fake (see
 * `packages/api/src/files/__tests__/s3-byo-validate.test.ts`). Never hit a
 * real bucket from tests.
 *
 * See docs/plans/byo-s3-storage.md and docs/architecture/features/files.md.
 */

import { PassThrough, type Readable, type Writable } from 'node:stream'
import type { GcsFilesClient, GcsObjectMetadata } from './gcs-client.js'

/**
 * The `@aws-sdk/*` packages are loaded lazily on first real S3 operation
 * rather than statically. This keeps the module (and everything that imports
 * it — the validator, the resolver, the connect route) loadable without the
 * SDK present, so tests that inject an in-memory fake client never pull the
 * heavy AWS dependency tree. The import is memoized on the first call.
 */
type S3Sdk = {
  S3Client: typeof import('@aws-sdk/client-s3').S3Client
  PutObjectCommand: typeof import('@aws-sdk/client-s3').PutObjectCommand
  GetObjectCommand: typeof import('@aws-sdk/client-s3').GetObjectCommand
  DeleteObjectCommand: typeof import('@aws-sdk/client-s3').DeleteObjectCommand
  getSignedUrl: typeof import('@aws-sdk/s3-request-presigner').getSignedUrl
  Upload: typeof import('@aws-sdk/lib-storage').Upload
}

let sdkPromise: Promise<S3Sdk> | null = null
function loadSdk(): Promise<S3Sdk> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const [client, presigner, libStorage] = await Promise.all([
        import('@aws-sdk/client-s3'),
        import('@aws-sdk/s3-request-presigner'),
        import('@aws-sdk/lib-storage'),
      ])
      return {
        S3Client: client.S3Client,
        PutObjectCommand: client.PutObjectCommand,
        GetObjectCommand: client.GetObjectCommand,
        DeleteObjectCommand: client.DeleteObjectCommand,
        getSignedUrl: presigner.getSignedUrl,
        Upload: libStorage.Upload,
      }
    })()
  }
  return sdkPromise
}

/**
 * A customer S3 access-key pair. Only `accessKeyId` is meaningfully
 * identifying; `secretAccessKey` is the signing secret and rides along without
 * ever being logged. Extra fields (e.g. a session token) pass through via the
 * index signature.
 */
export type S3Credentials = {
  accessKeyId: string
  secretAccessKey: string
  [k: string]: unknown
}

export type S3ClientOptions = {
  bucket: string
  /** AWS region. Defaults to `us-east-1`; use `auto` for Cloudflare R2. */
  region?: string
  /** Custom endpoint for non-AWS stores (MinIO/R2/B2). Omit for AWS S3. */
  endpoint?: string
  /**
   * Path-style addressing (`https://host/bucket/key`) instead of
   * virtual-hosted (`https://bucket.host/key`). Most S3-compatible stores need
   * this; AWS does not. Defaults to true whenever a custom `endpoint` is set.
   */
  forcePathStyle?: boolean
  credentials: S3Credentials
}

/** Map our workspace-scoped metadata onto S3 user metadata (lowercase keys, ASCII). */
function toS3Metadata(m: GcsObjectMetadata | undefined): Record<string, string> {
  if (!m) return {}
  return {
    ...(m.workspaceId ? { 'workspace-id': m.workspaceId } : {}),
    ...(m.createdByUserId ? { 'created-by-user-id': m.createdByUserId } : {}),
    ...(m.createdByAssistantId ? { 'created-by-assistant-id': m.createdByAssistantId } : {}),
    ...(m.mime ? { mime: m.mime } : {}),
  }
}

/** Read a Node/web stream body into a single Buffer. */
async function streamToBuffer(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

/** True for the "object/bucket not found" family across S3-compatible stores. */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string }
  if (e.$metadata?.httpStatusCode === 404) return true
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.Code === 'NoSuchKey'
}

export function createS3FilesClient({
  bucket,
  region,
  endpoint,
  forcePathStyle,
  credentials,
}: S3ClientOptions): GcsFilesClient {
  // Build the SDK client once, lazily, on the first real operation (see
  // `loadSdk`). `sdk` is captured too so command classes are reachable in every
  // method without re-importing.
  let built: Promise<{ sdk: S3Sdk; s3: InstanceType<S3Sdk['S3Client']> }> | null = null
  function client() {
    if (!built) {
      built = (async () => {
        const sdk = await loadSdk()
        const s3 = new sdk.S3Client({
          region: region || 'us-east-1',
          ...(endpoint ? { endpoint } : {}),
          forcePathStyle: forcePathStyle ?? Boolean(endpoint),
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
          },
        })
        return { sdk, s3 }
      })()
    }
    return built
  }

  return {
    async writeBlob(key, bytes, metadata) {
      const { sdk, s3 } = await client()
      await s3.send(
        new sdk.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: metadata.mime,
          Metadata: toS3Metadata(metadata),
        }),
      )
    },

    async appendBlob(key, bytes) {
      const existing = await this.readBlob(key)
      if (!existing) {
        throw new Error(`s3: cannot append — blob not found at ${key}`)
      }
      const combined = Buffer.concat([existing.bytes, bytes])
      const { sdk, s3 } = await client()
      await s3.send(
        new sdk.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: combined,
          ContentType: existing.mime,
          Metadata: toS3Metadata(existing.metadata),
        }),
      )
    },

    async readBlob(key) {
      const { sdk, s3 } = await client()
      try {
        const out = await s3.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }))
        const bytes = await streamToBuffer(out.Body)
        const custom = (out.Metadata ?? {}) as Record<string, string | undefined>
        const mime =
          (typeof out.ContentType === 'string' && out.ContentType) || custom.mime || 'application/octet-stream'
        return {
          bytes,
          mime,
          metadata: {
            workspaceId: custom['workspace-id'] ?? '',
            createdByUserId: custom['created-by-user-id'],
            createdByAssistantId: custom['created-by-assistant-id'],
            mime,
          },
        }
      } catch (err: unknown) {
        if (isNotFound(err)) return null
        throw err
      }
    },

    async deleteBlob(key) {
      const { sdk, s3 } = await client()
      try {
        await s3.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }))
      } catch (err: unknown) {
        // S3 delete is already idempotent (204 on a missing key); guard anyway.
        if (isNotFound(err)) return
        throw err
      }
    },

    async signedReadUrl(key, ttlSec = 3600) {
      const { sdk, s3 } = await client()
      return sdk.getSignedUrl(s3, new sdk.GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlSec })
    },

    async signedWriteUrl(key, opts) {
      const { sdk, s3 } = await client()
      return sdk.getSignedUrl(
        s3,
        new sdk.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
        }),
        { expiresIn: opts?.ttlSec ?? 3600 },
      )
    },

    writeStream(key, opts) {
      // S3 has no single-request resumable stream like GCS; multipart upload is
      // the space-efficient equivalent. Pipe the producer into a PassThrough
      // that lib-storage's `Upload` consumes chunk-by-chunk (no full buffering).
      // The SDK loads lazily, so the Upload is wired up once the module resolves.
      const pass = new PassThrough()
      client()
        .then(({ sdk, s3 }) => {
          const upload = new sdk.Upload({
            client: s3,
            params: {
              Bucket: bucket,
              Key: key,
              Body: pass as Readable,
              ContentType: opts.mime,
              Metadata: toS3Metadata(opts.metadata ? { ...opts.metadata, mime: opts.mime } : undefined),
            },
          })
          // Surface upload failures on the writable so `pipeline()` rejects.
          return upload.done()
        })
        .catch((err: unknown) => pass.destroy(err instanceof Error ? err : new Error(String(err))))
      return pass as unknown as Writable
    },
  }
}
