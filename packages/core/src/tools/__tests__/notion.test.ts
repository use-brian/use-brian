import { describe, it, expect, vi } from 'vitest'
import { createNotionTools, type NotionApi } from '../base/notion.js'

// ── Helpers ──────────────────────────────────────────────────

const ctx = {
  userId: 'test-user',
  assistantId: 'test-assistant',
  sessionId: 'test-session',
  appId: 'test',
  channelType: 'web' as const,
  channelId: 'test-channel',
  abortSignal: new AbortController().signal,
}

function mockApi(overrides?: Partial<NotionApi>): NotionApi {
  return {
    search: vi.fn().mockResolvedValue({ results: [] }),
    getPage: vi.fn().mockResolvedValue({ page: {}, blocks: [] }),
    getDatabase: vi.fn().mockResolvedValue({ id: 'db1', title: [{ text: { content: 'Test DB' } }] }),
    queryDatabase: vi.fn().mockResolvedValue({ results: [] }),
    createPage: vi.fn().mockResolvedValue({ id: 'page-new' }),
    updatePage: vi.fn().mockResolvedValue({ id: 'page1' }),
    appendBlocks: vi.fn().mockResolvedValue({ results: [] }),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('[COMP:tools/notion] Notion tools', () => {
  it('creates all 7 tools', () => {
    const tools = createNotionTools(mockApi())
    expect(tools).toHaveLength(7)
    expect(tools.map((t) => t.name).sort()).toEqual([
      'notionAppendBlocks',
      'notionCreatePage',
      'notionGetDatabase',
      'notionGetPage',
      'notionQueryDatabase',
      'notionSearch',
      'notionUpdatePage',
    ])
  })

  // ── Safety flags ──────────────────────────────────────────────

  it('read tools are concurrent-safe and read-only', () => {
    const tools = createNotionTools(mockApi())
    const readTools = tools.filter((t) =>
      ['notionSearch', 'notionGetPage', 'notionGetDatabase', 'notionQueryDatabase'].includes(t.name),
    )

    expect(readTools).toHaveLength(4)
    for (const tool of readTools) {
      expect(tool.isConcurrencySafe).toBe(true)
      expect(tool.isReadOnly).toBe(true)
      expect(tool.requiresConfirmation).toBeFalsy()
    }
  })

  it('write tools require confirmation', () => {
    const tools = createNotionTools(mockApi())
    const writeTools = tools.filter((t) =>
      ['notionCreatePage', 'notionUpdatePage', 'notionAppendBlocks'].includes(t.name),
    )

    expect(writeTools).toHaveLength(3)
    for (const tool of writeTools) {
      expect(tool.requiresConfirmation).toBe(true)
      expect(tool.isReadOnly).toBe(false)
    }
  })

  it('tool descriptions must NOT say "Requires confirmation" (causes double-confirm)', () => {
    const tools = createNotionTools(mockApi())
    for (const tool of tools) {
      expect(tool.description).not.toMatch(/[Rr]equires confirmation/)
    }
  })

  // ── API delegation ────────────────────────────────────────────

  it('search delegates to api.search with query and filter', async () => {
    const api = mockApi()
    const tools = createNotionTools(api)
    const searchTool = tools.find((t) => t.name === 'notionSearch')!

    await searchTool.execute({ query: 'meeting notes', filter: 'page' }, ctx)

    expect(api.search).toHaveBeenCalledWith({
      query: 'meeting notes',
      filter: 'page',
      pageSize: undefined,
    })
  })

  it('getPage delegates to api.getPage with pageId', async () => {
    const api = mockApi()
    const tools = createNotionTools(api)
    const getTool = tools.find((t) => t.name === 'notionGetPage')!

    await getTool.execute({ pageId: 'page-123' }, ctx)

    expect(api.getPage).toHaveBeenCalledWith('page-123')
  })

  it('getDatabase delegates to api.getDatabase', async () => {
    const api = mockApi()
    const tools = createNotionTools(api)
    const getTool = tools.find((t) => t.name === 'notionGetDatabase')!

    await getTool.execute({ databaseId: 'db-456' }, ctx)

    expect(api.getDatabase).toHaveBeenCalledWith('db-456')
  })

  it('queryDatabase delegates with filter and sorts', async () => {
    const api = mockApi()
    const tools = createNotionTools(api)
    const queryTool = tools.find((t) => t.name === 'notionQueryDatabase')!

    const filter = { property: 'Status', select: { equals: 'Done' } }
    const sorts = [{ property: 'Created', direction: 'descending' as const }]

    await queryTool.execute({ databaseId: 'db-456', filter, sorts }, ctx)

    expect(api.queryDatabase).toHaveBeenCalledWith('db-456', {
      filter,
      sorts,
      pageSize: undefined,
    })
  })

  it('createPage delegates with all params', async () => {
    const api = mockApi()
    const tools = createNotionTools(api)
    const createTool = tools.find((t) => t.name === 'notionCreatePage')!

    await createTool.execute({
      parentId: 'db-123',
      parentType: 'database',
      title: 'New Page',
      content: 'Hello world',
    }, ctx)

    expect(api.createPage).toHaveBeenCalledWith({
      parentId: 'db-123',
      parentType: 'database',
      title: 'New Page',
      properties: undefined,
      content: 'Hello world',
    })
  })

  it('updatePage delegates with properties and archived', async () => {
    const api = mockApi()
    const tools = createNotionTools(api)
    const updateTool = tools.find((t) => t.name === 'notionUpdatePage')!

    await updateTool.execute({
      pageId: 'page-123',
      archived: true,
    }, ctx)

    expect(api.updatePage).toHaveBeenCalledWith('page-123', {
      properties: undefined,
      archived: true,
    })
  })

  it('appendBlocks delegates with pageId and content', async () => {
    const api = mockApi()
    const tools = createNotionTools(api)
    const appendTool = tools.find((t) => t.name === 'notionAppendBlocks')!

    await appendTool.execute({
      pageId: 'page-123',
      content: 'New paragraph',
    }, ctx)

    expect(api.appendBlocks).toHaveBeenCalledWith('page-123', 'New paragraph')
  })

  // ── Error handling ────────────────────────────────────────────

  it('returns isError on API failure', async () => {
    const api = mockApi({
      search: vi.fn().mockRejectedValue(new Error('Notion token is invalid')),
    })
    const tools = createNotionTools(api)
    const searchTool = tools.find((t) => t.name === 'notionSearch')!

    const result = await searchTool.execute({}, ctx)

    expect(result.isError).toBe(true)
    expect(result.data).toContain('Notion token is invalid')
  })
})
