import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { buildToolIndex, createMcpSearchTools } from '../tool-search.js'
import type { McpSettingsStore, McpServerConfig, McpToolSetting } from '../types.js'
import { buildTool } from '../../tools/types.js'

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
    const callMcpTool = vi.fn(async () => ({ result: 'ok' }))
    const index = buildToolIndex([
      { kind: 'remote', server: cgovServer, serverUrl: cgovServer.url, callMcpTool },
      { kind: 'remote', server: notionServer, serverUrl: notionServer.url, callMcpTool },
    ])
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

  it('adds canonical and legacy remote aliases for workflow tool_call execution', async () => {
    const protonServer: McpServerConfig = {
      name: 'Proton calendar',
      url: 'https://proton.example.com/mcp',
      tools: [{
        name: 'list_events',
        description: 'List upcoming calendar events.',
        inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
      }],
    }
    const callMcpTool = vi.fn(async () => ({ events: [] }))
    const preToolUse = vi.fn(async () => ({
      action: 'modify' as const,
      input: { days: 14 },
    }))
    const postToolUse = vi.fn(async () => undefined)
    const tools = createMcpSearchTools({
      index: buildToolIndex([{
        kind: 'remote', server: protonServer, serverUrl: protonServer.url,
        callMcpTool,
      }]),
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool,
      hooks: { preToolUse, postToolUse },
      keepDynamicToolsDirect: true,
    })

    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp_search',
      'mcp_call',
      'list_events',
      'mcp_Proton_calendar_list_events',
    ])
    const legacy = tools.find((tool) => tool.name === 'mcp_Proton_calendar_list_events')!
    expect(await legacy.resolveConfirmation?.(ctx as never, { days: 7 })).toBe(false)
    const result = await legacy.execute({ days: 7 }, ctx as never)
    expect(result.isError).toBeFalsy()
    expect(callMcpTool).toHaveBeenCalledWith(
      'https://proton.example.com/mcp',
      'list_events',
      { days: 14 },
    )
    expect(preToolUse).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'Proton calendar',
      toolName: 'list_events',
      input: { days: 7 },
    }))
    expect(postToolUse).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'Proton calendar',
      toolName: 'list_events',
      input: { days: 14 },
    }))
  })

  it('keeps local workflow aliases schema-bound and skips only the handled outer approval', async () => {
    const execute = vi.fn(async () => ({ data: { created: true } }))
    const createEvent = buildTool({
      name: 'create_event',
      description: 'Create a calendar event.',
      inputSchema: z.object({ title: z.string() }),
      requiresConfirmation: true,
      execute,
    })
    const tools = createMcpSearchTools({
      index: buildToolIndex([{ kind: 'local', serverName: 'Proton calendar', tools: [createEvent] }]),
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool: vi.fn(async () => ({})),
      keepDynamicToolsDirect: true,
    })
    const legacy = tools.find((tool) => tool.name === 'mcp_Proton_calendar_create_event')!

    expect(legacy.requiresConfirmation).toBe(true)
    expect(legacy.inputSchema.safeParse({ title: 'Review' }).success).toBe(true)
    const result = await legacy.execute({ title: 'Review' }, ctx as never)
    expect(result.isError).toBeFalsy()
    expect(execute).toHaveBeenCalledWith({ title: 'Review' }, ctx)
  })

  it('does not let authorized workflow dispatch bypass a remote block policy', async () => {
    const overrides = new Map<string, McpToolSetting>()
    overrides.set('Notion:create_page', {
      id: 'set-block',
      assistantId: 'a1',
      userId: 'u1',
      serverName: 'Notion',
      toolName: 'create_page',
      policy: 'block',
      classification: 'write',
      timesAllowed: 0,
      timesDenied: 0,
    })
    const callMcpTool = vi.fn(async () => ({ result: 'should not run' }))
    const tools = createMcpSearchTools({
      index: buildToolIndex([{
        kind: 'remote', server: notionServer, serverUrl: notionServer.url,
        callMcpTool: async () => ({}),
      }]),
      settingsStore: makeFakeSettingsStore(overrides),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool,
      keepDynamicToolsDirect: true,
    })
    const direct = tools.find((tool) => tool.name === 'create_page')!

    const result = await direct.execute({ title: 'Blocked' }, ctx as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain("set to the 'block' policy")
    expect(callMcpTool).not.toHaveBeenCalled()
  })

  it('uses a remote source policy authority instead of the caller store', async () => {
    const sourcePolicies = new Map<string, McpToolSetting>()
    sourcePolicies.set('workspace-custom:search_pages', {
      id: 'set-workspace',
      assistantId: 'workspace-policy',
      userId: 'workspace-user',
      serverName: 'workspace-custom',
      toolName: 'search_pages',
      policy: 'block',
      classification: 'read',
      timesAllowed: 0,
      timesDenied: 0,
    })
    const callMcpTool = vi.fn(async () => ({ result: 'should not run' }))
    const tools = createMcpSearchTools({
      index: buildToolIndex([{
        kind: 'remote',
        server: notionServer,
        serverUrl: notionServer.url,
        callMcpTool: async () => ({}),
        policy: {
          settingsStore: makeFakeSettingsStore(sourcePolicies),
          userId: 'workspace-user',
          serverName: 'workspace-custom',
          appLevelAssistantId: 'workspace-policy',
        },
      }]),
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'caller-user',
      callMcpTool,
      keepDynamicToolsDirect: true,
    })

    const direct = tools.find((tool) => tool.name === 'search_pages')!
    const result = await direct.execute({ query: 'private' }, ctx as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain("set to the 'block' policy")
    expect(callMcpTool).not.toHaveBeenCalled()
  })

  it('omits an ambiguous canonical alias and keeps unique server-qualified aliases', () => {
    const makeServer = (name: string): McpServerConfig => ({
      name,
      url: `https://${name.toLowerCase()}.example.com/mcp`,
      tools: [{ name: 'list_events', description: 'List events.', inputSchema: { type: 'object' } }],
    })
    const primary = makeServer('Primary calendar')
    const archive = makeServer('Archive calendar')
    const tools = createMcpSearchTools({
      index: buildToolIndex([
        { kind: 'remote', server: primary, serverUrl: primary.url, callMcpTool: async () => ({}) },
        { kind: 'remote', server: archive, serverUrl: archive.url, callMcpTool: async () => ({}) },
      ]),
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1', userId: 'u1',
      callMcpTool: vi.fn(async () => ({})),
      keepDynamicToolsDirect: true,
    })

    expect(tools.some((tool) => tool.name === 'list_events')).toBe(false)
    expect(tools.some((tool) => tool.name === 'mcp_Primary_calendar_list_events')).toBe(true)
    expect(tools.some((tool) => tool.name === 'mcp_Archive_calendar_list_events')).toBe(true)
  })

  it('removes duplicate full server/tool keys from search and direct dispatch', async () => {
    const duplicate: McpServerConfig = {
      name: 'Calendar',
      url: 'https://calendar.example.com/mcp',
      tools: [{ name: 'list_events', description: 'List events.', inputSchema: { type: 'object' } }],
    }
    const tools = createMcpSearchTools({
      index: buildToolIndex([
        { kind: 'remote', server: duplicate, serverUrl: duplicate.url, callMcpTool: async () => ({}) },
        { kind: 'remote', server: { ...duplicate, url: 'https://other.example.com/mcp' }, serverUrl: 'https://other.example.com/mcp', callMcpTool: async () => ({}) },
      ]),
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1', userId: 'u1',
      callMcpTool: vi.fn(async () => ({})),
      keepDynamicToolsDirect: true,
    })

    expect(tools.map((tool) => tool.name)).toEqual(['mcp_search', 'mcp_call'])
    const search = await tools[0].execute({ query: 'list events' }, ctx as never)
    expect(String(search.data)).toContain('No tools found')
    const call = await tools[1].execute({ server: 'Calendar', tool: 'list_events', args: {} }, ctx as never)
    expect(call.isError).toBe(true)
    expect(String(call.data)).toContain('unknown tool')
  })

  it('fails closed when one canonical name collides with another legacy alias', () => {
    const server = (name: string, toolName: string): McpServerConfig => ({
      name,
      url: `https://collision.example.com/${name}`,
      tools: [{ name: toolName, description: 'Collision probe.', inputSchema: { type: 'object' } }],
    })
    const legacyOwner = server('Bar', 'do')
    const canonicalOwner = server('Other', 'mcp_Bar_do')
    const tools = createMcpSearchTools({
      index: buildToolIndex([
        { kind: 'remote', server: legacyOwner, serverUrl: legacyOwner.url, callMcpTool: async () => ({}) },
        { kind: 'remote', server: canonicalOwner, serverUrl: canonicalOwner.url, callMcpTool: async () => ({}) },
      ]),
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1', userId: 'u1',
      callMcpTool: vi.fn(async () => ({})),
      keepDynamicToolsDirect: true,
    })

    expect(tools.some((tool) => tool.name === 'mcp_Bar_do')).toBe(false)
    expect(tools.some((tool) => tool.name === 'do')).toBe(true)
    expect(tools.some((tool) => tool.name === 'mcp_Other_mcp_Bar_do')).toBe(true)
  })

  it('mcp_search description mentions total tool count and connector names', () => {
    const { tools } = makeSearchTools()
    expect(tools[0].description).toContain('11 tools')
    expect(tools[0].description).toContain('Cardano Onchain Governance')
    expect(tools[0].description).toContain('Notion')
  })

  it('identifies an indexed workspace KB and discovers its search tool from a KB-named query', async () => {
    const knowledgeTool = {
      name: 'searchKnowledge',
      description: 'Search the workspace knowledge base (KB) by keyword.',
      inputSchema: {} as never,
      isReadOnly: true,
      execute: vi.fn(async () => ({ data: [] })),
    } as never
    const index = buildToolIndex([
      { kind: 'local', serverName: 'knowledge', tools: [knowledgeTool] },
    ])
    const [searchTool] = createMcpSearchTools({
      index,
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool: vi.fn(async () => ({})),
    })

    expect(searchTool.description).toContain('workspace knowledge base (KB)')
    expect(searchTool.description).toContain('tool capabilities, not the underlying user data')

    const result = await searchTool.execute({ query: 'cathay-sp kb' }, ctx)
    expect(String(result.data)).toContain('searchKnowledge')
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

  it('limits an exact lookup to one compact tool shape while retaining nested fields and enums', async () => {
    const createEvent = buildTool({
      name: 'googleCalendarCreateEvent',
      description: 'Create a Google Calendar event.',
      inputSchema: z.object({
        summary: z.string(),
        reminders: z.object({
          useDefault: z.boolean(),
          overrides: z.array(z.object({
            method: z.enum(['email', 'popup']),
            minutes: z.number(),
          })).optional(),
        }).optional(),
      }),
      execute: async () => ({ data: {} }),
    })
    const updateEvent = buildTool({
      name: 'googleCalendarUpdateEvent',
      description: 'Update a Google Calendar event.',
      inputSchema: z.object({ eventId: z.string() }),
      execute: async () => ({ data: {} }),
    })
    const index = buildToolIndex([
      { kind: 'local', serverName: 'gcal', tools: [createEvent, updateEvent] },
    ])
    const [searchTool] = createMcpSearchTools({
      index,
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool: vi.fn(async () => ({})),
    })

    const result = await searchTool.execute({ query: 'create calendar event', limit: 1 }, ctx)
    const text = String(result.data)

    expect(text).toContain('Found 1 matching tools')
    expect(text).toContain('googleCalendarCreateEvent')
    expect(text).not.toContain('googleCalendarUpdateEvent')
    expect(text).toContain('reminders?: { useDefault: boolean; overrides?: Array<{ method: "email" | "popup"; minutes: number }> }')
  })

  it('bounds mcp_search result limits to 1-8', () => {
    const [searchTool] = makeSearchTools().tools
    expect(searchTool.inputSchema.safeParse({ query: 'calendar', limit: 1 }).success).toBe(true)
    expect(searchTool.inputSchema.safeParse({ query: 'calendar', limit: 8 }).success).toBe(true)
    expect(searchTool.inputSchema.safeParse({ query: 'calendar', limit: 0 }).success).toBe(false)
    expect(searchTool.inputSchema.safeParse({ query: 'calendar', limit: 9 }).success).toBe(false)
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

  it('mcp_call validates local-tool args against the tool schema and names the bad parameter', async () => {
    // The 2026-07-30 boarding-pass failure: the model called imapGetMessage
    // via mcp_call with `id` instead of `messageId`. mcp_call's provider-facing
    // schema only constrains `args` to "object", so the misnamed key reached
    // execute() as undefined and died deep in the seam ("Cannot read
    // properties of undefined (reading 'lastIndexOf')") — an error the model
    // cannot act on. Local dispatch must zod-validate so the result names the
    // right parameter and the model self-corrects.
    const execute = vi.fn(async () => ({ data: 'full message' }))
    const getMessage = {
      name: 'imapGetMessage',
      description: 'Read a full email by id.',
      inputSchema: z.object({ messageId: z.string() }),
      isConcurrencySafe: true,
      isReadOnly: true,
      requiresConfirmation: false,
      execute,
    } as never
    const index = buildToolIndex([
      { kind: 'local', serverName: 'imap', tools: [getMessage] },
    ])
    const [, callTool] = createMcpSearchTools({
      index,
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool: vi.fn(async () => ({})),
    })

    const bad = await callTool.execute(
      { server: 'imap', tool: 'imapGetMessage', args: { id: 'INBOX:72548' } },
      ctx,
    )
    expect(bad.isError).toBe(true)
    expect(String(bad.data)).toContain('messageId')
    expect(execute).not.toHaveBeenCalled()

    const good = await callTool.execute(
      { server: 'imap', tool: 'imapGetMessage', args: { messageId: 'INBOX:72548' } },
      ctx,
    )
    expect(good.isError).toBeFalsy()
    expect(execute).toHaveBeenCalledWith({ messageId: 'INBOX:72548' }, ctx)
  })

  it('mcp_call applies local-tool schema defaults on dispatch', async () => {
    // Parsed output replaces raw args so `.default()` fields behave the same
    // as on the direct-injection path (the provider fills defaults there).
    const execute = vi.fn(async () => ({ data: [] }))
    const searchTool = {
      name: 'imapSearchMessages',
      description: 'Search the mailbox.',
      inputSchema: z.object({ query: z.string(), limit: z.number().default(20) }),
      isConcurrencySafe: true,
      isReadOnly: true,
      requiresConfirmation: false,
      execute,
    } as never
    const index = buildToolIndex([
      { kind: 'local', serverName: 'imap', tools: [searchTool] },
    ])
    const [, callTool] = createMcpSearchTools({
      index,
      settingsStore: makeFakeSettingsStore(),
      assistantId: 'a1',
      userId: 'u1',
      callMcpTool: vi.fn(async () => ({})),
    })

    const result = await callTool.execute(
      { server: 'imap', tool: 'imapSearchMessages', args: { query: 'boarding pass' } },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(execute).toHaveBeenCalledWith({ query: 'boarding pass', limit: 20 }, ctx)
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
    const searchResult = await tools[0].execute({ query: 'create page', limit: 1 }, ctx)
    const searchText = String(searchResult.data)
    expect(searchText).not.toContain('create_page')
    expect(searchText).toContain('search_pages')
    expect(searchText).not.toContain('No tools found')
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
      { kind: 'remote', server: notionServer, serverUrl: notionServer.url, callMcpTool: async () => { throw new Error('connection refused') } },
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

  it('keeps exact-source dispatch distinct for equal URLs and ignores the legacy generic transport', async () => {
    const first = vi.fn(async () => ({ source: 'first' })), second = vi.fn(async () => ({ source: 'second' }))
    const generic = vi.fn(async () => ({ source: 'wrong generic transport' }))
    const server = { name: 'First source', url: 'https://shared-source.example/mcp', tools: [{ name: 'readRow', description: 'Read a source row.', inputSchema: { type: 'object' } }] }
    const tools = createMcpSearchTools({ index: buildToolIndex([
      { kind: 'remote', server, serverUrl: server.url, callMcpTool: first },
      { kind: 'remote', server: { ...server, name: 'Second source' }, serverUrl: server.url, callMcpTool: second },
    ]), assistantId: 'a1', userId: 'u1', settingsStore: makeFakeSettingsStore(), callMcpTool: generic, keepDynamicToolsDirect: true,
      hooks: { preToolUse: async () => ({ action: 'modify', headers: { 'X-Trace': 'source-call' } }) } })
    expect(JSON.stringify((await tools[1].execute({ server: 'Second source', tool: 'readRow', args: {} }, ctx)).data)).toContain('second')
    expect(second).toHaveBeenCalledWith(server.url, 'readRow', {}, { 'X-Trace': 'source-call' })
    expect(first).not.toHaveBeenCalled(); expect(generic).not.toHaveBeenCalled()
    await tools.find(tool => tool.name === 'mcp_First_source_readRow')!.execute({}, ctx)
    expect(first).toHaveBeenCalledTimes(1); expect(generic).not.toHaveBeenCalled()
  })

  it('refuses a lost private dispatcher rather than using a generic URL credential', async () => {
    const index = buildToolIndex([{ kind: 'remote', server: notionServer, serverUrl: notionServer.url, callMcpTool: async () => ({}) }])
    for (const entry of index.entries) delete (entry as unknown as { dispatch?: unknown }).dispatch
    const generic = vi.fn(async () => ({ secret: 'must not be read' }))
    const [, call] = createMcpSearchTools({ index, settingsStore: makeFakeSettingsStore(), assistantId: 'a1', userId: 'u1', callMcpTool: generic })
    const result = await call.execute({ server: 'Notion', tool: 'search_pages', args: { query: 'fixture' } }, ctx)
    expect(result.isError).toBe(true); expect(result.data).toContain('source transport is unavailable')
    expect(generic).not.toHaveBeenCalled()
  })

  it('does not serialize private transport callbacks into tool search results', async () => {
    const callback = vi.fn(async () => ({ secret: 'not search metadata' }))
    const index = buildToolIndex([{ kind: 'remote', server: notionServer, serverUrl: notionServer.url, callMcpTool: callback }])
    const [search] = createMcpSearchTools({ index, settingsStore: makeFakeSettingsStore(), assistantId: 'a1', userId: 'u1' })
    const metadata = JSON.stringify(await search.execute({ query: 'search pages' }, ctx))
    expect(metadata).not.toMatch(/dispatch|callMcpTool|not search metadata/)
    expect(callback).not.toHaveBeenCalled()
  })

  it('advertises stable source IDs, refuses ambiguous labels and keeps the actual hook actor separate from policy ownership', async () => {
    const first = vi.fn(async () => ({ source: 'first' })), second = vi.fn(async () => ({ source: 'second' }))
    const sourceIds = ['connector:11111111-1111-4111-8111-111111111111','connector:22222222-2222-4222-8222-222222222222']
    const server = { name: 'Shared source label', url: 'https://shared-source.example/mcp', tools: [{ name: 'readRow', description: 'Read a row.', inputSchema: { type: 'object' } }] }
    const preToolUse = vi.fn(async () => undefined), postToolUse = vi.fn(async () => undefined)
    const index = buildToolIndex([first,second].map((callMcpTool, i) => ({ kind: 'remote' as const, sourceId: sourceIds[i], server, serverUrl: server.url, callMcpTool })))
    const tools = createMcpSearchTools({ index, assistantId: 'a1', userId: 'credential-owner', settingsStore: makeFakeSettingsStore(),
      keepDynamicToolsDirect: true, hooks: { preToolUse, postToolUse } })
    const actual = { ...ctx, userId: 'actual-initiator' }
    const search = String((await tools[0].execute({ query: 'read row' }, actual)).data)
    for (const id of sourceIds) expect(search).toContain(id)
    expect(search).toContain('Shared source label')
    expect((await tools[1].execute({ server: 'Shared source label', tool: 'readRow', args: {} }, actual)).isError).toBe(true)
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled()
    expect(JSON.stringify((await tools[1].execute({ server: sourceIds[1], tool: 'readRow', args: {} }, actual)).data)).toContain('second')
    expect(preToolUse).toHaveBeenCalledWith(expect.objectContaining({ sourceId: sourceIds[1], serverName: 'Shared source label', userId: 'actual-initiator' }))
    expect(postToolUse).toHaveBeenCalledWith(expect.objectContaining({ sourceId: sourceIds[1], serverName: 'Shared source label', userId: 'actual-initiator' }))
    expect(tools.some(tool => tool.name === 'mcp_Shared_source_label_readRow')).toBe(false)
    expect(() => buildToolIndex([first,second].map(callMcpTool => ({ kind: 'remote' as const, sourceId: sourceIds[0], server, serverUrl: server.url, callMcpTool })))).toThrow('Duplicate remote source identity')
  })

  it('keeps unique saved labels/direct aliases compatible and shares policy denial with the stable ID', async () => {
    const sourceId = 'connector:33333333-3333-4333-8333-333333333333', callback = vi.fn(async () => ({ source: 'one' }))
    const source = { kind: 'remote' as const, sourceId, server: notionServer, serverUrl: notionServer.url, callMcpTool: callback }
    const tools = createMcpSearchTools({ index: buildToolIndex([source]), assistantId: 'a1', userId: 'u1', settingsStore: makeFakeSettingsStore(), keepDynamicToolsDirect: true })
    expect((await tools[1].execute({ server: 'Notion', tool: 'search_pages', args: { query: 'fixture' } }, ctx)).isError).toBeFalsy()
    expect(tools.some(tool => tool.name === 'mcp_Notion_search_pages')).toBe(true)
    const overrides = new Map<string, McpToolSetting>()
    overrides.set('Notion:search_pages', { id: 'deny', assistantId: 'a1', userId: 'u1', serverName: 'Notion', toolName: 'search_pages',
      policy: 'block', classification: 'read', timesAllowed: 0, timesDenied: 0 })
    const [, call] = createMcpSearchTools({ index: buildToolIndex([source]), assistantId: 'a1', userId: 'u1', settingsStore: makeFakeSettingsStore(overrides) })
    callback.mockClear()
    expect((await call.execute({ server: 'Notion', tool: 'search_pages', args: { query: 'fixture' } }, ctx)).isError).toBe(true)
    expect((await call.execute({ server: sourceId, tool: 'search_pages', args: { query: 'fixture' } }, ctx)).isError).toBe(true)
    expect(callback).not.toHaveBeenCalled()
  })
})


describe('[COMP:mcp/tool-search] mini-app grants on folded tools', () => {
  it('refuses a cached local tool call when its app set is disabled', async () => {
    const execute = vi.fn(async () => ({ data: 'saved' }))
    const write = buildTool({ name: 'writePage', description: 'Write a page', requiresCapability: 'page', inputSchema: z.object({}), execute })
    const index = buildToolIndex([{ kind: 'local', serverName: 'page', tools: [write] }])
    const [, call] = createMcpSearchTools({ index, settingsStore: makeFakeSettingsStore(), assistantId: 'a1', userId: 'u1', callMcpTool: vi.fn() })
    const result = await call.execute({ server: 'page', tool: 'writePage', args: {} }, { ...ctx, activeCapabilities: new Set(['page', 'home_app:page:read']) })
    expect(result.isError).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    const allowed = await call.execute({ server: 'page', tool: 'writePage', args: {} }, { ...ctx, activeCapabilities: new Set(['page', 'home_app:page:write']) })
    expect(allowed.data).toBe('saved')
  })
})
