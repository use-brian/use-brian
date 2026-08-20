import { describe, expect, it, vi } from 'vitest'
import { createSaveChatMediaTool, MAX_SAVE_CHAT_MEDIA_BYTES } from '../save-media-tool.js'
import type { MessageStoreClient } from '../message-store-client.js'
import type { FilesApi } from '@use-brian/core'

const SHA = 'a'.repeat(64)

function fakeClient(overrides: Partial<MessageStoreClient> = {}): MessageStoreClient {
  return {
    downloadMedia: vi.fn(async () => ({ bytes: Buffer.from('jpeg-bytes'), mime: 'image/jpeg' })),
    ...overrides,
  } as unknown as MessageStoreClient
}

function fakeFilesApi(over: Partial<FilesApi> = {}): FilesApi {
  return {
    writeBytes: vi.fn(async (_ctx: unknown, input: { path: string; bytes: Buffer }) => ({
      ok: true,
      value: { id: 'file-1', path: input.path, sizeBytes: input.bytes.length },
    })),
    ...over,
  } as unknown as FilesApi
}

const context = {
  userId: 'alice',
  workspaceId: 'w1',
  assistantId: 'a1',
  channelType: 'telegram',
  clearance: 'confidential',
} as never

describe('[COMP:tools/chat-archive-save-media] saveChatMedia', () => {
  it('binds the owner from tool context, never from model input', async () => {
    const client = fakeClient()
    const tool = createSaveChatMediaTool({ client, filesApi: fakeFilesApi() })

    await tool.execute({ sha256: SHA } as never, context)

    expect(client.downloadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'alice', sha256: SHA, maxBytes: MAX_SAVE_CHAT_MEDIA_BYTES }),
    )
    const shape = (tool.inputSchema as never as { shape: Record<string, unknown> }).shape
    expect(Object.keys(shape)).not.toContain('ownerUserId')
    expect(Object.keys(shape)).not.toContain('userId')
  })

  it('saves under /uploads/chat-archive and hands the fileId to delivery or semantic ingestion', async () => {
    const filesApi = fakeFilesApi()
    const tool = createSaveChatMediaTool({ client: fakeClient(), filesApi })

    const result = await tool.execute({ sha256: SHA, filename: 'sushi platter.jpg' } as never, context) as {
      data: { fileId: string; path: string; next: string }
      isError?: boolean
    }

    expect(result.isError).toBeFalsy()
    const writeInput = vi.mocked(filesApi.writeBytes).mock.calls[0][1] as { path: string; sensitivity: string; mime: string }
    expect(writeInput.path).toMatch(/^\/uploads\/chat-archive\/.+sushi platter\.jpg$/)
    expect(writeInput.sensitivity).toBe('internal')
    expect(writeInput.mime).toBe('image/jpeg')
    expect(result.data.fileId).toBe('file-1')
    // Saving preserves bytes only. Delivery and semantic reading stay explicit.
    expect(result.data.next).toContain('sendFile')
    expect(result.data.next).toContain('ingestFile')
    expect(result.data.next).toContain('confirmation')
    expect(result.data.next).toContain('file-1')
  })

  it('derives a safe name from the digest when none is given', async () => {
    const filesApi = fakeFilesApi()
    const tool = createSaveChatMediaTool({ client: fakeClient(), filesApi })

    await tool.execute({ sha256: SHA } as never, context)

    const writeInput = vi.mocked(filesApi.writeBytes).mock.calls[0][1] as { path: string }
    expect(writeInput.path).toContain(`chat-media-${SHA.slice(0, 12)}.jpg`)
  })

  it('strips path traversal from a model-supplied filename', async () => {
    const filesApi = fakeFilesApi()
    const tool = createSaveChatMediaTool({ client: fakeClient(), filesApi })

    await tool.execute({ sha256: SHA, filename: '../../etc/passwd' } as never, context)

    const writeInput = vi.mocked(filesApi.writeBytes).mock.calls[0][1] as { path: string }
    expect(writeInput.path).toMatch(/^\/uploads\/chat-archive\/[^/]+$/)
  })

  it('reports a missing digest as a failure, never a silent success', async () => {
    const client = fakeClient({
      downloadMedia: vi.fn(async () => {
        throw new Error('message store GET /media failed: 404 not found')
      }) as never,
    })
    const tool = createSaveChatMediaTool({ client, filesApi: fakeFilesApi() })

    const result = await tool.execute({ sha256: SHA } as never, context) as { isError?: boolean; data: unknown }

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('404')
  })

  it('refuses without a workspace instead of writing nowhere', async () => {
    const tool = createSaveChatMediaTool({ client: fakeClient(), filesApi: fakeFilesApi() })
    const result = await tool.execute({ sha256: SHA } as never, { ...(context as object), workspaceId: null } as never) as { isError?: boolean }
    expect(result.isError).toBe(true)
  })
})
