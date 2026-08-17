import { describe, expect, it, vi } from 'vitest'
import { createChatArchiveTools } from '../chat-tools.js'
import type { MessageStoreClient } from '../message-store-client.js'

function fakeClient(overrides: Partial<MessageStoreClient> = {}): MessageStoreClient {
  return {
    search: vi.fn(async () => ({ hits: [], embedding_coverage: { partial: false, pending: 0, capped: false, note: 'complete for the selected filters' } })),
    listChannels: vi.fn(async () => []),
    ...overrides,
  } as unknown as MessageStoreClient
}

const context = { userId: 'alice', workspaceId: 'w1', assistantId: 'a1' } as never

describe('chat archive tools', () => {
  it('exposes search and its channel resolver', () => {
    const names = createChatArchiveTools({ client: fakeClient() }).map((tool) => tool.name)
    // Without a resolver a model can only narrow a search using a handle lifted
    // from an earlier result, which it has no way to obtain first.
    expect(names).toEqual(['searchChatHistory', 'listChatChannels'])
  })

  it('binds the owner from tool context, never from model input', async () => {
    const search = vi.fn(async () => ({ hits: [], embedding_coverage: { partial: false, pending: 0, capped: false, note: 'ok' } }))
    const [searchTool] = createChatArchiveTools({ client: fakeClient({ search }) })

    await searchTool!.execute({ query: 'invoice' } as never, context)

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'alice', query: 'invoice' }))
    // The schema must offer no way to express whose archive to read.
    const shape = (searchTool!.inputSchema as never as { shape: Record<string, unknown> }).shape
    expect(Object.keys(shape)).not.toContain('ownerUserId')
    expect(Object.keys(shape)).not.toContain('userId')
  })

  it('hands back a reusable channel handle on every hit', async () => {
    const search = vi.fn(async () => ({
      hits: [{ instance_id: 'i1', conversation_id: 'c1@g.us', segment_text: 'hi' }],
      embedding_coverage: { partial: false, pending: 0, capped: false, note: 'ok' },
    }))
    const [searchTool] = createChatArchiveTools({ client: fakeClient({ search: search as never }) })

    const result = await searchTool!.execute({ query: 'hi' } as never, context) as { data: { hits: Array<{ channel: string }> } }

    // Pairing the two ids for the caller stops a conversation id being reused
    // against the wrong connected account.
    expect(result.data.hits[0]!.channel).toBe('i1:c1@g.us')
  })

  it('surfaces coverage so a thin result set can be told from a blind search', async () => {
    const search = vi.fn(async () => ({
      hits: [],
      embedding_coverage: { partial: true, pending: 5000, capped: true, note: 'at least 5000 segments pending' },
    }))
    const [searchTool] = createChatArchiveTools({ client: fakeClient({ search: search as never }) })

    const result = await searchTool!.execute({ query: 'x' } as never, context) as { data: { embeddingCoverage: string } }

    expect(result.data.embeddingCoverage).toContain('5000')
  })

  it('rejects a zoneless timestamp rather than resolving it against the server clock', () => {
    const [searchTool] = createChatArchiveTools({ client: fakeClient() })
    const schema = searchTool!.inputSchema as never as { safeParse(v: unknown): { success: boolean } }

    expect(schema.safeParse({ query: 'x', since: '2026-08-14' }).success).toBe(true)
    expect(schema.safeParse({ query: 'x', since: '2026-08-14T09:00:00Z' }).success).toBe(true)
    expect(schema.safeParse({ query: 'x', since: '2026-08-14T09:00:00' }).success).toBe(false)
    expect(schema.safeParse({ query: 'x', since: '2026' }).success).toBe(false)
  })

  it('reports a store failure as a tool error instead of throwing', async () => {
    const search = vi.fn(async () => { throw new Error('store unreachable') })
    const [searchTool] = createChatArchiveTools({ client: fakeClient({ search: search as never }) })

    const result = await searchTool!.execute({ query: 'x' } as never, context) as { isError?: true }

    expect(result.isError).toBe(true)
  })
})
