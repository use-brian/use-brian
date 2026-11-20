import { describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { createExecutionContext, executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { type ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { buildWorkspaceMcpCatalog } from '../../workspace-mcp/catalog.js'
import { createAuthorityLease } from '../../context-scope/authority-lease.js'
import { currentAgentAccess, runWithAgentAccess } from '../../db/agent-access-context.js'
import { createProjectHarnessTools } from '../tools.js'
import type { HarnessRevision } from '../contracts.js'

const userId = '32000000-0000-4000-8000-000000000001'
const workspaceId = '32000000-0000-4000-8000-000000000002'
const projectId = '32000000-0000-4000-8000-000000000003'
const otherId = '32000000-0000-4000-8000-000000000004'
const assistantId = '32000000-0000-4000-8000-000000000005'
const revision: HarnessRevision = { id: otherId, workspaceId, projectId, scope: { kind: 'project' }, revision: 1,
  definition: { schemaVersion: 1, rules: [{ key: 'safety', kind: 'invariant', value: 'Current authorized rule', override: false }], codeChecks: [], acceptanceScenarios: [] },
  createdBy: userId, createdAt: '2026-01-01T00:00:00Z' }
const names = ['getProjectHarnessContext', 'prepareProjectHarnessTask', 'listProjectHarnessScopes', 'selectProjectHarnessTests', 'getProjectHarnessAcceptance']
const taskInput = { prompt: 'Implement the requested change', runtimeProject: 'operator-runtime-key' }

function fixture(kind: 'brain_key' | 'assistant_key' | 'oauth_token' | 'home_app' = 'assistant_key') {
  let active = true
  const access = { userId, workspaceId, assistantId, assistantKind: 'standard' as const, clearance: 'internal' as const,
    compartments: [`project:${projectId}`], mutationCompartments: [`project:${projectId}`], projectIds: [projectId], visibilityAssistantIds: [assistantId] }
  const authority = createAuthorityLease(access, async () => active ? access : null)
  const ec = createExecutionContext({ identity: { kind: 'programmatic', principal: { kind, credentialId: otherId, actorUserId: userId }, credentialOwnerUserId: otherId },
    ownership: { kind: 'workspace', workspaceId }, access, authority, writeDefaults: { compartments: [], projectIds: [projectId] },
    lifecycle: { sessionId: otherId, sessionPersisted: false, channelType: 'assistant_mcp', channelId: otherId, abortSignal: new AbortController().signal } })
  const context: ToolContext = { ...executionToolContext(ec, { appId: 'harness-test' }), activeProjectId: projectId,
    activeCapabilities: new Set(), scopeAccumulator: new ContextScopeAccumulator() }
  const store = { lineage: vi.fn().mockResolvedValue([revision]), tree: vi.fn().mockResolvedValue({ products: [], components: [] }),
    definition: vi.fn().mockResolvedValue(revision), history: vi.fn().mockResolvedValue([revision]) }
  const execution = { approvals: vi.fn().mockResolvedValue([]), runs: vi.fn().mockResolvedValue([]) }
  const snapshot = vi.fn().mockResolvedValue({ tree: { products: [], components: [] }, revisions: [revision] })
  const tools = createProjectHarnessTools({ store, execution, snapshot })
  const admission = { context, tools: new Map(tools.map(tool => [tool.name, tool])), operationNames: new Set(names), readOnly: true }
  const resolve = vi.fn(async () => admission)
  const catalog = () => buildWorkspaceMcpCatalog(resolve)
  const noReads = () => { for (const read of [...Object.values(store), ...Object.values(execution), snapshot]) expect(read).not.toHaveBeenCalled() }
  return { access, ec, authority, context, store, execution, snapshot, tools, admission, resolve, catalog, noReads, revoke: () => { active = false } }
}

describe('real workspace MCP catalog with native harness operations', () => {
  it('projects exactly the native read operations and filters explicit credential consent', async () => {
    const f = fixture()
    expect((await f.catalog()).map(tool => tool.name)).toEqual(names)
    for (const tool of f.tools) { expect(tool.isReadOnly).toBe(true); expect(tool.isConcurrencySafe).toBe(true) }
    f.admission.operationNames = new Set(['getProjectHarnessContext', 'prepareProjectHarnessTask'])
    expect((await f.catalog()).map(tool => tool.name)).toEqual(['getProjectHarnessContext', 'prepareProjectHarnessTask'])
    f.admission.operationNames.clear()
    expect(await f.catalog()).toEqual([])
    f.noReads()
  })

  it.each(['brain_key', 'assistant_key', 'oauth_token', 'home_app'] as const)('canonical %s context needs no legacy actor fields and preserves native access/evidence', async kind => {
    const f = fixture(kind)
    expect(f.context.workspaceActorUserId).toBeUndefined()
    expect(f.context.programmaticPrincipal).toBeUndefined()
    expect(f.ec.identity).toMatchObject({ credentialOwnerUserId: otherId })
    const before = structuredClone(f.ec.security.access)
    f.store.lineage.mockImplementation(async (...args) => {
      expect(args).toEqual([userId, workspaceId, projectId, { kind: 'project' }])
      expect(currentAgentAccess()).toMatchObject({ userId, workspaceId, clearance: before.clearance, compartments: before.compartments,
        mutationCompartments: before.mutationCompartments, projectIds: before.projectIds, visibilityAssistantIds: before.visibilityAssistantIds })
      return [revision]
    })
    const tool = (await f.catalog()).find(tool => tool.name === 'getProjectHarnessContext')!
    const result = await tool.handler({})
    expect(result).toMatchObject({ isError: false, structuredContent: { status: 'succeeded', data: {
      context: { projectId, scope: { kind: 'project' }, status: 'resolved' }, prompt: expect.stringContaining('Current authorized rule'),
    } } })
    expect(f.context.scopeAccumulator!.evidence).toMatchObject({ sensitivity: 'internal', projectIds: [projectId], compartments: [`project:${projectId}`] })
    expect(f.ec.security.access).toEqual(before)
    expect(f.context.authority).toBe(f.authority)
    expect(currentAgentAccess()).toBeUndefined()
    expect(f.store.lineage).toHaveBeenCalledOnce()
    expect(f.store.tree).not.toHaveBeenCalled()
    expect(f.snapshot).not.toHaveBeenCalled()
    // Internal evidence is retained, not projected as another source-access grant.
    expect(result.structuredContent).not.toHaveProperty('scopeEvidence')
  })

  it('re-resolves consent and tool registration on invocation, not just at discovery', async () => {
    const f = fixture()
    const tool = (await f.catalog()).find(tool => tool.name === 'getProjectHarnessContext')!
    f.admission.operationNames.delete(tool.name)
    expect(await tool.handler({})).toMatchObject({ isError: true, structuredContent: { code: 'operation_unavailable' } })
    f.admission.operationNames.add(tool.name)
    f.admission.tools.delete(tool.name)
    expect(await tool.handler({})).toMatchObject({ isError: true, structuredContent: { code: 'operation_unavailable' } })
    expect(f.resolve).toHaveBeenCalledTimes(3)
    f.noReads()
  })

  it('refreshes the current server revision on each read and task preparation without launching a connector', async () => {
    const f = fixture()
    const catalog = await f.catalog()
    const get = catalog.find(tool => tool.name === 'getProjectHarnessContext')!
    const prepare = catalog.find(tool => tool.name === 'prepareProjectHarnessTask')!
    expect(JSON.stringify(await get.handler({}))).toContain('Current authorized rule')
    const current = { ...revision, id: assistantId, revision: 2, definition: { ...revision.definition,
      rules: [{ key: 'safety', kind: 'invariant' as const, value: 'REFRESHED RULE', override: false }] } }
    f.store.lineage.mockResolvedValue([current])
    f.snapshot.mockResolvedValue({ tree: { products: [], components: [] }, revisions: [current] })
    const result = await prepare.handler(taskInput)
    expect(result).toMatchObject({ isError: false, structuredContent: { status: 'succeeded', data: { status: 'prepared', toolName: 'new_task_with_context',
      arguments: { prompt: taskInput.prompt, context: { project: taskInput.runtimeProject,
        constraints: [expect.stringContaining('REFRESHED RULE'), expect.stringContaining('impact_selected_coding_test_plan')],
        verification: expect.stringContaining('Coding/test review only'), references: [expect.stringContaining(assistantId)] } }, binding: { revisions: [{ revisionId: assistantId, revision: 2 }] },
      notice: expect.stringContaining('no task started'),
    } } })
    expect(JSON.stringify(result)).not.toContain('Current authorized rule')
    expect(JSON.stringify(await get.handler({}))).toContain('REFRESHED RULE')
    expect(f.store.lineage).toHaveBeenCalledTimes(2)
    expect(f.execution.approvals).not.toHaveBeenCalled()
    expect(f.execution.runs).not.toHaveBeenCalled()
    expect(f.snapshot).toHaveBeenCalledExactlyOnceWith(userId, workspaceId, projectId)
  })

  it.each([
    { label: 'Project', narrow: { projectIds: [otherId] } },
    { label: 'compartment', narrow: { compartments: [] } },
    { label: 'public clearance', narrow: { clearance: 'public' } },
  ])('denies a narrowed parent $label ceiling before every native store', async ({ narrow }) => {
    const f = fixture()
    const catalog = await f.catalog()
    const before = structuredClone(f.ec.security.access)
    await runWithAgentAccess({ ...f.access, ...narrow }, async () => {
      const parent = currentAgentAccess()
      for (const tool of catalog) {
        const result = await tool.handler(tool.name === 'prepareProjectHarnessTask' ? taskInput : {})
        expect(result, tool.name).toMatchObject({ isError: true, structuredContent: { status: 'failed' } })
        expect(JSON.stringify(result)).not.toContain('Current authorized rule')
        expect(currentAgentAccess()).toEqual(parent)
      }
    })
    f.noReads()
    expect(f.ec.security.access).toEqual(before)
    expect(currentAgentAccess()).toBeUndefined()
  })

  it('explicit IDs do not widen the native Project ceiling or accept model-supplied authority', async () => {
    const f = fixture()
    const catalog = await f.catalog()
    for (const tool of catalog) {
      const input = tool.name === 'prepareProjectHarnessTask' ? taskInput : {}
      expect(await tool.handler({ ...input, projectId: otherId })).toMatchObject({ isError: true })
      expect(await tool.handler({ ...input, userId: otherId, authority: { approved: true } })).toMatchObject({ isError: true, structuredContent: { code: 'invalid_input' } })
    }
    f.noReads()
  })

  it('rechecks authority before reads and withholds a protected completed result after revocation', async () => {
    const pre = fixture()
    const [tool] = await pre.catalog()
    pre.revoke()
    expect(await tool.handler({})).toMatchObject({ isError: true, structuredContent: { code: 'operation_interrupted' } })
    pre.noReads()
    const post = fixture()
    const [postTool] = await post.catalog()
    post.store.lineage.mockImplementation(async () => { post.revoke(); return [revision] })
    const result = await postTool.handler({})
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result)).not.toContain('Current authorized rule')
    expect(post.store.lineage).toHaveBeenCalledOnce()
    expect(post.context.scopeAccumulator!.evidence.projectIds).toEqual([projectId])
  })

  it('rejects a mismatched canonical actor or authority without trusting legacy fields', async () => {
    const f = fixture()
    const [tool] = await f.catalog()
    f.admission.context = { ...f.context, userId: otherId, workspaceActorUserId: userId }
    expect(await tool.handler({})).toMatchObject({ isError: true })
    f.admission.context = { ...f.context, authority: { assertCurrent: vi.fn(async () => {}), execute: async work => work() } }
    expect(await tool.handler({})).toMatchObject({ isError: true, structuredContent: { code: 'authority_unavailable' } })
    f.noReads()
  })
})
