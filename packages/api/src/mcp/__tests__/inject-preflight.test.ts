import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextScopeAccumulator, createExecutionContext, executionToolContext, runPreflight,
  type LLMProvider, type Tool, type StreamChunk,
} from '@use-brian/core'
import { injectMcpTools } from '../inject.js'
import type { ConnectorSourceRuntime } from '../../application-platform/source-runtime.js'

const mocks = vi.hoisted(() => ({ read: vi.fn(), current: vi.fn() }))
vi.mock('../../connector-config.js', () => ({
  getConnectorConfig: () => ({ clientId: 'fictional-client', clientSecret: 'fictional-secret' }),
}))
vi.mock('../../google/client.js', async original => ({
  ...await original<typeof import('../../google/client.js')>(),
  refreshGoogleAccessToken: async () => 'fictional-access',
  listCalendarEvents: (...args: unknown[]) => mocks.read(...args),
}))
// Database admission is the external boundary. Keep the injector's exact
// execution/accumulator guard and current-source checks real.
vi.mock('../../application-platform/connector-runtime-authority.js', () => ({
  createConnectorRuntimeAuthority: async () => ({
    cacheKey: 'fixture', allows: () => true, assertCurrent: () => mocks.current(),
    execute: async (operation: () => Promise<unknown>) => { await mocks.current(); return operation() },
  }),
}))

async function setup() {
  const execution = createExecutionContext({
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'user-example', authenticationKind: 'verified_channel' } },
    ownership: { kind: 'workspace', workspaceId: 'workspace-example' },
    access: { workspaceId: 'workspace-example', userId: 'user-example', assistantId: 'assistant-example', assistantKind: 'standard',
      clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: ['assistant-example'] },
    writeDefaults: { compartments: [], projectIds: [] },
    authority: { assertCurrent: async () => {}, execute: operation => operation() },
    lifecycle: { sessionId: 'session-example', channelType: 'telegram', channelId: 'chat-example', abortSignal: new AbortController().signal },
  })
  const accumulator = new ContextScopeAccumulator()
  const rows = [
    { id: 'calendar-example', provider: 'gcal', custom: false, url: null, label: 'Calendar' },
    { id: 'protected-example', provider: 'custom', custom: true, url: 'https://connector.example/mcp', label: 'Protected source' },
  ].map(row => ({ ...row, scope: 'workspace', workspaceId: 'workspace-example', userId: null,
    connected: true, healthStatus: 'ok', sensitivity: 'internal', compartments: [], projectIds: [], config: {}, createdAt: new Date('2030-01-01') }))
  const source: ConnectorSourceRuntime = {
    execution, accumulator,
    discover: vi.fn(async name => ({ name, url: 'https://connector.example/mcp', tools: [] })),
    call: vi.fn(), assertCurrent: async () => {}, authorize: vi.fn(),
  }
  const tools = new Map<string, Tool>()
  await injectMcpTools({
    userId: 'user-example', assistantId: 'assistant-example', assistantTeamId: 'workspace-example', tools,
    executionContext: execution, scopeAccumulator: accumulator, exposeLocalReadTools: true,
    contextScope: { access: execution.security.access, effectiveCompartments: [], effectiveProjectIds: [] },
    connectorStore: { list: async () => [], getConfig: async () => ({}) } as never,
    settingsStore: { getPolicy: async () => null } as never,
    connectorInstanceStore: {
      listByWorkspaceSystem: async () => rows,
      getSystem: async (id: string) => rows.find(row => row.id === id),
      getAuthCredentialsSystem: async () => ({}),
      getCredentialsSystem: async () => ({ client_id: 'google_refresh', client_secret: 'fictional-refresh' }),
      markHealth: async () => {},
    } as never,
    connectorSourceRuntimeFactory: async () => source,
  })
  expect(source.discover).toHaveBeenCalled()
  expect(tools.has('googleCalendarListEvents')).toBe(true)
  return { execution, accumulator, tools }
}

beforeEach(() => {
  mocks.current.mockReset().mockResolvedValue(undefined)
  mocks.read.mockReset().mockResolvedValue({ items: [] })
})

describe('[COMP:api/mcp-inject] protected connector preflight', () => {
  it('keeps the admitted turn context for preliminary reads while rejecting substituted contexts and revoked authority', async () => {
    const { execution, accumulator, tools } = await setup()
    const provider: LLMProvider = {
      name: 'fixture', models: ['fixture'], createSession() { throw new Error('Stateless only') },
      async *stream(request): AsyncIterable<StreamChunk> {
        expect(request.tools?.map(tool => tool.name)).toContain('googleCalendarListEvents')
        const results = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .filter(block => block.type === 'tool_result')
        yield { type: 'message_start', model: 'fixture' }
        if (results.length) {
          expect(results.filter(result => result.isError)).toEqual([])
          yield { type: 'text_delta', text: 'Calendar checked successfully.' }
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
        } else {
          yield { type: 'tool_use_start', id: 'read-example', name: 'googleCalendarListEvents' }
          yield { type: 'tool_use_delta', id: 'read-example', input: '{}' }
          yield { type: 'tool_use_end', id: 'read-example' }
          yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
        }
      },
    }
    const context = { ...executionToolContext(execution, { appId: 'test' }), scopeAccumulator: accumulator, requestTools: tools }
    const errors: Error[] = []
    const result = await runPreflight({ provider, model: 'fixture', message: 'Read calendar', tools, context, forceResearch: true,
      onEvent: event => { if (event.type === 'error') errors.push(event.error) },
    })
    expect(errors).toEqual([])
    expect(result).toMatchObject({ type: 'researched', context: expect.stringContaining('Calendar checked successfully.') })
    expect(mocks.read).toHaveBeenCalledOnce()
    const read = tools.get('googleCalendarListEvents')!
    await expect(async () => read.execute({}, { ...context, executionContext: { ...execution } })).rejects.toMatchObject({ reason: 'authority_changed' })
    await expect(async () => read.execute({}, { ...context, scopeAccumulator: new ContextScopeAccumulator() })).rejects.toMatchObject({ reason: 'authority_changed' })
    mocks.current.mockRejectedValue(new Error('Current membership revoked'))
    await expect(read.execute({}, context)).rejects.toThrow('Current membership revoked')
    expect(mocks.read).toHaveBeenCalledOnce()
  })
})
