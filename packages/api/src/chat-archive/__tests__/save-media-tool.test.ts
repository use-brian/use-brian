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
    // Nothing saved yet — the first-save case.
    stat: vi.fn(async () => ({ ok: false, error: { kind: 'not_found', reference: 'x' } })),
    writeBytes: vi.fn(async (_ctx: unknown, input: { path: string; bytes: Buffer; title?: string }) => ({
      ok: true,
      value: {
        id: 'file-1',
        path: input.path,
        name: input.path.split('/').pop(),
        title: input.title ?? null,
        mime: 'image/jpeg',
        sizeBytes: input.bytes.length,
      },
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
  it('gives programmatic callers a binary download step instead of unavailable channel tools', async () => {
    const tool = createSaveChatMediaTool({ client: fakeClient(), filesApi: fakeFilesApi() })
    const result = await tool.execute({ sha256: SHA }, { ...context as object, channelType: 'programmatic' } as never)
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({ next: expect.stringContaining('fileReadBytes') })
    expect((result.data as { next: string }).next).not.toMatch(/sendFile|ingestFile/)
  })

  it('enforces Files tool policy before reading or downloading archived bytes', async () => {
    const client = fakeClient()
    const filesApi = fakeFilesApi()
    const tool = createSaveChatMediaTool({ client, filesApi, resolvePolicy: async () => 'block' })
    expect((await tool.execute({ sha256: SHA }, context)).isError).toBe(true)
    expect(client.downloadMedia).not.toHaveBeenCalled()
    expect(filesApi.stat).not.toHaveBeenCalled()
    expect(filesApi.writeBytes).not.toHaveBeenCalled()
  })

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
    const writeInput = vi.mocked(filesApi.writeBytes).mock.calls[0][1] as { path: string; sensitivity: string; mime: string; title: string }
    // Content-addressed: the path is the digest and nothing else, so the same
    // bytes always land on one path no matter how often they are asked for.
    expect(writeInput.path).toBe(`/uploads/chat-archive/${SHA}`)
    // The readable name lives in the title, which is what the Files view shows.
    expect(writeInput.title).toBe('sushi platter.jpg')
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

    const writeInput = vi.mocked(filesApi.writeBytes).mock.calls[0][1] as { title: string }
    expect(writeInput.title).toContain(`chat-media-${SHA.slice(0, 12)}.jpg`)
  })

  it('keeps a model-supplied filename out of the path entirely', async () => {
    const filesApi = fakeFilesApi()
    const tool = createSaveChatMediaTool({ client: fakeClient(), filesApi })

    await tool.execute({ sha256: SHA, filename: '../../etc/passwd' } as never, context)

    const writeInput = vi.mocked(filesApi.writeBytes).mock.calls[0][1] as { path: string; title: string }
    // The path is derived from the digest alone, so a hostile filename cannot
    // reach it at all — and the title it does reach is still separator-free.
    expect(writeInput.path).toBe(`/uploads/chat-archive/${SHA}`)
    expect(writeInput.title).not.toContain('/')
  })

  it('returns the file already saved for this digest without transferring bytes', async () => {
    // Saved once, not once per request. The lookup runs BEFORE the download,
    // so asking a second time costs one metadata read and no transfer.
    const client = fakeClient()
    const filesApi = fakeFilesApi({
      stat: vi.fn(async () => ({
        ok: true,
        value: {
          id: 'file-existing', path: `/uploads/chat-archive/${SHA}`,
          name: SHA, title: 'sushi platter.jpg', mime: 'image/jpeg', sizeBytes: 10,
        },
      })) as never,
    })
    const tool = createSaveChatMediaTool({ client, filesApi })

    const result = await tool.execute({ sha256: SHA } as never, context) as {
      data: { fileId: string; filename: string; next: string }
      isError?: boolean
    }

    expect(result.isError).toBeFalsy()
    expect(result.data.fileId).toBe('file-existing')
    // A hit is success, not a conflict — and it reads the same as a fresh save.
    expect(result.data.filename).toBe('sushi platter.jpg')
    expect(result.data.next).toContain('sendFile')
    expect(client.downloadMedia).not.toHaveBeenCalled()
    expect(filesApi.writeBytes).not.toHaveBeenCalled()
  })

  it('reports the winner when a concurrent save reaches the path first', async () => {
    // Both callers wanted these bytes at this path and they are there. An
    // error would blame the user for a race neither of them caused.
    const stat = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { kind: 'not_found', reference: 'x' } })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          id: 'file-raced', path: `/uploads/chat-archive/${SHA}`,
          name: SHA, title: 'receipt.jpg', mime: 'image/jpeg', sizeBytes: 10,
        },
      })
    const filesApi = fakeFilesApi({
      stat: stat as never,
      writeBytes: vi.fn(async () => ({ ok: false, error: { kind: 'conflict', path: `/uploads/chat-archive/${SHA}` } })) as never,
    })
    const tool = createSaveChatMediaTool({ client: fakeClient(), filesApi })

    const result = await tool.execute({ sha256: SHA } as never, context) as {
      data: { fileId: string }
      isError?: boolean
    }

    expect(result.isError).toBeFalsy()
    expect(result.data.fileId).toBe('file-raced')
  })

  it('surfaces a write failure that is not a conflict', async () => {
    const filesApi = fakeFilesApi({
      writeBytes: vi.fn(async () => ({
        ok: false,
        error: { kind: 'quota_exceeded', currentBytes: 10, limitBytes: 10, attemptedBytes: 5 },
      })) as never,
    })
    const tool = createSaveChatMediaTool({ client: fakeClient(), filesApi })

    const result = await tool.execute({ sha256: SHA } as never, context) as { isError?: boolean }
    expect(result.isError).toBe(true)
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
