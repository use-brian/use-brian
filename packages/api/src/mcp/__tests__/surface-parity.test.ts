/**
 * Entrypoint surface parity (M3 WP5). Every kernel and host surface prepared
 * through `composeSurfaceCapabilities` registers the same capabilities the
 * retired injector did: direct tools (names, descriptions, read-only and
 * confirmation flags, confirmation hooks, persistent approval, resolved
 * policy), the search index (per source: tool names, descriptions and the
 * resolved tool's flags and hooks), unavailable notices, searchable sources,
 * restricted names, the capture prompt, routine Calendar adapters and the
 * confirmation enricher. The injector's output for these exact fixtures was
 * recorded once into `fixtures/surface-parity-baseline.json` before
 * `mcp/inject.ts` was deleted (M3 WP5); the documented intentional
 * differences (I1-I7) are applied to the recording by `intentional()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const boundary = vi.hoisted(() => ({
  discoverMcpServer: vi.fn(), callRemoteMcpTool: vi.fn(),
  discoverCliServer: vi.fn(), callCliMcpTool: vi.fn(),
  indexed: [] as unknown[][],
}))
vi.mock('../client.js', () => ({
  discoverMcpServer: (...args: unknown[]) => boundary.discoverMcpServer(...args),
  callRemoteMcpTool: (...args: unknown[]) => boundary.callRemoteMcpTool(...args),
}))
vi.mock('../cli-transport.js', () => ({
  discoverCliServer: (...args: unknown[]) => boundary.discoverCliServer(...args),
  callCliMcpTool: (...args: unknown[]) => boundary.callCliMcpTool(...args),
}))
vi.mock('../../connector-config.js', () => ({ getConnectorConfig: () => ({ clientId: 'fixture', clientSecret: 'fixture' }) }))
vi.mock('../../google/client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshGoogleAccessToken: async (refreshToken: string) => `access-${refreshToken}`,
  getCalendarEvent: async (_token: string, eventId: string) => ({ id: eventId, summary: 'Fixture planning', attendees: [{ email: 'guest@example.com' }] }),
}))
vi.mock('@use-brian/core/mcp/tool-search.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@use-brian/core/mcp/tool-search.js')>()
  return { ...real, buildToolIndex: (sources: Parameters<typeof real.buildToolIndex>[0]) => {
    boundary.indexed.push(sources as unknown[])
    return real.buildToolIndex(sources)
  } }
})

import type { KnowledgeStoreInterface } from '@use-brian/core/knowledge/types.js'
import type { LocalSource, RemoteSource } from '@use-brian/core/mcp/tool-search.js'
import { buildTool, type Tool, type ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { z } from 'zod'
import { createDescriptorLifecycle } from '../descriptors.js'
import { composeResumeCapabilities, composeSurfaceCapabilities, type SurfaceCapabilities, type SurfaceCapabilityOptions } from '../surface.js'
import type { CapabilitySurface } from '../catalog.js'
import { OFFICIAL_CONNECTORS } from '@use-brian/shared'

const NATIVE_SOURCES = new Set([...OFFICIAL_CONNECTORS.map((connector) => connector.id), 'knowledge', 'introspection', 'google-maps', 'agentmail'])
/** Descriptions are compared by digest to keep the recorded baseline small. */
const text = (value: string | undefined) => value === undefined ? null : createHash('sha256').update(value).digest('hex').slice(0, 16)

const BASELINE = fileURLToPath(new URL('./fixtures/surface-parity-baseline.json', import.meta.url))
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

function readTool(name: string, description: string): Tool {
  return buildTool({ name, description, inputSchema: z.object({}).passthrough(), isReadOnly: true, async execute() { return { data: name } } })
}

/** A workspace assistant with owned, multi-account, exposed, failed, custom, CLI, Calendar and KB lanes. */
function workspaceFixture() {
  const instances = [
    instance({ id: 'ci-gh-1', provider: 'github', label: 'GitHub', createdAt: at(1) }),
    instance({ id: 'ci-gh-2', provider: 'github', label: 'Ops Bot', createdAt: at(3) }),
    instance({ id: 'ci-gcal', provider: 'gcal', label: 'Team Calendar', connectedEmail: 'team@example.com' }),
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
    setConnected: vi.fn(async () => {}),
  }
  return { teamId: WORKSPACE as string | null, connectorInstanceStore, connectorGrantStore, connectorStore }
}

/** A workspace-less personal assistant: the owner's own rows only. */
function personalFixture() {
  const rows = [
    { id: 'pc-gcal', connectorId: 'gcal', name: 'Google Calendar', connected: true, url: null, custom: false, createdAt: at(1), updatedAt: at(1), connectedEmail: 'owner@example.com', config: {} },
    { id: 'pc-gh', connectorId: 'github', name: 'GitHub', connected: true, url: null, custom: false, createdAt: at(1), updatedAt: at(1), connectedEmail: null, config: {} },
    { id: 'pc-gh-2', connectorId: 'github', name: 'Side Project', connected: true, url: null, custom: false, createdAt: at(2), updatedAt: at(2), connectedEmail: null, config: {} },
    { id: 'pc-remote', connectorId: 'custom-notes', name: 'Notes Server', connected: true, url: 'https://notes.example/mcp', custom: true, createdAt: at(1), updatedAt: at(1), connectedEmail: null, config: {} },
    { id: 'pc-cli', connectorId: 'cli', name: 'Shell Tools', connected: true, url: null, custom: false, createdAt: at(1), updatedAt: at(1), connectedEmail: null, config: {} },
  ]
  const connectorStore = {
    list: vi.fn(async () => rows),
    getConfig: vi.fn(async () => ({})),
    getCredentials: vi.fn(async () => ({ client_id: 'fixture', client_secret: 'fictional-token' })),
    setConnected: vi.fn(async () => {}),
  }
  const connectorInstanceStore = {
    listByWorkspaceSystem: vi.fn(async () => []),
    getSystem: vi.fn(async () => null),
    getCredentialsSystem: vi.fn(async () => ({ client_id: 'fixture', client_secret: 'fictional-secret' })),
    getAuthCredentialsSystem: vi.fn(async (id: string) => (id === 'pc-cli' ? { type: 'cli', binaryPath: '/opt/example/shell', args: [] } : null)),
    updateCredentialsSystem: vi.fn(async () => {}),
    markHealth: vi.fn(async () => {}),
  }
  return { teamId: null as string | null, connectorInstanceStore, connectorGrantStore: undefined, connectorStore }
}

type Policy = 'allow' | 'ask' | 'block'
type PolicyRows = { workspace: Array<{ serverName: string; toolName: string; policy: Policy }>
  user: Array<{ assistantId: string; userId: string; serverName: string; toolName: string; policy: Policy }> }

/** The workspace fixture with workspace policy (block a write, ask a read) and a grantor's L2 block. */
function policyFixture() {
  return { ...workspaceFixture(), policy: {
    workspace: [
      { serverName: 'github', toolName: 'githubWriteFile', policy: 'block' },
      { serverName: 'github', toolName: 'githubListIssues', policy: 'ask' },
      { serverName: 'shopify', toolName: 'shopifyCancelOrder', policy: 'block' },
    ],
    user: [{ assistantId: ASSISTANT, userId: MEMBER, serverName: 'notion', toolName: 'notionAppendBlocks', policy: 'block' }],
  } satisfies PolicyRows }
}

type Lanes = (ReturnType<typeof workspaceFixture> | ReturnType<typeof personalFixture>) & { policy?: PolicyRows }

function options(lanes: Lanes, extra: Partial<SurfaceCapabilityOptions>): SurfaceCapabilityOptions {
  const rows = lanes.policy ?? { workspace: [], user: [] }
  const settingsStore = { getPolicy: vi.fn(async (q: { assistantId: string; userId: string; serverName: string; toolName: string }) => {
    const row = rows.user.find((r) => r.assistantId === q.assistantId && r.userId === q.userId && r.serverName === q.serverName && r.toolName === q.toolName)
    return row ? { id: 'policy-row', ...q, policy: row.policy, classification: 'unknown', timesAllowed: 0, timesDenied: 0 } : null
  }), setPolicy: vi.fn(), recordUsage: vi.fn(),
    recordUsageAndGetCount: vi.fn(async () => ({ timesAllowed: 0, timesDenied: 0 })) }
  const assistantConnectorStore = { isEnabled: vi.fn(async () => true), listForAssistant: vi.fn(async () => []) }
  const knowledgeStore = { hasEntriesForAssistant: vi.fn(async () => true), listSourcesForAssistant: vi.fn(async () => []) } as unknown as KnowledgeStoreInterface
  const tools = new Map<string, Tool>([
    ['firstPartyRead', readTool('firstPartyRead', 'A first-party boot tool')],
    ['googleMapsSearchPlaces', readTool('googleMapsSearchPlaces', 'Search places on a map')],
  ])
  return {
    userId: OWNER, assistantId: ASSISTANT, assistantTeamId: lanes.teamId, tools,
    connectorStore: lanes.connectorStore as never, settingsStore: settingsStore as never, assistantConnectorStore: assistantConnectorStore as never,
    connectorInstanceStore: lanes.connectorInstanceStore as never, connectorGrantStore: lanes.connectorGrantStore as never,
    workspaceToolPolicyStore: { getPolicy: vi.fn(async (_workspace: string, serverName: string, toolName: string) => {
      const row = rows.workspace.find((r) => r.serverName === serverName && r.toolName === toolName)
      return row ? { id: 'workspace-policy-row', policy: row.policy, classification: null } : null
    }) } as never,
    knowledgeStore, actionGrantReader: null,
    policyReader: async ({ assistantIds, userIds, workspaceId }) => [
      ...(workspaceId ? rows.workspace.map((r) => ({ scope: 'workspace' as const, workspaceId, ...r })) : []),
      ...rows.user.filter((r) => assistantIds.includes(r.assistantId) && userIds.includes(r.userId)).map((r) => ({ scope: 'user' as const, ...r })),
    ],
    ...extra,
  }
}

const introspection = [readTool('listPendingApprovals', 'List pending approvals in this workspace')]
const PINS = ['search_tasks', 'mcp_Local_Tools_list_files', 'list_files', 'githubListIssues']

/** Entrypoint parameter blocks, as each entrypoint passes them. */
const PROFILES: Array<{ id: string; surface: CapabilitySurface; extra: Partial<SurfaceCapabilityOptions>; strip?: boolean }> = [
  { id: 'web', surface: 'web', extra: { allowKnowledgeWrites: true, knowledgeCaptureText: 'what is on my calendar today', discoveryQuery: 'list calendar events today',
    exposeLocalReadTools: true, introspectionTools: introspection, routineCalendarRead: true } },
  { id: 'web-programmatic', surface: 'web', extra: { allowKnowledgeWrites: true, exposeLocalReadTools: true, keepBuiltinsDirect: true, keepDynamicToolsDirect: true,
    restrictSearchToToolNames: PINS } },
  { id: 'public', surface: 'public', extra: { allowKnowledgeWrites: false }, strip: true },
  { id: 'channel', surface: 'channel', extra: { allowKnowledgeWrites: true, knowledgeCaptureText: 'hello', exposeLocalReadTools: true } },
  { id: 'callee', surface: 'callee', extra: { allowKnowledgeWrites: false } },
  { id: 'callee-pinned', surface: 'callee', extra: { allowKnowledgeWrites: false, keepBuiltinsDirect: true, restrictSearchToToolNames: PINS } },
  { id: 'callee-consent', surface: 'callee', extra: { allowKnowledgeWrites: false, keepBuiltinsDirect: true, keepDynamicToolsDirect: true, restrictSearchToToolNames: PINS } },
  { id: 'workspace-mcp', surface: 'workspace-mcp', extra: { keepBuiltinsDirect: true, keepDynamicToolsDirect: true } },
  { id: 'workspace-mcp-consent', surface: 'workspace-mcp', extra: { keepBuiltinsDirect: true, keepDynamicToolsDirect: true, restrictSearchToToolNames: PINS } },
  { id: 'workflow', surface: 'workflow', extra: { keepBuiltinsDirect: true, keepDynamicToolsDirect: true, allowKnowledgeWrites: true, knowledgeWriteAuthorization: 'workflow' } },
]

function context(teamId: string | null): ToolContext {
  return { assistantId: ASSISTANT, userId: OWNER, workspaceId: teamId ?? undefined, sessionId: 'parity-session', appId: 'test',
    channelType: 'web', channelId: 'parity-session', abortSignal: new AbortController().signal } as ToolContext
}

async function toolShape(tool: Tool, teamId: string | null) {
  return {
    description: text(tool.description),
    isReadOnly: tool.isReadOnly ?? false,
    requiresConfirmation: tool.requiresConfirmation ?? false,
    resolveConfirmation: typeof tool.resolveConfirmation,
    describeConfirmation: typeof tool.describeConfirmation,
    allowPersistentApproval: tool.allowPersistentApproval ?? false,
    ...(tool.resolveConfirmation && !tool.deferredSchemaOnly ? { resolvedPolicy: await tool.resolveConfirmation(context(teamId), {}).catch(() => 'refused') } : {}),
  }
}

/** One normalized index: source label → tool name → shape (lazy entries resolved). */
async function indexShape(sources: unknown[] | undefined, teamId: string | null) {
  const out: Record<string, Record<string, unknown>> = {}
  for (const raw of sources ?? []) {
    const source = raw as LocalSource | RemoteSource
    if (source.kind === 'remote') {
      out[`dynamic:${source.server.name}`] = Object.fromEntries(source.server.tools.map((tool) => [tool.name, { description: text(tool.description) }]))
      continue
    }
    const dynamic = !NATIVE_SOURCES.has(source.serverName)
    const key = dynamic ? `dynamic:${source.label ?? source.serverName}` : source.serverName
    const entries: Record<string, unknown> = {}
    let descriptors = source.descriptors ?? []
    if (source.discover && descriptors.length === 0) descriptors = await source.discover().catch(() => [])
    for (const tool of source.tools) entries[tool.name] = dynamic ? { description: text(tool.description) } : await toolShape(tool, teamId)
    for (const descriptor of descriptors) {
      if (entries[descriptor.name]) continue
      if (dynamic) { entries[descriptor.name] = { description: text(descriptor.description) }; continue }
      const resolved = await source.resolve?.(descriptor.name)
      const tool = resolved && 'status' in resolved ? (resolved.status === 'ready' ? resolved.tool : null) : resolved
      entries[descriptor.name] = tool ? { ...await toolShape(tool, teamId), description: text(descriptor.description),
        ...(descriptor.description === tool.description ? {} : { resolvedDescription: text(tool.description) }) } : 'unresolved'
    }
    out[key] = { ...(out[key] ?? {}), ...entries }
  }
  return out
}

async function surfaceShape(result: SurfaceCapabilities, tools: Map<string, Tool>, teamId: string | null, strip: boolean) {
  if (strip) for (const [name, tool] of tools) if (tool.requiresConfirmation) tools.delete(name)
  const direct: Record<string, unknown> = {}
  for (const [name, tool] of [...tools].sort(([a], [b]) => a.localeCompare(b))) {
    const shape = await toolShape(tool, teamId)
    direct[name] = name === 'mcp_search' || name === 'mcp_call' ? { ...shape, description: '(pair)' } : shape
  }
  return {
    direct,
    index: await indexShape(boundary.indexed.at(-1), teamId),
    unavailable: [...result.unavailable].sort(),
    searchableSources: [...result.searchableSources].sort(),
    restrictedSearchToolNames: [...(result.restrictedSearchToolNames ?? [])].sort(),
    knowledgeCapturePrompt: result.knowledgeCapturePrompt ?? null,
    routineCalendarTools: [...(result.routineCalendarTools?.keys() ?? [])].sort(),
    admittedConnectorIds: [...(result.admittedConnectorIds ?? [])].sort(),
    enriched: await result.enrichConfirmation('googleCalendarUpdateEvent', { eventId: 'evt-1' }),
  }
}

async function runSurface(lanesFor: () => Lanes, profile: (typeof PROFILES)[number]) {
  boundary.indexed.length = 0
  const lanes = lanesFor()
  const opts = options(lanes, { ...profile.extra, descriptorLifecycle: createDescriptorLifecycle() })
  const result = await composeSurfaceCapabilities(profile.surface, opts)
  return surfaceShape(result, opts.tools, lanes.teamId, !!profile.strip)
}

/**
 * Intentional differences from the injector, applied to the recorded
 * baseline before comparison. Each is documented in the M3 kernel cutover
 * receipt and in docs/architecture/integrations/mcp.md → "Entrypoint surfaces".
 */
function intentional(recorded: Awaited<ReturnType<typeof surfaceShape>>, key: string) {
  const baseline = structuredClone(recorded)
  const [fixtureId, profileId] = key.split('/') as [keyof typeof FIXTURES, string]
  const cliLabel = fixtureId === 'personal' ? 'Shell Tools' : 'Local Tools'
  // I1. A personal assistant's connected rows are admitted bindings (the injector counted exposure-gated rows only).
  if (fixtureId === 'personal') baseline.admittedConnectorIds = ['cli', 'custom-notes', 'gcal', 'github']
  // I2. A dynamic source is searched under its label with the server's own tool description.
  const cli = baseline.index[`dynamic:${cliLabel}`]
  if (cli?.list_files) cli.list_files = { description: text(cliTools[0]!.description) }
  // I3. Calendar previews come from the winning Google lane (the injector kept only the personal lane's enricher).
  if (fixtureId !== 'personal') baseline.enriched = { eventId: 'evt-1', currentSummary: 'Fixture planning', currentAttendees: ['guest@example.com'] }
  // I4. An auth_failed connector reports "reconnect required" only, never also "not connected".
  baseline.unavailable = baseline.unavailable.filter((line) => !(fixtureId !== 'personal' && line.startsWith('Fathom: not connected')))
  // I5. The public profile never indexes a confirmation-required capability (static flag or ask policy).
  if (profileId === 'public') {
    for (const [source, entries] of Object.entries(baseline.index)) {
      for (const [name, entry] of Object.entries(entries)) {
        const shape = entry as { requiresConfirmation?: boolean; resolvedPolicy?: unknown }
        if (shape.requiresConfirmation || shape.resolvedPolicy === true || (source.startsWith('dynamic:') && name === 'create_task')) delete entries[name]
      }
    }
  }
  // I6. Only web chat consumes routine Calendar adapters, so only web activates the canonical read.
  if (profileId === 'channel') baseline.routineCalendarTools = []
  // I7. Dynamic sources are discovered lazily: no read adapter for a source whose descriptors are not cached yet.
  if (profileId === 'web' || profileId === 'channel') delete baseline.direct.list_files
  return baseline
}

/** The recording stores each distinct tool shape once; expand it per profile. */
function loadBaseline(): Record<string, unknown> {
  const recorded = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
    shapes: Record<string, unknown>
    profiles: Record<string, { tool?: string; direct?: Record<string, string>; index?: Record<string, Record<string, string>> } & Record<string, unknown>>
  }
  const shape = (id: string) => structuredClone(recorded.shapes[id])
  return Object.fromEntries(Object.entries(recorded.profiles).map(([key, profile]) => [key, profile.tool ? shape(profile.tool) : {
    ...profile,
    direct: Object.fromEntries(Object.entries(profile.direct ?? {}).map(([name, id]) => [name, shape(id)])),
    index: Object.fromEntries(Object.entries(profile.index ?? {}).map(([source, entries]) =>
      [source, Object.fromEntries(Object.entries(entries).map(([name, id]) => [name, shape(id)]))])),
  }]))
}

beforeEach(() => {
  for (const spy of [boundary.discoverMcpServer, boundary.callRemoteMcpTool, boundary.discoverCliServer, boundary.callCliMcpTool]) spy.mockReset()
  boundary.discoverMcpServer.mockImplementation(async (url: string, name: string) => ({ name, url, tools: remoteTools }))
  boundary.discoverCliServer.mockImplementation(async (_params: unknown, name: string) => ({ name, url: '', tools: cliTools }))
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden in parity tests'))
  for (const level of ['error', 'warn', 'debug', 'info', 'log'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

const FIXTURES = { workspace: workspaceFixture, personal: personalFixture, policy: policyFixture }

describe('[COMP:api/mcp-catalog] entrypoint surface parity with the retired injector', () => {
  const baseline = loadBaseline()
  for (const [fixtureId, lanesFor] of Object.entries(FIXTURES)) {
    for (const profile of PROFILES) {
      it(`${fixtureId} / ${profile.id}`, async () => {
        const current = await runSurface(lanesFor, profile)
        const key = `${fixtureId}/${profile.id}`
        expect(current).toEqual(intentional(baseline[key] as never, key))
      })
    }
    it(`${fixtureId} / resume`, async () => {
      const lanes = lanesFor()
      const opts = options(lanes, { descriptorLifecycle: createDescriptorLifecycle() })
      const tools = opts.tools
      await composeResumeCapabilities({ ...opts, suspendedToolName: 'githubCreateIssue' })
      const resumed = await toolShape(tools.get('githubCreateIssue')!, lanes.teamId)
      const key = `${fixtureId}/resume`
      // The baseline is the injector's direct-registry tool of that name.
      expect(resumed).toEqual(baseline[key])
      // Exactly the suspended tool was activated.
      expect([...tools.keys()].filter((name) => name !== 'firstPartyRead' && name !== 'googleMapsSearchPlaces')).toEqual(['githubCreateIssue'])
    })
  }
})
