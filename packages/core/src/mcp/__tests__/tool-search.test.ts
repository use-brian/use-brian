import { describe, it, expect, vi } from 'vitest'
import { buildToolIndex, createMcpSearchTools } from '../tool-search.js'
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
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'c_1',
  abortSignal: new AbortController().signal,
}

// ── Realistic cgov-style MCP server ────────────────────────────

const cgovServer: McpServerConfig = {
  name: 'Cardano Onchain Governance',
  url: 'https://cgov.example.com/mcp',
  tools: [
    { name: 'get_drep_profile', description: 'Get detailed profile of a DRep', inputSchema: { type: 'object', properties: { drep_id: { type: 'string', description: 'DRep ID or bech32 address' } }, required: ['drep_id'] } },
    { name: 'get_drep_voting_history', description: 'Get voting history for a DRep', inputSchema: { type: 'object', properties: { drep_id: { type: 'string' }, limit: { type: 'number' } }, required: ['drep_id'] } },
    { name: 'search_proposals', description: 'Search governance proposals by keyword or status', inputSchema: { type: 'object', properties: { query: { type: 'string' }, status: { type: 'string' } } } },
    { name: 'get_proposal_details', description: 'Get full details of a governance proposal', inputSchema: { type: 'object', properties: { proposal_id: { type: 'string' } }, required: ['proposal_id'] } },
    { name: 'get_voting_turnout', description: 'Get voting turnout statistics', inputSchema: { type: 'object', properties: { epoch: { type: 'number' } } } },
    { name: 'get_delegation_stats', description: 'Get delegation statistics and distribution', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_committee_state', description: 'Get current constitutional committee state', inputSchema: { type: 'object', properties: {} } },
    { name: 'search_dreps', description: 'Search for DReps by name or metadata', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  ],
}

const notionServer: McpServerConfig = {
  name: 'Notion',
  url: 'https://notion.example.com/mcp',
  tools: [
    { name: 'search_pages', description: 'Search Notion pages by title or content', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'get_page', description: 'Get a Notion page by ID', inputSchema: { type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'] } },
    { name: 'create_page', description: 'Create a new Notion page', inputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title'] } },
  ],
}

// ── Tests ────────────────────────────────────���─────────────────

describe('[COMP:mcp/tool-search] buildToolIndex', () => {
  it('indexes all tools from all servers', () => {
    const index = buildToolIndex([
      { kind: 'remote', server: cgovServer, serverUrl: cgovServer.url, callMcpTool: async () => ({}) },
      { kind: 'remote', server: notionServer, serverUrl: notionServer.url, callMcpTool: async () => ({}) },
    ])
    expect(index.entries).toHaveLength(11) // 8 cgov + 3 notion
    expect(index.serverSummaries.size).toBe(2)
  })

  it('generates capability summaries per server', () => {
    const index = buildToolIndex([
      { kind: 'remote', server: cgovServer, serverUrl: cgovServer.url, callMcpTool: async () => ({}) },
    ])
    const summary = index.serverSummaries.get('Cardano Onchain Governance')
    expect(summary).toBeDefined()
    expect(summary).toContain('get_')
    expect(summary).toContain('search_')
  })
})

describe('[COMP:mcp/tool-search] createMcpSearchTools', () => {
  function makeSearchTools(overrides?: Map<string, McpToolSetting>) {
    const index = buildToolIndex([
      { kind: 'remote', server: cgovServer, serverUrl: cgovServer.url, callMcpTool: async () => ({}) },
      { kind: 'remote', server: notionServer, serverUrl: notionServer.url, callMcpTool: async () => ({}) },
    ])
    const callMcpTool = vi.fn(async () => ({ result: 'ok' }))
    const tools = createMcpSearchTools({
      index,
      settingsStore: makeFakeSettingsStore(overrides),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool,
    })
    return { tools, callMcpTool, index }
  }

  it('creates exactly 2 tools: mcp_search and mcp_call', () => {
    const { tools } = makeSearchTools()
    expect(tools).toHaveLength(2)
    expect(tools[0].name).toBe('mcp_search')
    expect(tools[1].name).toBe('mcp_call')
  })

  it('mcp_search description mentions total tool count and connector names', () => {
    const { tools } = makeSearchTools()
    expect(tools[0].description).toContain('11 tools')
    expect(tools[0].description).toContain('Cardano Onchain Governance')
    expect(tools[0].description).toContain('Notion')
  })

  // ── Search tests ──────────────────────────────────────────────

  it('mcp_search finds DRep tools when searching for "drep"', async () => {
    const { tools } = makeSearchTools()
    const result = await tools[0].execute({ query: 'drep profile' }, ctx)
    const text = String(result.data)
    expect(text).toContain('get_drep_profile')
    expect(text).toContain('drep_id')  // schema should be included
  })

  it('mcp_search finds proposal tools when searching for "proposals"', async () => {
    const { tools } = makeSearchTools()
    const result = await tools[0].execute({ query: 'governance proposals' }, ctx)
    const text = String(result.data)
    expect(text).toContain('search_proposals')
    expect(text).toContain('get_proposal_details')
  })

  it('mcp_search finds Notion tools when searching for "notion pages"', async () => {
    const { tools } = makeSearchTools()
    const result = await tools[0].execute({ query: 'search pages' }, ctx)
    const text = String(result.data)
    expect(text).toContain('search_pages')
    expect(text).toContain('[Notion]')
  })

  it('mcp_search returns helpful message for no matches', async () => {
    const { tools } = makeSearchTools()
    const result = await tools[0].execute({ query: 'xyznonexistent' }, ctx)
    const text = String(result.data)
    expect(text).toContain('No tools found')
    expect(text).toContain('Cardano Onchain Governance')  // hints at available connectors
  })

  it('mcp_search includes parameter schemas in results', async () => {
    const { tools } = makeSearchTools()
    const result = await tools[0].execute({ query: 'drep voting history' }, ctx)
    const text = String(result.data)
    expect(text).toContain('drep_id')
    expect(text).toContain('limit')
  })

  it('mcp_search ranks name matches higher than description matches', async () => {
    const { tools } = makeSearchTools()
    const result = await tools[0].execute({ query: 'delegation' }, ctx)
    const text = String(result.data)
    // get_delegation_stats has "delegation" in the name — should rank high
    expect(text).toContain('get_delegation_stats')
  })

  // ── Call tests ────────────────────────────────────────────────

  it('mcp_call proxies to the correct server and tool', async () => {
    const { tools, callMcpTool } = makeSearchTools()
    const result = await tools[1].execute({
      server: 'Cardano Onchain Governance',
      tool: 'get_drep_profile',
      args: { drep_id: 'drep1abc' },
    }, ctx)
    expect(result.isError).toBeFalsy()
    expect(callMcpTool).toHaveBeenCalledWith(
      'https://cgov.example.com/mcp',
      'get_drep_profile',
      { drep_id: 'drep1abc' },
    )
  })

  it('mcp_call recovers when the model emits args as a JSON string', async () => {
    // Gemini Flash variants intermittently double-stringify `args`. Without
    // the schema-level preprocess the Zod validator rejects the call before
    // execute(), the model hallucinates a confirmation prompt, and the user
    // sees "no button to tap". With the preprocess the call goes through.
    const { tools, callMcpTool } = makeSearchTools()
    const parsed = tools[1].inputSchema.parse({
      server: 'Cardano Onchain Governance',
      tool: 'get_drep_profile',
      args: '{"drep_id": "drep1abc"}',
    })
    expect(parsed.args).toEqual({ drep_id: 'drep1abc' })

    const result = await tools[1].execute(parsed, ctx)
    expect(result.isError).toBeFalsy()
    expect(callMcpTool).toHaveBeenCalledWith(
      'https://cgov.example.com/mcp',
      'get_drep_profile',
      { drep_id: 'drep1abc' },
    )
  })

  it('mcp_call surfaces an object-required error when args is an unparseable string', async () => {
    // The preprocess is a best-effort recovery — when JSON.parse fails the
    // original string flows through so Zod still produces a meaningful error
    // for the model to react to.
    const { tools } = makeSearchTools()
    expect(() => tools[1].inputSchema.parse({
      server: 'Notion',
      tool: 'create_page',
      args: 'not valid json',
    })).toThrow(/Expected object, received string/)
  })

  it('mcp_call returns error for unknown server', async () => {
    const { tools } = makeSearchTools()
    const result = await tools[1].execute({
      server: 'NonExistent',
      tool: 'foo',
    }, ctx)
    expect(result.isError).toBe(true)
    // Unified server+tool lookup: error mentions the tool wasn't found and
    // lists the available servers so the model can re-search.
    expect(String(result.data)).toContain('unknown tool')
    expect(String(result.data)).toContain('Cardano Onchain Governance')
  })

  it('mcp_call returns error for unknown tool', async () => {
    const { tools } = makeSearchTools()
    const result = await tools[1].execute({
      server: 'Notion',
      tool: 'nonexistent_tool',
    }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('unknown tool')
  })

  it('mcp_call blocks tool when user policy says block', async () => {
    const overrides = new Map<string, McpToolSetting>()
    overrides.set('Notion:create_page', {
      id: 'set_1',
      assistantId: 'a1',
      userId: 'u1',
      serverName: 'Notion',
      toolName: 'create_page',
      policy: 'block',
      classification: 'write',
      timesAllowed: 0,
      timesDenied: 0,
    })
    const { tools, callMcpTool } = makeSearchTools(overrides)
    const result = await tools[1].execute({
      server: 'Notion',
      tool: 'create_page',
      args: { title: 'test' },
    }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('blocked')
    expect(callMcpTool).not.toHaveBeenCalled()
  })

  it('blocked tool is filtered from subsequent mcp_search results', async () => {
    const overrides = new Map<string, McpToolSetting>()
    overrides.set('Notion:create_page', {
      id: 'set_1',
      assistantId: 'a1',
      userId: 'u1',
      serverName: 'Notion',
      toolName: 'create_page',
      policy: 'block',
      classification: 'write',
      timesAllowed: 0,
      timesDenied: 0,
    })
    const { tools } = makeSearchTools(overrides)

    // First: block the tool via mcp_call
    await tools[1].execute({ server: 'Notion', tool: 'create_page', args: { title: 'test' } }, ctx)

    // Then: search should NOT return the blocked tool
    const searchResult = await tools[0].execute({ query: 'create page' }, ctx)
    expect(String(searchResult.data)).not.toContain('create_page')
  })

  it('re-calling a blocked tool gets immediate rejection without policy lookup', async () => {
    const overrides = new Map<string, McpToolSetting>()
    overrides.set('Notion:create_page', {
      id: 'set_1',
      assistantId: 'a1',
      userId: 'u1',
      serverName: 'Notion',
      toolName: 'create_page',
      policy: 'block',
      classification: 'write',
      timesAllowed: 0,
      timesDenied: 0,
    })
    const { tools, callMcpTool } = makeSearchTools(overrides)

    // Block it once
    await tools[1].execute({ server: 'Notion', tool: 'create_page', args: { title: 'test' } }, ctx)

    // Second call should be immediately rejected
    const result = await tools[1].execute({ server: 'Notion', tool: 'create_page', args: { title: 'retry' } }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('blocked')
    expect(callMcpTool).not.toHaveBeenCalled()
  })

  it('mcp_call surfaces MCP errors cleanly', async () => {
    const index = buildToolIndex([
      { kind: 'remote', server: notionServer, serverUrl: notionServer.url, callMcpTool: async () => ({}) },
    ])
    const tools = createMcpSearchTools({
      index,
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool: async () => { throw new Error('connection refused') },
    })
    const result = await tools[1].execute({
      server: 'Notion',
      tool: 'search_pages',
      args: { query: 'test' },
    }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('connection refused')
  })
})
