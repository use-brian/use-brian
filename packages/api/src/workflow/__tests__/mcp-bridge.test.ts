/**
 * Unit tests for the workflow MCP tool-registry bridge.
 * Component tag: [COMP:workflow/mcp-bridge].
 *
 * Mocks the capability composition (`prepareComposedCatalog` +
 * `applyDirectCapabilities`). Verifies buildWorkflowToolRegistry: the
 * first-party map is shallow-copied (boot-time entries never mutated), the
 * no-user branch skips MCP entirely, the user branch delegates to the
 * catalog plus direct activation and returns the map it mutated, and the run
 * scope is forwarded. One suite runs the real composition over fixture stores
 * to prove approval flags stay visible to the workflow executor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { buildTool } from '@use-brian/agent-runtime/tools/types.js'
import { currentAgentAccess } from '../../db/agent-access-context.js'

vi.mock('../../mcp/composition.js', async (original) => {
  const actual = await original<typeof import('../../mcp/composition.js')>()
  return { ...actual, prepareComposedCatalog: vi.fn(actual.prepareComposedCatalog), applyDirectCapabilities: vi.fn(actual.applyDirectCapabilities) }
})
// The real-composition suite must not reach PostgreSQL: the bulk policy read fails closed.
vi.mock('../../db/client.js', async (original) => ({
  ...(await original<typeof import('../../db/client.js')>()),
  query: vi.fn(async () => { throw new Error('no database in this unit suite') }),
}))

import { buildWorkflowToolRegistry, type WorkflowToolRegistryDeps } from '../mcp-bridge.js'
import * as composition from '../../mcp/composition.js'
import type { Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'

const actualComposition = await vi.importActual<typeof import('../../mcp/composition.js')>('../../mcp/composition.js')
const mockPrepare = vi.mocked(composition.prepareComposedCatalog)
const mockApply = vi.mocked(composition.applyDirectCapabilities)
/** Arguments of the n-th catalog preparation. */
const prepared = (n = 0) => mockPrepare.mock.calls[n]![0] as Parameters<typeof composition.prepareComposedCatalog>[0]

function makeDeps(firstParty: Map<string, Tool>): WorkflowToolRegistryDeps {
  return {
    firstParty,
    connectorStore: {},
    settingsStore: {},
  } as unknown as WorkflowToolRegistryDeps
}

const scope = {
  workspaceId: 'ws-1',
  assistantId: 'a-1',
  userId: 'u-1' as string | null,
}

beforeEach(() => {
  mockPrepare.mockReset()
  mockApply.mockReset()
  mockPrepare.mockResolvedValue({ catalog: {}, composition: {} } as never)
  mockApply.mockResolvedValue([])
})

describe('[COMP:workflow/mcp-bridge] buildWorkflowToolRegistry', () => {
  it('retains the originating connection operation and account maximum after every injector',async()=>{
    const consent={operationNames:['permitted'],connectorBindings:{'fictional-account':'fingerprint'}} as never;
    mockApply.mockImplementationOnce(async tools=>{
      tools.set('unconsentedConnector',{} as Tool);
      return [];
    });
    const registry=await buildWorkflowToolRegistry(makeDeps(new Map([['permitted',{} as Tool],['unconsented',{} as Tool]])),{...scope,workspaceConsent:consent});
    expect([...registry.keys()]).toEqual(['permitted']);
    expect(prepared()).toMatchObject({bindingMaximum:{'fictional-account':'fingerprint'},profile:{restrictSearchToToolNames:['permitted']}});
  });

  it('enforces the supplied run ceiling during a deterministic tool invocation',async()=>{
    const probe=buildTool({name:'scopeProbe',description:'Fixture scope probe',inputSchema:z.object({}),execute:async()=>({data:currentAgentAccess()})})
    const turnScope={access:{workspaceId:'ws-1',userId:'u-1',assistantId:'a-1',assistantKind:'primary' as const,
      clearance:'internal' as const,compartments:['product'],projectIds:[],visibilityAssistantIds:[]},
      effectiveCompartments:['product'],effectiveProjectIds:[],writeCompartments:['product'],writeProjectIds:[],activeGroupId:null,activeProjectId:null}
    const warning = 'Connector discovery is limited by the current execution scope.'
    mockApply.mockResolvedValueOnce([warning])
    const registry=await buildWorkflowToolRegistry(makeDeps(new Map([[probe.name,probe]])),{...scope,turnScope})
    expect(registry.discoveryWarnings).toEqual([warning])
    expect(prepared().contextScope).toBe(turnScope)
    const result=await registry.get(probe.name)!.execute({}, {userId:'u-1',assistantId:'a-1',assistantKind:'primary',workspaceId:'ws-1',
      sessionId:'run',appId:'fixture',channelType:'workflow',channelId:'run',abortSignal:new AbortController().signal})
    expect(result.data).toMatchObject({workspaceId:'ws-1',userId:'u-1',clearance:'internal',compartments:['product'],projectIds:[],visibilityAssistantIds:[]})
    expect(currentAgentAccess()).toBeUndefined()
  })
  it('returns a shallow copy — mutating the result never touches the boot map', async () => {
    const firstParty = new Map<string, Tool>([['fp', {} as Tool]])
    const out = await buildWorkflowToolRegistry(makeDeps(firstParty), { ...scope, userId: null })
    expect(out).not.toBe(firstParty)
    out.set('mutation', {} as Tool)
    expect(firstParty.has('mutation')).toBe(false)
  })

  it('skips MCP injection entirely when the run has no user', async () => {
    const firstParty = new Map<string, Tool>([['fp', {} as Tool]])
    const out = await buildWorkflowToolRegistry(makeDeps(firstParty), { ...scope, userId: null })
    expect(mockPrepare).not.toHaveBeenCalled()
    expect(mockApply).not.toHaveBeenCalled()
    expect([...out.keys()]).toEqual(['fp'])
  })

  it('delegates to the catalog plus direct activation and returns the map it mutated when a user is present', async () => {
    mockApply.mockImplementationOnce(async (tools) => {
      tools.set('mcp_added', {} as Tool)
      return []
    })
    const firstParty = new Map<string, Tool>([['fp', {} as Tool]])
    const out = await buildWorkflowToolRegistry(makeDeps(firstParty), scope)
    expect(mockPrepare).toHaveBeenCalledOnce()
    expect(mockApply).toHaveBeenCalledOnce()
    expect([...out.keys()].sort()).toEqual(['fp', 'mcp_added'])
  })

  it('forwards the run scope to the catalog and activation', async () => {
    const engineHooks = { preToolUse: vi.fn() }
    const assistantConnectorGrantsStore = { listForAssistant: vi.fn() }
    await buildWorkflowToolRegistry({
      ...makeDeps(new Map<string, Tool>()),
      engineHooks,
      assistantConnectorGrantsStore,
    } as never, scope)
    const arg = prepared()
    expect(arg.connectorUserId).toBe('u-1')
    expect(arg.assistant).toEqual({ id: 'a-1', workspaceId: 'ws-1' })
    expect(arg.composition.hosted?.engineHooks).toBe(engineHooks)
    expect(arg.composition.stores.assistantConnectorGrantsStore).toBe(assistantConnectorGrantsStore)
    // A wired grants store means the catalog reads action grants (never the unwired `null`).
    expect(arg.actionGrantReader).toBeUndefined()
    expect(mockApply.mock.calls[0]![2]).toMatchObject({ hooks: engineHooks })
  })

  it('strips recursive orchestration tools from the deterministic registry', async () => {
    mockApply.mockImplementationOnce(async (tools) => {
      tools.set('mcp_safe', {} as Tool)
      return []
    })
    const firstParty = new Map<string, Tool>([
      ['runWorkflow', {} as Tool],
      ['createWorkflow', {} as Tool],
      ['askAssistant', {} as Tool],
      ['createScheduledJob', {} as Tool],
      ['scheduleWorkflow', {} as Tool],
      ['listTasks', {} as Tool],
    ])
    const out = await buildWorkflowToolRegistry(makeDeps(firstParty), scope)

    expect([...out.keys()].sort()).toEqual(['listTasks', 'mcp_safe'])
    expect(firstParty.has('runWorkflow')).toBe(true)
  })

  it('enables KB writes and forwards the repo writer — the executor approval pause is the gate', async () => {
    // Not a regression of the chat-only D2 decision: the gate moved rather
    // than disappeared. Both KB write tools declare `requiresConfirmation`,
    // and `keepBuiltinsDirect` keeps that flag visible to the executor, which
    // routes it into a `kind='workflow_step'` approval. Without this the
    // `knowledge` event source could only ever notify, never maintain.
    const writer = { commitEntryUpdate: vi.fn(), commitEntryCreate: vi.fn() }
    const knowledgeStore = {}
    const deps = { ...makeDeps(new Map<string, Tool>()), knowledgeStore, knowledgeRepoWriter: writer } as unknown as WorkflowToolRegistryDeps
    await buildWorkflowToolRegistry(deps, scope)
    expect(prepared().profile.knowledgeWrites).toBe('workflow')
    expect(prepared().knowledge).toEqual({ store: knowledgeStore, repoWriter: writer })
    expect(prepared().composition.stores.knowledgeRepoWriter).toBe(writer)
    // The executor can only see `requiresConfirmation` on a built-in that was
    // left directly in the map; routing it behind mcp_call would hide it.
    expect(prepared().profile.keepBuiltinsDirect).toBe(true)
    // Deterministic tool_call steps also need exact custom/CLI registry names.
    expect(prepared().profile.keepDynamicToolsDirect).toBe(true)
  })

  it('exposes no repo write path when the writer port is absent (open standalone boot)', async () => {
    await buildWorkflowToolRegistry({ ...makeDeps(new Map<string, Tool>()), knowledgeStore: {} } as unknown as WorkflowToolRegistryDeps, scope)
    expect(prepared().knowledge?.repoWriter).toBeUndefined()
  })
})

describe('[COMP:workflow/mcp-bridge] approval flags through the real composition', () => {
  const at = new Date(Date.UTC(2030, 0, 1))
  const github = { id: 'ci-github', scope: 'workspace', userId: null, workspaceId: 'ws-1', provider: 'github', label: 'GitHub',
    connectedEmail: null, url: null, custom: false, config: {}, sensitivity: 'internal', connected: true, healthStatus: 'ok',
    compartments: [], projectIds: [], createdAt: at, updatedAt: at }

  it('keeps built-ins direct with their confirmation hooks so the executor can pause', async () => {
    mockPrepare.mockImplementation(actualComposition.prepareComposedCatalog)
    mockApply.mockImplementation(actualComposition.applyDirectCapabilities)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const settingsStore = {
      // An assistant-level `ask` row on a read the registry would auto-allow.
      getPolicy: vi.fn(async ({ assistantId, toolName }: { assistantId: string; toolName: string }) =>
        assistantId === 'a-1' && toolName === 'githubGetIssue' ? { policy: 'ask' } : null),
      setPolicy: vi.fn(), recordUsage: vi.fn(), recordUsageAndGetCount: vi.fn(),
    }
    const deps = {
      firstParty: new Map<string, Tool>(),
      connectorStore: { list: vi.fn(async () => []), getCredentials: vi.fn(async () => null) },
      settingsStore,
      connectorInstanceStore: {
        listByWorkspaceSystem: vi.fn(async () => [github]),
        getCredentialsSystem: vi.fn(async () => ({ client_id: 'github_pat', client_secret: 'fictional-token' })),
        getSystem: vi.fn(async () => github), markHealth: vi.fn(async () => {}),
      },
      connectorGrantStore: { listForTargetSystem: vi.fn(async () => []) },
    } as unknown as WorkflowToolRegistryDeps
    const registry = await buildWorkflowToolRegistry(deps, scope)
    const context = { userId: 'u-1', assistantId: 'a-1', workspaceId: 'ws-1', sessionId: 'run', appId: 'fixture',
      channelType: 'workflow', channelId: 'run', abortSignal: new AbortController().signal } as ToolContext
    const create = registry.get('githubCreateIssue')!
    expect(create.requiresConfirmation).toBe(true)
    expect(await create.resolveConfirmation!(context)).toBe(true)
    const read = registry.get('githubGetIssue')!
    expect(read.requiresConfirmation).toBe(false)
    expect(await read.resolveConfirmation!(context)).toBe(true)
    // Built-ins are direct, never folded behind the search pair.
    expect(registry.has('mcp_call')).toBe(false)
  })
})
