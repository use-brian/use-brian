import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// External boundaries. The catalog must reach none of them on a fully
// connected fixture; the spies prove it.
const boundary = vi.hoisted(() => ({
  discoverMcpServer: vi.fn(), callRemoteMcpTool: vi.fn(),
  discoverCliServer: vi.fn(), callCliMcpTool: vi.fn(),
  spawn: vi.fn(), execFile: vi.fn(), exec: vi.fn(), fork: vi.fn(),
  query: vi.fn(), queryWithRLS: vi.fn(),
}))
vi.mock('../client.js', () => ({
  discoverMcpServer: (...args: unknown[]) => boundary.discoverMcpServer(...args),
  callRemoteMcpTool: (...args: unknown[]) => boundary.callRemoteMcpTool(...args),
}))
vi.mock('../cli-transport.js', () => ({
  discoverCliServer: (...args: unknown[]) => boundary.discoverCliServer(...args),
  callCliMcpTool: (...args: unknown[]) => boundary.callCliMcpTool(...args),
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => boundary.spawn(...args),
  execFile: (...args: unknown[]) => boundary.execFile(...args),
  exec: (...args: unknown[]) => boundary.exec(...args),
  fork: (...args: unknown[]) => boundary.fork(...args),
}))
vi.mock('../../db/client.js', async (original) => ({
  ...(await original<typeof import('../../db/client.js')>()),
  query: (...args: unknown[]) => boundary.query(...args),
  queryWithRLS: (...args: unknown[]) => boundary.queryWithRLS(...args),
}))
// Every built-in is configured on this fictional deployment (the catalog-time config check has its own case).
vi.mock('../../connector-config.js', () => ({ getConnectorConfig: () => ({ clientId: 'fixture', clientSecret: 'fixture' }) }))

import type { KnowledgeStoreInterface } from '@use-brian/core/knowledge/types.js'
import {
  buildToolIndex,
  createMcpSearchTools,
  legacyMcpToolName,
} from '@use-brian/core/mcp/tool-search.js'
import {
  createConfirmationResolver,
  type ToolConfirmationRequest,
} from '@use-brian/agent-runtime/mcp/types.js'
import { buildTool, type Tool, type ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { APP_LEVEL_ASSISTANT_ID, OFFICIAL_CONNECTOR_TOOLS, BOOT_INJECTED_BUILTIN_TOOLS } from '@use-brian/shared'
import {
  createCatalogActivator, prepareCapabilityCatalog, surfaceProfile,
  type CatalogActivator, type PrepareCapabilityCatalogInput,
} from '../catalog.js'
import { connectorBindingFingerprint } from '../activation.js'
import {
  createDescriptorLifecycle, descriptorVersion, dynamicSourceBindingKey, dynamicToolDescriptors,
  nativeFamilyForConnector, remoteDescriptorSourceKey, staticNativeDescriptorRecords,
} from '../descriptors.js'
import { composeSurfaceCapabilities } from '../surface.js'
import { IMPLEMENTATION_UNAVAILABLE_REASON } from '../catalog.js'
import { LAZY_IMPLEMENTATION_RETRY_MS, lazyImplementation } from '@use-brian/agent-runtime/tools/lazy-implementation.js'
import { createConnectorLifecycleService } from '../../connectors/lifecycle-service.js'
import type { KnowledgeCaptureRuleStore } from '../../knowledge/capture-rules.js'

const WORKSPACE = 'workspace-example'
const ASSISTANT = 'assistant-example'
const OWNER = 'owner-example'
const MEMBER = 'member-example'
const at = (day: number) => new Date(Date.UTC(2030, 0, day))

function instance(row: { id: string; provider: string } & Record<string, unknown>) {
  return {
    scope: 'workspace', userId: null as string | null, workspaceId: WORKSPACE as string | null, connectedEmail: null as string | null,
    url: null as string | null, custom: false,
    config: {}, sensitivity: 'internal', connected: true, healthStatus: 'ok', compartments: [], projectIds: [],
    createdAt: at(1), updatedAt: at(2), label: String(row.provider), ...row,
  }
}

const remoteRow = instance({ id: 'ci-remote', provider: 'custom-planner', label: 'Team Planner', custom: true, url: 'https://planner.example/mcp' })
const remoteTools = [
  { name: 'search_tasks', description: 'Search planner tasks', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'create_task', description: 'Create a planner task', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
]

function fixture() {
  const instances = [
    instance({ id: 'ci-gcal', provider: 'gcal', label: 'Calendar' }),
    instance({ id: 'ci-gh-1', provider: 'github', label: 'GitHub', createdAt: at(1) }),
    instance({ id: 'ci-gh-2', provider: 'github', label: 'Ops Bot', createdAt: at(3) }),
    instance({ id: 'ci-fathom', provider: 'fathom', label: 'Meetings', healthStatus: 'auth_failed' }),
    remoteRow,
    instance({ id: 'ci-cli', provider: 'cli', label: 'Local Tools' }),
  ]
  const grants = [{
    id: 'grant-notion', connectorInstanceId: 'ci-notion', targetType: 'workspace', targetId: WORKSPACE,
    grantedByUserId: MEMBER, grantedAt: at(4), compartments: [], projectIds: [],
    instance: instance({ id: 'ci-notion', provider: 'notion', label: 'Notion', scope: 'user', userId: MEMBER, workspaceId: null }),
  }]
  // Every store method other than the listings is a credential/detail read the catalog must not make.
  const calls: string[] = []
  const tracked = <T extends object>(name: string, impl: Record<string, (...args: never[]) => unknown>) => new Proxy(impl, {
    get(target, property) {
      const key = String(property)
      if (key === 'then') return undefined
      return (...args: never[]) => {
        calls.push(`${name}.${key}`)
        const fn = target[key]
        if (!fn) throw new Error(`unexpected ${name}.${key}`)
        return fn(...args)
      }
    },
  }) as unknown as T
  const stores = {
    connectorStore: tracked<PrepareCapabilityCatalogInput['stores']['connectorStore']>('connectorStore', { list: async () => [] }),
    connectorInstanceStore: tracked<NonNullable<PrepareCapabilityCatalogInput['stores']['connectorInstanceStore']>>('connectorInstanceStore', {
      listByWorkspaceSystem: async () => instances,
    }),
    connectorGrantStore: tracked<NonNullable<PrepareCapabilityCatalogInput['stores']['connectorGrantStore']>>('connectorGrantStore', {
      listForTargetSystem: async () => grants,
    }),
    assistantConnectorStore: tracked<NonNullable<PrepareCapabilityCatalogInput['stores']['assistantConnectorStore']>>('assistantConnectorStore', {
      listForAssistant: async () => [],
    }),
  }
  const policyReader = vi.fn<NonNullable<PrepareCapabilityCatalogInput['policyReader']>>(async () => [
    // Workspace-owned Calendar: an admin blocked event creation.
    { scope: 'workspace', workspaceId: WORKSPACE, serverName: 'gcal', toolName: 'googleCalendarCreateEvent', policy: 'block' },
    // Exposed Notion: the grantor's own L1 blocks page updates.
    { scope: 'user', assistantId: APP_LEVEL_ASSISTANT_ID, userId: MEMBER, serverName: 'notion', toolName: 'notionUpdatePage', policy: 'block' },
  ])
  // The primary GitHub account may only comment; the second keeps the registry default.
  const actionGrantReader = vi.fn(async () => [{ connectorId: 'github', allowedActions: ['githubCreateIssueComment'] }])
  const knowledgeStore = {
    hasEntriesForAssistant: vi.fn(async () => true),
    listSourcesForAssistant: vi.fn(async () => []),
  } as unknown as KnowledgeStoreInterface & { hasEntriesForAssistant: ReturnType<typeof vi.fn>; listSourcesForAssistant: ReturnType<typeof vi.fn> }
  const captureRuleStore = { listEnabledForWorkspace: vi.fn(async () => []) } as unknown as KnowledgeCaptureRuleStore
    & { listEnabledForWorkspace: ReturnType<typeof vi.fn> }
  const authority = { cacheKey: 'authority-example', allows: vi.fn(() => true), assertCurrent: vi.fn(async () => {}),
    execute: vi.fn(async <T>(operation: () => Promise<T>) => operation()) }
  const createRuntimeAuthority = vi.fn(async () => authority)
  const lifecycle = createDescriptorLifecycle()
  const remoteRef = { sourceKey: remoteDescriptorSourceKey('ci-remote'), family: 'remote-mcp' as const,
    connectorId: 'custom-planner', bindingKey: dynamicSourceBindingKey(remoteRow, OWNER) }
  lifecycle.record(remoteRef, dynamicToolDescriptors({ family: 'remote-mcp', connectorId: 'custom-planner', tools: remoteTools }))
  return { instances, grants, calls, stores, policyReader, actionGrantReader, knowledgeStore, captureRuleStore,
    authority, createRuntimeAuthority, lifecycle, remoteRef }
}

type Fixture = ReturnType<typeof fixture>

function catalogInput(f: Fixture, extra: Partial<PrepareCapabilityCatalogInput> = {}): PrepareCapabilityCatalogInput {
  return {
    profile: surfaceProfile('web'),
    assistant: { id: ASSISTANT, workspaceId: WORKSPACE },
    connectorUserId: OWNER,
    actorUserId: OWNER,
    stores: f.stores,
    policyReader: f.policyReader,
    actionGrantReader: f.actionGrantReader,
    knowledge: { store: f.knowledgeStore, captureRuleStore: f.captureRuleStore },
    descriptorLifecycle: f.lifecycle,
    createRuntimeAuthority: f.createRuntimeAuthority as never,
    isProtectedSource: () => false,
    ...extra,
  }
}

function context(extra: Partial<ToolContext> = {}): ToolContext {
  return { assistantId: ASSISTANT, userId: OWNER, workspaceId: WORKSPACE, sessionId: 'session-example', appId: 'test',
    channelType: 'web', channelId: 'channel-example', abortSignal: new AbortController().signal, ...extra } as ToolContext
}

function confirming() {
  const resolver = createConfirmationResolver()
  const prompts: ToolConfirmationRequest[] = []
  const ctx = context({
    confirmationResolver: resolver,
    notifyConfirmationRequired: (request: ToolConfirmationRequest) => {
      prompts.push(request)
      queueMicrotask(() => resolver.resolve(request.toolCallId, 'allow'))
    },
  })
  return { ctx, prompts }
}

function searchPair(catalog: Awaited<ReturnType<typeof prepareCapabilityCatalog>>) {
  const tools = createMcpSearchTools({ index: buildToolIndex(catalog.sources), assistantId: ASSISTANT, userId: OWNER,
    settingsStore: { getPolicy: async () => null, setPolicy: async () => {}, recordUsage: async () => {},
      recordUsageAndGetCount: async () => ({ timesAllowed: 0, timesDenied: 0 }) },
    ...catalog.searchOptions })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { byName, search: byName.get('mcp_search')!, call: byName.get('mcp_call')! }
}

let fetchSpy: { mock: { calls: unknown[][] } }
beforeEach(() => {
  for (const spy of Object.values(boundary)) spy.mockReset()
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden in catalog tests'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('[COMP:api/mcp-catalog] catalog-only preparation', () => {
  it('activates only the admitted primary mailbox binding and never falls forward to a sibling', async () => {
    const f = fixture()
    f.instances.push(instance({ id: 'mailbox-primary', provider: 'imap', createdAt: at(1) }),
      instance({ id: 'mailbox-extra', provider: 'imap', createdAt: at(2) }))
    const activate = vi.fn<CatalogActivator>().mockResolvedValue([])
    const catalog = await prepareCapabilityCatalog(catalogInput(f, { onlyNativeConnector: 'imap', activator: activate }))
    expect(f.knowledgeStore.hasEntriesForAssistant).not.toHaveBeenCalled()
    expect(catalog.sources.map(source => source.serverName)).toEqual(['imap'])
    expect(activate).not.toHaveBeenCalled()
    const source = catalog.sources[0]!
    if (source.kind !== 'local') throw new Error('Expected a native mailbox source')
    await expect(source.resolve!('imapSearchMessages')).resolves.toEqual({ status: 'unavailable', reason: 'it is no longer available to this assistant' })
    expect(activate).toHaveBeenCalledOnce()
    expect(activate.mock.calls[0]![0].admitted.map(row => row.instanceId)).toEqual(['mailbox-primary'])
    expect(activate.mock.calls[0]![1]).toEqual({ toolNames: ['imapSearchMessages'] })
  })

  it('prepares a fully connected workspace with metadata reads only: no network, credentials or spawns', async () => {
    const f = fixture()
    const catalog = await prepareCapabilityCatalog(catalogInput(f))

    // Bounded metadata work, one call each.
    expect(f.createRuntimeAuthority).toHaveBeenCalledOnce()
    expect(f.calls.sort()).toEqual([
      'assistantConnectorStore.listForAssistant',
      'connectorGrantStore.listForTargetSystem',
      'connectorInstanceStore.listByWorkspaceSystem',
    ])
    expect(f.policyReader).toHaveBeenCalledOnce()
    expect(f.policyReader).toHaveBeenCalledWith({ assistantIds: [APP_LEVEL_ASSISTANT_ID, ASSISTANT], userIds: [OWNER, MEMBER], workspaceId: WORKSPACE })
    expect(f.actionGrantReader).toHaveBeenCalledOnce()
    expect(f.knowledgeStore.hasEntriesForAssistant).toHaveBeenCalledOnce()
    expect(f.knowledgeStore.listSourcesForAssistant).toHaveBeenCalledOnce()
    // No capture text: capture rules are never read.
    expect(f.captureRuleStore.listEnabledForWorkspace).not.toHaveBeenCalled()

    // Zero network, credential, spawn and direct SQL.
    for (const spy of Object.values(boundary)) expect(spy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()

    // Every connected family is advertised.
    const names = new Set(catalog.descriptors.map((descriptor) => descriptor.name))
    expect(names.has('googleCalendarListEvents')).toBe(true)
    expect(names.has('githubGetIssue')).toBe(true)
    expect([...names].some((name) => name.startsWith('githubGetIssue__opsbot_'))).toBe(true)
    expect(names.has('notionSearch')).toBe(true)
    expect(names.has('search_tasks')).toBe(true)
    expect(catalog.sources.map((source) => source.serverName)).toEqual(expect.arrayContaining(
      ['gcal', 'github', 'notion', 'knowledge', 'connector:ci-remote', 'connector:ci-cli']))
    const cli = catalog.sources.find((source) => source.serverName === 'connector:ci-cli')!
    expect(cli.descriptors).toEqual([])
    expect(cli.summary).toContain('search for "Local Tools"')
    expect(catalog.unavailable).toEqual(expect.arrayContaining([expect.stringContaining('reconnect required')]))
    expect(catalog.admittedBindings.size).toBe(f.instances.length + f.grants.length)
  })

  it('neither advertises nor announces a built-in this deployment cannot activate (no connector app config)', async () => {
    const f = fixture()
    const catalog = await prepareCapabilityCatalog(catalogInput(f, { isConnectorConfigured: (connectorId) => connectorId !== 'notion' }))
    expect(catalog.descriptors.some((descriptor) => descriptor.family === 'notion')).toBe(false)
    expect(catalog.sources.some((source) => source.serverName === 'notion')).toBe(false)
    expect(catalog.unavailable.some((line) => line.startsWith('Notion'))).toBe(false)
    // Configured families are unaffected.
    expect(catalog.descriptors.some((descriptor) => descriptor.name === 'githubGetIssue')).toBe(true)
  })

  it('omits blocked and ungranted tools from the index before search', async () => {
    const f = fixture()
    const catalog = await prepareCapabilityCatalog(catalogInput(f))
    const names = catalog.descriptors.map((descriptor) => descriptor.name)
    expect(names).not.toContain('googleCalendarCreateEvent')
    expect(names).not.toContain('notionUpdatePage')
    expect(names).not.toContain('githubCreateIssue')
    expect(names).not.toContain('githubWriteFile')
    expect(names).toContain('githubCreateIssueComment')
    // Destructive defaults are never granted without an explicit row.
    expect(names).not.toContain('googleCalendarDeleteEvent')
    // The second GitHub account keeps the registry default grant.
    expect(names.some((name) => name.startsWith('githubCreateIssue__opsbot_'))).toBe(true)

    const { search, call } = searchPair(catalog)
    const calendar = String((await search.execute({ query: 'create calendar event' }, context())).data)
    expect(calendar).not.toMatch(/\] googleCalendarCreateEvent:/)
    const issues = String((await search.execute({ query: 'create github issue' }, context())).data)
    expect(issues).not.toMatch(/\] githubCreateIssue:/)
    const refused = await call.execute({ server: 'gcal', tool: 'googleCalendarCreateEvent', args: {} }, context())
    expect(String(refused.data)).toContain('unknown tool')
  })

  it('admits the same bindings and fingerprints as the workspace-MCP surface and honors bindingMaximum identically', async () => {
    const instances = [
      instance({ id: 'ci-gh-1', provider: 'github', label: 'GitHub' }),
      instance({ id: 'ci-finance', provider: 'notion', label: 'Finance Notion', compartments: ['finance'] }),
    ]
    const grants = [{ id: 'grant-gcal', connectorInstanceId: 'ci-gcal-member', targetType: 'workspace', targetId: WORKSPACE,
      grantedByUserId: MEMBER, grantedAt: at(4), compartments: [], projectIds: [],
      instance: instance({ id: 'ci-gcal-member', provider: 'gcal', label: 'Member Calendar', scope: 'user', userId: MEMBER, workspaceId: null }) }]
    const connectorInstanceStore = {
      listByWorkspaceSystem: vi.fn(async () => instances),
      getCredentialsSystem: vi.fn(async () => ({ client_id: 'github_pat', client_secret: 'fictional-token' })),
      getAuthCredentialsSystem: vi.fn(async () => null), markHealth: vi.fn(async () => {}),
      updateCredentialsSystem: vi.fn(async () => {}), getSystem: vi.fn(async (id: string) => instances.find((row) => row.id === id)),
    }
    const connectorGrantStore = { listForTargetSystem: vi.fn(async () => grants) }
    const connectorStore = { list: vi.fn(async () => []), getConfig: vi.fn(async () => ({})) }
    const settingsStore = { getPolicy: vi.fn(async () => null), setPolicy: vi.fn(), recordUsage: vi.fn(), recordUsageAndGetCount: vi.fn() }

    // The workspace-MCP surface: the consumer that issues and enforces consent ceilings.
    async function viaSurface(bindingMaximum?: Record<string, string>) {
      const seen = new Map<string, string>()
      const tools = new Map<string, Tool>()
      await composeSurfaceCapabilities('workspace-mcp', { userId: OWNER, assistantId: ASSISTANT, assistantTeamId: WORKSPACE, tools,
        keepBuiltinsDirect: true, keepDynamicToolsDirect: true,
        connectorStore: connectorStore as never, settingsStore: settingsStore as never,
        connectorInstanceStore: connectorInstanceStore as never, connectorGrantStore: connectorGrantStore as never,
        policyReader: async () => [], actionGrantReader: null,
        bindingMaximum, onAdmittedBinding: (key, fingerprint) => { seen.set(key, fingerprint) } })
      return { seen, tools }
    }
    async function viaCatalog(bindingMaximum?: Record<string, string>) {
      const seen = new Map<string, string>()
      const catalog = await prepareCapabilityCatalog({
        profile: surfaceProfile('workflow'), assistant: { id: ASSISTANT, workspaceId: WORKSPACE }, connectorUserId: OWNER,
        stores: { connectorStore, connectorInstanceStore: connectorInstanceStore as never, connectorGrantStore: connectorGrantStore as never },
        policyReader: async () => [], actionGrantReader: null,
        bindingMaximum, onAdmittedBinding: (key, fingerprint) => { seen.set(key, fingerprint) },
      })
      return { seen, catalog }
    }

    const injected = await viaSurface()
    const prepared = await viaCatalog()
    // No actor facts: both admit General bindings only (the finance-labelled row is withheld),
    // the same two keys the retired injector admitted for this fixture.
    expect([...prepared.seen.keys()].sort()).toEqual(['grant:grant-gcal', 'instance:ci-gh-1'])
    expect(prepared.seen).toEqual(injected.seen)
    expect(prepared.seen.get('instance:ci-gh-1')).toBe(connectorBindingFingerprint(instances[0] as never))

    // A consent ceiling issued before the GitHub row changed admits nothing for it on either path.
    const ceiling = Object.fromEntries(prepared.seen)
    instances[0] = { ...instances[0]!, connectedEmail: 'replacement@example.com' }
    const injectedAfter = await viaSurface(ceiling)
    const preparedAfter = await viaCatalog(ceiling)
    expect(injectedAfter.seen.has('instance:ci-gh-1')).toBe(false)
    expect(preparedAfter.seen.has('instance:ci-gh-1')).toBe(false)
    expect([...injectedAfter.tools.keys()].some((name) => name.startsWith('github'))).toBe(false)
    expect(preparedAfter.catalog.descriptors.some((descriptor) => descriptor.family === 'github')).toBe(false)
    expect(preparedAfter.seen).toEqual(injectedAfter.seen)
  })

  it('keeps confirmation hooks on lazy entries and activates only the selected tool', async () => {
    const f = fixture()
    const execute = vi.fn(async () => ({ data: { commented: true } }))
    const resolveConfirmation = vi.fn(async () => true)
    const activator = vi.fn<CatalogActivator>(async (_plan, selection) => selection.toolNames?.includes('githubCreateIssueComment')
      ? [buildTool({ name: 'githubCreateIssueComment', description: 'Comment on an issue or PR',
          inputSchema: z.object({ body: z.string() }), isReadOnly: false, requiresConfirmation: true, resolveConfirmation, execute })]
      : [])
    const catalog = await prepareCapabilityCatalog(catalogInput(f, { activator }))
    expect(activator).not.toHaveBeenCalled()
    const { call } = searchPair(catalog)
    const { ctx, prompts } = confirming()
    const result = await call.execute({ server: 'github', tool: 'githubCreateIssueComment', args: { body: 'Looks good' } }, ctx)
    expect(result.isError).toBeFalsy()
    expect(activator).toHaveBeenCalledOnce()
    const [plan, selection] = activator.mock.calls[0]!
    expect(selection).toEqual({ toolNames: ['githubCreateIssueComment'] })
    expect(plan.bindingFingerprints).toBe(catalog.admittedBindings)
    expect(plan.runtimeAuthority).toBe(f.authority)
    expect(resolveConfirmation).toHaveBeenCalledOnce()
    expect(prompts).toEqual([expect.objectContaining({ toolName: 'githubCreateIssueComment', serverName: 'github' })])
    expect(execute).toHaveBeenCalledWith({ body: 'Looks good' }, ctx)
    for (const spy of Object.values(boundary)) expect(spy).not.toHaveBeenCalled()
  })

  it('marks a changed dynamic descriptor stale and refuses dispatch with search again', async () => {
    const f = fixture()
    const execute = vi.fn(async () => ({ data: { created: true } }))
    const changed = [remoteTools[0]!, { ...remoteTools[1]!, description: 'Create a planner task in a project',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, project: { type: 'string' } }, required: ['title', 'project'] } }]
    const activator: CatalogActivator = async (plan, selection) => {
      // Activation rediscovers the source and records what it found.
      const { record } = plan.descriptorLifecycle.record(f.remoteRef,
        dynamicToolDescriptors({ family: 'remote-mcp', connectorId: 'custom-planner', tools: changed }))
      return { tools: selection.toolNames?.includes('create_task')
        ? [buildTool({ name: 'create_task', description: 'Create a planner task in a project', inputSchema: z.record(z.unknown()),
            isReadOnly: false, requiresConfirmation: false, execute })]
        : [], records: [record] }
    }
    const catalog = await prepareCapabilityCatalog(catalogInput(f, { activator }))
    const before = f.lifecycle.read(f.remoteRef).version
    const { call, search } = searchPair(catalog)
    const refused = await call.execute({ server: 'connector:ci-remote', tool: 'create_task', args: { title: 'Plan' } }, context())
    expect(refused.isError).toBe(true)
    expect(String(refused.data)).toMatch(/changed since it was found.*NOT executed.*Search again/)
    expect(execute).not.toHaveBeenCalled()
    expect(f.lifecycle.read(f.remoteRef).version).not.toBe(before)

    const found = String((await search.execute({ query: 'planner create task', limit: 1 }, context())).data)
    expect(found).toContain('Create a planner task in a project')
    expect(found).toContain('project')
    const retried = await call.execute({ server: 'connector:ci-remote', tool: 'create_task', args: { title: 'Plan', project: 'Q1' } }, confirming().ctx)
    expect(retried.isError).toBeFalsy()
    expect(execute).toHaveBeenCalledOnce()
  })

  it('discovers an undiscovered CLI source only when a search names it', async () => {
    const f = fixture()
    const activator = vi.fn<CatalogActivator>(async (plan, selection) => {
      if (selection.sourceKeys?.[0] !== 'cli:ci-cli') return []
      const ref = { sourceKey: 'cli:ci-cli', family: 'cli' as const, connectorId: 'cli', bindingKey: 'fixture' }
      const { record } = plan.descriptorLifecycle.record(ref, dynamicToolDescriptors({ family: 'cli', connectorId: 'cli',
        tools: [{ name: 'list_files', description: 'List local project files', inputSchema: { type: 'object' } }] }))
      return { tools: [], records: [record] }
    })
    const catalog = await prepareCapabilityCatalog(catalogInput(f, { activator }))
    const { search } = searchPair(catalog)
    const discoveries = () => activator.mock.calls.filter(([, selection]) => selection.sourceKeys?.includes('cli:ci-cli'))
    await search.execute({ query: 'calendar events' }, context())
    expect(discoveries()).toHaveLength(0)
    const found = String((await search.execute({ query: 'local tools list files' }, context())).data)
    expect(discoveries()).toHaveLength(1)
    expect(found).toContain('[connector:ci-cli] (Local Tools) list_files')
  })

  it('applies surface profiles: public excludes confirmation-required tools, a pinned callee keeps only its pins', async () => {
    const f = fixture()
    const publicCatalog = await prepareCapabilityCatalog(catalogInput(f, { profile: surfaceProfile('public') }))
    expect(publicCatalog.descriptors.length).toBeGreaterThan(0)
    expect(publicCatalog.descriptors.every((descriptor) => descriptor.effectivePolicy === 'allow' && !descriptor.requiresConfirmation)).toBe(true)
    expect(publicCatalog.descriptors.map((descriptor) => descriptor.name)).not.toContain('githubCreateIssueComment')

    const pinned = await prepareCapabilityCatalog(catalogInput(fixture(), {
      profile: surfaceProfile('callee', { restrictSearchToToolNames: ['githubGetIssue', legacyMcpToolName('Team Planner', 'search_tasks')] }) }))
    const indexed = pinned.sources.flatMap((source) => [...source.tools.map((tool) => tool.name), ...(source.descriptors ?? []).map((d) => d.name)])
    expect(indexed.sort()).toEqual(['githubGetIssue', 'search_tasks'])
    expect(pinned.restrictedSearchToolNames?.sort()).toEqual(['githubGetIssue', 'mcp_Team_Planner_search_tasks'])

    const workflow = await prepareCapabilityCatalog(catalogInput(fixture(), { profile: surfaceProfile('workflow') }))
    expect(workflow.sources.some((source) => source.serverName === 'github')).toBe(false)
    expect(workflow.direct.descriptors.some((descriptor) => descriptor.name === 'githubGetIssue')).toBe(true)
    expect(workflow.searchOptions.keepDynamicToolsDirect).toBe(true)
  })

  it('reads capture rules only when capture text is present', async () => {
    const f = fixture()
    await prepareCapabilityCatalog(catalogInput(f, { knowledge: { store: f.knowledgeStore, captureRuleStore: f.captureRuleStore, captureText: 'Remember the onboarding checklist' } }))
    expect(f.captureRuleStore.listEnabledForWorkspace).toHaveBeenCalledOnce()
    const channel = fixture()
    await prepareCapabilityCatalog(catalogInput(channel, { profile: surfaceProfile('public'),
      knowledge: { store: channel.knowledgeStore, captureRuleStore: channel.captureRuleStore, captureText: 'Remember this' } }))
    expect(channel.captureRuleStore.listEnabledForWorkspace).not.toHaveBeenCalled()
  })

  it('loads a workspace-less personal assistant from one personal listing', async () => {
    const f = fixture()
    const list = vi.fn(async () => [
      { id: 'ci-personal-gh', connectorId: 'github', name: 'GitHub', connected: true, url: null, custom: false, createdAt: at(1), updatedAt: at(1), connectedEmail: null, userId: OWNER, credentialsType: 'none' },
    ])
    const catalog = await prepareCapabilityCatalog(catalogInput(f, {
      assistant: { id: ASSISTANT, workspaceId: null },
      stores: { connectorStore: { list } as never, assistantConnectorStore: f.stores.assistantConnectorStore },
    }))
    expect(list).toHaveBeenCalledOnce()
    expect(f.createRuntimeAuthority).not.toHaveBeenCalled()
    expect(catalog.descriptors.some((descriptor) => descriptor.name === 'githubGetIssue')).toBe(true)
    expect(catalog.unavailable).toEqual(expect.arrayContaining([expect.stringContaining('Google Calendar: not connected')]))
  })
})

describe('[COMP:api/mcp-catalog] implementation loads on activation (M4 step 5)', () => {
  // A family whose execute implementation lives in a module of its own: the
  // catalog entry (name, schema, confirmation flag) is the descriptor; the
  // module loads inside catalog.activate, through the turn's activator.
  function lazyFamily(load: () => Promise<{ comment(body: string): Promise<{ commented: string }> }>) {
    const loader = vi.fn(load)
    const implementation = lazyImplementation('The fixture issue commenter', loader)
    const activator = vi.fn<CatalogActivator>(async (_plan, selection) => {
      if (!selection.toolNames?.includes('githubCreateIssueComment')) return []
      const impl = await implementation()
      return [buildTool({ name: 'githubCreateIssueComment', description: 'Comment on an issue or PR',
        inputSchema: z.object({ body: z.string() }), isReadOnly: false, requiresConfirmation: true,
        resolveConfirmation: async () => false, execute: async (input) => ({ data: await impl.comment(input.body) }) })]
    })
    return { loader, activator }
  }

  it('loads the implementation on the first activation only: not at preparation or on a second call', async () => {
    const f = fixture()
    const { loader, activator } = lazyFamily(async () => ({ comment: async (body: string) => ({ commented: body }) }))
    const catalog = await prepareCapabilityCatalog(catalogInput(f, { activator }))
    const { call } = searchPair(catalog)
    expect(loader).not.toHaveBeenCalled()
    expect(activator).not.toHaveBeenCalled()
    const first = await call.execute({ server: 'github', tool: 'githubCreateIssueComment', args: { body: 'one' } }, context())
    const second = await call.execute({ server: 'github', tool: 'githubCreateIssueComment', args: { body: 'two' } }, context())
    expect(first).toEqual({ data: { commented: 'one' } })
    expect(second).toEqual({ data: { commented: 'two' } })
    expect(loader).toHaveBeenCalledOnce()
    expect(activator).toHaveBeenCalledOnce()
    for (const spy of Object.values(boundary)) expect(spy).not.toHaveBeenCalled()
  })

  it('a failed implementation load is the honest unavailable outcome: nothing runs, a later call retries', async () => {
    const f = fixture()
    const comment = vi.fn(async (body: string) => ({ commented: body }))
    let broken = true
    const { loader, activator } = lazyFamily(async () => {
      if (broken) throw Object.assign(new Error('fixture: module missing'), { code: 'ERR_MODULE_NOT_FOUND' })
      return { comment }
    })
    const catalog = await prepareCapabilityCatalog(catalogInput(f, { activator }))
    const resolve = catalog.sources.find((source) => source.serverName === 'github')!.resolve!
    expect(await resolve('githubCreateIssueComment')).toEqual({ status: 'unavailable', reason: IMPLEMENTATION_UNAVAILABLE_REASON })
    const { call } = searchPair(catalog)
    const refused = await call.execute({ server: 'github', tool: 'githubCreateIssueComment', args: { body: 'blocked' } }, context())
    expect(refused.isError).toBe(true)
    expect(String(refused.data)).toContain(IMPLEMENTATION_UNAVAILABLE_REASON)
    expect(comment).not.toHaveBeenCalled()
    // Inside the retry window the load is not repeated; after it, it is.
    expect(loader).toHaveBeenCalledOnce()
    broken = false
    const later = Date.now() + LAZY_IMPLEMENTATION_RETRY_MS + 1
    vi.spyOn(Date, 'now').mockReturnValue(later)
    const fresh = await prepareCapabilityCatalog(catalogInput(f, { activator }))
    const result = await searchPair(fresh).call.execute({ server: 'github', tool: 'githubCreateIssueComment', args: { body: 'ok' } }, context())
    expect(result).toEqual({ data: { commented: 'ok' } })
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

describe('[COMP:api/mcp-catalog] descriptor lifecycle', () => {
  const ref = { sourceKey: 'remote:ci-example', family: 'remote-mcp' as const, connectorId: 'custom-example', bindingKey: 'binding-1' }
  const tools = dynamicToolDescriptors({ family: 'remote-mcp', connectorId: 'custom-example', tools: remoteTools })

  it('versions tool lists by content, independent of order', () => {
    expect(descriptorVersion(tools)).toBe(descriptorVersion([...tools].reverse()))
    expect(descriptorVersion(tools)).not.toBe(descriptorVersion([{ ...tools[0]!, description: 'Changed' }, tools[1]!]))
  })

  it('moves through fresh, stale, unavailable and undiscovered explicitly', () => {
    let now = 0
    const lifecycle = createDescriptorLifecycle({ ttlMs: 1000, now: () => now })
    expect(lifecycle.read(ref).availability).toBe('undiscovered')
    const first = lifecycle.record(ref, tools)
    expect(first).toMatchObject({ changed: false, stored: true, record: { availability: 'fresh', discoveredAt: new Date(0) } })
    expect(lifecycle.read(ref).availability).toBe('fresh')
    expect(lifecycle.read({ ...ref, bindingKey: 'binding-2' }).availability).toBe('stale')
    now = 1001
    expect(lifecycle.read(ref).availability).toBe('stale')
    const second = lifecycle.record(ref, [tools[0]!])
    expect(second.changed).toBe(true)
    expect(lifecycle.isCurrent(ref.sourceKey, second.record.version!)).toBe(true)
    lifecycle.markUnavailable(ref, 'the connector was disconnected')
    expect(lifecycle.read(ref)).toMatchObject({ availability: 'unavailable', reason: 'the connector was disconnected', tools: [] })
    lifecycle.invalidate(ref.sourceKey)
    expect(lifecycle.read(ref).availability).toBe('undiscovered')
  })

  it('never positively caches a protected source', () => {
    const lifecycle = createDescriptorLifecycle()
    lifecycle.record(ref, tools)
    const result = lifecycle.record({ ...ref, protected: true }, tools)
    expect(result.stored).toBe(false)
    expect(lifecycle.size()).toBe(0)
    expect(lifecycle.read({ ...ref, protected: true }).availability).toBe('undiscovered')
  })

  it('derives a static native record for every registry connector with tools', () => {
    const records = staticNativeDescriptorRecords()
    for (const [connectorId, rows] of Object.entries(OFFICIAL_CONNECTOR_TOOLS)) {
      const covered = nativeFamilyForConnector(connectorId) !== null
      const excluded = connectorId in BOOT_INJECTED_BUILTIN_TOOLS || rows.length === 0
      expect(covered !== excluded, connectorId).toBe(true)
      if (covered) {
        const record = records.find((candidate) => candidate.connectorId === connectorId)!
        expect(record).toMatchObject({ availability: 'fresh', origin: 'static', discoveredAt: null })
        expect(record.tools.map((tool) => tool.name)).toEqual(rows.map((row) => row.name))
      }
    }
    const provided = staticNativeDescriptorRecords([{ family: 'github', describe: () => [{ ...records.find((r) => r.connectorId === 'github')!.tools[0]!, description: 'From describe()' }] }])
    expect(provided.find((record) => record.connectorId === 'github')!.tools).toHaveLength(1)
  })

  it('records connect/refresh discovery from the connector lifecycle and retires it on disconnect', async () => {
    const lifecycle = createDescriptorLifecycle()
    const row = { ...instance({ id: 'ci-own', provider: 'custom-own', label: 'Own MCP', custom: true, url: 'https://own.example/mcp' }),
      scope: 'user', userId: OWNER, workspaceId: null }
    const instanceStore = {
      get: vi.fn(async () => row),
      update: vi.fn(async (_userId: string, _id: string, updates: Record<string, unknown>) => ({ ...row, ...updates })),
    }
    const service = createConnectorLifecycleService({
      instanceStore: instanceStore as never, legacyStore: {} as never, policy: { directoryInstall: 'reuse_primary' },
      descriptorLifecycle: lifecycle,
      drivers: { 'custom-own': { discoverTools: async () => ({ serverName: 'Own MCP', tools: remoteTools }) } },
    })
    const ownRef = { sourceKey: remoteDescriptorSourceKey('ci-own'), family: 'remote-mcp' as const, connectorId: 'custom-own',
      bindingKey: dynamicSourceBindingKey(row, OWNER) }
    await service.tools(OWNER, { kind: 'instance', instanceId: 'ci-own' })
    expect(lifecycle.read(ownRef)).toMatchObject({ availability: 'fresh' })
    expect(lifecycle.read(ownRef).tools.map((tool) => tool.name)).toEqual(['search_tasks', 'create_task'])
    await service.disconnect(OWNER, { kind: 'instance', instanceId: 'ci-own' })
    expect(lifecycle.read(ownRef)).toMatchObject({ availability: 'unavailable', reason: 'the connector was disconnected' })
    await service.projectToolInventory({ userId: OWNER, serverName: 'Own MCP', tools: remoteTools, source: row as never })
    expect(lifecycle.read(ownRef).availability).toBe('fresh')
  })
})
