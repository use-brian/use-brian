/**
 * Capability composition (M3 WP3): the catalog wired to provider activation
 * through the lane builder on the direct (workflow) surface. Parity with the
 * retired injector, for this and every other entrypoint profile, is recorded
 * in `surface-parity.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  discoverMcpServer: vi.fn(), callRemoteMcpTool: vi.fn(),
  discoverCliServer: vi.fn(), callCliMcpTool: vi.fn(),
}))
vi.mock('../client.js', () => ({
  discoverMcpServer: (...args: unknown[]) => boundary.discoverMcpServer(...args),
  callRemoteMcpTool: (...args: unknown[]) => boundary.callRemoteMcpTool(...args),
}))
vi.mock('../cli-transport.js', () => ({
  discoverCliServer: (...args: unknown[]) => boundary.discoverCliServer(...args),
  callCliMcpTool: (...args: unknown[]) => boundary.callCliMcpTool(...args),
}))
// Every built-in is configured on this fictional deployment.
vi.mock('../../connector-config.js', () => ({ getConnectorConfig: () => ({ clientId: 'fixture', clientSecret: 'fixture' }) }))

import type { KnowledgeStoreInterface } from '@use-brian/core/knowledge/types.js'
import type { Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { surfaceProfile, type CatalogActivationPlan } from '../catalog.js'
import { applyDirectCapabilities, createLaneBuilder, prepareComposedCatalog } from '../composition.js'
import { createDescriptorLifecycle, remoteDescriptorSourceKey } from '../descriptors.js'
import { resolveResumeOutcomeNote } from '../../routes/session-resume-replay.js'
import { composeResumeCapabilities, composeSurfaceCapabilities } from '../surface.js'
import type { ProviderActivationContext } from '../providers/types.js'
import type { TurnAuthority } from '../activation.js'

const WORKSPACE = 'workspace-example'
const ASSISTANT = 'assistant-example'
const OWNER = 'owner-example'
const MEMBER = 'member-example'
const at = (day: number) => new Date(Date.UTC(2030, 0, day))

function instance(row: { id: string; provider: string } & Record<string, unknown>) {
  return {
    scope: 'workspace', userId: null as string | null, workspaceId: WORKSPACE as string | null, connectedEmail: null as string | null,
    url: null as string | null, custom: false, config: {}, sensitivity: 'internal', connected: true, healthStatus: 'ok',
    compartments: [], projectIds: [], createdAt: at(1), updatedAt: at(2), label: String(row.provider), ...row,
  }
}

const remoteTools = [
  { name: 'search_tasks', description: 'Search planner tasks', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'create_task', description: 'Create a planner task', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
]
const cliTools = [{ name: 'list_files', description: 'List local project files', inputSchema: { type: 'object' } }]

function fixture() {
  const instances = [
    instance({ id: 'ci-gh-1', provider: 'github', label: 'GitHub', createdAt: at(1) }),
    instance({ id: 'ci-gh-2', provider: 'github', label: 'Ops Bot', createdAt: at(3) }),
    instance({ id: 'ci-shop', provider: 'shopify', label: 'Store' }),
    instance({ id: 'ci-fathom', provider: 'fathom', label: 'Meetings', healthStatus: 'auth_failed' }),
    instance({ id: 'ci-remote', provider: 'custom-planner', label: 'Team Planner', custom: true, url: 'https://planner.example/mcp' }),
    instance({ id: 'ci-cli', provider: 'cli', label: 'Local Tools' }),
  ]
  const grants = [{
    id: 'grant-notion', connectorInstanceId: 'ci-notion', targetType: 'workspace', targetId: WORKSPACE,
    grantedByUserId: MEMBER, grantedAt: at(4), compartments: [], projectIds: [],
    instance: instance({ id: 'ci-notion', provider: 'notion', label: 'Notion', scope: 'user', userId: MEMBER, workspaceId: null }),
  }]
  const connectorInstanceStore = {
    listByWorkspaceSystem: vi.fn(async () => instances),
    getSystem: vi.fn(async (id: string) => instances.find((row) => row.id === id) ?? grants.find((grant) => grant.instance.id === id)?.instance),
    getCredentialsSystem: vi.fn(async () => ({ client_id: 'fixture', client_secret: 'fictional-secret' })),
    getAuthCredentialsSystem: vi.fn(async (id: string) => (id === 'ci-cli' ? { type: 'cli', binaryPath: '/opt/example/tool', args: [] } : null)),
    updateCredentialsSystem: vi.fn(async () => {}),
    markHealth: vi.fn(async () => {}),
  }
  const connectorGrantStore = { listForTargetSystem: vi.fn(async () => grants) }
  const connectorStore = {
    list: vi.fn(async (userId: string) => userId === MEMBER
      ? [{ id: 'ci-notion', connectorId: 'notion', name: 'Notion', connected: true, url: null, custom: false, createdAt: at(1), updatedAt: at(1), connectedEmail: null }]
      : []),
    getConfig: vi.fn(async () => ({})),
    getCredentials: vi.fn(async () => null),
  }
  const settingsStore = { getPolicy: vi.fn(async () => null), setPolicy: vi.fn(), recordUsage: vi.fn(),
    recordUsageAndGetCount: vi.fn(async () => ({ timesAllowed: 0, timesDenied: 0 })) }
  const assistantConnectorStore = { isEnabled: vi.fn(async () => true), listForAssistant: vi.fn(async () => []) }
  const knowledgeStore = { hasEntriesForAssistant: vi.fn(async () => true), listSourcesForAssistant: vi.fn(async () => []) } as unknown as KnowledgeStoreInterface
  return { instances, grants, connectorInstanceStore, connectorGrantStore, connectorStore, settingsStore, assistantConnectorStore, knowledgeStore }
}
type Fixture = ReturnType<typeof fixture>

async function viaComposition(f: Fixture) {
  const stores = {
    connectorStore: f.connectorStore as never, settingsStore: f.settingsStore as never, assistantConnectorStore: f.assistantConnectorStore as never,
    connectorGrantStore: f.connectorGrantStore as never, connectorInstanceStore: f.connectorInstanceStore as never, knowledgeStore: f.knowledgeStore,
  }
  const lifecycle = createDescriptorLifecycle()
  const composed = await prepareComposedCatalog({
    profile: surfaceProfile('workflow'), assistant: { id: ASSISTANT, workspaceId: WORKSPACE }, connectorUserId: OWNER,
    stores, policyReader: async () => [], actionGrantReader: null, knowledge: { store: f.knowledgeStore },
    descriptorLifecycle: lifecycle, composition: { stores },
  })
  const tools = new Map<string, Tool>()
  const unavailable = await applyDirectCapabilities(tools, composed, { settingsStore: f.settingsStore as never })
  return { tools, unavailable, composed, lifecycle }
}

function shape(tools: Map<string, Tool>) {
  return Object.fromEntries([...tools].map(([name, tool]) => [name, {
    description: tool.description,
    isReadOnly: tool.isReadOnly,
    requiresConfirmation: tool.requiresConfirmation,
    resolveConfirmation: typeof tool.resolveConfirmation,
    describeConfirmation: typeof tool.describeConfirmation,
    allowPersistentApproval: tool.allowPersistentApproval ?? false,
  }]))
}

function context(): ToolContext {
  return { assistantId: ASSISTANT, userId: OWNER, workspaceId: WORKSPACE, sessionId: 'run-example', appId: 'test',
    channelType: 'workflow', channelId: 'run-example', abortSignal: new AbortController().signal } as ToolContext
}

beforeEach(() => {
  for (const spy of Object.values(boundary)) spy.mockReset()
  boundary.discoverMcpServer.mockImplementation(async (url: string, name: string) => ({ name, url, tools: remoteTools }))
  boundary.discoverCliServer.mockImplementation(async (_params: unknown, name: string) => ({ name, url: '', tools: cliTools }))
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden in composition tests'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('[COMP:api/mcp-catalog] capability composition', () => {
  it('registers the direct workflow surface with its approval flags', async () => {
    const composed = await viaComposition(fixture())
    // The pair names every dynamic source by its stable `connector:<instanceId>` identity.
    const { mcp_search: composedSearch } = shape(composed.tools)
    expect(composedSearch!.description).toContain('Search across 3 tools')
    expect(composedSearch!.description).toContain('connector:ci-remote (search_tasks, create_task)')
    expect(composedSearch!.description).toContain('connector:ci-cli (list_files)')
    // Built-ins, a second account, a member exposure, KB writes, remote and CLI adapters and the pair.
    for (const name of ['githubCreateIssue', 'shopifyGetShop', 'notionSearch', 'addKnowledgeEntry', 'search_tasks',
      'mcp_Team_Planner_create_task', 'list_files', 'mcp_search', 'mcp_call']) expect(composed.tools.has(name), name).toBe(true)
    expect([...composed.tools.keys()].some((name) => name.startsWith('githubCreateIssue__opsbot_'))).toBe(true)
    // The dead Fathom connection contributes no tools on either path.
    expect([...composed.tools.keys()].some((name) => name.startsWith('fathom'))).toBe(false)
    // Approval flags stay visible: policy-resolved confirmation on built-ins, the static flag on KB writes.
    expect(await composed.tools.get('githubCreateIssue')!.resolveConfirmation!(context())).toBe(true)
    expect(composed.tools.get('addKnowledgeEntry')!.requiresConfirmation).toBe(true)
    expect(composed.unavailable).toEqual(expect.arrayContaining([expect.stringContaining('reconnect required')]))
  })

  it('records activation-time discovery into the plan lifecycle and discovers each source once', async () => {
    const f = fixture()
    const composed = await viaComposition(f)
    expect(boundary.discoverMcpServer).toHaveBeenCalledOnce()
    expect(boundary.discoverCliServer).toHaveBeenCalledOnce()
    const record = composed.lifecycle.read({ sourceKey: remoteDescriptorSourceKey('ci-remote'), family: 'remote-mcp',
      connectorId: 'custom-planner', bindingKey: 'any' })
    expect(record.tools.map((tool) => tool.name)).toEqual(['search_tasks', 'create_task'])
    // A second preparation over the same lifecycle reads the record fresh and does not rediscover.
    const again = await prepareComposedCatalog({
      profile: surfaceProfile('workflow'), assistant: { id: ASSISTANT, workspaceId: WORKSPACE }, connectorUserId: OWNER,
      stores: { connectorStore: f.connectorStore as never, connectorInstanceStore: f.connectorInstanceStore as never,
        connectorGrantStore: f.connectorGrantStore as never, assistantConnectorStore: f.assistantConnectorStore as never },
      policyReader: async () => [], actionGrantReader: null, descriptorLifecycle: composed.lifecycle,
      composition: { stores: { connectorStore: f.connectorStore as never, settingsStore: f.settingsStore as never,
        connectorInstanceStore: f.connectorInstanceStore as never, connectorGrantStore: f.connectorGrantStore as never,
        assistantConnectorStore: f.assistantConnectorStore as never } },
    })
    expect(again.catalog.descriptors.some((descriptor) => descriptor.name === 'create_task')).toBe(true)
    await applyDirectCapabilities(new Map(), again, { settingsStore: f.settingsStore as never })
    expect(boundary.discoverMcpServer).toHaveBeenCalledOnce()
  })

  it('activates only the named connector on a narrowed surface (no discovery, no spawn)', async () => {
    const f = fixture()
    const stores = { connectorStore: f.connectorStore as never, settingsStore: f.settingsStore as never,
      connectorInstanceStore: f.connectorInstanceStore as never, connectorGrantStore: f.connectorGrantStore as never }
    const composed = await prepareComposedCatalog({
      profile: surfaceProfile('home-app'), assistant: { id: ASSISTANT, workspaceId: WORKSPACE }, connectorUserId: OWNER,
      stores, policyReader: async () => [], actionGrantReader: null, composition: { stores },
    })
    const tools = new Map<string, Tool>()
    await applyDirectCapabilities(tools, composed, { connectorIds: ['shopify'], settingsStore: f.settingsStore as never })
    expect([...tools.keys()].length).toBeGreaterThan(0)
    expect([...tools.keys()].every((name) => name.startsWith('shopify'))).toBe(true)
    expect(boundary.discoverMcpServer).not.toHaveBeenCalled()
    expect(boundary.discoverCliServer).not.toHaveBeenCalled()
  })

  it('dispatches each of two same-label dynamic sources to its own server on a folded surface', async () => {
    const f = fixture()
    f.instances.push(instance({ id: 'ci-remote-2', provider: 'custom-planner-2', label: 'Team Planner', custom: true, url: 'https://planner-two.example/mcp' }))
    boundary.callRemoteMcpTool.mockImplementation(async (url: string) => `answer from ${url}`)
    f.settingsStore.recordUsage.mockImplementation(async () => {})
    const tools = new Map<string, Tool>()
    await composeSurfaceCapabilities('channel', { userId: OWNER, assistantId: ASSISTANT, assistantTeamId: WORKSPACE, tools,
      connectorStore: f.connectorStore as never, settingsStore: f.settingsStore as never, assistantConnectorStore: f.assistantConnectorStore as never,
      connectorInstanceStore: f.connectorInstanceStore as never, connectorGrantStore: f.connectorGrantStore as never,
      policyReader: async () => [], actionGrantReader: null, descriptorLifecycle: createDescriptorLifecycle() })
    await tools.get('mcp_search')!.execute({ query: 'Team Planner' }, context())
    for (const [id, url] of [['ci-remote', 'https://planner.example/mcp'], ['ci-remote-2', 'https://planner-two.example/mcp']] as const) {
      const result = await tools.get('mcp_call')!.execute({ server: `connector:${id}`, tool: 'search_tasks', args: { query: 'x' } }, context())
      expect(JSON.stringify(result)).toContain(`answer from ${url}`)
    }
  })

  it('resumes a held gateway approval on its exact source and refuses drift or removal', async () => {
    const f = fixture()
    const secondUrl = 'https://planner-two.example/mcp'
    const fixtureSecond = instance({ id: 'ci-remote-2', provider: 'custom-planner-2', label: 'Project Orchard', custom: true, url: secondUrl })
    f.instances.push(fixtureSecond)
    boundary.callRemoteMcpTool.mockResolvedValue('created in selected planner')
    f.settingsStore.recordUsage.mockImplementation(async () => {})
    const lifecycle = createDescriptorLifecycle()
    const stores = { userId: OWNER, assistantId: ASSISTANT, assistantTeamId: WORKSPACE,
      connectorStore: f.connectorStore as never, settingsStore: f.settingsStore as never,
      connectorInstanceStore: f.connectorInstanceStore as never, connectorGrantStore: f.connectorGrantStore as never,
      policyReader: async () => [], actionGrantReader: null, descriptorLifecycle: lifecycle }
    const tools = new Map<string, Tool>()
    await composeSurfaceCapabilities('web', { ...stores, tools })
    expect(boundary.discoverMcpServer).not.toHaveBeenCalled()
    expect(boundary.discoverCliServer).not.toHaveBeenCalled()
    await tools.get('mcp_search')!.execute({ query: 'Project Orchard' }, context())
    const onInnerAwaitingApproval = vi.fn<NonNullable<ToolContext['onInnerAwaitingApproval']>>()
    await tools.get('mcp_call')!.execute({ server: 'connector:ci-remote-2', tool: 'create_task', args: { title: 'Frozen approval' } }, {
      ...context(), confirmationResolver: { waitForDecision: async () => ({ decision: 'deny' }) } as never,
      notifyConfirmationRequired: vi.fn(), createToolInvocationApproval: async () => 'approval-fixed',
      onInnerAwaitingApproval,
    })
    expect(boundary.callRemoteMcpTool).not.toHaveBeenCalled()
    expect(boundary.discoverMcpServer.mock.calls.map(([url]) => url)).toEqual([secondUrl])
    expect(boundary.discoverCliServer).not.toHaveBeenCalled()
    expect(onInnerAwaitingApproval).toHaveBeenCalledOnce()
    const held = onInnerAwaitingApproval.mock.calls[0]![0]
    expect(held.connectorTarget).toEqual({ serverName: 'connector:ci-remote-2', version: expect.any(String) })
    expect(held.toolInput).toEqual({ title: 'Frozen approval' })

    const outcome = async () => {
      const resumed = new Map<string, Tool>()
      await composeResumeCapabilities({ ...stores, tools: resumed, suspendedToolName: held.toolName, connectorTarget: held.connectorTarget })
      return resolveResumeOutcomeNote(resumed, {
        approvalId: held.approvalId, suspendedToolName: held.toolName, suspendedToolInput: held.toolInput,
        approvalStatus: 'approved', approvalKind: 'tool_invocation', rejectReason: null, answerText: null,
      }, context())
    }
    expect(await outcome()).toContain('created in selected planner')
    expect(boundary.callRemoteMcpTool).toHaveBeenCalledWith(secondUrl, 'create_task', { title: 'Frozen approval' }, undefined)
    expect(boundary.discoverMcpServer.mock.calls.map(([url]) => url)).toEqual([secondUrl, secondUrl])

    boundary.discoverMcpServer.mockImplementation(async (url: string, name: string) => ({ name, url, tools: [{
      name: 'create_task', description: 'Create a planner task for a dated plan', inputSchema: {
        type: 'object', properties: { title: { type: 'string' }, due: { type: 'string' } }, required: ['title', 'due'],
      },
    }] }))
    expect(await outcome()).toContain('the tool is no longer available')
    expect(boundary.callRemoteMcpTool).toHaveBeenCalledOnce()

    f.instances.splice(f.instances.indexOf(fixtureSecond), 1)
    expect(await outcome()).toContain('the tool is no longer available')
    expect(boundary.discoverMcpServer.mock.calls.map(([url]) => url)).toEqual([secondUrl, secondUrl, secondUrl])
    expect(boundary.discoverCliServer).not.toHaveBeenCalled()

    await composeResumeCapabilities({ ...stores, tools: new Map(), suspendedToolName: 'unknown_tool' })
    expect(boundary.discoverMcpServer).toHaveBeenCalledTimes(3)
    expect(boundary.discoverCliServer).not.toHaveBeenCalled()
  })

  it('replays an unambiguous legacy alias using catalog metadata and refuses an unknown or ambiguous alias', async () => {
    const f = fixture()
    const firstUrl = 'https://planner.example/mcp'
    const secondUrl = 'https://planner-two.example/mcp'
    const discoveryName = 'Team Planner'
    const first = f.instances.find(row => row.id === 'ci-remote')!
    f.instances.splice(0, f.instances.length, first)
    const lifecycle = createDescriptorLifecycle()
    const stores = { userId: OWNER, assistantId: ASSISTANT, assistantTeamId: WORKSPACE,
      connectorStore: f.connectorStore as never, settingsStore: f.settingsStore as never,
      connectorInstanceStore: f.connectorInstanceStore as never, connectorGrantStore: f.connectorGrantStore as never,
      policyReader: async () => [], actionGrantReader: null, descriptorLifecycle: lifecycle }
    const discover = async (query: string) => {
      const tools = new Map<string, Tool>()
      await composeSurfaceCapabilities('web', { ...stores, tools })
      await tools.get('mcp_search')!.execute({ query }, context())
    }
    const resume = async (suspendedToolName: string) => {
      const tools = new Map<string, Tool>()
      await composeResumeCapabilities({ ...stores, tools, suspendedToolName })
      return tools
    }
    await discover(discoveryName)
    const legacyName = 'mcp_Team_Planner_create_task'
    expect((await resume(legacyName)).has(legacyName)).toBe(true)
    expect(boundary.discoverMcpServer.mock.calls.map(([url]) => url)).toEqual([firstUrl, firstUrl])
    expect((await resume('unknown')).size).toBe(0)
    expect(boundary.discoverMcpServer).toHaveBeenCalledTimes(2)

    f.instances.push(instance({ id: 'ci-remote-2', provider: 'custom-planner-2', label: discoveryName, custom: true, url: secondUrl }))
    await discover(discoveryName)
    expect((await resume(legacyName)).size).toBe(0)
    expect(boundary.discoverMcpServer.mock.calls.map(([url]) => url)).toEqual([firstUrl, firstUrl, secondUrl])
  })

  it('pins exactly the admitted rows a family lane uses, with the catalog-time binding', async () => {
    const f = fixture()
    const composed = await viaComposition(f)
    const plan: CatalogActivationPlan = composed.composed.catalog.plan
    const pinned: unknown[] = []
    const authority = { pinBinding: (binding: unknown) => { pinned.push(binding) } } as unknown as TurnAuthority
    const ctx = { assistantId: ASSISTANT, assistantTeamId: WORKSPACE, userId: OWNER, unavailable: [],
      stores: { settingsStore: f.settingsStore, connectorStore: f.connectorStore, connectorInstanceStore: f.connectorInstanceStore } } as unknown as ProviderActivationContext
    const lanes = await createLaneBuilder({ ctx, authority, ports: { stores: ctx.stores } })('github', plan, { families: ['github'] }) as Array<{ supersedes?: string[] }>
    expect(lanes).toHaveLength(1)
    expect(lanes[0]!.supersedes).toEqual(['github'])
    expect(pinned).toEqual([f.instances[0], f.instances[1]])
    const grantLanes = await createLaneBuilder({ ctx, authority, ports: { stores: ctx.stores } })('notion', plan, { families: ['notion'] })
    expect(grantLanes).toHaveLength(1)
    expect(pinned.at(-1)).toEqual(f.grants[0])
  })
})
