/**
 * Provider activation (M3 WP2): `createActivation(...).activate(selection)`,
 * the provider modules, and the turn authority, exercised directly rather
 * than through an entrypoint surface.
 * Component tag: [COMP:api/mcp-surface].
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { APP_LEVEL_ASSISTANT_ID, OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'

const runtime = vi.hoisted(() => ({ assertCurrent: vi.fn(async () => {}), allows: vi.fn((_binding: unknown) => true) }))
vi.mock('../../application-platform/connector-runtime-authority.js', () => ({
  createConnectorRuntimeAuthority: async () => ({
    cacheKey: 'fixture',
    allows: (binding: unknown) => runtime.allows(binding),
    assertCurrent: () => runtime.assertCurrent(),
    execute: async (operation: () => Promise<unknown>) => { await runtime.assertCurrent(); return operation() },
  }),
}))
vi.mock('../../connector-config.js', () => ({ getConnectorConfig: () => undefined }))
const discovery = vi.hoisted(() => ({ discoverMcpServer: vi.fn(), callRemoteMcpTool: vi.fn() }))
vi.mock('../client.js', () => ({
  discoverMcpServer: (...args: unknown[]) => discovery.discoverMcpServer(...args),
  callRemoteMcpTool: (...args: unknown[]) => discovery.callRemoteMcpTool(...args),
}))

import {
  applyToolPolicies, connectorBindingFingerprint, connectorBindingKey, createActivation, createTurnAuthority,
  type ProviderRegistry, type TurnAuthority,
} from '../activation.js'
import { PROVIDER_MODULES, type ProviderActivationContext, type ProviderModule } from '../providers/index.js'
import type { GitHubLane } from '../providers/github.js'
import { activateShopifyLane } from '../providers/shopify.js'
import { createDbMcpSettingsStore } from '../../db/mcp-settings-store.js'
import * as db from '../../db/client.js'
import { runLanes } from '../providers/lanes.js'
import { AuthorityChangedError } from '../../context-scope/authority-lease.js'
import { CONNECTOR_SCOPE_RESTRICTION } from '../discovery-diagnostics.js'
import { baseToolName, instanceToolSuffix } from '../tool-names.js'

const GITHUB_ROW = { id: 'ci-a', connectorId: 'github', name: 'GitHub', connected: true, url: null }

function policyStore(policies: Record<string, 'allow' | 'ask' | 'block'> = {}) {
  return {
    getPolicy: vi.fn(async ({ toolName }: { toolName: string }) => (policies[toolName] ? { policy: policies[toolName] } : null)),
  }
}

function makeCtx(overrides: Partial<ProviderActivationContext['stores']> = {}): ProviderActivationContext {
  const settingsStore = policyStore()
  return {
    userId: 'u-1',
    assistantId: 'a-1',
    authority: {
      exposureAllowed: () => true, pinBinding: () => {}, pinAuth: () => {}, assertBindingsCurrent: async () => {},
    },
    stores: {
      connectorStore: { getCredentials: vi.fn(async () => ({ client_id: 'github_pat', client_secret: 'pat-primary' })) } as never,
      settingsStore: settingsStore as never,
      ...overrides,
    },
    attachments: {},
    hosted: {},
    unavailable: [],
  }
}

const noAuthority = { wrapTool: (tool: Tool) => tool, assertActivationCurrent: async () => {} }

function githubLane(lane: Partial<GitHubLane> = {}): GitHubLane {
  return { connectors: [GITHUB_ROW], settingsStore: policyStore() as never, userId: 'u-1', reportUnavailable: true, ...lane }
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  runtime.assertCurrent.mockReset().mockResolvedValue(undefined)
  runtime.allows.mockReset().mockReturnValue(true)
})

describe('[COMP:api/mcp-surface] provider describe()', () => {
  it('describes official families from their factories with registry metadata, without touching any port', () => {
    const names = PROVIDER_MODULES.github.describe().map((descriptor) => descriptor.name)
    expect(names).toEqual(OFFICIAL_CONNECTOR_TOOLS.github!.map((tool) => tool.name))
    const google = PROVIDER_MODULES.google.describe()
    expect(new Set(google.map((descriptor) => descriptor.connectorId))).toEqual(new Set(['gcal', 'gmail', 'gdrive']))
    for (const descriptor of google) {
      expect(descriptor.origin).toBe('static')
      expect(descriptor.requiresConfirmation).toBe(descriptor.defaultPolicy === 'ask')
      expect(descriptor.inputSchema).toEqual({ kind: 'static', family: 'google', toolName: descriptor.name, schema: expect.objectContaining({ type: 'object' }) })
    }
  })

  it('describes knowledge and Maps from their core factories and leaves dynamic families to discovery', () => {
    expect(PROVIDER_MODULES.knowledge.describe().map((d) => d.name)).toEqual(
      ['searchKnowledge', 'browseKnowledge', 'readKnowledgeEntry', 'addKnowledgeEntry', 'updateKnowledgeEntry'],
    )
    expect(PROVIDER_MODULES['google-maps'].describe().map((d) => d.name)).toEqual(
      ['googleMapsSearchPlaces', 'googleMapsLookupWeather', 'googleMapsComputeRoute'],
    )
    expect(PROVIDER_MODULES['remote-mcp'].describe()).toEqual([])
    expect(PROVIDER_MODULES.cli.describe()).toEqual([])
  })
})

describe('[COMP:api/mcp-surface] activate() memoization', () => {
  it('builds one promise per family per turn and reuses it for a later selection', async () => {
    const tool = { name: 'exampleRead', description: 'Example read', requiresConfirmation: false, isReadOnly: true } as Tool
    const activate = vi.fn(async (_ctx: ProviderActivationContext, _instances: unknown) => [tool])
    const providers: ProviderRegistry = { github: { family: 'github', describe: () => [], activate } as ProviderModule<never> }
    const activation = createActivation({ ctx: makeCtx(), authority: noAuthority, providers })
    const [first, second] = await Promise.all([
      activation.activate({ families: [{ family: 'github', instances: ['first'] }] }),
      activation.activate({ families: [{ family: 'github', instances: ['second'] }] }),
    ])
    expect(activate).toHaveBeenCalledTimes(1)
    expect(activate.mock.calls[0]![1]).toEqual(['first'])
    expect(first).toEqual([tool])
    expect(second[0]).toBe(first[0])
    expect(activation.activatedFamilies()).toEqual(['github'])
  })

  it('refuses a family with no registered provider instead of returning an empty surface', async () => {
    const activation = createActivation({ ctx: makeCtx(), authority: noAuthority, providers: {} })
    await expect(activation.activate({ families: [{ family: 'notion', instances: [] }] })).rejects.toThrow(/No provider module/)
  })
})

describe('[COMP:api/mcp-surface] activate() over the GitHub provider', () => {
  const activateGitHub = (ctx: ProviderActivationContext, lanes: GitHubLane[]) =>
    createActivation({ ctx, authority: noAuthority, providers: PROVIDER_MODULES }).activate({ families: [{ family: 'github', instances: lanes }] })

  it('activates canonical tools for the primary and a labelled variant for an extra account', async () => {
    const ctx = makeCtx()
    const tools = await activateGitHub(ctx, [githubLane({
      extraInstances: [{ id: 'ci-b-0000', label: 'Work' }],
      resolveInstanceCreds: async (id) => `pat-${id}`,
    })])
    const names = tools.map((tool) => tool.name)
    expect(names).toContain('githubSearchRepositories')
    const variant = `githubSearchRepositories${instanceToolSuffix('ci-b-0000', 'Work')}`
    expect(names).toContain(variant)
    expect(tools.find((tool) => tool.name === variant)!.description).toMatch(/^\[Work\]/)
    expect(names.filter((name) => baseToolName(name) === 'githubSearchRepositories')).toHaveLength(2)
  })

  it('drops a blocked tool, records the notice, and installs live confirmation for ask', async () => {
    const ctx = makeCtx()
    const lane = githubLane({ settingsStore: policyStore({ githubCreateIssue: 'block', githubSearchRepositories: 'ask' }) as never })
    const tools = await activateGitHub(ctx, [lane])
    expect(tools.some((tool) => tool.name === 'githubCreateIssue')).toBe(false)
    expect(ctx.unavailable).toContain('githubCreateIssue (blocked by policy)')
    const search = tools.find((tool) => tool.name === 'githubSearchRepositories')!
    await expect(search.resolveConfirmation!({} as ToolContext)).resolves.toBe(true)
  })

  it('removes an ungranted write through filterToolsByActionGrants before the tools are returned', async () => {
    const grants = { getForAssistantSystem: vi.fn(async () => null), listForAssistant: vi.fn(), upsert: vi.fn(), delete: vi.fn() }
    const ctx = makeCtx({ assistantConnectorGrantsStore: grants as never })
    const tools = await activateGitHub(ctx, [githubLane()])
    expect(tools.some((tool) => tool.name === 'githubCreateIssue')).toBe(false)
    expect(tools.some((tool) => tool.name === 'githubSearchRepositories')).toBe(true)
    expect(grants.getForAssistantSystem).toHaveBeenCalledWith('a-1', 'github')
  })

  it('reports not-connected only from a reporting lane', async () => {
    const quiet = makeCtx()
    expect(await activateGitHub(quiet, [githubLane({ connectors: [], reportUnavailable: false })])).toEqual([])
    expect(quiet.unavailable).toEqual([])
    const loud = makeCtx()
    await activateGitHub(loud, [githubLane({ connectors: [] })])
    expect(loud.unavailable).toEqual([expect.stringMatching(/^GitHub: not connected for this assistant/)])
  })

  it('lets a superseding workspace lane remove the earlier lanes\' tools for its provider', async () => {
    const tools = await runLanes([githubLane(), githubLane({ connectors: [], reportUnavailable: false, supersedes: ['github'] })],
      (lane) => PROVIDER_MODULES.github.activate(makeCtx(), [lane] as never) as Promise<Tool[]>)
    expect(tools).toEqual([])
  })
})

describe('[COMP:api/mcp-surface] connector policy batch and effect boundary', () => {
  it('reads all Shopify tool settings in one statement and counts connector enablement separately', async () => {
    const policyQuery = vi.spyOn(db, 'query').mockResolvedValue({ rows: [] } as never)
    const isEnabled = vi.fn(async () => true)
    const ctx = makeCtx({ assistantConnectorStore: { isEnabled } as never })
    try {
      const tools = await activateShopifyLane(ctx, {
        connectors: [{ connectorId: 'shopify', connected: true }],
        userId: ctx.userId, settingsStore: createDbMcpSettingsStore(), reportUnavailable: true,
      })
      expect(tools).toHaveLength(43)
      expect(policyQuery).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('FROM mcp_tool_settings'), [
        ctx.userId, [APP_LEVEL_ASSISTANT_ID, ctx.assistantId], ['shopify', 'shopify'], tools.map(tool => tool.name),
      ])
      expect(isEnabled).toHaveBeenCalledExactlyOnceWith(ctx.assistantId, 'shopify')
      expect(ctx.stores.connectorStore.getCredentials).not.toHaveBeenCalled()
    } finally {
      policyQuery.mockRestore()
    }
  })

  it('checks the chosen variant using current exact, legacy and app settings at execution', async () => {
    type Policy = 'allow' | 'ask' | 'block'
    const ctx = { userId: 'u-1', assistantId: 'a-1' } as ToolContext
    const toolName = 'githubSearchRepositories'
    const name = `${toolName}__alternate_ci2`
    const serverName = 'github:ci-2'
    let exact: Policy | undefined = 'allow'
    let legacy: Policy = 'block'
    let app: Policy | undefined
    const getPolicies = vi.fn(async () => [
      ...(exact ? [{ assistantId: ctx.assistantId, serverName, toolName, policy: exact }] : []),
      { assistantId: ctx.assistantId, serverName: 'github', toolName, policy: legacy },
      ...(app ? [{ assistantId: APP_LEVEL_ASSISTANT_ID, serverName: 'github', toolName, policy: app }] : []),
    ])
    const execute = vi.fn(async () => ({ data: 'executed' }))
    const [tool] = await applyToolPolicies([{ name, execute } as unknown as Tool], serverName,
      { getPolicies } as never, ctx.assistantId, ctx.userId, undefined, {
        canonicalName: () => toolName, appServerName: 'github', assistantFallbackServerName: 'github',
      })
    expect(getPolicies).toHaveBeenCalledExactlyOnceWith({
      userId: ctx.userId, toolNames: [toolName], scopes: [
        { assistantId: APP_LEVEL_ASSISTANT_ID, serverName: 'github' },
        { assistantId: ctx.assistantId, serverName },
        { assistantId: ctx.assistantId, serverName: 'github' },
      ],
    })
    expect(await tool!.resolveConfirmation!(ctx)).toBe(false)
    exact = undefined
    expect(await tool!.execute({}, { ...ctx, confirmedToolName: name })).toMatchObject({ isError: true, data: expect.stringContaining("'block'") })
    legacy = 'allow'
    app = 'ask'
    expect(await tool!.execute({}, { ...ctx, confirmedToolName: toolName })).toMatchObject({ isError: true, data: expect.stringContaining('requires approval') })
    expect(execute).not.toHaveBeenCalled()
    expect(await tool!.resolveConfirmation!(ctx)).toBe(true)
    expect(await tool!.execute({}, { ...ctx, confirmedToolName: name })).toEqual({ data: 'executed' })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:api/mcp-surface] turn authority', () => {
  const instanceRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'inst-1', provider: 'github', scope: 'workspace', userId: null, workspaceId: 'w-1', connectedEmail: null,
    connected: true, url: null, sensitivity: 'internal', compartments: [], projectIds: [], healthStatus: 'ok', config: {}, ...overrides,
  })

  async function authorityWith(options: { bindingMaximum?: Record<string, string>; onAdmittedBinding?: (key: string, fp: string) => void } = {}) {
    let current = instanceRow()
    const store = {
      getSystem: vi.fn(async () => current),
      getAuthCredentialsSystem: vi.fn(async () => null),
    }
    const unavailable: string[] = []
    const authority = (await createTurnAuthority({
      assistantId: 'a-1', assistantTeamId: 'w-1', actorIdentity: { channel: 'web', userId: 'u-1' },
      connectorInstanceStore: store as never, connectorGrantStore: { listForTargetSystem: vi.fn(async () => []) } as never,
      connectorSourceRuntimeFactory: undefined, unavailable, ...options,
    })) as TurnAuthority
    return { authority, unavailable, setRow: (row: ReturnType<typeof instanceRow>) => { current = row } }
  }
  const context = { userId: 'u-1', assistantId: 'a-1', workspaceId: 'w-1' } as ToolContext

  it('admits by the issued bindingMaximum fingerprint, reports admitted bindings, and records one scope notice', async () => {
    const admitted: Array<[string, string]> = []
    const row = instanceRow()
    const other = instanceRow({ id: 'inst-2' })
    const { authority, unavailable } = await authorityWith({
      bindingMaximum: { [connectorBindingKey(row as never)]: connectorBindingFingerprint(row as never) },
      onAdmittedBinding: (key, fp) => admitted.push([key, fp]),
    })
    expect(authority.exposureAllowed(row as never)).toBe(true)
    expect(authority.exposureAllowed(other as never)).toBe(false)
    expect(authority.exposureAllowed(instanceRow({ id: 'inst-3' }) as never)).toBe(false)
    expect(admitted).toEqual([['instance:inst-1', connectorBindingFingerprint(row as never)]])
    expect(unavailable).toEqual([CONNECTOR_SCOPE_RESTRICTION])
    expect(authority.admittedConnectorIds).toEqual(new Set(['github']))
  })

  it('checks pins before the effect and refuses after a binding changes', async () => {
    const { authority, setRow } = await authorityWith()
    expect(authority.exposureAllowed(instanceRow() as never)).toBe(true)
    const execute = vi.fn(async () => ({ data: 'ok' }))
    const wrapped = authority.wrapTool({ name: 'exampleRead', description: 'Example', execute } as unknown as Tool)
    await expect(wrapped.execute({}, context)).resolves.toEqual({ data: 'ok' })
    setRow(instanceRow({ connectedEmail: 'other@example.invalid' }))
    const refused = wrapped.execute({}, context)
    await expect(refused).rejects.toBeInstanceOf(AuthorityChangedError)
    await expect(refused).rejects.toMatchObject({ operationMayHaveExecuted: false })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('re-checks pins after the effect and marks the outcome as possibly executed', async () => {
    const { authority, setRow } = await authorityWith()
    authority.exposureAllowed(instanceRow() as never)
    const wrapped = authority.wrapTool({ name: 'exampleWrite', description: 'Example', execute: async () => {
      setRow(instanceRow({ healthStatus: 'auth_failed' }))
      return { data: 'sent' }
    } } as unknown as Tool)
    await expect(wrapped.execute({}, context)).rejects.toMatchObject({ name: 'AuthorityChangedError', operationMayHaveExecuted: true })
  })

  it('refuses a tool context from a different actor than the captured invocation', async () => {
    const { authority } = await authorityWith()
    const execute = vi.fn()
    const wrapped = authority.wrapTool({ name: 'exampleRead', description: 'Example', execute } as unknown as Tool)
    // The actor check runs before any effect (synchronously, as in the injector).
    await expect(async () => wrapped.execute({}, { ...context, userId: 'u-2' })).rejects.toBeInstanceOf(AuthorityChangedError)
    expect(execute).not.toHaveBeenCalled()
  })

  it('invalidates the turn when a binding is re-pinned with a different fingerprint', async () => {
    const { authority } = await authorityWith()
    authority.pinBinding(instanceRow() as never)
    authority.pinBinding(instanceRow({ url: 'https://changed.example.invalid' }) as never)
    await expect(authority.assertBindingsCurrent()).rejects.toBeInstanceOf(AuthorityChangedError)
  })

  it('wraps activated family tools through activate() when a runtime authority exists', async () => {
    const { authority } = await authorityWith()
    const ctx = makeCtx()
    const tools = await createActivation({ ctx, authority, providers: PROVIDER_MODULES })
      .activate({ families: [{ family: 'github', instances: [githubLane()] }] })
    const search = tools.find((tool) => tool.name === 'githubSearchRepositories')!
    await expect(async () => search.execute({ query: 'x' } as never, { ...context, userId: 'u-2' })).rejects.toBeInstanceOf(AuthorityChangedError)
    expect(runtime.assertCurrent).toHaveBeenCalled()
  })
})

describe('[COMP:api/mcp-surface] activate() over knowledge and remote MCP', () => {
  it('activates KB read tools only, with writes closed on a surface without write authorization', async () => {
    const knowledgeStore = { hasEntriesForAssistant: vi.fn(async () => true), listSourcesForAssistant: vi.fn(async () => []) }
    const ctx = makeCtx({ knowledgeStore: knowledgeStore as never })
    const tools = await createActivation({ ctx, authority: noAuthority, providers: PROVIDER_MODULES }).activate({ families: [{
      family: 'knowledge', instances: { allowKnowledgeWrites: false, knowledgeWriteAuthorization: 'capture', matchedCaptureRules: [] },
    }] })
    expect(tools.map((tool) => tool.name)).toEqual(['searchKnowledge', 'browseKnowledge', 'readKnowledgeEntry'])
    expect(ctx.unavailable).toEqual([])
  })

  it('discovers an admitted custom MCP and returns direct adapters, never the search pair', async () => {
    discovery.discoverMcpServer.mockResolvedValue({
      name: 'Example Source', url: 'https://mcp.example.invalid',
      tools: [{ name: 'lookup', description: 'Look up a record', inputSchema: { type: 'object', properties: {} } }],
    })
    const ctx = makeCtx()
    const settingsStore = ctx.stores.settingsStore
    const tools = await createActivation({ ctx, authority: noAuthority, providers: PROVIDER_MODULES }).activate({ families: [{
      family: 'remote-mcp',
      instances: {
        instances: [{ connectorId: 'example', name: 'Example Source', url: 'https://mcp.example.invalid', instanceId: null, updatedAt: null,
          preflightHeaders: {}, sendActorIdentity: false, sendMediaToken: false, policyStore: settingsStore, policyUserId: 'u-1', governanceId: 'example' }],
        authority: { runtimeAuthority: undefined, assertBindingsCurrent: async () => {}, sourceRuntime: async () => null,
          pinAuth: () => {}, bindingCacheKey: () => 'none', noteProtectedUnavailable: () => {} },
      },
    }] })
    const names = tools.map((tool) => tool.name)
    expect(names).toContain('lookup')
    expect(names).not.toContain('mcp_search')
    expect(names).not.toContain('mcp_call')
    expect(discovery.discoverMcpServer).toHaveBeenCalledTimes(1)
  })
})
