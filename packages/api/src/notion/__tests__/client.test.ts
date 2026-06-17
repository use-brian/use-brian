import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  searchNotion,
  getNotionPage,
  getNotionDatabase,
  queryNotionDatabase,
  createNotionPage,
  updateNotionPage,
  appendNotionBlocks,
} from '../client.js'

// ── Mock fetch ──────────────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

beforeEach(() => {
  mockFetch.mockReset()
})

const TOKEN = 'ntn_test_token_123'

// ── Tests ────────────────────────────────────────────────────

describe('[COMP:notion/client] Notion API client', () => {
  it('sends correct headers on every request', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }))

    await searchNotion(TOKEN, {})

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': `Bearer ${TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        }),
      }),
    )
  })

  // ── Search ──────────────────────────────────────────────────

  it('searchNotion calls POST /v1/search', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [{ id: 'page1' }] }))

    const result = await searchNotion(TOKEN, { query: 'test', filter: 'page' })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.notion.com/v1/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'test', filter: { value: 'page', property: 'object' } }),
      }),
    )
    expect(result).toEqual({ results: [{ id: 'page1' }] })
  })

  // ── Pages ──────────────────────────────────────────────────

  it('getNotionPage fetches page + blocks', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'page1', properties: {} }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ type: 'paragraph' }], has_more: false }))

    const result = await getNotionPage(TOKEN, 'page-123')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.notion.com/v1/pages/page-123',
      expect.any(Object),
    )
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.notion.com/v1/blocks/page-123/children',
      expect.any(Object),
    )
    expect(result).toEqual({
      page: { id: 'page1', properties: {} },
      blocks: [{ type: 'paragraph' }],
    })
  })

  it('createNotionPage sends POST /v1/pages with content blocks', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'page-new' }))

    await createNotionPage(TOKEN, {
      parentId: 'db-123',
      parentType: 'database',
      title: 'My Page',
      content: 'Hello\n\nWorld',
    })

    const call = mockFetch.mock.calls[0]
    expect(call[0]).toBe('https://api.notion.com/v1/pages')
    expect(call[1].method).toBe('POST')

    const body = JSON.parse(call[1].body)
    expect(body.parent).toEqual({ database_id: 'db-123' })
    expect(body.children).toHaveLength(2)
    expect(body.children[0].type).toBe('paragraph')
  })

  it('updateNotionPage sends PATCH /v1/pages/:id', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'page1' }))

    await updateNotionPage(TOKEN, 'page-123', { archived: true })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.notion.com/v1/pages/page-123',
      expect.objectContaining({ method: 'PATCH' }),
    )
  })

  it('appendNotionBlocks sends PATCH /v1/blocks/:id/children', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }))

    await appendNotionBlocks(TOKEN, 'page-123', 'New text')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.notion.com/v1/blocks/page-123/children',
      expect.objectContaining({ method: 'PATCH' }),
    )
  })

  // ── Databases ──────────────────────────────────────────────

  it('getNotionDatabase calls GET /v1/databases/:id', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'db1' }))

    await getNotionDatabase(TOKEN, 'db-456')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.notion.com/v1/databases/db-456',
      expect.any(Object),
    )
  })

  it('queryNotionDatabase calls POST /v1/databases/:id/query', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: [] }))

    await queryNotionDatabase(TOKEN, 'db-456', {
      filter: { property: 'Status', select: { equals: 'Done' } },
      pageSize: 10,
    })

    const call = mockFetch.mock.calls[0]
    expect(call[0]).toBe('https://api.notion.com/v1/databases/db-456/query')
    expect(call[1].method).toBe('POST')
    const body = JSON.parse(call[1].body)
    expect(body.filter).toEqual({ property: 'Status', select: { equals: 'Done' } })
    expect(body.page_size).toBe(10)
  })

  // ── Error handling ────────────────────────────────────────────

  it('throws descriptive error on non-200 response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ message: 'Not found' }, 404))

    await expect(searchNotion(TOKEN, {})).rejects.toThrow('Notion API error (404)')
  })

  it('throws reconnect message on 401', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401))

    await expect(searchNotion(TOKEN, {})).rejects.toThrow('reconnect Notion')
  })
})
