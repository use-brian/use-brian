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

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Built-in connector injectors resolve their OAuth app creds via
// getConnectorConfig and no-op when none are configured — stub it to undefined
// so the no-connector path is inert regardless of the runner's process.env.
vi.mock('../../connector-config.js', () => ({
  getConnectorConfig: () => undefined,
}))

// The workspace-scoping gate calls `isSoloWorkspaceSystem`; mock the
// store module so the test never touches the DB client. Default to `false`
// (suppress — shared or multi-member) — individual tests override per case.
const isSoloWorkspaceSystem = vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(false)
vi.mock('../../db/workspace-store.js', () => ({
  isSoloWorkspaceSystem: (id: string) => isSoloWorkspaceSystem(id),
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

import {
  injectMcpTools,
  INJECTED_BUILTIN_TOOLS_BY_CONNECTOR,
  _getMcpDiscoveryCacheSize,
} from '../inject.js'

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
  // Reset only the discovery stubs — leave isSoloWorkspaceSystem's
  // default `false` intact (a blanket clearAllMocks would wipe it).
  discoverMcpServer.mockReset()
  callRemoteMcpTool.mockReset()
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

describe('[COMP:api/mcp-inject] workspace connector-scoping gate', () => {
  // Regression guard for the 2026-06-01 cross-member leak: a shared
  // (non-personal) workspace assistant must NOT load the workspace owner's
  // personal connectors. The base `connectorStore.list(userId)` load is the
  // leak source, so we assert whether it is called per workspace kind.

  function listSpy() {
    return vi.fn().mockResolvedValue([])
  }

  it('SHARED / multi-member workspace: does NOT load the owner-personal connector base', async () => {
    // The gate returns false for any workspace with more than one member
    // (member count > 1), regardless of is_personal.
    isSoloWorkspaceSystem.mockResolvedValueOnce(false)
    const list = listSpy()
    await injectMcpTools({
      userId: 'owner-1',
      assistantId: 'a-1',
      tools: new Map(),
      connectorStore: { list } as never,
      settingsStore: settingsStoreStub() as never,
      assistantTeamId: 'ws-shared',
    })
    expect(isSoloWorkspaceSystem).toHaveBeenCalledWith('ws-shared')
    expect(list).not.toHaveBeenCalled()
  })

  it('SOLO personal workspace: DOES load the owner-personal connector base', async () => {
    isSoloWorkspaceSystem.mockResolvedValueOnce(true)
    const list = listSpy()
    await injectMcpTools({
      userId: 'owner-1',
      assistantId: 'a-1',
      tools: new Map(),
      connectorStore: { list } as never,
      settingsStore: settingsStoreStub() as never,
      assistantTeamId: 'ws-personal',
    })
    expect(isSoloWorkspaceSystem).toHaveBeenCalledWith('ws-personal')
    expect(list).toHaveBeenCalledWith('owner-1')
  })

  it('no workspace (personal assistant): loads the connector base without a gate check', async () => {
    isSoloWorkspaceSystem.mockClear()
    const list = listSpy()
    await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools: new Map(),
      connectorStore: { list } as never,
      settingsStore: settingsStoreStub() as never,
    })
    expect(isSoloWorkspaceSystem).not.toHaveBeenCalled()
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
    isSoloWorkspaceSystem.mockResolvedValueOnce(false) // shared workspace
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
    isSoloWorkspaceSystem.mockResolvedValueOnce(false)
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
      'X-Sidanclaw-Actor-Channel': 'web',
      'X-Sidanclaw-User-Id': 'u-actor-1',
      'X-Sidanclaw-Actor-Id': 'ceo@corp.com',
      'X-Sidanclaw-Actor-Email': 'ceo@corp.com',
    })
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
      expect.arrayContaining(['gcal', 'gmail', 'gdrive', 'github', 'notion', 'fathom']),
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

describe('[COMP:integrations/connector-health] team-native connector health gate', () => {
  function teamGithub(healthStatus: 'ok' | 'auth_failed') {
    return {
      id: 'ci-ws', scope: 'workspace', userId: null, workspaceId: 'ws-1',
      provider: 'github', label: 'sidanclaw', connectedEmail: null, url: null,
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

describe('[COMP:api/mcp-inject] _getMcpDiscoveryCacheSize', () => {
  it('reports the discovery-cache size as a non-negative number', () => {
    const size = _getMcpDiscoveryCacheSize()
    expect(typeof size).toBe('number')
    expect(size).toBeGreaterThanOrEqual(0)
  })
})
