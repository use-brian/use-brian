import { createHash } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_ARCHIVE_SMALL_MEDIA_MAX_BYTES,
  ChatArchiveMediaTooLargeError,
  createChatArchiveMediaService,
} from '../media-service.js'

const ids = {
  asset: '4a1e6bd8-0000-4000-8000-000000000001',
  workspace: '4a1e6bd8-0000-4000-8000-000000000002',
  instance: '4a1e6bd8-0000-4000-8000-000000000003',
  owner: '4a1e6bd8-0000-4000-8000-000000000004',
}

function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.asset,
    workspaceId: ids.workspace,
    instanceId: ids.instance,
    ownerUserId: ids.owner,
    messageId: null,
    source: 'whatsapp',
    providerMessageId: 'wa-1',
    kind: 'image',
    filename: 'receipt.png',
    mime: 'image/png',
    sizeBytes: 0,
    expectedSha256: null,
    sha256: null,
    storageKey: `${ids.workspace}/chat-archive-${ids.asset}`,
    storageUri: `file://${ids.workspace}/chat-archive-${ids.asset}`,
    uploadStatus: 'uploading',
    extractionStatus: 'pending',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function harness(initialAsset = asset()) {
  let current = initialAsset
  const writeBlob = vi.fn(async () => {})
  const writeStream = vi.fn(() => new Writable({ write(_chunk, _encoding, callback) { callback() } }))
  const storage = {
    writeBlob,
    writeStream,
    deleteBlob: vi.fn(async () => {}),
  }
  const store = {
    bindingExists: vi.fn(async () => true),
    getByProvider: vi.fn(async () => null),
    upsertUploading: vi.fn(async (input: Record<string, unknown>) => {
      current = asset(input)
      return current
    }),
    markUploaded: vi.fn(async (_id: string, sha256: string, sizeBytes: number) => {
      current = asset({ ...current, sha256, sizeBytes, uploadStatus: 'uploaded' })
      return current
    }),
    markUploadFailed: vi.fn(async () => {}),
    completeUpload: vi.fn(async () => asset({ ...current, uploadStatus: 'stored' })),
    get: vi.fn(async () => current),
  }
  const service = createChatArchiveMediaService({
    store: store as never,
    filesResolver: {
      forWorkspace: vi.fn(async () => ({
        bucket: 'local', uriScheme: 'file', gcs: storage,
      })),
      forUri: vi.fn(async () => storage),
    } as never,
  })
  return { service, store, writeBlob, writeStream }
}

const input = {
  workspaceId: ids.workspace,
  instanceId: ids.instance,
  ownerUserId: ids.owner,
  source: 'whatsapp',
  providerMessageId: 'wa-1',
  kind: 'image' as const,
  filename: 'receipt.png',
  mime: 'image/png',
  sizeBytes: 0,
}

describe('[COMP:api/chat-archive-media] local media staging', () => {
  it('fingerprints bytes and completes a durable asset', async () => {
    const { service, store, writeBlob } = harness()
    const stored = await service.storeBuffer({ ...input, bytes: Buffer.from('receipt bytes') })
    expect(stored.uploadStatus).toBe('stored')
    expect(store.markUploaded).toHaveBeenCalledWith(
      expect.any(String),
      createHash('sha256').update('receipt bytes').digest('hex'),
      13,
    )
    expect(writeBlob).toHaveBeenCalledOnce()
  })

  it('rejects an oversized image before allocating storage', async () => {
    const { service, store } = harness()
    await expect(service.init({ ...input, sizeBytes: CHAT_ARCHIVE_SMALL_MEDIA_MAX_BYTES + 1 }))
      .rejects.toBeInstanceOf(ChatArchiveMediaTooLargeError)
    expect(store.upsertUploading).not.toHaveBeenCalled()
  })

  it('marks a streaming upload failed when the byte cap is crossed', async () => {
    const { service, store } = harness()
    await service.init(input)
    await expect(service.upload({
      assetId: ids.asset,
      stream: Readable.from(Buffer.alloc(CHAT_ARCHIVE_SMALL_MEDIA_MAX_BYTES + 1)),
    })).rejects.toBeInstanceOf(ChatArchiveMediaTooLargeError)
    expect(store.markUploadFailed).toHaveBeenCalledOnce()
  })

  it('reuses an already stored provider asset without another upload', async () => {
    const { service, store } = harness()
    const stored = asset({
      uploadStatus: 'stored',
      extractionStatus: 'ready',
      sha256: 'a'.repeat(64),
    })
    store.getByProvider.mockResolvedValue(stored as never)

    const initialized = await service.init({ ...input, sha256: 'a'.repeat(64) })
    expect(initialized).toEqual({ asset: stored, alreadyStored: true })
    expect(store.upsertUploading).not.toHaveBeenCalled()
  })

  it('acknowledges a repeated PUT without replacing stored bytes', async () => {
    const stored = asset({ uploadStatus: 'stored', extractionStatus: 'ready', sha256: 'a'.repeat(64) })
    const { service, writeStream } = harness(stored)
    const result = await service.upload({ assetId: ids.asset, stream: Readable.from(Buffer.from('replacement')) })
    expect(result).toBe(stored)
    expect(writeStream).not.toHaveBeenCalled()
  })
})
