import { describe, expect, it, vi } from 'vitest'
import { createChatArchiveMediaWorker } from '../media-worker.js'

function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: '4a1e6bd8-0000-4000-8000-000000000001',
    workspaceId: '4a1e6bd8-0000-4000-8000-000000000002',
    instanceId: '4a1e6bd8-0000-4000-8000-000000000003',
    ownerUserId: '4a1e6bd8-0000-4000-8000-000000000004',
    messageId: '4a1e6bd8-0000-4000-8000-000000000005',
    source: 'whatsapp',
    providerMessageId: 'wa-1',
    kind: 'image',
    filename: 'receipt.png',
    mime: 'image/png',
    sizeBytes: 5,
    expectedSha256: null,
    sha256: 'a'.repeat(64),
    storageKey: 'workspace/chat-archive-asset',
    storageUri: 'file://workspace/chat-archive-asset',
    uploadStatus: 'stored',
    extractionStatus: 'pending',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function harness(mediaAsset = asset()) {
  const store = {
    claimNext: vi.fn(async () => ({ id: 'job-1', asset: mediaAsset, attemptCount: 1 })),
    replaceDerivedSegments: vi.fn(async (_asset: unknown, _segments: unknown[]) => {}),
    completeJob: vi.fn(async () => {}),
    unsupportedJob: vi.fn(async () => {}),
    failJob: vi.fn(async () => {}),
    listUnlinkedBefore: vi.fn(async () => []),
    remove: vi.fn(async () => {}),
    listDeletions: vi.fn(async () => []),
    completeDeletion: vi.fn(async () => {}),
    failDeletion: vi.fn(async () => {}),
  }
  const storage = {
    signedReadUrl: vi.fn(async () => 'file:///tmp/media'),
    readBlob: vi.fn(async () => ({ bytes: Buffer.from('bytes'), metadata: {} })),
    writeBlob: vi.fn(async () => {}),
    deleteBlob: vi.fn(async () => {}),
  }
  const distill = vi.fn(async ({ prompt }: { prompt?: string }) =>
    prompt?.startsWith('Transcribe') ? 'TOTAL 42.00' : 'A photographed shop receipt',
  )
  const worker = createChatArchiveMediaWorker({
    store: store as never,
    filesResolver: { forUri: vi.fn(async () => storage) } as never,
    distill,
  })
  return { worker, store, distill }
}

describe('[COMP:api/chat-archive-media] derived segment worker', () => {
  it('stores separate image OCR and semantic-description segments', async () => {
    const { worker, store, distill } = harness()
    expect(await worker.runOnce()).toBe(true)
    expect(distill).toHaveBeenCalledTimes(2)
    const segments = store.replaceDerivedSegments.mock.calls[0]![1]
    expect(segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'TOTAL 42.00', metadata: expect.objectContaining({ modality: 'image_ocr' }) }),
      expect.objectContaining({ text: 'A photographed shop receipt', metadata: expect.objectContaining({ modality: 'image_description' }) }),
    ]))
    expect(store.completeJob).toHaveBeenCalledWith('job-1', expect.any(String))
  })

  it('parks an unknown binary as unsupported while retaining the asset', async () => {
    const { worker, store } = harness(asset({
      kind: 'file', filename: 'legacy.bin', mime: 'application/octet-stream',
    }))
    expect(await worker.runOnce()).toBe(true)
    expect(store.replaceDerivedSegments).not.toHaveBeenCalled()
    expect(store.unsupportedJob).toHaveBeenCalledWith(
      'job-1', expect.any(String), expect.stringContaining('unsupported'),
    )
  })

  it('passes the workspace language preference to voice transcription', async () => {
    const mediaAsset = asset({
      kind: 'voice', filename: 'voice.ogg', mime: 'audio/ogg',
    })
    const store = {
      claimNext: vi.fn(async () => ({ id: 'job-1', asset: mediaAsset, attemptCount: 1 })),
      replaceDerivedSegments: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      unsupportedJob: vi.fn(async () => {}),
      failJob: vi.fn(async () => {}),
      listUnlinkedBefore: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      listDeletions: vi.fn(async () => []),
      completeDeletion: vi.fn(async () => {}),
      failDeletion: vi.fn(async () => {}),
    }
    const storage = {
      signedReadUrl: vi.fn(async () => 'file:///tmp/media'),
      writeBlob: vi.fn(async () => {}),
      deleteBlob: vi.fn(async () => {}),
    }
    const transcribe = vi.fn(async () => ({
      utterances: [{ startMs: 0, endMs: 1_000, speaker: null, text: 'Hello, hello, hello.' }],
      usages: [], windows: 1, truncated: false, degenerateWindows: 0,
    }))
    const worker = createChatArchiveMediaWorker({
      store: store as never,
      filesResolver: { forUri: vi.fn(async () => storage) } as never,
      transcriber: { name: 'test', transcribe },
      resolveTranscriptionLanguage: vi.fn(async () => 'en'),
      probe: vi.fn(async () => 1_000),
      extract: vi.fn(async () => ({ buffer: Buffer.from('audio'), mime: 'audio/mp4' })),
    })

    expect(await worker.runOnce()).toBe(true)
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: 'en' }))
    expect(store.replaceDerivedSegments).toHaveBeenCalledWith(
      mediaAsset,
      [expect.objectContaining({ text: 'Hello, hello, hello.' })],
    )
  })
})
