import { describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator, type ToolContext } from '@use-brian/core'
import { createProjectHarnessTools, type ProjectHarnessToolsOptions } from '../tools.js'
import type { HarnessApproval, HarnessRun } from '../execution-contracts.js'
import type { HarnessDefinition, HarnessRevision, HarnessScope, ProjectProduct } from '../contracts.js'
import { currentAgentAccess, runWithAgentAccess } from '../../db/agent-access-context.js'

const userId = '20000000-0000-4000-8000-000000000001'
const workspaceId = '20000000-0000-4000-8000-000000000002'
const projectId = '20000000-0000-4000-8000-000000000003'
const productId = '20000000-0000-4000-8000-000000000004'
const componentId = '20000000-0000-4000-8000-000000000005'
const revisionId = '20000000-0000-4000-8000-000000000006'
const approvalId = '20000000-0000-4000-8000-000000000007'
const otherId = '20000000-0000-4000-8000-000000000008'
const scope: HarnessScope = { kind: 'project' }
const scenario = { key: 'accept', title: 'Accept change', preconditions: ['Signed in'], steps: ['Observe result'],
  criteria: [{ key: 'visible', observation: 'Correct result visible', evidence: 'Screenshot or observation' }] }
const definition: HarnessDefinition = { schemaVersion: 1,
  rules: [{ key: 'implementation', kind: 'invariant', value: 'IMPLEMENTATION_SECRET', override: false }],
  codeChecks: [{ key: 'unit', kind: 'unit', instructions: 'Implement unit tests', command: 'COMMAND_NOT_TO_RUN' }], acceptanceScenarios: [scenario] }
const revision: HarnessRevision = { id: revisionId, workspaceId, projectId, scope, revision: 1, definition, createdBy: userId, createdAt: '2026-01-01T00:00:00Z' }
const approval: HarnessApproval = { id: approvalId, workspaceId, projectId, revisionId, approvedBy: userId, approvedAt: revision.createdAt, reason: 'Reviewed acceptance' }
const product: ProjectProduct = { id: productId, workspaceId, projectId, name: 'Frontend', description: 'NOT_IN_SCOPE_LIST', status: 'active', revision: 1, createdAt: revision.createdAt, updatedAt: revision.createdAt }
const tree = { products: [product], components: [{ ...product, id: componentId, productId, name: 'Calendar' }] }
const names = ['getProjectHarnessContext', 'listProjectHarnessScopes', 'selectProjectHarnessTests', 'getProjectHarnessAcceptance']
function fixture() {
  const store = { lineage: vi.fn().mockResolvedValue([revision]), tree: vi.fn().mockResolvedValue(tree),
    definition: vi.fn().mockResolvedValue(revision), history: vi.fn().mockResolvedValue([revision]) }
  const execution = { approvals: vi.fn().mockResolvedValue([approval]), runs: vi.fn().mockResolvedValue([]) }
  const snapshot = vi.fn().mockResolvedValue({ tree, revisions: [revision] })
  const options: ProjectHarnessToolsOptions = { store, execution, snapshot }
  const tools = createProjectHarnessTools(options)
  const authority = { assertCurrent: vi.fn().mockResolvedValue(undefined), execute: async <T>(work: () => Promise<T>) => work() }
  const context: ToolContext = { userId: otherId, workspaceActorUserId: userId, workspaceId, activeProjectId: projectId,
    assistantId: otherId, sessionId: otherId, appId: 'test', channelType: 'web', channelId: 'test', authority, abortSignal: new AbortController().signal,
    scopeAccumulator: new ContextScopeAccumulator() }
  const invoke = (name: string, input: Record<string, unknown> = {}, ctx = context) => tools.find(t => t.name === name)!.execute(input, ctx)
  return { store, execution, snapshot, tools, authority, context, invoke }
}

describe('native/MCP harness read tools', () => {
  it('publishes five concurrency-safe, read-only tools and no write/approval/executor', () => {
    const { tools } = fixture()
    expect(tools.map(t => t.name)).toEqual([names[0], 'prepareProjectHarnessTask', ...names.slice(1)])
    for (const tool of tools) {
      expect(tool.isReadOnly).toBe(true)
      expect(tool.isConcurrencySafe).toBe(true)
      expect(tool.requiresConfirmation).toBe(false)
      expect(tool.description.length).toBeGreaterThan(50)
      expect(tool.inputSchema.parse(tool.name === 'prepareProjectHarnessTask' ? { prompt: 'Implement', runtimeProject: 'frontend' } : {})).toMatchObject({ scope: { kind: 'project' } })
    }
  })
  it.each(names)('%s rejects injected identity, authority, definitions, approval claims and malformed scopes', async name => {
    const f = fixture()
    for (const input of [{ workspaceId }, { userId }, { actor: userId }, { definition }, { approved: true }, { fresh: true },
      { scope: { kind: 'project', componentId } }, { scope: { kind: 'component', componentId } }, { scope: { kind: 'product', productId, extra: true } }]) {
      expect(await f.invoke(name, input)).toMatchObject({ isError: true, data: { error: 'harness_invalid_input' } })
    }
    expect(f.store.lineage).not.toHaveBeenCalled()
    expect(f.store.tree).not.toHaveBeenCalled()
    expect(f.store.definition).not.toHaveBeenCalled()
    expect(f.execution.approvals).not.toHaveBeenCalled()
    expect(f.snapshot).not.toHaveBeenCalled()
  })
  it('gets canonical context + prompt and records internal Project evidence without granting source access', async () => {
    const f = fixture()
    const before = { ...f.context }
    const result = await f.invoke(names[0])
    expect(result).toMatchObject({ data: { context: { projectId, scope, status: 'resolved' }, prompt: expect.stringContaining('actual unit tests and integration tests') },
      scopeEvidence: { sensitivity: 'internal', projectIds: [projectId], compartments: [`project:${projectId}`] } })
    expect(f.context.scopeAccumulator!.evidence).toMatchObject(result.scopeEvidence!)
    expect(f.store.lineage).toHaveBeenCalledExactlyOnceWith(userId, workspaceId, projectId, scope)
    expect(f.snapshot).not.toHaveBeenCalled()
    expect(f.store.tree).not.toHaveBeenCalled()
    expect(f.context.authority).toBe(before.authority)
    expect(f.context.activeProjectId).toBe(before.activeProjectId)
    expect(f.context).not.toHaveProperty('projectIds')
  })
  it('uses explicit project/scope or authenticated programmatic actor, never the billed owner', async () => {
    const f = fixture()
    f.store.lineage.mockResolvedValue([])
    const target = { kind: 'component', productId, componentId }
    await f.invoke(names[0], { projectId: otherId, scope: target }, { ...f.context, workspaceActorUserId: undefined,
      programmaticPrincipal: { kind: 'oauth_token', credentialId: otherId, userId } })
    expect(f.store.lineage).toHaveBeenCalledWith(userId, workspaceId, otherId, target)
    for (const patch of [{ workspaceActorUserId: undefined }, { workspaceId: undefined }, { authority: undefined }, { systemRead: true }, { activeProjectId: null }]) {
      expect(await f.invoke(names[0], {}, { ...f.context, ...patch })).toMatchObject({ isError: true })
    }
    expect(f.store.lineage).toHaveBeenCalledTimes(1)
  })
  it.each(names)('%s checks authority before storage and withholds data on post-read revocation', async name => {
    const pre = fixture()
    pre.authority.assertCurrent.mockRejectedValue(new Error('REVOKED_SECRET'))
    expect(await pre.invoke(name)).toEqual({ isError: true, data: { error: 'harness_unavailable' } })
    expect(pre.store.lineage).not.toHaveBeenCalled()
    expect(pre.store.tree).not.toHaveBeenCalled()
    expect(pre.snapshot).not.toHaveBeenCalled()
    expect(pre.execution.approvals).not.toHaveBeenCalled()
    const post = fixture()
    const revoke = () => post.authority.assertCurrent.mockRejectedValue(new Error('REVOKED_SECRET'))
    post.store.lineage.mockImplementation(async () => { revoke(); return [revision] })
    post.store.tree.mockImplementation(async () => { revoke(); return tree })
    post.snapshot.mockImplementation(async () => { revoke(); return { tree, revisions: [revision] } })
    post.execution.approvals.mockImplementation(async () => { revoke(); return [approval] })
    expect(await post.invoke(name)).toEqual({ isError: true, data: { error: 'harness_unavailable' } })
    expect(post.store.definition).not.toHaveBeenCalled()
  })
  it.each(names)('%s returns internal Project evidence even for empty results', async name => {
    const f = fixture()
    f.store.lineage.mockResolvedValue([])
    f.execution.approvals.mockResolvedValue([])
    const result = await f.invoke(name)
    expect(result.isError).not.toBe(true)
    expect(result.scopeEvidence).toEqual({ sensitivity: 'internal', projectIds: [projectId], compartments: [`project:${projectId}`] })
    expect(f.context.scopeAccumulator!.evidence).toMatchObject(result.scopeEvidence!)
  })
  it('lists metadata without definitions and excludes sibling scopes for a component', async () => {
    const f = fixture()
    f.store.tree.mockResolvedValue({ ...tree, components: [...tree.components, { ...tree.components[0], id: otherId, name: 'SIBLING' }] })
    const result = await f.invoke(names[1], { scope: { kind: 'component', productId, componentId } })
    expect(result).toMatchObject({ data: { scopes: [{ scope: { kind: 'component', productId, componentId }, name: 'Calendar' }] } })
    expect(JSON.stringify(result)).not.toContain('SIBLING')
    expect(JSON.stringify(result)).not.toContain('NOT_IN_SCOPE_LIST')
    expect(f.store.lineage).not.toHaveBeenCalled()
    expect(await f.invoke(names[1], { scope: { kind: 'component', productId: otherId, componentId } })).toMatchObject({ isError: true })
  })
  it('selects tests from the authorized snapshot, no definitions from arguments or command execution', async () => {
    const f = fixture()
    const access = { workspaceId, userId, clearance: 'internal', compartments: [`project:${projectId}`], projectIds: [projectId] }
    await runWithAgentAccess(access, async () => {
      const original = currentAgentAccess()
      f.snapshot.mockImplementation(async (u, w, p) => {
        expect([u, w, p]).toEqual([userId, workspaceId, projectId]); expect(currentAgentAccess()).toEqual(original)
        return { tree, revisions: [revision] }
      })
      expect(await f.invoke(names[2])).toMatchObject({ data: { impact: { status: 'ready', codeChecks: [{ command: 'COMMAND_NOT_TO_RUN' }] }, notice: expect.stringContaining('No commands executed') } })
      expect(currentAgentAccess()).toEqual(original)
    })
    expect(f.store.definition).not.toHaveBeenCalled()
    f.snapshot.mockResolvedValue({ tree, revisions: [revision] })
    expect(await f.invoke(names[2], { scopes: [scope], changedSources: [{ repository: 'app', path: 'a.ts' }] })).toMatchObject({ isError: true })
    expect(await f.invoke(names[2], { changedSources: [{ repository: 'app', path: 'unmapped.ts' }] })).toMatchObject({ data: { impact: { status: 'blocked', uncovered: [{ reason: 'no_source_mapping' }] } } })
  })
  it('acceptance returns only server-approved revision/scenario and optional run metadata, not implementation context', async () => {
    const f = fixture()
    const run = { id: otherId, workspaceId, projectId, approvalId, revisionId, executor: 'human', status: 'passed',
      createdAt: revision.createdAt, startedAt: null, expiresAt: revision.createdAt, completedAt: null,
      preview: { implementationPrompt: 'PREVIEW_SECRET' }, result: { data: 'RESULT_SECRET' }, requestedBy: userId } as unknown as HarnessRun
    f.execution.runs.mockResolvedValue([run])
    const result = await f.invoke(names[3], { approvalId, scenarioKey: scenario.key, includeRuns: true })
    expect(result).toMatchObject({ data: { status: 'available', approval, revision: { id: revisionId, revision: 1 }, scenarios: [scenario], runs: [{ id: otherId, status: 'passed' }] } })
    for (const secret of ['IMPLEMENTATION_SECRET', 'COMMAND_NOT_TO_RUN', 'PREVIEW_SECRET', 'RESULT_SECRET', '"prompt"']) expect(JSON.stringify(result)).not.toContain(secret)
    expect(f.execution.approvals).toHaveBeenCalledWith(userId, workspaceId, projectId, scope)
    expect(f.store.history).toHaveBeenCalledWith(userId, workspaceId, projectId, scope)
    expect(f.store.lineage).not.toHaveBeenCalled()
    expect(f.authority.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(8)
  })
  it('does not manufacture approval or a scenario from client flags; historical approval does not approve a new head', async () => {
    const f = fixture()
    f.store.definition.mockResolvedValue({ ...revision, id: otherId, revision: 2 })
    expect(await f.invoke(names[3])).toMatchObject({ data: { status: 'unavailable', reason: 'approved_revision_unavailable', scenarios: [] } })
    expect(f.execution.runs).not.toHaveBeenCalled()
    expect(await f.invoke(names[3], { approvalId, scenarioKey: 'missing' })).toMatchObject({ isError: true, data: { error: 'harness_not_found' } })
    expect(await f.invoke(names[3], { approvalId: otherId })).toMatchObject({ isError: true, data: { error: 'harness_not_found' } })
    expect(await f.invoke(names[3], { approvalId, approved: true })).toMatchObject({ isError: true })
  })
  it('prepares exact sidanCode context from the explicit scope, never launching or copying hidden history', async () => {
    const f = fixture()
    const target = { kind: 'component' as const, productId, componentId }
    const child = { ...revision, id: otherId, scope: target, definition: { ...definition, rules: [{ key: 'width', kind: 'local' as const, value: 'Calendar local width', override: false }] } }
    f.snapshot.mockResolvedValue({ tree, revisions: [revision, child] })
    const result = await f.invoke('prepareProjectHarnessTask', { prompt: 'Fix calendar', runtimeProject: 'configured-frontend', scope: target })
    expect(result).toMatchObject({ data: { status: 'prepared', toolName: 'new_task_with_context', arguments: {
      prompt: 'Fix calendar', context: { project: 'configured-frontend', product: 'Frontend',
        constraints: [expect.stringContaining('Calendar local width'), expect.stringContaining('impact_selected_coding_test_plan')],
        verification: expect.stringContaining('Coding/test review only'), references: [expect.stringContaining(revisionId), expect.stringContaining(otherId)] },
    }, binding: { projectId, scope: target }, notice: expect.stringContaining('no task started') } })
    const encoded = JSON.stringify(result)
    expect(encoded).toContain('IMPLEMENTATION_SECRET')
    expect(encoded).toContain('contract tests')
    for (const key of ['"conversation":', '"cwd":', '"authority":']) expect(encoded).not.toContain(key)
    expect(f.store.lineage).not.toHaveBeenCalled()
    expect(f.store.tree).not.toHaveBeenCalled()
    expect(f.execution.approvals).not.toHaveBeenCalled()
    expect(f.snapshot).toHaveBeenCalledExactlyOnceWith(userId, workspaceId, projectId)
  })
  it('preparation rejects caller-authored contracts, missing runtime selection, conflicts and unconfigured scopes', async () => {
    const f = fixture()
    const valid = { prompt: 'Implement', runtimeProject: 'frontend' }
    for (const input of [{ prompt: 'Implement' }, { ...valid, context: { constraints: ['replace'] } }, { ...valid, runtimeProject: '../private' },
      { ...valid, verification: 'approved' }, { ...valid, cwd: '/elsewhere' }, { ...valid, prompt: 'bad\0text' }]) {
      expect(await f.invoke('prepareProjectHarnessTask', input)).toMatchObject({ isError: true, data: { error: 'harness_invalid_input' } })
    }
    expect(f.store.lineage).not.toHaveBeenCalled()
    f.snapshot.mockResolvedValue({ tree, revisions: [] })
    expect(await f.invoke('prepareProjectHarnessTask', valid)).toMatchObject({ isError: true, data: { error: 'harness_context_unconfigured' } })
    f.snapshot.mockResolvedValue({ tree, revisions: [{ ...revision, definition: { ...definition, rules: [{ ...definition.rules[0], override: true }] } }] })
    expect(await f.invoke('prepareProjectHarnessTask', valid)).toMatchObject({ isError: true, data: { error: 'harness_context_conflicted' } })
  })
  it('rejects CJK results before the executor could truncate the successful context/prompt pair', async () => {
    const f = fixture()
    f.store.lineage.mockResolvedValue([{ ...revision, definition: { ...definition, rules: Array.from({ length: 4 }, (_, i) => ({
      key: `cjk-${i}`, kind: 'invariant', value: '漢'.repeat(3500), override: false,
    })) } }])
    expect(await f.invoke(names[0])).toMatchObject({ isError: true, data: { error: 'harness_context_too_large' } })
    expect(f.context.scopeAccumulator!.evidence.projectIds).toEqual([projectId])
  })
  it('rejects foreign rows instead of treating them as evidence or authority', async () => {
    const f = fixture()
    f.execution.approvals.mockResolvedValue([{ ...approval, workspaceId: otherId }])
    expect(await f.invoke(names[3])).toMatchObject({ isError: true })
    expect(f.store.definition).not.toHaveBeenCalled()
    f.store.tree.mockResolvedValue({ products: [{ ...product, projectId: otherId }], components: [] })
    expect(await f.invoke(names[1])).toMatchObject({ isError: true })
  })
})
