import { describe, it, expect, vi } from 'vitest'
import { wrapMcpTools } from '../connector.js'
import type { McpSettingsStore, McpServerConfig, McpToolSetting } from '../types.js'

function makeFakeSettingsStore(overrides: Map<string, McpToolSetting> = new Map()): McpSettingsStore {
  return {
    async getPolicy(params) {
      return overrides.get(`${params.serverName}:${params.toolName}`) ?? null
    },
    async setPolicy() {},
    async recordUsage() {},
    async recordUsageAndGetCount() { return { timesAllowed: 0, timesDenied: 0 } },
  }
}

const ctx = {
  assistantId: 'a1',
  userId: 'u1',
  sessionId: 's1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c_1',
  abortSignal: new AbortController().signal,
}

const readToolServer: McpServerConfig = {
  name: 'notion',
  url: 'https://example.mcp',
  tools: [
    { name: 'search_pages', description: 'Search for pages', inputSchema: {} },
  ],
}

const writeToolServer: McpServerConfig = {
  name: 'notion',
  url: 'https://example.mcp',
  tools: [
    { name: 'create_page', description: 'Create a new page', inputSchema: {} },
  ],
}

describe('[COMP:mcp/connector] wrapMcpTools', () => {
  it('wraps each MCP tool as a sidanclaw Tool with namespaced name', () => {
    const wrapped = wrapMcpTools({
      server: readToolServer,
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool: async () => ({ ok: true }),
    })
    expect(wrapped).toHaveLength(1)
    expect(wrapped[0].name).toBe('mcp_notion_search_pages')
  })

  it('marks read-classified tools as concurrency-safe and read-only', () => {
    const [tool] = wrapMcpTools({
      server: readToolServer,
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool: async () => ({}),
    })
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
  })

  it('marks write-classified tools as not read-only and requires confirmation by default', () => {
    const [tool] = wrapMcpTools({
      server: writeToolServer,
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool: async () => ({}),
    })
    expect(tool.isReadOnly).toBe(false)
    expect(tool.requiresConfirmation).toBe(true)
  })

  it('calls the MCP client and returns its result', async () => {
    const callMcpTool = vi.fn(async () => ({ pages: ['p1', 'p2'] }))
    const [tool] = wrapMcpTools({
      server: readToolServer,
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool,
    })
    const result = await tool.execute({ query: 'foo' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({ pages: ['p1', 'p2'] })
    expect(callMcpTool).toHaveBeenCalledWith('notion', 'search_pages', { query: 'foo' })
  })

  it('blocks a tool when user policy override says block', async () => {
    const overrides = new Map<string, McpToolSetting>()
    overrides.set('notion:search_pages', {
      id: 'set_1',
      assistantId: 'a1',
      userId: 'u1',
      serverName: 'notion',
      toolName: 'search_pages',
      policy: 'block',
      classification: 'read',
      timesAllowed: 0,
      timesDenied: 0,
    })
    const callMcpTool = vi.fn(async () => ({}))
    const [tool] = wrapMcpTools({
      server: readToolServer,
      settingsStore: makeFakeSettingsStore(overrides),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool,
    })
    const result = await tool.execute({ query: 'foo' }, ctx)
    expect(result.isError).toBe(true)
    expect(callMcpTool).not.toHaveBeenCalled()
  })

  it('surfaces MCP client errors as tool errors', async () => {
    const [tool] = wrapMcpTools({
      server: readToolServer,
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool: async () => { throw new Error('network down') },
    })
    const result = await tool.execute({}, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('network down')
  })
})
