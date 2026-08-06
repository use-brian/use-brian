/** Local archive media staging orchestration. Bytes never enter message rows. */

import { createHash, randomUUID } from 'node:crypto'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { CanonicalIngestMessageV2 } from '@use-brian/shared'
import type { FilesClientResolver } from '../files/files-api.js'
import { buildStorageKey, buildStorageUri } from '../files/gcs-client.js'
import type {
  ChatArchiveMediaAsset,
  ChatArchiveMediaKind,
  ChatArchiveMediaStore,
} from '../db/chat-archive-media-store.js'

export const CHAT_ARCHIVE_SMALL_MEDIA_MAX_BYTES = 25 * 1024 * 1024
export const CHAT_ARCHIVE_LARGE_MEDIA_MAX_BYTES = 500 * 1024 * 1024

export class ChatArchiveMediaTooLargeError extends Error {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`chat archive media exceeds ${maxBytes} bytes (saw ${bytes})`)
    this.name = 'ChatArchiveMediaTooLargeError'
  }
}

export type InitChatArchiveMedia = {
  workspaceId: string
  instanceId: string
  ownerUserId: string
  source: string
  providerMessageId: string
  kind: ChatArchiveMediaKind
  filename: string
  mime: string
  sizeBytes: number
  sha256?: string | null
}

export type ChatArchiveMediaService = ReturnType<typeof createChatArchiveMediaService>

export function mediaByteLimit(kind: ChatArchiveMediaKind): number {
  return kind === 'video' || kind === 'voice'
    ? CHAT_ARCHIVE_LARGE_MEDIA_MAX_BYTES
    : CHAT_ARCHIVE_SMALL_MEDIA_MAX_BYTES
}

export function archiveMediaRef(asset: ChatArchiveMediaAsset): NonNullable<CanonicalIngestMessageV2['media_ref']> {
  if (asset.uploadStatus !== 'stored' || !asset.sha256) {
    throw new Error('chat archive media asset is not durably stored')
  }
  return {
    asset_id: asset.id,
    sha256: asset.sha256,
    availability: 'stored',
    filename: asset.filename,
    mime: asset.mime,
    size_bytes: asset.sizeBytes,
  }
}

export function createChatArchiveMediaService(deps: {
  store: ChatArchiveMediaStore
  filesResolver: FilesClientResolver
}) {
  async function resolveBinding(input: {
    workspaceId: string
    ownerUserId: string
    source: string
    instanceId?: string | null
  }): Promise<string> {
    const instanceId = await deps.store.ensureBinding(input)
    if (!instanceId) throw new Error('unable to resolve local chat archive connector binding')
    return instanceId
  }

  async function init(input: InitChatArchiveMedia): Promise<{ asset: ChatArchiveMediaAsset; alreadyStored: boolean }> {
    input = { ...input, mime: input.mime.trim() || 'application/octet-stream' }
    if (!(await deps.store.bindingExists(input))) {
      throw new Error('instance/source/workspace/owner archive binding is invalid')
    }
    const limit = mediaByteLimit(input.kind)
    if (input.sizeBytes > limit) throw new ChatArchiveMediaTooLargeError(input.sizeBytes, limit)

    const existing = await deps.store.getByProvider({
      instanceId: input.instanceId,
      providerMessageId: input.providerMessageId,
    })
    if (
      existing?.uploadStatus === 'stored'
      && existing.sha256
      && (!input.sha256 || existing.sha256 === input.sha256)
    ) {
      return { asset: existing, alreadyStored: true }
    }

    const id = existing?.id ?? randomUUID()
    let storageKey = existing?.storageKey
    let storageUri = existing?.storageUri
    if (!storageKey || !storageUri) {
      const resolved = await deps.filesResolver.forWorkspace(input.workspaceId)
      const storageId = `chat-archive-${id}`
      storageKey = buildStorageKey(input.workspaceId, storageId)
      storageUri = buildStorageUri(
        resolved.bucket,
        input.workspaceId,
        storageId,
        resolved.uriScheme,
      )
    }
    const asset = await deps.store.upsertUploading({
      id,
      ...input,
      expectedSha256: input.sha256 ?? null,
      storageKey,
      storageUri,
    })
    return { asset, alreadyStored: asset.uploadStatus === 'stored' }
  }

  async function upload(input: {
    assetId: string
    stream: Readable
    contentLength?: number | null
  }): Promise<ChatArchiveMediaAsset> {
    const asset = await deps.store.get(input.assetId)
    if (!asset) throw new Error('chat archive media asset not found')
    // A completed idempotency key is immutable. A retried PUT may still arrive
    // after init reported the existing asset; acknowledge it without replacing
    // durable bytes or resetting extraction.
    if (asset.uploadStatus === 'stored') return asset
    const maxBytes = mediaByteLimit(asset.kind)
    if (input.contentLength != null && input.contentLength > maxBytes) {
      throw new ChatArchiveMediaTooLargeError(input.contentLength, maxBytes)
    }
    const client = await deps.filesResolver.forUri(asset.workspaceId, asset.storageUri)
    const hash = createHash('sha256')
    let bytes = 0
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > maxBytes) {
          callback(new ChatArchiveMediaTooLargeError(bytes, maxBytes))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(
        input.stream,
        counter,
        client.writeStream(asset.storageKey, {
          mime: asset.mime,
          metadata: {
            workspaceId: asset.workspaceId,
            createdByUserId: asset.ownerUserId,
            mime: asset.mime,
          },
        }),
      )
      return deps.store.markUploaded(asset.id, hash.digest('hex'), bytes)
    } catch (err) {
      await client.deleteBlob(asset.storageKey).catch(() => {})
      await deps.store.markUploadFailed(asset.id, err instanceof Error ? err.message : String(err)).catch(() => {})
      throw err
    }
  }

  async function complete(assetId: string): Promise<ChatArchiveMediaAsset> {
    return deps.store.completeUpload(assetId)
  }

  async function storeBuffer(input: InitChatArchiveMedia & { bytes: Buffer }): Promise<ChatArchiveMediaAsset> {
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const initialized = await init({ ...input, sizeBytes: input.bytes.byteLength, sha256 })
    if (initialized.alreadyStored) return initialized.asset
    const client = await deps.filesResolver.forUri(input.workspaceId, initialized.asset.storageUri)
    try {
      await client.writeBlob(initialized.asset.storageKey, input.bytes, {
        workspaceId: input.workspaceId,
        createdByUserId: input.ownerUserId,
        mime: input.mime,
      })
      await deps.store.markUploaded(initialized.asset.id, sha256, input.bytes.byteLength)
      return complete(initialized.asset.id)
    } catch (err) {
      await client.deleteBlob(initialized.asset.storageKey).catch(() => {})
      await deps.store.markUploadFailed(
        initialized.asset.id,
        err instanceof Error ? err.message : String(err),
      ).catch(() => {})
      throw err
    }
  }

  return { resolveBinding, init, upload, complete, storeBuffer }
}
