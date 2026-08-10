/**
 * Unit tests for the MCP tool-injection module.
 * Component tag: [COMP:api/mcp-inject].
 *
 * Exercises the public surface of inject.ts: injectMcpTools' fail-soft
 * contract (a connector-store error degrades to an empty result rather
 * than throwing), the no-connectors path returning a valid
 * McpInjectionResult, the INJECTED_BUILTIN_TOOLS_BY_CONNECTOR drift-
 * sweep table's integrity, and the discovery-cache size accessor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Built-in connector injectors resolve their OAuth app creds via
// getConnectorConfig and no-op when none are configured — default to
// undefined so the no-connector path is inert regardless of the runner's
// process.env. The Google multi-account suite overrides per test.
const getConnectorConfig = vi.fn<(provider: string) => { clientId: string; clientSecret: string } | undefined>()
  .mockReturnValue(undefined)
vi.mock('../../connector-config.js', () => ({
  getConnectorConfig: (provider: string) => getConnectorConfig(provider),
}))

// Google API client — the multi-account suite needs token refresh + the
// enricher's task fetch to be observable without the network. Everything
// else keeps the real (unreached) implementation.
const refreshGoogleAccessToken = vi.fn(
  async (refreshToken: string, _clientId: string, _clientSecret: string) => `access-${refreshToken}`,
)
const getGoogleTask = vi.fn(
  async (_token: string, _taskListId: string, _taskId: string) => ({ title: 'Standup prep' }),
)
const getCalendarEvent = vi.fn(
  async (_token: string, eventId: string, _calendarId: string) => ({ id: eventId, summary: 'Planning' }),
)
vi.mock('../../google/client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshGoogleAccessToken: (refreshToken: string, clientId: string, clientSecret: string) =>
    refreshGoogleAccessToken(refreshToken, clientId, clientSecret),
  getGoogleTask: (token: string, taskListId: string, taskId: string) =>
    getGoogleTask(token, taskListId, taskId),
  getCalendarEvent: (token: string, eventId: string, calendarId: string) =>
    getCalendarEvent(token, eventId, calendarId),
}))

// Custom remote MCP discovery / calls — stubbed so the tests never hit the
// network. Discovery returns a tiny server; tests that don't connect a custom
// MCP simply never invoke it.
const discoverMcpServer = vi.fn()
const callRemoteMcpTool = vi.fn()
vi.mock('../client.js', () => ({
  discoverMcpServer: (...args: unknown[]) => discoverMcpServer(...args),
  callRemoteMcpTool: (...args: unknown[]) => callRemoteMcpTool(...args),
}))

const discoverCliServer = vi.fn()
const callCliMcpTool = vi.fn()
vi.mock('../cli-transport.js', () => ({
  discoverCliServer: (...args: unknown[]) => discoverCliServer(...args),
  callCliMcpTool: (...args: unknown[]) => callCliMcpTool(...args),
}))

// Microsoft Graph transport. The injector builds the client eagerly but only
// resolves an access token lazily (on tool execute), so capturing the resolver
// is the only way to assert WHICH instance's credentials a workspace-overlaid
// msgraph connector binds to — without a network call. The tool factory reads
// the client's methods lazily too, so a bare object is a sufficient stand-in.
const msGraphTokenResolvers: Array<() => Promise<string>> = []
vi.mock('../../msgraph/client.js', () => ({
  createMsGraphClient: (opts: { getAccessToken: () => Promise<string> }) => {
    msGraphTokenResolvers.push(opts.getAccessToken)
    return {}
  },
}))

import {
  injectMcpTools,
  INJECTED_BUILTIN_TOOLS_BY_CONNECTOR,
  _getMcpDiscoveryCacheSize,
} from '../inject.js'
import { buildUnavailableCapabilitiesPrompt } from '../../routes/route-helpers.js'
import { packMsGraphTokens } from '../../msgraph/token.js'

function settingsStoreStub() {
  // Generous stub — the no-connector path touches few of these, but
  // returning safe defaults keeps the test resilient to internal calls.
  return new Proxy(
    {},
    { get: () => vi.fn().mockResolvedValue(undefined) },
  )
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  // Reset only the discovery stubs.
  discoverMcpServer.mockReset()
  callRemoteMcpTool.mockReset()
  discoverCliServer.mockReset()
  callCliMcpTool.mockReset()
})

describe('[COMP:api/mcp-inject] injectMcpTools', () => {
  it('degrades to an empty result without throwing when the connector store errors', async () => {
    const tools = new Map()
    const result = await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools,
      connectorStore: { list: vi.fn().mockRejectedValue(new Error('db down')) } as never,
      settingsStore: settingsStoreStub() as never,
    })
    expect(typeof result.enrichConfirmation).toBe('function')
    expect(Array.isArray(result.unavailable)).toBe(true)
    expect(tools.size).toBe(0)
  })

  it('returns a valid McpInjectionResult when the user has no connectors', async () => {
    const result = await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools: new Map(),
      connectorStore: { list: vi.fn().mockResolvedValue([]) } as never,
      settingsStore: settingsStoreStub() as never,
    })
    expect(typeof result.enrichConfirmation).toBe('function')
    expect(Array.isArray(result.unavailable)).toBe(true)
    // enrichConfirmation is an identity pass-through when no enrichers wired
    const input = { a: 1 }
    expect(await result.enrichConfirmation('someTool', input)).toEqual(input)
  })
})

describe('[COMP:api/mcp-inject] KB write-tool exposure gate', () => {
  type KbSource = { id: string; repo: string; sourceType: 'github' | 'local'; writeAccess?: boolean | null }

  function kbStoreStub(sources: KbSource[]) {
    return {
      hasEntriesForAssistant: vi.fn().mockResolvedValue(true),
      listSourcesForAssistant: vi.fn().mockResolvedValue(sources),
    } as never
  }

  const repoWriterStub = {
    commitEntryUpdate: vi.fn(),
    commitEntryCreate: vi.fn(),
  }

  async function inject(params: {
    sources: KbSource[]
    allowKnowledgeWrites?: boolean
    withWriter?: boolean
    keepBuiltinsDirect?: boolean
  }) {
    const tools = new Map()
    const result = await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools,
      connectorStore: { list: vi.fn().mockResolvedValue([]) } as never,
      settingsStore: settingsStoreStub() as never,
      knowledgeStore: kbStoreStub(params.sources),
      knowledgeRepoWriter: params.withWriter === false ? undefined : (repoWriterStub as never),
      allowKnowledgeWrites: params.allowKnowledgeWrites,
      keepBuiltinsDirect: params.keepBuiltinsDirect ?? true,
    })
    return { tools, result }
  }

  const WRITABLE: KbSource[] = [{ id: 's1', repo: 'acme/kb', sourceType: 'github', writeAccess: true }]
  const READ_ONLY: KbSource[] = [{ id: 's1', repo: 'acme/kb', sourceType: 'github', writeAccess: null }]
  const LOCAL: KbSource[] = [{ id: 'local1', repo: '/srv/kb', sourceType: 'local', writeAccess: null }]

  it('exposes updateKnowledgeEntry on an interactive surface with a writable source', async () => {
    const { tools, result } = await inject({ sources: WRITABLE, allowKnowledgeWrites: true })
    expect([...tools.keys()]).toContain('updateKnowledgeEntry')
    expect(result.unavailable.join(' ')).not.toContain('knowledge base editing')
  })

  it('treats a local source as writable without a GitHub capability probe', async () => {
    const { tools, result } = await inject({ sources: LOCAL, allowKnowledgeWrites: true })
    expect([...tools.keys()]).toContain('updateKnowledgeEntry')
    expect(result.unavailable.join(' ')).not.toContain('GitHub token')
  })

  it('keeps write tools out on non-interactive surfaces (default), with no unavailable advert', async () => {
    const { tools, result } = await inject({ sources: WRITABLE })
    expect([...tools.keys()]).not.toContain('updateKnowledgeEntry')
    expect([...tools.keys()]).toContain('searchKnowledge')
    // The capability doesn't exist on this surface by design — advertising
    // it as "unavailable" would invite the model to promise it.
    expect(result.unavailable.join(' ')).not.toContain('knowledge base editing')
  })

  it('reports a precise read-only reason when no source is writable', async () => {
    const { tools, result } = await inject({ sources: READ_ONLY, allowKnowledgeWrites: true })
    expect([...tools.keys()]).not.toContain('updateKnowledgeEntry')
    const line = result.unavailable.find((u) => u.includes('knowledge base editing'))
    expect(line).toBeDefined()
    expect(line).toContain('read-only')
    expect(line).toContain('acme/kb')
  })

  it('reports not-configured when the writer port is absent (open standalone)', async () => {
    const { result } = await inject({ sources: WRITABLE, allowKnowledgeWrites: true, withWriter: false })
    const line = result.unavailable.find((u) => u.includes('knowledge base editing'))
    expect(line).toContain('not configured')
  })

  it('keeps write tools out of the mcp_search index when gated (closed world)', async () => {
    const denied = await inject({ sources: WRITABLE, allowKnowledgeWrites: false, keepBuiltinsDirect: false })
    const deniedSearch = denied.tools.get('mcp_search')
    expect(deniedSearch).toBeDefined()
    const deniedHits = await deniedSearch!.execute({ query: 'update knowledge entry' }, {} as never)
    expect(JSON.stringify(deniedHits.data)).not.toContain('updateKnowledgeEntry')

    const allowed = await inject({ sources: WRITABLE, allowKnowledgeWrites: true, keepBuiltinsDirect: false })
    const allowedSearch = allowed.tools.get('mcp_search')
    const allowedHits = await allowedSearch!.execute({ query: 'update knowledge entry' }, {} as never)
    expect(JSON.stringify(allowedHits.data)).toContain('updateKnowledgeEntry')
  })
})

describe('[COMP:api/mcp-inject] workspace connector-scoping gate', () => {
  // Regression guard for the 2026-06-01 cross-member leak and the 2026-07-14
  // cross-workspace leak: NO workspace assistant may load the workspace
  // owner's personal connectors as its base tool set — exposure
  // (connector_grant) is the injection boundary in every workspace, solo
  // included. The base `connectorStore.list(userId)` load is the leak source,
  // so we assert whether it is called per assistant context.

  function listSpy() {
    return vi.fn().mockResolvedValue([])
  }

  it('workspace assistant (any member count): does NOT load the owner-personal connector base', async () => {
    const list = listSpy()
    await injectMcpTools({
      userId: 'owner-1',
      assistantId: 'a-1',
      tools: new Map(),
      connectorStore: { list } as never,
      settingsStore: settingsStoreStub() as never,
      assistantTeamId: 'ws-any',
    })
    expect(list).not.toHaveBeenCalled()
  })

  it('no workspace (personal assistant): loads the connector base', async () => {
    const list = listSpy()
    await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools: new Map(),
      connectorStore: { list } as never,
      settingsStore: settingsStoreStub() as never,
    })
    expect(list).toHaveBeenCalledWith('u-1')
  })
})

describe('[COMP:api/mcp-inject] granted custom MCP overlay', () => {
  // Regression: a user-scoped CUSTOM remote MCP shared to a shared workspace
  // via a connector_grant was silently dropped (the grant overlay only
  // re-injected known built-in providers). For a shared workspace the
  // owner-personal base load is suppressed, so the grant is the only source —
  // it must be discovered and surfaced through mcp_search / mcp_call.
  it('discovers and injects a user-scoped custom MCP granted to a shared workspace', async () => {
    discoverMcpServer.mockResolvedValueOnce({
      name: 'My MCP',
      tools: [{ name: 'doThing', description: 'does a thing', inputSchema: { type: 'object', properties: {} } }],
    })
    const tools = new Map()
    const connectorGrantStore = {
      listForTargetSystem: vi.fn().mockResolvedValue([
        {
          grantedByUserId: 'grantor-1',
          instance: {
            id: 'ci-mcp', scope: 'user', userId: 'grantor-1', workspaceId: null,
            provider: 'mcp-uuid-123', label: 'My MCP', url: 'http://localhost:8770/mcp',
            custom: true, connected: true, config: {}, sensitivity: 'internal',
          },
        },
      ]),
    }

    await injectMcpTools({
      userId: 'owner-1',
      assistantId: 'a-1',
      tools,
      connectorStore: { list: vi.fn().mockResolvedValue([]) } as never,
      settingsStore: settingsStoreStub() as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-shared',
    })

    // The granted custom MCP was discovered by URL...
    expect(discoverMcpServer).toHaveBeenCalledWith('http://localhost:8770/mcp', 'My MCP', {})
    // ...and surfaced through the unified search pair. (Both would be absent if
    // the grant were dropped — no other source exists for this workspace.)
    expect(tools.has('mcp_search')).toBe(true)
    expect(tools.has('mcp_call')).toBe(true)
  })

  it('skips a disconnected granted custom MCP', async () => {
    const tools = new Map()
    const connectorGrantStore = {
      listForTargetSystem: vi.fn().mockResolvedValue([
        {
          grantedByUserId: 'grantor-1',
          instance: {
            id: 'ci-mcp', provider: 'mcp-uuid-456', label: 'Down MCP',
            url: 'http://localhost:8771/mcp', custom: true, connected: false, config: {},
          },
        },
      ]),
    }
    await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools,
      connectorStore: { list: vi.fn().mockResolvedValue([]) } as never,
      settingsStore: settingsStoreStub() as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-shared',
    })
    expect(discoverMcpServer).not.toHaveBeenCalled()
    expect(tools.has('mcp_call')).toBe(false)
  })
})

describe('[COMP:api/mcp-inject] granted CLI MCP overlay', () => {
  it('injects every CLI instance exposed to a workspace', async () => {
    discoverCliServer.mockImplementation(async (_params, name) => ({
      name,
      url: `stdio://${name}`,
      tools: [{ name: `read${name.replace(/\W/g, '')}`, description: `Read from ${name}`, inputSchema: { type: 'object' } }],
    }))
    const instances = [
      { id: 'cli-1', provider: 'cli', label: 'Test Filesystem', connected: true, config: {}, updatedAt: new Date(0) },
      { id: 'cli-2', provider: 'cli', label: 'Project Filesystem', connected: true, config: {}, updatedAt: new Date(0) },
    ]
    const tools = new Map()
    const connectorGrantStore = {
      listForTargetSystem: vi.fn().mockResolvedValue(instances.map((instance) => ({
        grantedByUserId: 'grantor-1',
        instance,
      }))),
    }
    const connectorInstanceStore = {
      listByWorkspaceSystem: vi.fn().mockResolvedValue([]),
      getAuthCredentialsSystem: vi.fn(async (id: string) => ({
        type: 'cli', binaryPath: '/usr/bin/node', args: [`/tmp/${id}.js`],
      })),
    }

    await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools,
      connectorStore: { list: vi.fn().mockResolvedValue([]) } as never,
      settingsStore: settingsStoreStub() as never,
      connectorGrantStore: connectorGrantStore as never,
      connectorInstanceStore: connectorInstanceStore as never,
      assistantTeamId: 'ws-shared',
    })

    expect(discoverCliServer).toHaveBeenCalledTimes(2)
    expect(discoverCliServer).toHaveBeenCalledWith(expect.anything(), 'Test Filesystem')
    expect(discoverCliServer).toHaveBeenCalledWith(expect.anything(), 'Project Filesystem')
    expect(tools.has('mcp_search')).toBe(true)
    expect(tools.has('mcp_call')).toBe(true)
  })

  it('skips only the CLI instance disabled for this assistant', async () => {
    discoverCliServer.mockImplementation(async (_params, name) => ({
      name,
      url: `stdio://${name}`,
      tools: [{ name: `read${name}`, description: 'Read data', inputSchema: { type: 'object' } }],
    }))
    const instances = [
      { id: 'cli-disabled-1', provider: 'cli', label: 'One', connected: true, config: {}, updatedAt: new Date(0) },
      { id: 'cli-enabled-2', provider: 'cli', label: 'Two', connected: true, config: {}, updatedAt: new Date(0) },
    ]
    const isEnabled = vi.fn(async (_assistantId: string, governanceId: string) => governanceId !== 'cli:cli-disabled-1')
    const tools = new Map()

    await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools,
      connectorStore: { list: vi.fn().mockResolvedValue([]) } as never,
      settingsStore: settingsStoreStub() as never,
      assistantConnectorStore: { isEnabled } as never,
      connectorGrantStore: {
        listForTargetSystem: vi.fn().mockResolvedValue(instances.map((instance) => ({
          grantedByUserId: 'grantor-1', instance,
        }))),
      } as never,
      connectorInstanceStore: {
        listByWorkspaceSystem: vi.fn().mockResolvedValue([]),
        getAuthCredentialsSystem: vi.fn().mockResolvedValue({
          type: 'cli', binaryPath: '/usr/bin/node', args: ['/tmp/server.js'],
        }),
      } as never,
      assistantTeamId: 'ws-shared',
    })

    expect(isEnabled).toHaveBeenCalledWith('a-1', 'cli:cli-disabled-1', 'cli')
    expect(isEnabled).toHaveBeenCalledWith('a-1', 'cli:cli-enabled-2', 'cli')
    expect(discoverCliServer).toHaveBeenCalledTimes(1)
    expect(discoverCliServer).toHaveBeenCalledWith(expect.anything(), 'Two')
  })
})

describe('[COMP:api/mcp-inject] custom connector auth threading', () => {
  // Execution dispatches by serverUrl alone (tool-search's mcp_call carries
  // no per-entry credentials), so inject.ts joins per-connector auth headers
  // by URL. Both halves matter: discovery AND the mcp_call dispatcher.
  it('threads bearer headers through discovery and the mcp_call dispatcher', async () => {
    discoverMcpServer.mockResolvedValueOnce({
      name: 'Trading MCP',
      url: 'http://localhost:9000/mcp',
      tools: [{ name: 'getQuote', description: 'Read a market quote', inputSchema: { type: 'object', properties: {} } }],
    })
    callRemoteMcpTool.mockResolvedValueOnce('42')
    const tools = new Map()
    const connectorStore = {
      list: vi.fn().mockResolvedValue([
        {
          id: 'ci-bear', connectorId: 'cx-1', name: 'Trading MCP', connected: true,
          url: 'http://localhost:9000/mcp', custom: true,
          createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-06-01T00:00:00Z'),
        },
      ]),
    }
    const connectorInstanceStore = {
      getAuthCredentialsSystem: vi.fn().mockResolvedValue({ type: 'bearer', token: 'tok-1' }),
      getCredentialsSystem: vi.fn(),
      updateCredentialsSystem: vi.fn(),
    }

    await injectMcpTools({
      userId: 'u-bearer',
      assistantId: 'a-1',
      tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
    })

    // Discovery carried the Authorization header...
    expect(connectorInstanceStore.getAuthCredentialsSystem).toHaveBeenCalledWith('ci-bear')
    expect(discoverMcpServer).toHaveBeenCalledWith(
      'http://localhost:9000/mcp', 'Trading MCP', { Authorization: 'Bearer tok-1' },
    )

    // ...and execution joins the same headers by serverUrl through mcp_call.
    const mcpCall = tools.get('mcp_call') as { execute: (i: unknown, c: unknown) => Promise<unknown> }
    expect(mcpCall).toBeTruthy()
    await mcpCall.execute({ server: 'Trading MCP', tool: 'getQuote', args: { symbol: 'ADA' } }, {} as never)
    expect(callRemoteMcpTool).toHaveBeenCalledWith(
      'http://localhost:9000/mcp', 'getQuote', { symbol: 'ADA' }, { Authorization: 'Bearer tok-1' },
    )
  })

  // config.preflightHeaders — static operational headers configured per
  // connector — merge OVER the auth headers and travel on both discovery and
  // the mcp_call dispatcher, same join-by-URL path. See tool-hooks.md.
  // (Unique userId/connectorId/url so the per-process discovery cache, keyed
  // on userId:connectorId:url:updatedAt, doesn't short-circuit discovery.)
  it('merges config.preflightHeaders over auth headers through discovery and dispatch', async () => {
    discoverMcpServer.mockResolvedValueOnce({
      name: 'Preflight MCP', url: 'http://localhost:9100/mcp',
      tools: [{ name: 'getQuote', description: 'Read a market quote', inputSchema: { type: 'object', properties: {} } }],
    })
    callRemoteMcpTool.mockResolvedValueOnce('42')
    const tools = new Map()
    const connectorStore = {
      list: vi.fn().mockResolvedValue([
        {
          id: 'ci-pf-1', connectorId: 'cx-pf-1', name: 'Preflight MCP', connected: true,
          url: 'http://localhost:9100/mcp', custom: true,
          config: { preflightHeaders: [{ name: 'X-Tenant', value: 'acme' }] },
          createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-06-02T00:00:00Z'),
        },
      ]),
    }
    const connectorInstanceStore = {
      getAuthCredentialsSystem: vi.fn().mockResolvedValue({ type: 'bearer', token: 'tok-1' }),
      getCredentialsSystem: vi.fn(), updateCredentialsSystem: vi.fn(),
    }
    await injectMcpTools({
      userId: 'u-pf-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
    })
    expect(discoverMcpServer).toHaveBeenCalledWith(
      'http://localhost:9100/mcp', 'Preflight MCP',
      { Authorization: 'Bearer tok-1', 'X-Tenant': 'acme' },
    )
    const mcpCall = tools.get('mcp_call') as { execute: (i: unknown, c: unknown) => Promise<unknown> }
    await mcpCall.execute({ server: 'Preflight MCP', tool: 'getQuote', args: { symbol: 'ADA' } }, {} as never)
    expect(callRemoteMcpTool).toHaveBeenCalledWith(
      'http://localhost:9100/mcp', 'getQuote', { symbol: 'ADA' },
      { Authorization: 'Bearer tok-1', 'X-Tenant': 'acme' },
    )
  })

  it('drops an invalid preflight header at inject time but keeps auth + valid ones', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    discoverMcpServer.mockResolvedValueOnce({ name: 'Preflight MCP 2', url: 'http://localhost:9101/mcp', tools: [] })
    const tools = new Map()
    await injectMcpTools({
      userId: 'u-pf-2', assistantId: 'a-1', tools,
      connectorStore: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'ci-pf-2', connectorId: 'cx-pf-2', name: 'Preflight MCP 2', connected: true,
            url: 'http://localhost:9101/mcp', custom: true,
            config: { preflightHeaders: [{ name: 'X-Bad: nope\r\n', value: 'v' }, { name: 'X-Good', value: 'ok' }] },
            createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-06-03T00:00:00Z'),
          },
        ]),
      } as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: {
        getAuthCredentialsSystem: vi.fn().mockResolvedValue({ type: 'bearer', token: 'tok-1' }),
        getCredentialsSystem: vi.fn(), updateCredentialsSystem: vi.fn(),
      } as never,
    })
    expect(discoverMcpServer).toHaveBeenCalledWith(
      'http://localhost:9101/mcp', 'Preflight MCP 2',
      { Authorization: 'Bearer tok-1', 'X-Good': 'ok' },
    )
  })

  // Opt-in actor identity: the connector with config.sendActorIdentity gets the
  // reserved X-Sidanclaw-Actor-* headers (over auth + preflight). See tool-hooks.md.
  it('injects X-Sidanclaw-Actor-* for an opted-in connector at highest precedence', async () => {
    discoverMcpServer.mockResolvedValueOnce({
      name: 'Actor MCP', url: 'http://localhost:9200/mcp',
      tools: [{ name: 'getQuote', description: 'q', inputSchema: { type: 'object', properties: {} } }],
    })
    const tools = new Map()
    await injectMcpTools({
      userId: 'u-actor-1', assistantId: 'a-1', tools,
      connectorStore: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'ci-actor-1', connectorId: 'cx-actor-1', name: 'Actor MCP', connected: true,
            url: 'http://localhost:9200/mcp', custom: true,
            config: { sendActorIdentity: true, preflightHeaders: [{ name: 'X-Tenant', value: 'acme' }] },
            createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-06-04T00:00:00Z'),
          },
        ]),
      } as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: {
        getAuthCredentialsSystem: vi.fn().mockResolvedValue({ type: 'bearer', token: 'tok' }),
        getCredentialsSystem: vi.fn(), updateCredentialsSystem: vi.fn(),
      } as never,
      actorIdentity: { channel: 'web', id: 'ceo@corp.com', email: 'ceo@corp.com', userId: 'u-actor-1' },
    })
    expect(discoverMcpServer).toHaveBeenCalledWith('http://localhost:9200/mcp', 'Actor MCP', {
      Authorization: 'Bearer tok',
      'X-Tenant': 'acme',
      'X-UseBrian-Actor-Channel': 'web',
      'X-Sidanclaw-Actor-Channel': 'web',
      'X-UseBrian-User-Id': 'u-actor-1',
      'X-Sidanclaw-User-Id': 'u-actor-1',
      'X-UseBrian-Actor-Id': 'ceo@corp.com',
      'X-Sidanclaw-Actor-Id': 'ceo@corp.com',
      'X-UseBrian-Actor-Email': 'ceo@corp.com',
      'X-Sidanclaw-Actor-Email': 'ceo@corp.com',
    })
  })

  // The api channel: an external client of the workspace, served through a
  // consumer-hosted bridge MCP server. The bridge resolves Actor-Id back to
  // its own user record and scopes every fetch to that person, so these
  // headers are what makes "one client can never read another" structural
  // rather than a prompt instruction. Actor-Id is the consumer's own opaque
  // externalUserId; User-Id is the stable Use Brian shadow UUID.
  it('injects the api-channel actor headers (id / email / org) for a bridge connector', async () => {
    discoverMcpServer.mockResolvedValueOnce({
      name: 'Bridge MCP', url: 'http://localhost:9202/mcp',
      tools: [{ name: 'getMyOrders', description: 'self-scoped', inputSchema: { type: 'object', properties: {} } }],
    })
    const tools = new Map()
    await injectMcpTools({
      userId: 'u-owner-1', assistantId: 'a-1', tools,
      connectorStore: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'ci-bridge-1', connectorId: 'cx-bridge-1', name: 'Bridge MCP', connected: true,
            url: 'http://localhost:9202/mcp', custom: true,
            config: { sendActorIdentity: true },
            createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-08-06T00:00:00Z'),
          },
        ]),
      } as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: {
        getAuthCredentialsSystem: vi.fn().mockResolvedValue({ type: 'bearer', token: 'bridge-tok' }),
        getCredentialsSystem: vi.fn(), updateCredentialsSystem: vi.fn(),
      } as never,
      actorIdentity: {
        channel: 'api',
        id: 'cust_8812',
        email: 'jane@client.example',
        userId: 'u-shadow-jane',
        org: 'acme-corp',
      },
    })
    const headers = discoverMcpServer.mock.calls.at(-1)![2] as Record<string, string>
    expect(headers['X-UseBrian-Actor-Channel']).toBe('api')
    expect(headers['X-UseBrian-Actor-Id']).toBe('cust_8812')
    expect(headers['X-UseBrian-Actor-Email']).toBe('jane@client.example')
    expect(headers['X-UseBrian-Actor-Org']).toBe('acme-corp')
    expect(headers['X-UseBrian-User-Id']).toBe('u-shadow-jane')
    expect(headers.Authorization).toBe('Bearer bridge-tok')
  })

  it('does NOT inject actor headers for a connector that did not opt in (no PII leak)', async () => {
    discoverMcpServer.mockResolvedValueOnce({ name: 'No-Actor MCP', url: 'http://localhost:9201/mcp', tools: [] })
    const tools = new Map()
    await injectMcpTools({
      userId: 'u-actor-2', assistantId: 'a-1', tools,
      connectorStore: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'ci-actor-2', connectorId: 'cx-actor-2', name: 'No-Actor MCP', connected: true,
            url: 'http://localhost:9201/mcp', custom: true,
            config: {}, // sendActorIdentity absent → opted out
            createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-06-05T00:00:00Z'),
          },
        ]),
      } as never,
      settingsStore: settingsStoreStub() as never,
      actorIdentity: { channel: 'web', id: 'ceo@corp.com', email: 'ceo@corp.com', userId: 'u-actor-2' },
    })
    expect(discoverMcpServer).toHaveBeenCalledWith('http://localhost:9201/mcp', 'No-Actor MCP', {})
  })

  // Opt-in media capability: the connector with config.sendMediaToken gets the
  // reserved X-Sidanclaw-Media-Token header, gated INDEPENDENTLY of actor identity.
  it('injects X-Sidanclaw-Media-Token for an opted-in connector', async () => {
    discoverMcpServer.mockResolvedValueOnce({ name: 'Media MCP', url: 'http://localhost:9210/mcp', tools: [] })
    const tools = new Map()
    await injectMcpTools({
      userId: 'u-media-1', assistantId: 'a-1', tools,
      connectorStore: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'ci-media-1', connectorId: 'cx-media-1', name: 'Media MCP', connected: true,
            url: 'http://localhost:9210/mcp', custom: true,
            config: { sendMediaToken: true }, // media opt-in, actor identity NOT opted in
            createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-06-06T00:00:00Z'),
          },
        ]),
      } as never,
      settingsStore: settingsStoreStub() as never,
      actorIdentity: { channel: 'whatsapp', id: '+15551234567', email: null, userId: 'u-media-1', mediaToken: 'tok.media.sig' },
    })
    // Media token present; actor headers absent (that connector opted out of identity).
    expect(discoverMcpServer).toHaveBeenCalledWith('http://localhost:9210/mcp', 'Media MCP', {
      'X-UseBrian-Media-Token': 'tok.media.sig',
      'X-Sidanclaw-Media-Token': 'tok.media.sig',
    })
  })

  it('does NOT inject X-Sidanclaw-Media-Token for a connector that did not opt in', async () => {
    discoverMcpServer.mockResolvedValueOnce({ name: 'No-Media MCP', url: 'http://localhost:9211/mcp', tools: [] })
    const tools = new Map()
    await injectMcpTools({
      userId: 'u-media-2', assistantId: 'a-1', tools,
      connectorStore: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'ci-media-2', connectorId: 'cx-media-2', name: 'No-Media MCP', connected: true,
            url: 'http://localhost:9211/mcp', custom: true,
            config: { sendActorIdentity: true }, // identity opted in, media NOT
            createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-06-07T00:00:00Z'),
          },
        ]),
      } as never,
      settingsStore: settingsStoreStub() as never,
      actorIdentity: { channel: 'whatsapp', id: '+15551234567', email: null, userId: 'u-media-2', mediaToken: 'tok.media.sig' },
    })
    // Actor headers present (identity opt-in), but NO media token.
    expect(discoverMcpServer).toHaveBeenCalledWith('http://localhost:9211/mcp', 'No-Media MCP', {
      'X-UseBrian-Actor-Channel': 'whatsapp',
      'X-Sidanclaw-Actor-Channel': 'whatsapp',
      'X-UseBrian-User-Id': 'u-media-2',
      'X-Sidanclaw-User-Id': 'u-media-2',
      'X-UseBrian-Actor-Id': '+15551234567',
      'X-Sidanclaw-Actor-Id': '+15551234567',
    })
  })

  it('discovers with empty headers when no instance store is wired (legacy parity)', async () => {
    discoverMcpServer.mockResolvedValueOnce({ name: 'Open MCP', url: 'http://localhost:9001/mcp', tools: [] })
    const tools = new Map()
    await injectMcpTools({
      userId: 'u-open',
      assistantId: 'a-1',
      tools,
      connectorStore: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'ci-open', connectorId: 'cx-2', name: 'Open MCP', connected: true,
            url: 'http://localhost:9001/mcp', custom: true,
            createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-06-01T00:00:00Z'),
          },
        ]),
      } as never,
      settingsStore: settingsStoreStub() as never,
    })
    expect(discoverMcpServer).toHaveBeenCalledWith('http://localhost:9001/mcp', 'Open MCP', {})
  })
})

describe('[COMP:api/mcp-inject] INJECTED_BUILTIN_TOOLS_BY_CONNECTOR', () => {
  it('maps each built-in connector to a non-empty, duplicate-free tool list', () => {
    const connectors = Object.keys(INJECTED_BUILTIN_TOOLS_BY_CONNECTOR)
    expect(connectors).toEqual(
      expect.arrayContaining(['gcal', 'gmail', 'gdrive', 'github', 'notion', 'fathom', 'msgraph']),
    )
    for (const [connector, toolNames] of Object.entries(INJECTED_BUILTIN_TOOLS_BY_CONNECTOR)) {
      expect(toolNames.length, connector).toBeGreaterThan(0)
      expect(new Set(toolNames).size, `${connector} has duplicate tool names`).toBe(toolNames.length)
    }
  })
})

describe('[COMP:api/mcp-inject] multi-instance built-ins', () => {
  // Two connected GitHub accounts: the OLDEST keeps the canonical tool names
  // (so single-account users are unchanged); the newer one is injected as a
  // label-qualified variant bound to its own PAT.
  it('injects canonical tools for the primary GitHub and a labelled variant for the extra', async () => {
    const tools = new Map()
    const connectorStore = {
      list: vi.fn().mockResolvedValue([
        { id: 'ci-a', connectorId: 'github', name: 'GitHub', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
        { id: 'ci-b', connectorId: 'github', name: 'Work', connected: true, url: null, custom: false, createdAt: new Date('2026-02-01T00:00:00Z') },
      ]),
      getCredentials: vi.fn().mockResolvedValue({ client_id: 'github_pat', client_secret: 'pat-primary' }),
    }
    const connectorInstanceStore = {
      getCredentialsSystem: vi.fn(async (id: string) => ({ client_id: 'github_pat', client_secret: `pat-${id}` })),
      updateCredentialsSystem: vi.fn(),
    }

    await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      // Keep built-ins direct so the variants stay in the map (not plucked
      // behind mcp_search), making the assertion straightforward.
      keepBuiltinsDirect: true,
    })

    const names = [...tools.keys()]
    // Primary keeps the canonical name.
    expect(names).toContain('githubSearchRepositories')
    // The extra account gets a suffixed variant, tagged with its label.
    const variant = names.find((n) => n.startsWith('githubSearchRepositories__'))
    expect(variant).toBeTruthy()
    expect((tools.get(variant!) as { description: string }).description).toMatch(/^\[Work\]/)
    // Both the canonical set (10) and the variant set (10) are present.
    expect(names.filter((n) => n.startsWith('githubSearchRepositories')).length).toBe(2)
  })

  it('single GitHub account: no variants, canonical tools only (unchanged behavior)', async () => {
    const tools = new Map()
    const connectorStore = {
      list: vi.fn().mockResolvedValue([
        { id: 'ci-a', connectorId: 'github', name: 'GitHub', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
      ]),
      getCredentials: vi.fn().mockResolvedValue({ client_id: 'github_pat', client_secret: 'pat-x' }),
    }
    const connectorInstanceStore = {
      getCredentialsSystem: vi.fn(),
      updateCredentialsSystem: vi.fn(),
    }
    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      keepBuiltinsDirect: true,
    })
    const names = [...tools.keys()]
    expect(names).toContain('githubSearchRepositories')
    expect(names.some((n) => n.includes('__'))).toBe(false)
  })
})

describe('[COMP:api/mcp-inject] multi-account Google built-ins', () => {
  // Two connected accounts per Google provider: the oldest keeps the
  // canonical names + the legacy per-provider token path; the newer one is a
  // suffixed variant set bound to its OWN refresh token (resolved lazily off
  // its connector_instance row). Tasks variants ride the gcal instance.
  function googleStores() {
    const connectorStore = {
      list: vi.fn().mockResolvedValue([
        { id: 'ci-gm1', connectorId: 'gmail', name: 'Gmail', connectedEmail: 'primary@example.com', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
        { id: 'ci-gm2', connectorId: 'gmail', name: 'Work', connectedEmail: 'work@example.com', connected: true, url: null, custom: false, createdAt: new Date('2026-02-01T00:00:00Z') },
        { id: 'ci-gc1', connectorId: 'gcal', name: 'Google Calendar', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
        { id: 'ci-gc2', connectorId: 'gcal', name: 'Work', connected: true, url: null, custom: false, createdAt: new Date('2026-02-01T00:00:00Z') },
      ]),
      // Primary (oldest-connected) credential read — the legacy path.
      getCredentials: vi.fn().mockResolvedValue({ client_id: 'google_refresh', client_secret: 'refresh-primary' }),
      getConfig: vi.fn().mockResolvedValue({}),
      setConnected: vi.fn(),
    }
    const connectorInstanceStore = {
      getCredentialsSystem: vi.fn(async (id: string) => ({ client_id: 'google_refresh', client_secret: `refresh-${id}` })),
      updateCredentialsSystem: vi.fn(),
      markHealth: vi.fn(),
    }
    return { connectorStore, connectorInstanceStore }
  }

  beforeEach(() => {
    getConnectorConfig.mockImplementation((provider: string) =>
      provider === 'google' ? { clientId: 'app-id', clientSecret: 'app-secret' } : undefined,
    )
    refreshGoogleAccessToken.mockClear()
    getGoogleTask.mockClear()
    getCalendarEvent.mockClear()
  })
  afterEach(() => {
    getConnectorConfig.mockReset()
    getConnectorConfig.mockReturnValue(undefined)
  })

  it('injects canonical Google tools for the primary and labelled variants for the extra accounts', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore } = googleStores()
    await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      keepBuiltinsDirect: true,
    })

    const names = [...tools.keys()]
    // Primaries keep canonical names.
    expect(names).toContain('gmailSendMessage')
    expect(names).toContain('googleCalendarListEvents')
    expect(names).toContain('googleTasksListTasks')
    // Extras get suffixed variants, description-tagged with the label —
    // Gmail, Calendar, AND Tasks (which ride the gcal credential).
    const gmailVariant = names.find((n) => n.startsWith('gmailSendMessage__'))
    const calVariant = names.find((n) => n.startsWith('googleCalendarListEvents__'))
    const tasksVariant = names.find((n) => n.startsWith('googleTasksListTasks__'))
    expect(gmailVariant).toBeTruthy()
    expect(calVariant).toBeTruthy()
    expect(tasksVariant).toBeTruthy()
    expect((tools.get(gmailVariant!) as { description: string }).description).toMatch(/^\[Work\]/)
    // Only the PRIMARY refresh token was exchanged at inject time
    // (prevalidation); extras resolve lazily at first tool call.
    const exchanged = refreshGoogleAccessToken.mock.calls.map((c) => c[0])
    expect(exchanged).toContain('refresh-primary')
    expect(exchanged).not.toContain('refresh-ci-gm2')
    expect(exchanged).not.toContain('refresh-ci-gc2')
  })

  it('binds each Gmail confirmation preview to its concrete sender account', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore } = googleStores()
    await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      keepBuiltinsDirect: true,
    })

    const input = { to: ['client@example.com'], subject: 'Hi', body: 'Hello' }
    const primary = tools.get('gmailSendMessage') as {
      describeConfirmation: (input: unknown, context: unknown) => Promise<string[] | null>
    }
    expect(await primary.describeConfirmation(input, {})).toContain(
      '• From: primary@example.com',
    )

    const variantName = [...tools.keys()].find((name) =>
      String(name).startsWith('gmailSendMessage__'),
    )
    const variant = tools.get(variantName) as {
      describeConfirmation: (input: unknown, context: unknown) => Promise<string[] | null>
    }
    expect(await variant.describeConfirmation(input, {})).toContain(
      '• From: work@example.com',
    )
  })

  it('enriches a suffixed confirmation with THAT account\'s token, not the primary\'s', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore } = googleStores()
    const result = await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      keepBuiltinsDirect: true,
    })

    const variant = [...tools.keys()].find((n) => n.startsWith('googleTasksDeleteTask__'))
    expect(variant).toBeTruthy()
    const enriched = await result.enrichConfirmation(variant!, { taskId: 'task-1' })
    // The extra gcal instance is ci-gc2 → its refresh token exchanged lazily,
    // and the task fetched with the VARIANT account's access token.
    expect(getGoogleTask).toHaveBeenCalledWith('access-refresh-ci-gc2', '@default', 'task-1')
    expect(enriched).toMatchObject({ task: 'Standup prep' })
  })

  it('enriches an event mutation from the calendar it will modify', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore } = googleStores()
    const result = await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      keepBuiltinsDirect: true,
    })

    await result.enrichConfirmation('googleCalendarDeleteEvent', {
      eventId: 'event-1', calendarId: 'team@example.com',
    })
    expect(getCalendarEvent).toHaveBeenCalledWith(
      'access-refresh-primary', 'event-1', 'team@example.com',
    )
  })

  it('single account per Google provider: canonical tools only, no variants', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore } = googleStores()
    connectorStore.list.mockResolvedValue([
      { id: 'ci-gm1', connectorId: 'gmail', name: 'Gmail', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
    ])
    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      keepBuiltinsDirect: true,
    })
    const names = [...tools.keys()]
    expect(names).toContain('gmailSendMessage')
    expect(names.some((n) => n.includes('__'))).toBe(false)
  })
})

describe('[COMP:api/mcp-inject] per-assistant write-grant gate', () => {
  // The registry-derived `gateToolsOnActionGrants` wrapper must ride the
  // REAL injection path for every built-in with write tools — a missing
  // wire here is exactly the dead-checkbox drift (Studio shows grant
  // boxes the runtime never enforces). Missing grants must remove writes
  // before either direct injection or the folded search index is built.
  const grantsStore = {
    getForAssistantSystem: vi.fn(),
    listForAssistant: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  }

  beforeEach(() => {
    grantsStore.getForAssistantSystem.mockReset().mockResolvedValue(null)
    getConnectorConfig.mockImplementation((provider: string) =>
      provider === 'google' ? { clientId: 'app-id', clientSecret: 'app-secret' } : undefined,
    )
  })
  afterEach(() => {
    getConnectorConfig.mockReset()
    getConnectorConfig.mockReturnValue(undefined)
  })

  async function injectWith(connectorRows: unknown[], keepBuiltinsDirect = true) {
    const tools = new Map()
    await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools,
      connectorStore: {
        list: vi.fn().mockResolvedValue(connectorRows),
        getCredentials: vi.fn().mockResolvedValue({ client_id: 'google_refresh', client_secret: 'refresh-or-pat' }),
        getConfig: vi.fn().mockResolvedValue({}),
        setConnected: vi.fn(),
      } as never,
      settingsStore: settingsStoreStub() as never,
      assistantConnectorGrantsStore: grantsStore as never,
      keepBuiltinsDirect,
    })
    return tools
  }

  it('does not inject an ungranted gmailSendMessage', async () => {
    const tools = await injectWith([
      { id: 'ci-gm1', connectorId: 'gmail', name: 'Gmail', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
    ])
    expect(tools.has('gmailSendMessage')).toBe(false)
    expect(grantsStore.getForAssistantSystem).toHaveBeenCalledWith('a-1', 'gmail')
  })

  it('does not inject an ungranted googleTasksCreateTask', async () => {
    const tools = await injectWith([
      { id: 'ci-gc1', connectorId: 'gcal', name: 'Google Calendar', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
    ])
    expect(tools.has('googleTasksCreateTask')).toBe(false)
  })

  it('does not inject an ungranted githubCreateIssue', async () => {
    const tools = await injectWith([
      { id: 'ci-gh1', connectorId: 'github', name: 'GitHub', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
    ])
    expect(tools.has('githubCreateIssue')).toBe(false)
    expect(grantsStore.getForAssistantSystem).toHaveBeenCalledWith('a-1', 'github')
  })

  it('keeps an ungranted Calendar write out of mcp_search discovery', async () => {
    const tools = await injectWith([
      { id: 'ci-gc1', connectorId: 'gcal', name: 'Google Calendar', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
    ], false)
    const search = tools.get('mcp_search') as { execute: (i: unknown, c: unknown) => Promise<{ data: unknown }> }
    const hits = await search.execute({ query: 'create calendar event', limit: 8 }, {} as never)

    expect(JSON.stringify(hits.data)).not.toContain('googleCalendarCreateEvent')
    expect(JSON.stringify(hits.data)).toContain('googleCalendarListEvents')
  })

  it('keeps an explicitly granted write discoverable through mcp_search', async () => {
    grantsStore.getForAssistantSystem.mockResolvedValue({
      id: 'g-1', assistantId: 'a-1', connectorId: 'gcal', readAllowed: true,
      allowedActions: ['googleCalendarCreateEvent'], grantedByUserId: 'u-1',
      grantedAt: new Date(), updatedAt: new Date(),
    })
    const tools = new Map()
    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: {
        list: vi.fn().mockResolvedValue([
          { id: 'ci-gc1', connectorId: 'gcal', name: 'Google Calendar', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
        ]),
        getCredentials: vi.fn().mockResolvedValue({ client_id: 'google_refresh', client_secret: 'refresh-primary' }),
        getConfig: vi.fn().mockResolvedValue({}),
        setConnected: vi.fn(),
      } as never,
      settingsStore: settingsStoreStub() as never,
      assistantConnectorGrantsStore: grantsStore as never,
      keepBuiltinsDirect: false,
    })

    const search = tools.get('mcp_search') as { execute: (i: unknown, c: unknown) => Promise<{ data: unknown }> }
    const hits = await search.execute({ query: 'create calendar event', limit: 8 }, {} as never)
    expect(JSON.stringify(hits.data)).toContain('googleCalendarCreateEvent')
  })

  it('does not let a provider grant expose a sibling Calendar account write', async () => {
    grantsStore.getForAssistantSystem.mockImplementation(async (_assistantId: string, connectorId: string) =>
      connectorId === 'gcal'
        ? {
            id: 'g-primary', assistantId: 'a-1', connectorId: 'gcal', readAllowed: true,
            allowedActions: ['googleCalendarCreateEvent'], grantedByUserId: 'u-1',
            grantedAt: new Date(), updatedAt: new Date(),
          }
        : null,
    )
    const tools = new Map()
    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: {
        list: vi.fn().mockResolvedValue([
          { id: 'ci-gc1', connectorId: 'gcal', name: 'Personal', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
          { id: 'ci-gc2', connectorId: 'gcal', name: 'Work', connected: true, url: null, custom: false, createdAt: new Date('2026-02-01T00:00:00Z') },
        ]),
        getCredentials: vi.fn().mockResolvedValue({ client_id: 'google_refresh', client_secret: 'refresh-primary' }),
        getConfig: vi.fn().mockResolvedValue({}),
        setConnected: vi.fn(),
      } as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: {
        getCredentialsSystem: vi.fn(async (id: string) => ({ client_id: 'google_refresh', client_secret: `refresh-${id}` })),
        updateCredentialsSystem: vi.fn(),
        markHealth: vi.fn(),
      } as never,
      assistantConnectorGrantsStore: grantsStore as never,
      keepBuiltinsDirect: true,
    })

    expect(tools.has('googleCalendarCreateEvent')).toBe(true)
    expect([...tools.keys()].some((name) => name.startsWith('googleCalendarCreateEvent__'))).toBe(false)
    expect([...tools.keys()].some((name) => name.startsWith('googleCalendarListEvents__'))).toBe(true)
  })
})

describe('[COMP:api/mcp-inject] grant overlay instance binding', () => {
  // Incident 2026-07-08 (fls.com.hk): a workspace assistant sent mail from a
  // PERSONAL Gmail that was never exposed to the workspace. The team-grant
  // overlay gated injection on the connector_grant existing, but resolved the
  // refresh token via connectorStore.getCredentials(grantor, 'gmail') =
  // `ORDER BY created_at ASC LIMIT 1` — the grantor's OLDEST connected Gmail,
  // i.e. the personal account — instead of binding to the GRANTED instance.
  beforeEach(() => {
    getConnectorConfig.mockImplementation((provider: string) =>
      provider === 'google' ? { clientId: 'app-id', clientSecret: 'app-secret' } : undefined,
    )
    refreshGoogleAccessToken.mockClear()
  })
  afterEach(() => {
    getConnectorConfig.mockReset()
    getConnectorConfig.mockReturnValue(undefined)
  })

  function stores() {
    // getCredentials returns the PERSONAL (oldest-by-created_at) refresh token —
    // the legacy provider-wide path the fix must NOT take.
    const connectorStore = {
      list: vi.fn().mockResolvedValue([
        { id: 'ci-gm-personal', connectorId: 'gmail', name: 'Gmail', connected: true, url: null, custom: false, createdAt: new Date('2026-04-14T00:00:00Z') },
        { id: 'ci-gm-exposed', connectorId: 'gmail', name: 'hinson.wong@deltadefi.io', connected: true, url: null, custom: false, createdAt: new Date('2026-07-07T00:00:00Z') },
        // A connected but UNGRANTED sibling Google service (Calendar).
        { id: 'ci-gc-personal', connectorId: 'gcal', name: 'Google Calendar', connected: true, url: null, custom: false, createdAt: new Date('2026-04-14T00:00:00Z') },
      ]),
      getCredentials: vi.fn().mockResolvedValue({ client_id: 'google_refresh', client_secret: 'refresh-PERSONAL-oldest' }),
      getConfig: vi.fn().mockResolvedValue({}),
      setConnected: vi.fn(),
    }
    // getCredentialsSystem is instance-bound: token = refresh-<instanceId>.
    const connectorInstanceStore = {
      getCredentialsSystem: vi.fn(async (id: string) => ({ client_id: 'google_refresh', client_secret: `refresh-${id}` })),
      updateCredentialsSystem: vi.fn(),
      markHealth: vi.fn(),
      // No team-native rows — the grant overlay is the only Google source.
      listByWorkspaceSystem: vi.fn().mockResolvedValue([]),
    }
    const connectorGrantStore = {
      listForTargetSystem: vi.fn().mockResolvedValue([
        {
          grantedByUserId: 'grantor-1',
          instance: {
            id: 'ci-gm-exposed', scope: 'user', userId: 'grantor-1', workspaceId: null,
            provider: 'gmail', label: 'hinson.wong@deltadefi.io', url: null, custom: false,
            connected: true, healthStatus: 'ok', config: {}, sensitivity: 'internal',
          },
        },
      ]),
    }
    return { connectorStore, connectorInstanceStore, connectorGrantStore }
  }

  it('sends from the GRANTED instance, never the grantor\'s oldest personal account', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore, connectorGrantStore } = stores()

    await injectMcpTools({
      userId: 'owner-1',
      assistantId: 'a-1',
      tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-fls',
      keepBuiltinsDirect: true,
    })

    // Gmail tools ARE injected (the grant exists)...
    expect([...tools.keys()]).toContain('gmailSendMessage')
    // ...bound to the exposed instance's credentials, resolved by instance id.
    expect(connectorInstanceStore.getCredentialsSystem).toHaveBeenCalledWith('ci-gm-exposed')
    const exchanged = refreshGoogleAccessToken.mock.calls.map((c) => c[0])
    expect(exchanged).toContain('refresh-ci-gm-exposed')
    // The personal (oldest) account's token was NEVER exchanged — the leak.
    expect(exchanged).not.toContain('refresh-PERSONAL-oldest')
    expect(exchanged).not.toContain('refresh-ci-gm-personal')
  })

  it('does not let an ungranted sibling Google service ride along on a granted one', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore, connectorGrantStore } = stores()

    await injectMcpTools({
      userId: 'owner-1',
      assistantId: 'a-1',
      tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-fls',
      keepBuiltinsDirect: true,
    })

    const names = [...tools.keys()]
    // Only Gmail was granted — the connected-but-ungranted Calendar must not appear.
    expect(names).toContain('gmailSendMessage')
    expect(names.some((n) => n.startsWith('googleCalendar'))).toBe(false)
    expect(names.some((n) => n.startsWith('googleTasks'))).toBe(false)
  })

  it('injects every exposed Gmail account and honors an exact extra-account enable switch', async () => {
    const { connectorStore, connectorInstanceStore, connectorGrantStore } = stores()
    connectorGrantStore.listForTargetSystem.mockResolvedValue([
      {
        grantedByUserId: 'grantor-1',
        instance: {
          id: 'ci-gm-exposed', provider: 'gmail', label: 'Personal Gmail',
          connectedEmail: 'personal@example.com', connected: true, healthStatus: 'ok',
          custom: false, url: null, createdAt: new Date('2026-07-01T00:00:00Z'),
        },
      },
      {
        grantedByUserId: 'grantor-1',
        instance: {
          id: 'ci-gm-work', provider: 'gmail', label: 'Work Gmail',
          connectedEmail: 'work@example.com', connected: true, healthStatus: 'ok',
          custom: false, url: null, createdAt: new Date('2026-07-02T00:00:00Z'),
        },
      },
    ])
    const assistantConnectorStore = {
      isEnabled: vi.fn().mockResolvedValue(true),
    }
    const tools = new Map()

    await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      assistantConnectorStore: assistantConnectorStore as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-fls', keepBuiltinsDirect: true,
    })

    const names = [...tools.keys()] as string[]
    expect(names).toContain('gmailSendMessage')
    const variant = names.find((name) => name.startsWith('gmailSendMessage__'))
    expect(variant).toBeTruthy()
    expect((tools.get(variant!) as { description: string }).description).toMatch(/^\[Work Gmail\]/)
    expect(assistantConnectorStore.isEnabled).toHaveBeenCalledWith(
      'a-1', 'gmail:ci-gm-work', 'gmail',
    )

    assistantConnectorStore.isEnabled.mockImplementation(async (
      _assistantId: string,
      connectorId: string,
    ) => connectorId !== 'gmail:ci-gm-work')
    const disabledTools = new Map()
    await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools: disabledTools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      assistantConnectorStore: assistantConnectorStore as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-fls', keepBuiltinsDirect: true,
    })
    expect([...disabledTools.keys()].some((name) => String(name).startsWith('gmailSendMessage__'))).toBe(false)

    // Exact account switches are independent in both directions: disabling
    // the canonical account must not hide a secondary account that has an
    // explicit enabled row.
    assistantConnectorStore.isEnabled.mockImplementation(async (
      _assistantId: string,
      connectorId: string,
    ) => connectorId !== 'gmail')
    const extraOnlyTools = new Map()
    await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools: extraOnlyTools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      assistantConnectorStore: assistantConnectorStore as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-fls', keepBuiltinsDirect: true,
    })
    expect(extraOnlyTools.has('gmailSendMessage')).toBe(false)
    expect([...extraOnlyTools.keys()].some((name) => String(name).startsWith('gmailSendMessage__'))).toBe(true)
  })

  it('injects every exposed GitHub account as an exact-credential variant', async () => {
    const connectorStore = {
      list: vi.fn().mockResolvedValue([
        { id: 'ci-gh-primary', connectorId: 'github', name: 'GitHub - hinson', connected: true, createdAt: new Date('2026-07-01T00:00:00Z') },
        { id: 'ci-gh-work', connectorId: 'github', name: 'GitHub - brian', connected: true, createdAt: new Date('2026-07-02T00:00:00Z') },
      ]),
    }
    const connectorInstanceStore = {
      getCredentialsSystem: vi.fn(async (id: string) => ({ client_id: 'github_pat', client_secret: `pat-${id}` })),
      updateCredentialsSystem: vi.fn(), markHealth: vi.fn(),
      listByWorkspaceSystem: vi.fn().mockResolvedValue([]),
    }
    const connectorGrantStore = {
      listForTargetSystem: vi.fn().mockResolvedValue([
        { grantedByUserId: 'grantor-1', instance: { id: 'ci-gh-primary', provider: 'github', label: 'GitHub - hinson', connected: true, healthStatus: 'ok', custom: false, url: null, createdAt: new Date('2026-07-01T00:00:00Z') } },
        { grantedByUserId: 'grantor-1', instance: { id: 'ci-gh-work', provider: 'github', label: 'GitHub - brian', connected: true, healthStatus: 'ok', custom: false, url: null, createdAt: new Date('2026-07-02T00:00:00Z') } },
      ]),
    }
    const tools = new Map()

    await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-fls', keepBuiltinsDirect: true,
    })

    const names = [...tools.keys()] as string[]
    expect(names).toContain('githubListIssues')
    expect(names.some((name) => name.startsWith('githubListIssues__'))).toBe(true)
  })
})

describe('[COMP:integrations/connector-health] team-native connector health gate', () => {
  function teamGithub(healthStatus: 'ok' | 'auth_failed') {
    return {
      id: 'ci-ws', scope: 'workspace', userId: null, workspaceId: 'ws-1',
      provider: 'github', label: 'Use Brian', connectedEmail: null, url: null,
      custom: false, config: {}, sensitivity: 'internal', connected: true,
      ingestionEnabled: false, credentialsType: 'oauth', healthStatus,
      lastError: null, lastCheckedAt: null, createdBy: null,
      createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    }
  }
  function makeStores(healthStatus: 'ok' | 'auth_failed') {
    return {
      connectorStore: { list: vi.fn().mockResolvedValue([]), getCredentials: vi.fn().mockResolvedValue(null) },
      connectorInstanceStore: {
        listByWorkspaceSystem: vi.fn().mockResolvedValue([teamGithub(healthStatus)]),
        getCredentialsSystem: vi.fn().mockResolvedValue({ client_id: 'github_pat', client_secret: 'pat-ws' }),
        getAuthCredentialsSystem: vi.fn().mockResolvedValue(null),
        markHealth: vi.fn(),
      },
    }
  }

  it('injects a healthy team-native GitHub connector (no reconnect notice)', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore } = makeStores('ok')
    const result = await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      assistantTeamId: 'ws-1',
      keepBuiltinsDirect: true,
    })
    expect([...tools.keys()]).toContain('githubSearchRepositories')
    expect(result.unavailable.some((u) => /stopped working/i.test(u))).toBe(false)
  })

  it('skips a dead team-native GitHub connector and tells the model to reconnect', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore } = makeStores('auth_failed')
    const result = await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      assistantTeamId: 'ws-1',
      keepBuiltinsDirect: true,
    })
    expect([...tools.keys()].some((n) => n.startsWith('githubSearchRepositories'))).toBe(false)
    expect(result.unavailable.some((u) => /stopped working/i.test(u) && /github/i.test(u))).toBe(true)
  })
})

describe('[COMP:api/workspace-tool-policy-store] team-owned connector shared policy', () => {
  function teamGithub() {
    return {
      id: 'ci-ws', scope: 'workspace', userId: null, workspaceId: 'ws-1',
      provider: 'github', label: 'Team GitHub', connectedEmail: null, url: null,
      custom: false, config: {}, sensitivity: 'internal', connected: true,
      ingestionEnabled: false, credentialsType: 'oauth', healthStatus: 'ok',
      lastError: null, lastCheckedAt: null, createdBy: null,
      createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    }
  }
  function stores() {
    return {
      connectorStore: { list: vi.fn().mockResolvedValue([]), getCredentials: vi.fn().mockResolvedValue(null) },
      connectorInstanceStore: {
        listByWorkspaceSystem: vi.fn().mockResolvedValue([teamGithub()]),
        getCredentialsSystem: vi.fn().mockResolvedValue({ client_id: 'github_pat', client_secret: 'pat-ws' }),
        getAuthCredentialsSystem: vi.fn().mockResolvedValue(null),
        markHealth: vi.fn(),
      },
    }
  }

  it('resolves a team-owned tool policy from workspace_tool_policy, not the per-user store', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore } = stores()
    // The per-user store would ALLOW (stub returns undefined → default), but the
    // workspace policy BLOCKS this tool — the shared policy must win.
    const workspaceToolPolicyStore = {
      getPolicy: vi.fn().mockImplementation(async (_ws: string, _server: string, tool: string) =>
        tool === 'githubSearchRepositories'
          ? { id: 'p1', workspaceId: 'ws-1', serverName: 'github', toolName: tool, policy: 'block', classification: 'read', updatedBy: 'u-x', updatedAt: new Date() }
          : null,
      ),
      setPolicy: vi.fn(),
      listForWorkspace: vi.fn().mockResolvedValue([]),
    }
    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      workspaceToolPolicyStore: workspaceToolPolicyStore as never,
      assistantTeamId: 'ws-1',
      keepBuiltinsDirect: true,
    })
    // The workspace store was consulted, and its `block` excluded the tool.
    expect(workspaceToolPolicyStore.getPolicy).toHaveBeenCalledWith('ws-1', 'github', 'githubSearchRepositories')
    expect([...tools.keys()]).not.toContain('githubSearchRepositories')
  })
})

describe('[COMP:api/mcp-inject] Microsoft Graph (msgraph) built-in', () => {
  // Read-only Teams tools over a rotating-refresh-token credential. Unlike
  // github/notion/fathom there is no extras path: `msgraph` is
  // `single_instance` in OFFICIAL_CONNECTORS, so a second account can never
  // reach the injector. See docs/architecture/integrations/msgraph.md.
  const MSGRAPH_TOOLS = [
    'msTeamsListTeams',
    'msTeamsListChannels',
    'msTeamsReadChannelMessages',
    'msTeamsReadThreadReplies',
    'msTeamsListChats',
    'msTeamsReadChatMessages',
    'msTeamsSearchMessages',
    'msTeamsListMembers',
    'msTeamsFindPerson',
  ]

  function msgraphStore(connected: boolean, credentials?: string) {
    return {
      list: vi.fn().mockResolvedValue([
        { id: 'ci-ms', connectorId: 'msgraph', name: 'Microsoft Teams', connected, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
      ]),
      getCredentials: vi.fn().mockResolvedValue({
        client_id: 'msgraph_oauth',
        client_secret: credentials ?? JSON.stringify({
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      }),
      upsert: vi.fn(),
    }
  }

  async function inject(opts: {
    connected?: boolean
    settingsStore?: unknown
    /** Override the stored envelope (e.g. one carrying a workspace app pair). */
    credentials?: string
  } = {}): Promise<{ tools: Map<string, unknown>; unavailable: string[] }> {
    const tools = new Map()
    const result = await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools,
      connectorStore: msgraphStore(opts.connected ?? true, opts.credentials) as never,
      settingsStore: (opts.settingsStore ?? settingsStoreStub()) as never,
      keepBuiltinsDirect: true,
    })
    return { tools, unavailable: result.unavailable }
  }

  beforeEach(() => {
    getConnectorConfig.mockImplementation((provider: string) =>
      provider === 'msgraph' ? { clientId: 'entra-app', clientSecret: 'entra-secret' } : undefined,
    )
  })
  afterEach(() => {
    getConnectorConfig.mockReset()
    getConnectorConfig.mockReturnValue(undefined)
  })

  it('injects all nine read-only Teams tools when connected and enabled', async () => {
    const { tools } = await inject()
    for (const name of MSGRAPH_TOOLS) expect([...tools.keys()], name).toContain(name)
  })

  it('injects nothing and announces the gap when the connector is disconnected', async () => {
    const { tools, unavailable } = await inject({ connected: false })
    for (const name of MSGRAPH_TOOLS) expect(tools.has(name)).toBe(false)
    expect(unavailable.join('\n')).toMatch(/Microsoft Teams: not connected/)
  })

  it('no-ops entirely on a connector-less boot', async () => {
    // Open single-player: no MSGRAPH_CLIENT_ID/SECRET and nothing connected.
    // Silent — not even a not-connected notice, since nothing could connect.
    getConnectorConfig.mockReturnValue(undefined)
    const { tools, unavailable } = await inject({ connected: false })
    for (const name of MSGRAPH_TOOLS) expect(tools.has(name)).toBe(false)
    expect(unavailable.join('\n')).not.toMatch(/Microsoft Teams/)
  })

  /**
   * Deployment config is no longer the GATE, only a fallback: a workspace that
   * registered its own Entra app (migration 394) connects through an app this
   * process has no env var for, and the pair rides in the grant envelope so
   * the refresh path can find it without a workspace id.
   */
  it('injects a workspace-owned connection with no deployment config at all', async () => {
    getConnectorConfig.mockReturnValue(undefined)
    const { tools } = await inject({
      credentials: packMsGraphTokens({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        appClientId: 'ws-client',
        appClientSecret: 'ws-secret',
      }),
    })
    for (const name of MSGRAPH_TOOLS) expect([...tools.keys()], name).toContain(name)
  })

  /**
   * Connected, but nothing can rotate the token — a self-host that removed its
   * env config after users connected. Injecting tools that would all fail at
   * the first refresh is worse than saying the connector is unavailable.
   */
  it('announces the gap when a connected grant has no app to refresh it', async () => {
    getConnectorConfig.mockReturnValue(undefined)
    const { tools, unavailable } = await inject()
    for (const name of MSGRAPH_TOOLS) expect(tools.has(name)).toBe(false)
    expect(unavailable.join('\n')).toMatch(/Microsoft Teams: not connected/)
  })

  it('lands blocked tools in unavailable[] instead of the tool map', async () => {
    const blockAll = {
      getPolicy: vi.fn(async ({ toolName }: { toolName: string }) =>
        toolName.startsWith('msTeams') ? { policy: 'block' } : undefined,
      ),
    }
    const { tools, unavailable } = await inject({ settingsStore: blockAll })
    for (const name of MSGRAPH_TOOLS) {
      expect(tools.has(name), name).toBe(false)
      expect(unavailable).toContain(`${name} (blocked by policy)`)
    }
  })

  it('is single_instance, so a second connected instance produces no variant tools', async () => {
    const tools = new Map()
    const connectorStore = {
      list: vi.fn().mockResolvedValue([
        { id: 'ci-ms1', connectorId: 'msgraph', name: 'Microsoft Teams', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
        { id: 'ci-ms2', connectorId: 'msgraph', name: 'Second', connected: true, url: null, custom: false, createdAt: new Date('2026-02-01T00:00:00Z') },
      ]),
      getCredentials: vi.fn().mockResolvedValue({ client_id: 'msgraph_oauth', client_secret: '{}' }),
      upsert: vi.fn(),
    }
    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: {
        getCredentialsSystem: vi.fn(), updateCredentialsSystem: vi.fn(), markHealth: vi.fn(),
      } as never,
      keepBuiltinsDirect: true,
    })
    expect([...tools.keys()]).toContain('msTeamsListTeams')
    expect([...tools.keys()].some((n) => n.startsWith('msTeamsListTeams__'))).toBe(false)
  })

  it('registers its tools in the drift-sweep table so local tool search can see them', async () => {
    // The INJECTED_BUILTIN_TOOLS_BY_CONNECTOR entry is what turns injected
    // tools into an mcp_search local source — omitting it injects tools the
    // model can never find. Assert the fold, not just the constant.
    expect(INJECTED_BUILTIN_TOOLS_BY_CONNECTOR.msgraph).toEqual(MSGRAPH_TOOLS)

    const tools = new Map()
    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: msgraphStore(true) as never,
      settingsStore: settingsStoreStub() as never,
      keepBuiltinsDirect: false,
    })
    // Folded out of the direct map, reachable through mcp_search.
    expect(tools.has('msTeamsListTeams')).toBe(false)
    expect(tools.has('mcp_search')).toBe(true)
    const searchTool = tools.get('mcp_search') as { execute: (i: unknown, c: unknown) => Promise<{ data: unknown }> }
    const hit = await searchTool.execute({ query: 'teams channel messages' }, {} as never)
    expect(JSON.stringify(hit.data)).toContain('msTeamsReadChannelMessages')
  })
})

describe('[COMP:api/mcp-inject] msgraph workspace overlays', () => {
  // The suite above exercises the PERSONAL-assistant path (no assistantTeamId),
  // which base-loads the owner's connectors. Every assistant that a user
  // actually chats with is workspace-scoped, and the workspace connector-scoping
  // gate suppresses that base load entirely — so for a real assistant the two
  // overlays (member-exposure grant, team-native instance) are the ONLY source
  // of msgraph tools. A provider missing from the overlay branch chains is
  // connected, healthy, and governable in Studio while being invisible at
  // runtime. See docs/architecture/integrations/mcp.md → "Workspace connector
  // scoping" and integrations/msgraph.md §7.
  const PROBE_TOOLS = ['msTeamsListTeams', 'msTeamsSearchMessages', 'msTeamsFindPerson']

  /** A live (unexpired) tuple, so getAccessToken short-circuits the refresh. */
  function packed(refreshToken: string): string {
    return JSON.stringify({
      accessToken: `access-${refreshToken}`,
      refreshToken,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
  }

  const exposedInstance = {
    id: 'ci-ms-exposed', scope: 'user', userId: 'grantor-1', workspaceId: null,
    provider: 'msgraph', label: 'Microsoft Teams', url: null, custom: false,
    connected: true, healthStatus: 'ok', config: {}, sensitivity: 'internal',
    updatedAt: new Date('2026-07-28T00:00:00Z'),
  }

  function stores() {
    const connectorStore = {
      // The grantor's dual-written mcp_connectors row + a DECOY older personal
      // instance: provider-wide credential lookup would pick the decoy.
      list: vi.fn().mockResolvedValue([
        { id: 'ci-ms-personal', connectorId: 'msgraph', name: 'Personal Teams', connected: true, url: null, custom: false, createdAt: new Date('2026-01-01T00:00:00Z') },
        { id: 'ci-ms-exposed', connectorId: 'msgraph', name: 'Microsoft Teams', connected: true, url: null, custom: false, createdAt: new Date('2026-07-28T00:00:00Z') },
      ]),
      getCredentials: vi.fn().mockResolvedValue({ client_id: 'msgraph_oauth', client_secret: packed('refresh-PERSONAL-oldest') }),
      upsert: vi.fn(),
    }
    const connectorInstanceStore = {
      getCredentialsSystem: vi.fn(async (id: string) => ({ client_id: 'msgraph_oauth', client_secret: packed(`refresh-${id}`) })),
      updateCredentialsSystem: vi.fn(),
      markHealth: vi.fn(),
      listByWorkspaceSystem: vi.fn().mockResolvedValue([]),
    }
    const connectorGrantStore = {
      listForTargetSystem: vi.fn().mockResolvedValue([]),
    }
    return { connectorStore, connectorInstanceStore, connectorGrantStore }
  }

  beforeEach(() => {
    msGraphTokenResolvers.length = 0
    getConnectorConfig.mockImplementation((provider: string) =>
      provider === 'msgraph' ? { clientId: 'entra-app', clientSecret: 'entra-secret' } : undefined,
    )
  })
  afterEach(() => {
    getConnectorConfig.mockReset()
    getConnectorConfig.mockReturnValue(undefined)
  })

  it('injects Teams tools for a workspace assistant through a member-exposure grant', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore, connectorGrantStore } = stores()
    connectorGrantStore.listForTargetSystem.mockResolvedValue([
      { grantedByUserId: 'grantor-1', instance: exposedInstance },
    ])

    await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-1',
      keepBuiltinsDirect: true,
    })

    for (const name of PROBE_TOOLS) expect([...tools.keys()], name).toContain(name)
  })

  it('binds the granted connector to the EXPOSED instance, not the grantor\'s oldest account', async () => {
    // Same rule as the 2026-07-08 Gmail incident: gating on the grant while
    // resolving credentials provider-wide picks the grantor's oldest connected
    // account, which may never have been exposed to this workspace.
    const tools = new Map()
    const { connectorStore, connectorInstanceStore, connectorGrantStore } = stores()
    connectorGrantStore.listForTargetSystem.mockResolvedValue([
      { grantedByUserId: 'grantor-1', instance: exposedInstance },
    ])

    await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-1',
      keepBuiltinsDirect: true,
    })

    expect(msGraphTokenResolvers.length).toBeGreaterThan(0)
    const token = await msGraphTokenResolvers[msGraphTokenResolvers.length - 1]!()
    expect(token).toBe('access-refresh-ci-ms-exposed')
    expect(connectorInstanceStore.getCredentialsSystem).toHaveBeenCalledWith('ci-ms-exposed')
  })

  it('announces a reconnect instead of injecting when the granted instance is dead', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore, connectorGrantStore } = stores()
    connectorGrantStore.listForTargetSystem.mockResolvedValue([
      { grantedByUserId: 'grantor-1', instance: { ...exposedInstance, healthStatus: 'auth_failed' } },
    ])

    const result = await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-1',
      keepBuiltinsDirect: true,
    })

    expect(tools.has('msTeamsListTeams')).toBe(false)
    // The reconnect wording specifically — a bare "Microsoft Teams" match also
    // passes on the not-connected notice the suppressed base load emits, which
    // is what this suite exists to distinguish.
    expect(result.unavailable.join('\n')).toMatch(/Microsoft Teams .*credentials failed/)
  })

  it('retracts the base pass\'s not-connected advert once the grant overlay injects', async () => {
    // The advert and the tools shipped together before this: the model held
    // nine Teams tools while Layer-1 context said Teams was not connected, and
    // answered from the advert ("it has no interactive tools I can call").
    const tools = new Map()
    const { connectorStore, connectorInstanceStore, connectorGrantStore } = stores()
    connectorGrantStore.listForTargetSystem.mockResolvedValue([
      { grantedByUserId: 'grantor-1', instance: exposedInstance },
    ])

    const result = await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-1',
      keepBuiltinsDirect: true,
    })

    expect([...tools.keys()]).toContain('msTeamsListTeams')
    expect(result.unavailable.join('\n')).not.toMatch(/Microsoft Teams: not connected/)
    // Providers that genuinely did not inject keep their advert.
    expect(result.unavailable.join('\n')).toMatch(/GitHub: not connected/)
  })

  it('injects Teams tools for a team-native (workspace-scoped) msgraph instance', async () => {
    const tools = new Map()
    const { connectorStore, connectorInstanceStore, connectorGrantStore } = stores()
    connectorInstanceStore.listByWorkspaceSystem.mockResolvedValue([
      {
        id: 'ci-ms-team', scope: 'workspace', userId: null, workspaceId: 'ws-1',
        provider: 'msgraph', label: 'Company Teams', url: null, custom: false,
        connected: true, healthStatus: 'ok', config: {}, sensitivity: 'internal',
        updatedAt: new Date('2026-07-28T00:00:00Z'),
      },
    ])

    await injectMcpTools({
      userId: 'owner-1', assistantId: 'a-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
      assistantTeamId: 'ws-1',
      keepBuiltinsDirect: true,
    })

    for (const name of PROBE_TOOLS) expect([...tools.keys()], name).toContain(name)
    const token = await msGraphTokenResolvers[msGraphTokenResolvers.length - 1]!()
    expect(token).toBe('access-refresh-ci-ms-team')
  })
})

describe('[COMP:api/mcp-inject] _getMcpDiscoveryCacheSize', () => {
  it('reports the discovery-cache size as a non-negative number', () => {
    const size = _getMcpDiscoveryCacheSize()
    expect(typeof size).toBe('number')
    expect(size).toBeGreaterThanOrEqual(0)
  })
})

describe('[COMP:api/mcp-inject] built-in fold vs direct (keepBuiltinsDirect)', () => {
  // The contract a workflow `assistant_call` step's `tools` allow-list depends
  // on. With the flag OFF, a built-in connector tool is DELETED from the map
  // and reachable only through `mcp_search` — so pinning it by name resolves to
  // nothing. The callee sets the flag whenever the caller pins an allow-list;
  // this suite is what makes that safe to rely on.
  function githubConnector() {
    return {
      list: vi.fn().mockResolvedValue([
        { id: 'ci-1', connectorId: 'github', name: 'GitHub', connected: true, createdAt: new Date(0) },
      ]),
      getCredentials: vi.fn().mockResolvedValue({ client_secret: 'ghp_test' }),
    }
  }

  async function injectWith(keepBuiltinsDirect: boolean) {
    const tools = new Map()
    await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools,
      connectorStore: githubConnector() as never,
      settingsStore: settingsStoreStub() as never,
      keepBuiltinsDirect,
    })
    return tools
  }

  it('keeps githubListPullRequests under its own name when direct', async () => {
    const tools = await injectWith(true)
    expect(tools.has('githubListPullRequests')).toBe(true)
    expect(tools.has('githubGetPullRequest')).toBe(true)
  })

  it('folds it behind mcp_search when NOT direct (why a pinned name resolved to nothing)', async () => {
    const tools = await injectWith(false)
    expect(tools.has('githubListPullRequests')).toBe(false)
    expect(tools.has('mcp_search')).toBe(true)
    expect(tools.has('mcp_call')).toBe(true)
  })

  // ── The prod failure this fold caused (2026-07-23) ────────────────
  // Composed against the REAL injector, because the bug lives in the gap
  // between two individually-correct halves: the pluck (above) and the
  // closed-world prompt. TaskMaster held a live github grant, saw
  // ["mcp_search","mcp_call"] as its whole tool map, read a system prompt
  // asserting that map plus the unavailable list was the complete
  // integration surface, and denied a GitHub write it was authorized for.
  describe('closed-world prompt vs the folded surface', () => {
    it('never leaves a connected connector in neither the tool map nor the unavailable list without a search order', async () => {
      // ONE injector run supplies BOTH halves — the map and the unavailable
      // list have to come from the same turn or the composition proves nothing.
      const tools = new Map()
      const result = await injectMcpTools({
        userId: 'u-1',
        assistantId: 'a-1',
        tools,
        connectorStore: githubConnector() as never,
        settingsStore: settingsStoreStub() as never,
        keepBuiltinsDirect: false,
      })

      // Guard the guard: an empty list would make the github assertion below
      // vacuous, and this turn genuinely adverts other disconnected providers.
      expect(result.unavailable.length).toBeGreaterThan(0)
      // github is connected, so it is correctly absent from `unavailable`...
      expect(result.unavailable.some((u) => /github/i.test(u))).toBe(false)
      // ...and plucked, so it is absent from the visible tool map too.
      expect([...tools.keys()].some((n) => /^github/i.test(n))).toBe(false)
      expect(tools.has('mcp_search')).toBe(true)

      // Which means the prompt must NOT treat those two sets as exhaustive.
      const prompt = buildUnavailableCapabilitiesPrompt(result.unavailable, tools)
      expect(prompt).not.toContain('This list plus your tools is the complete integration surface')
      expect(prompt).toContain('mcp_search')
    })

    it('still emits the search order when every connector is healthy (empty unavailable list)', async () => {
      const tools = await injectWith(false)
      const prompt = buildUnavailableCapabilitiesPrompt([], tools)
      expect(prompt).toContain('mcp_search')
    })
  })
})
