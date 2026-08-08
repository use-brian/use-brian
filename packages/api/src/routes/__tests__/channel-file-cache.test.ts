import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(),
}))

import { cacheInboundImage, cacheInboundImageTag } from '../channel-file-cache.js'
import { findOrCreateSession } from '../../db/sessions.js'

const mockSession = vi.mocked(findOrCreateSession)

function makeStore() {
  return { cache: vi.fn(async (_params: Record<string, unknown>) => ({ id: 'fc_9' }) as never) }
}

function baseInput(store: ReturnType<typeof makeStore>) {
  return {
    fileStore: store as never,
    channelType: 'telegram',
    channelId: '123',
    userId: 'u_1',
    assistant: { id: 'a_1', workspaceId: 'ws_1' },
    file: { buffer: Buffer.from('img-bytes'), mime: 'image/png', fileName: 'photo.png' },
  }
}

describe('[COMP:api/channel-file-cache] cacheInboundImage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('caches an image as a data URL, workspace-shared, keyed to the pipeline session', async () => {
    mockSession.mockResolvedValue({ id: 'sess-1' } as never)
    const store = makeStore()
    const id = await cacheInboundImage(baseInput(store))
    expect(id).toBe('fc_9')
    // Same session key the channel pipeline resolves — the pre-resolve is an
    // idempotent find of the turn's own session.
    expect(mockSession).toHaveBeenCalledWith({
      assistantId: 'a_1',
      userId: 'u_1',
      channelType: 'telegram',
      channelId: '123',
    })
    const arg = store.cache.mock.calls[0][0]
    expect(arg).toMatchObject({
      sessionId: 'sess-1',
      fileName: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 9,
      workspaceId: 'ws_1',
      // Same data-URL format the web upload route stores — what
      // saveFileToBrain / the chat attach seam decode.
      content: `data:image/png;base64,${Buffer.from('img-bytes').toString('base64')}`,
    })
    // Workspace-shared: no user/assistant pin, so the promotion-time tool
    // context (BYO channel user vs owner) can always read the row.
    expect(arg.userId).toBeUndefined()
    expect(arg.assistantId).toBeUndefined()
  })

  it('returns null for non-image mimes without touching the store', async () => {
    const store = makeStore()
    const id = await cacheInboundImage({
      ...baseInput(store),
      file: { buffer: Buffer.from('x'), mime: 'application/pdf', fileName: 'a.pdf' },
    })
    expect(id).toBeNull()
    expect(store.cache).not.toHaveBeenCalled()
    expect(mockSession).not.toHaveBeenCalled()
  })

  it('returns null when the assistant has no workspace', async () => {
    const store = makeStore()
    const id = await cacheInboundImage({
      ...baseInput(store),
      assistant: { id: 'a_1', workspaceId: null },
    })
    expect(id).toBeNull()
    expect(store.cache).not.toHaveBeenCalled()
  })

  it('degrades to null on any failure — caching never blocks the turn', async () => {
    mockSession.mockRejectedValue(new Error('db down'))
    const store = makeStore()
    const id = await cacheInboundImage(baseInput(store))
    expect(id).toBeNull()

    mockSession.mockResolvedValue({ id: 'sess-1' } as never)
    const failingStore = { cache: vi.fn(async () => { throw new Error('cache write failed') }) }
    const id2 = await cacheInboundImage({ ...baseInput(store), fileStore: failingStore as never })
    expect(id2).toBeNull()
  })
})

// The envelope has to match `buildFileContentBlocks` byte for byte: the model
// pattern-matches the tag shape it already sees in web chat and on Telegram.
// Slack / Discord / MS Teams / WeChat build content blocks by hand and pushed
// a bare `image` block with NO tag, so a photo on those channels carried no
// identifier in any form — this helper is what makes wiring them two lines.
describe('[COMP:api/channel-file-cache] cacheInboundImageTag', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the same <attached_file> envelope buildFileContentBlocks emits', async () => {
    mockSession.mockResolvedValue({ id: 'sess-1' } as never)
    const tag = await cacheInboundImageTag(baseInput(makeStore()))
    expect(tag).toBe('<attached_file id="fc_9" name="photo.png" type="image/png">[image]</attached_file>')
  })

  it('returns an empty string on every miss, so callers can append unconditionally', async () => {
    mockSession.mockResolvedValue({ id: 'sess-1' } as never)
    const store = makeStore()

    // non-image
    expect(await cacheInboundImageTag({
      ...baseInput(store),
      file: { buffer: Buffer.from('x'), mime: 'application/pdf', fileName: 'a.pdf' },
    })).toBe('')

    // workspace-less assistant
    expect(await cacheInboundImageTag({
      ...baseInput(store),
      assistant: { id: 'a_1', workspaceId: null },
    })).toBe('')

    // store failure
    const failingStore = { cache: vi.fn(async () => { throw new Error('boom') }) }
    expect(await cacheInboundImageTag({
      ...baseInput(store),
      fileStore: failingStore as never,
    })).toBe('')
  })
})
