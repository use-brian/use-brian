/**
 * Azure Blob Storage backend for the workspace filesystem primitive — the
 * app-default sibling of `gcs-client.ts` (hosted GCS) and
 * `local-files-client.ts` (self-hosted disk) for self-hosted deployments that
 * run on Azure. Same bytes-layer contract (`GcsFilesClient`), different
 * backend: one blob container, objects keyed
 * `az://<container>/<workspace_id>/<file_id>`. The structural / discovery
 * layer stays in `workspace_files`; `files-api.ts` is storage-blind.
 *
 * Auth: shared key only — an account name + account key, or a connection
 * string that carries one. That is what a single-VM self-host has to hand and
 * it is the only credential the SDK can mint SAS URLs from, which
 * `signedReadUrl` / `signedWriteUrl` need. Managed identity (Entra ID) is not
 * wired in v1: a user-delegation SAS needs an extra round-trip and a different
 * key lifetime, and no deployment asks for it yet.
 *
 * Direct PUTs to a write SAS (recordings, Work Bench chunked parts, WhatsApp
 * media) must carry `x-ms-blob-type: BlockBlob`, which no signed URL can
 * embed. The client exposes that as `signedWriteHeaders`; the routes that hand
 * a signed URL to a browser or connector echo it beside the URL.
 *
 * Azure metadata names must be C# identifiers, so the `workspace-id` style
 * keys the GCS/S3 clients use become `workspace_id` here and are folded back
 * on read. The SDK loads lazily and the container surface is injectable, so
 * tests run against an in-memory fake — never a real storage account.
 */

import { PassThrough, Writable, type Readable } from 'node:stream'
import type { GcsBlob, GcsBlobStat, GcsFilesClient, GcsObjectMetadata } from './gcs-client.js'

/** Header a direct PUT to an Azure write SAS must carry (Put Blob, block blob). */
export const AZURE_BLOB_WRITE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-ms-blob-type': 'BlockBlob',
})

export type AzureBlobClientOptions = {
  /** Container that holds every workspace's objects. Must already exist. */
  container: string
  /** Storage account name; paired with `accountKey`. Ignored when `connectionString` is set. */
  account?: string
  accountKey?: string
  /** Full connection string (`DefaultEndpointsProtocol=…;AccountName=…;AccountKey=…`). */
  connectionString?: string
  /**
   * Blob service endpoint for Azurite or a sovereign cloud, e.g.
   * `http://127.0.0.1:10000/devstoreaccount1`. Defaults to
   * `https://<account>.blob.core.windows.net`. Ignored with a connection string.
   */
  endpoint?: string
}

/** Environment surface the boot wiring and the ledger runtime both read. */
export type AzureBlobEnv = {
  AZURE_BLOB_CONTAINER?: string
  AZURE_STORAGE_CONNECTION_STRING?: string
  AZURE_STORAGE_ACCOUNT?: string
  AZURE_STORAGE_ACCOUNT_KEY?: string
  AZURE_BLOB_ENDPOINT?: string
}

/**
 * `null` when Azure Blob is not configured (no container named); otherwise
 * the client options. Throws on a half-configured deployment so boot fails
 * closed instead of silently falling back to the ephemeral temp directory.
 */
export function azureBlobOptionsFromEnv(env: AzureBlobEnv): AzureBlobClientOptions | null {
  const container = env.AZURE_BLOB_CONTAINER?.trim()
  if (!container) return null
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(container) || container.includes('--')) {
    throw new Error(`[files] AZURE_BLOB_CONTAINER "${container}" is not a valid container name`)
  }
  const connectionString = env.AZURE_STORAGE_CONNECTION_STRING?.trim()
  if (connectionString) return { container, connectionString }
  const account = env.AZURE_STORAGE_ACCOUNT?.trim()
  const accountKey = env.AZURE_STORAGE_ACCOUNT_KEY?.trim()
  if (!account || !accountKey) {
    throw new Error(
      '[files] AZURE_BLOB_CONTAINER is set but neither AZURE_STORAGE_CONNECTION_STRING nor AZURE_STORAGE_ACCOUNT + AZURE_STORAGE_ACCOUNT_KEY is',
    )
  }
  const endpoint = env.AZURE_BLOB_ENDPOINT?.trim()
  return { container, account, accountKey, ...(endpoint ? { endpoint } : {}) }
}

/**
 * The slice of a container the client needs. The real adapter wraps
 * `@azure/storage-blob`; tests supply an in-memory implementation.
 */
export type AzureBlobContainer = {
  upload(key: string, bytes: Buffer, opts: { mime: string; metadata: Record<string, string> }): Promise<void>
  download(key: string): Promise<{ bytes: Buffer; mime: string; metadata: Record<string, string> } | null>
  head(key: string): Promise<(GcsBlobStat & { metadata: Record<string, string> }) | null>
  downloadRange?(key: string, version: string, start: number, end: number): Promise<Buffer | null>
  delete(key: string): Promise<void>
  sasUrl(key: string, opts: { permissions: 'r' | 'cw'; expiresOn: Date }): Promise<string>
  uploadStream(key: string, stream: Readable, opts: { mime: string; metadata: Record<string, string> }): Promise<void>
}

export type AzureBlobClientDeps = {
  /** Container factory — overridable in tests. */
  createContainer?: (opts: AzureBlobClientOptions) => Promise<AzureBlobContainer>
}

/** Azure metadata names must be C# identifiers: letters, digits, underscore. */
function toAzureMetadata(m: GcsObjectMetadata | undefined): Record<string, string> {
  if (!m) return {}
  return {
    ...(m.workspaceId ? { workspace_id: m.workspaceId } : {}),
    ...(m.createdByUserId ? { created_by_user_id: m.createdByUserId } : {}),
    ...(m.createdByAssistantId ? { created_by_assistant_id: m.createdByAssistantId } : {}),
    ...(m.mime ? { mime: m.mime } : {}),
  }
}

/** Metadata names come back case-insensitively; fold to our shape. */
function fromAzureMetadata(raw: Record<string, string> | undefined, mime: string): GcsObjectMetadata {
  const custom: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw ?? {})) custom[k.toLowerCase()] = v
  return {
    workspaceId: custom.workspace_id ?? '',
    createdByUserId: custom.created_by_user_id,
    createdByAssistantId: custom.created_by_assistant_id,
    mime,
  }
}

function resolveMime(contentType: string | undefined, metadata: Record<string, string> | undefined): string {
  if (typeof contentType === 'string' && contentType) return contentType
  const fromMeta = Object.entries(metadata ?? {}).find(([k]) => k.toLowerCase() === 'mime')?.[1]
  return fromMeta || 'application/octet-stream'
}

/** True for the blob/container-not-found family of SDK errors. */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { statusCode?: number; code?: string; details?: { errorCode?: string } }
  if (e.statusCode === 404) return true
  const code = e.code ?? e.details?.errorCode
  return code === 'BlobNotFound' || code === 'ContainerNotFound' || code === 'ResourceNotFound'
}

async function streamToBuffer(body: NodeJS.ReadableStream | undefined): Promise<Buffer> {
  if (!body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

const STREAM_BLOCK_BYTES = 4 * 1024 * 1024
const STREAM_CONCURRENCY = 4

/**
 * Real adapter over `@azure/storage-blob`. Imported lazily on first use so the
 * module (and boot, and every test that injects a fake) loads without the SDK
 * being exercised.
 */
export async function createAzureBlobContainer(opts: AzureBlobClientOptions): Promise<AzureBlobContainer> {
  const sdk = await import('@azure/storage-blob')
  let service: InstanceType<typeof sdk.BlobServiceClient>
  if (opts.connectionString) {
    service = sdk.BlobServiceClient.fromConnectionString(opts.connectionString)
    if (!(service.credential instanceof sdk.StorageSharedKeyCredential)) {
      throw new Error('[files] AZURE_STORAGE_CONNECTION_STRING must carry an AccountKey (SAS URLs need a shared key)')
    }
  } else {
    if (!opts.account || !opts.accountKey) {
      throw new Error('[files] Azure Blob needs an account + key or a connection string')
    }
    const credential = new sdk.StorageSharedKeyCredential(opts.account, opts.accountKey)
    const endpoint = opts.endpoint?.replace(/\/+$/, '') || `https://${opts.account}.blob.core.windows.net`
    service = new sdk.BlobServiceClient(endpoint, credential)
  }
  const container = service.getContainerClient(opts.container)
  const blob = (key: string) => container.getBlockBlobClient(key)

  return {
    async upload(key, bytes, o) {
      await blob(key).uploadData(bytes, {
        blobHTTPHeaders: { blobContentType: o.mime },
        metadata: o.metadata,
      })
    },
    async download(key) {
      try {
        const res = await blob(key).download(0)
        const bytes = await streamToBuffer(res.readableStreamBody)
        return { bytes, mime: resolveMime(res.contentType, res.metadata), metadata: res.metadata ?? {} }
      } catch (err: unknown) {
        if (isNotFound(err)) return null
        throw err
      }
    },

    async downloadRange(key, version, start, end) {
      try {
        const result = await blob(key).download(start, end - start, { conditions: { ifMatch: version } })
        if (result.contentLength !== end - start || result.etag !== version) {
          (result.readableStreamBody as { destroy?(): void } | undefined)?.destroy?.()
          return null
        }
        return streamToBuffer(result.readableStreamBody)
      } catch (err: unknown) {
        if (isNotFound(err) || [412, 416].includes((err as { statusCode?: number })?.statusCode ?? 0)) return null
        throw err
      }
    },
    async head(key) {
      try {
        const props = await blob(key).getProperties()
        const size = typeof props.contentLength === 'number' ? props.contentLength : 0
        return {
          sizeBytes: Number.isFinite(size) ? size : 0,
          mime: resolveMime(props.contentType, props.metadata),
          metadata: props.metadata ?? {},
          updatedAt: props.lastModified ?? null,
          version: props.etag,
        }
      } catch (err: unknown) {
        if (isNotFound(err)) return null
        throw err
      }
    },
    async delete(key) {
      await blob(key).deleteIfExists()
    },
    async sasUrl(key, o) {
      return blob(key).generateSasUrl({
        permissions: sdk.BlobSASPermissions.parse(o.permissions),
        expiresOn: o.expiresOn,
      })
    },
    async uploadStream(key, stream, o) {
      await blob(key).uploadStream(stream, STREAM_BLOCK_BYTES, STREAM_CONCURRENCY, {
        blobHTTPHeaders: { blobContentType: o.mime },
        metadata: o.metadata,
      })
    },
  }
}

export function createAzureBlobFilesClient(
  opts: AzureBlobClientOptions,
  deps: AzureBlobClientDeps = {},
): GcsFilesClient {
  // Build the container once, lazily, on the first real operation.
  let built: Promise<AzureBlobContainer> | null = null
  const container = () => {
    if (!built) built = (deps.createContainer ?? createAzureBlobContainer)(opts)
    return built
  }

  return {
    signedWriteHeaders: AZURE_BLOB_WRITE_HEADERS,

    async writeBlob(key, bytes, metadata) {
      const c = await container()
      await c.upload(key, bytes, { mime: metadata.mime, metadata: toAzureMetadata(metadata) })
    },

    async appendBlob(key, bytes) {
      const existing = await this.readBlob(key)
      if (!existing) {
        throw new Error(`azure: cannot append — blob not found at ${key}`)
      }
      const c = await container()
      await c.upload(key, Buffer.concat([existing.bytes, bytes]), {
        mime: existing.mime,
        metadata: toAzureMetadata(existing.metadata),
      })
    },

    async readBlob(key): Promise<GcsBlob | null> {
      const c = await container()
      const got = await c.download(key)
      if (!got) return null
      return { bytes: got.bytes, mime: got.mime, metadata: fromAzureMetadata(got.metadata, got.mime) }
    },

    async readBlobRange(key, version, start, end) {
      const c = await container()
      return c.downloadRange?.(key, version, start, end) ?? null
    },

    async statBlob(key): Promise<GcsBlobStat | null> {
      // Get Blob Properties is a HEAD: a large recording is sized without
      // moving a byte through this process.
      const c = await container()
      const got = await c.head(key)
      if (!got) return null
      return { sizeBytes: got.sizeBytes, mime: got.mime, updatedAt: got.updatedAt, version: got.version }
    },

    async deleteBlob(key) {
      const c = await container()
      try {
        await c.delete(key)
      } catch (err: unknown) {
        if (isNotFound(err)) return
        throw err
      }
    },

    async signedReadUrl(key, ttlSec = 3600) {
      const c = await container()
      return c.sasUrl(key, { permissions: 'r', expiresOn: new Date(Date.now() + ttlSec * 1000) })
    },

    async signedWriteUrl(key, o) {
      const c = await container()
      return c.sasUrl(key, { permissions: 'cw', expiresOn: new Date(Date.now() + (o?.ttlSec ?? 3600) * 1000) })
    },

    writeStream(key, o) {
      // Block-blob staged upload is Azure's streaming ingress: the SDK reads
      // the PassThrough block by block, so a large channel media pull never
      // buffers whole in memory. The returned writable only finishes once the
      // SDK has committed the block list, so `pipeline()` resolving means the
      // bytes are durable — a caller may insert the `workspace_files` row on it.
      const pass = new PassThrough()
      const upload = container().then((c) =>
        c.uploadStream(key, pass as Readable, {
          mime: o.mime,
          metadata: toAzureMetadata(o.metadata ? { ...o.metadata, mime: o.mime } : undefined),
        }),
      )
      const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)))
      const sink = new Writable({
        write(chunk, encoding, cb) {
          if (pass.write(chunk, encoding)) cb()
          else pass.once('drain', () => cb())
        },
        final(cb) {
          pass.end()
          upload.then(
            () => cb(),
            (err: unknown) => cb(asError(err)),
          )
        },
        destroy(err, cb) {
          pass.destroy(err ?? undefined)
          cb(err)
        },
      })
      // An upload can reject before it starts consuming `pass`. Destroying
      // the sink then destroys `pass` with the same error, which still needs
      // a listener even when no SDK reader has attached yet. Forward internal
      // stream errors through the public writable, where pipeline handles them.
      pass.on('error', (err: Error) => sink.destroy(err))
      upload.catch((err: unknown) => sink.destroy(asError(err)))
      return sink
    },
  }
}
