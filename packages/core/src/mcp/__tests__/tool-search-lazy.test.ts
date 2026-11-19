import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildToolIndex, createMcpSearchTools, type LocalSource, type LocalToolDescriptor, type LocalToolResolution } from '../tool-search.js'
import { createConfirmationResolver, type McpSettingsStore, type ToolConfirmationRequest } from '@use-brian/agent-runtime/mcp/types.js'
import { buildTool, type Tool, type ToolContext } from '@use-brian/agent-runtime/tools/types.js'

const settingsStore: McpSettingsStore = {
  async getPolicy() { return null },
  async setPolicy() {},
  async recordUsage() {},
  async recordUsageAndGetCount() { return { timesAllowed: 0, timesDenied: 0 } },
}

function context(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    assistantId: 'assistant-example', userId: 'user-example', sessionId: 'session-example', appId: 'test',
    channelType: 'web', channelId: 'channel-example', abortSignal: new AbortController().signal,
    ...extra,
  } as ToolContext
}

/** A confirmation channel that answers every prompt with `decision`. */
function confirmingContext(decision: 'allow' | 'deny' = 'allow') {
  const resolver = createConfirmationResolver()
  const prompts: ToolConfirmationRequest[] = []
  const ctx = context({
    confirmationResolver: resolver,
    notifyConfirmationRequired: (request: ToolConfirmationRequest) => {
      prompts.push(request)
      queueMicrotask(() => resolver.resolve(request.toolCallId, decision))
    },
  })
  return { ctx, prompts }
}

const createEventSchema = {
  type: 'object',
  properties: { title: { type: 'string', description: 'Event title' } },
  required: ['title'],
}

function writeTool(execute = vi.fn(async (input: unknown) => ({ data: { created: input } }))) {
  const resolveConfirmation = vi.fn(async () => true)
  const describeConfirmation = vi.fn(async (input: unknown) => [`Create "${(input as { title: string }).title}"`])
  const tool = buildTool({
    name: 'calendarCreateEvent',
    description: 'Create a calendar event',
    inputSchema: z.object({ title: z.string() }),
    isReadOnly: false,
    requiresConfirmation: true,
    resolveConfirmation,
    describeConfirmation,
    execute,
  })
  return { tool, execute, resolveConfirmation, describeConfirmation }
}

function readTool(execute = vi.fn(async () => ({ data: { events: [] } }))) {
  return {
    tool: buildTool({
      name: 'calendarListEvents',
      description: 'List calendar events',
      inputSchema: z.object({ limit: z.number().optional() }),
      isReadOnly: true,
      requiresConfirmation: false,
      execute,
    }),
    execute,
  }
}

const descriptors: LocalToolDescriptor[] = [
  { name: 'calendarListEvents', description: 'List calendar events', isReadOnly: true, requiresConfirmation: false,
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }, version: 'v1' },
  { name: 'calendarCreateEvent', description: 'Create a calendar event', isReadOnly: false, requiresConfirmation: true,
    inputSchema: createEventSchema, version: 'v1' },
]

function lazySource(resolve: LocalSource['resolve'], extra: Partial<LocalSource> = {}): LocalSource {
  return { kind: 'local', serverName: 'calendar', tools: [], descriptors, resolve, ...extra }
}

function searchPair(sources: LocalSource[], options: Partial<Parameters<typeof createMcpSearchTools>[0]> = {}) {
  const index = buildToolIndex(sources)
  const tools = createMcpSearchTools({ index, settingsStore, assistantId: 'assistant-example', userId: 'user-example', ...options })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { index, tools, byName, search: byName.get('mcp_search')!, call: byName.get('mcp_call')! }
}

describe('[COMP:core/tool-search-lazy] descriptor-only local entries', () => {
  it('indexes descriptors, builds summaries from them and resolves nothing until a call', async () => {
    const resolve = vi.fn(async () => null)
    const { index, search } = searchPair([lazySource(resolve)])
    expect(index.entries.map((entry) => entry.toolName)).toEqual(['calendarListEvents', 'calendarCreateEvent'])
    expect(index.serverSummaries.get('calendar')).toContain('calendarCreateEvent')
    const result = await search.execute({ query: 'create calendar event', limit: 1 }, context())
    expect(String(result.data)).toContain('calendarCreateEvent')
    expect(String(result.data)).toContain('title: string')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('awaits resolve before the confirmation path and runs the resolved hooks under the canonical name', async () => {
    const write = writeTool()
    const order: string[] = []
    const resolve = vi.fn(async (name: string) => {
      order.push(`resolve:${name}`)
      return name === 'calendarCreateEvent' ? { status: 'ready' as const, tool: write.tool, version: 'v1' } : null
    })
    write.resolveConfirmation.mockImplementation(async () => { order.push('resolveConfirmation'); return true })
    const { call } = searchPair([lazySource(resolve)])
    const { ctx, prompts } = confirmingContext('allow')
    const result = await call.execute({ server: 'calendar', tool: 'calendarCreateEvent', args: { title: 'Planning' } }, ctx)
    expect(result.isError).toBeFalsy()
    expect(order).toEqual(['resolve:calendarCreateEvent', 'resolveConfirmation'])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ toolName: 'calendarCreateEvent', serverName: 'calendar', displayLines: ['Create "Planning"'] })
    expect(write.execute).toHaveBeenCalledWith({ title: 'Planning' }, ctx)
  })

  it('memoizes one resolution per entry and keeps a denied lazy write blocked', async () => {
    const write = writeTool()
    const resolve = vi.fn(async () => write.tool)
    const { call } = searchPair([lazySource(resolve)])
    const denied = confirmingContext('deny')
    const first = await call.execute({ server: 'calendar', tool: 'calendarCreateEvent', args: { title: 'A' } }, denied.ctx)
    expect(first.isError).toBe(true)
    const second = await call.execute({ server: 'calendar', tool: 'calendarCreateEvent', args: { title: 'B' } }, denied.ctx)
    expect(second.isError).toBe(true)
    expect(resolve).toHaveBeenCalledOnce()
    expect(write.execute).not.toHaveBeenCalled()
  })

  it('keeps confirmation hooks on direct adapters for lazy entries', async () => {
    const write = writeTool()
    write.resolveConfirmation.mockResolvedValue(false)
    const resolve = vi.fn(async (name: string) => (name === 'calendarCreateEvent' ? write.tool : null))
    const { byName } = searchPair([lazySource(resolve)], { keepDynamicToolsDirect: true })
    const adapter = byName.get('calendarCreateEvent')!
    expect(adapter.requiresConfirmation).toBe(true)
    expect(resolve).not.toHaveBeenCalled()
    await expect(adapter.resolveConfirmation!(context(), { title: 'Sync' })).resolves.toBe(false)
    expect(resolve).toHaveBeenCalledOnce()
    expect(write.resolveConfirmation).toHaveBeenCalledOnce()
    await expect(adapter.describeConfirmation!({ title: 'Sync' }, context())).resolves.toEqual(['Create "Sync"'])
    const result = await adapter.execute({ title: 'Sync' }, context())
    expect(result.isError).toBeFalsy()
    expect(write.execute).toHaveBeenCalledOnce()
  })

  it('dispatches interactive read adapters through the same lazy resolution', async () => {
    const read = readTool()
    const resolve = vi.fn(async (name: string) => (name === 'calendarListEvents' ? read.tool : null))
    const { byName } = searchPair([lazySource(resolve)], { exposeLocalReadTools: true })
    const adapter = byName.get('calendarListEvents')!
    expect(adapter.deferredSchemaOnly).toBe(true)
    expect(byName.has('calendarCreateEvent')).toBe(false)
    const result = await adapter.execute({ limit: 2 }, context())
    expect(result.isError).toBeFalsy()
    expect(read.execute).toHaveBeenCalledWith({ limit: 2 }, expect.anything())
  })

  it('marks a changed descriptor version stale and refuses with search again, then runs the current tool', async () => {
    const write = writeTool()
    const resolve = vi.fn(async (): Promise<LocalToolResolution> => ({ status: 'ready', tool: write.tool, version: 'v2' }))
    const { call, search } = searchPair([lazySource(resolve)])
    const { ctx, prompts } = confirmingContext('allow')
    const refused = await call.execute({ server: 'calendar', tool: 'calendarCreateEvent', args: { title: 'A' } }, ctx)
    expect(refused.isError).toBe(true)
    expect(String(refused.data)).toMatch(/changed since it was found.*NOT executed.*Search again with mcp_search/)
    expect(prompts).toHaveLength(0)
    expect(write.execute).not.toHaveBeenCalled()

    const searched = await search.execute({ query: 'create calendar event', limit: 1 }, ctx)
    expect(String(searched.data)).toContain('title: string')
    const retried = await call.execute({ server: 'calendar', tool: 'calendarCreateEvent', args: { title: 'A' } }, ctx)
    expect(retried.isError).toBeFalsy()
    expect(prompts).toHaveLength(1)
    expect(write.execute).toHaveBeenCalledOnce()
  })

  it('refuses a direct adapter built against an older version for the rest of the index', async () => {
    const write = writeTool()
    const resolve = vi.fn(async (): Promise<LocalToolResolution> => ({ status: 'ready', tool: write.tool, version: 'v2' }))
    const { byName } = searchPair([lazySource(resolve)], { keepDynamicToolsDirect: true })
    const adapter = byName.get('calendarCreateEvent')!
    await expect(adapter.resolveConfirmation!(context(), { title: 'A' })).resolves.toBe(false)
    const result = await adapter.execute({ title: 'A' }, context())
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('Search again')
    expect(write.execute).not.toHaveBeenCalled()
  })

  it('re-resolves after an explicit stale outcome and refuses an unavailable one honestly', async () => {
    const write = writeTool()
    const outcomes: LocalToolResolution[] = [
      { status: 'stale', descriptor: { ...descriptors[1]!, description: 'Create an event (updated)' }, version: 'v3' },
      { status: 'ready', tool: write.tool, version: 'v3' },
    ]
    const resolve = vi.fn(async (name: string): Promise<LocalToolResolution> =>
      name === 'calendarListEvents' ? { status: 'unavailable', reason: 'the connector was disconnected' } : outcomes.shift()!)
    const { call } = searchPair([lazySource(resolve)])
    const { ctx } = confirmingContext('allow')
    const stale = await call.execute({ server: 'calendar', tool: 'calendarCreateEvent', args: { title: 'A' } }, ctx)
    expect(String(stale.data)).toContain('Search again')
    const ok = await call.execute({ server: 'calendar', tool: 'calendarCreateEvent', args: { title: 'A' } }, ctx)
    expect(ok.isError).toBeFalsy()
    expect(write.execute).toHaveBeenCalledOnce()
    const unavailable = await call.execute({ server: 'calendar', tool: 'calendarListEvents', args: {} }, ctx)
    expect(unavailable.isError).toBe(true)
    expect(String(unavailable.data)).toContain('the connector was disconnected')
  })

  it('propagates resolver failures so authority changes stay typed', async () => {
    class AuthorityChanged extends Error { reason = 'authority_changed' }
    const resolve = vi.fn(async () => { throw new AuthorityChanged('changed') })
    const { call } = searchPair([lazySource(resolve)])
    await expect(call.execute({ server: 'calendar', tool: 'calendarListEvents', args: {} }, context()))
      .rejects.toMatchObject({ reason: 'authority_changed' })
  })

  it('resolves a schema-less hit during search so its real parameters are shown', async () => {
    const write = writeTool()
    const resolve = vi.fn(async () => write.tool)
    const source = lazySource(resolve, { descriptors: [{ name: 'calendarCreateEvent', description: 'Create a calendar event', requiresConfirmation: true }] })
    const { search } = searchPair([source])
    const result = await search.execute({ query: 'create event', limit: 1 }, context())
    expect(String(result.data)).toContain('title: string')
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('advertises an undiscovered source by name and discovers it only when a search names it', async () => {
    const write = writeTool()
    const discover = vi.fn(async () => [descriptors[1]!])
    const resolve = vi.fn(async () => write.tool)
    const source: LocalSource = { kind: 'local', serverName: 'connector:fixture', label: 'Team Planner', tools: [], discover, resolve }
    const { search, call, index } = searchPair([source])
    expect(index.entries).toHaveLength(0)
    expect(index.serverSummaries.get('connector:fixture')).toContain('search for "Team Planner"')
    expect(search.description).toContain('Team Planner')

    await search.execute({ query: 'create calendar event' }, context())
    expect(discover).not.toHaveBeenCalled()
    const found = await search.execute({ query: 'team planner create event' }, context())
    expect(discover).toHaveBeenCalledOnce()
    expect(String(found.data)).toContain('[connector:fixture] (Team Planner) calendarCreateEvent')
    const { ctx } = confirmingContext('allow')
    const result = await call.execute({ server: 'connector:fixture', tool: 'calendarCreateEvent', args: { title: 'A' } }, ctx)
    expect(result.isError).toBeFalsy()
    await search.execute({ query: 'team planner' }, context())
    expect(discover).toHaveBeenCalledOnce()
  })

  it('reports a failed discovery honestly instead of an empty source', async () => {
    const discover = vi.fn(async (): Promise<LocalToolDescriptor[]> => { throw new Error('offline') })
    const source: LocalSource = { kind: 'local', serverName: 'connector:fixture', label: 'Team Planner', tools: [], discover, resolve: async () => null }
    const { search, index } = searchPair([source])
    const result = await search.execute({ query: 'team planner' }, context())
    expect(String(result.data)).toContain('Could not load the tools from Team Planner right now.')
    expect(index.serverSummaries.get('connector:fixture')).toContain('could not be loaded')
  })

  it('leaves eager local sources unchanged', async () => {
    const read = readTool()
    const tool: Tool = read.tool
    const { call } = searchPair([{ kind: 'local', serverName: 'calendar', tools: [tool] }])
    const result = await call.execute({ server: 'calendar', tool: 'calendarListEvents', args: {} }, context())
    expect(result.isError).toBeFalsy()
    expect(read.execute).toHaveBeenCalledOnce()
  })
})
