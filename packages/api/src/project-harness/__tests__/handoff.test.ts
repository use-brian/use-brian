import { createExecutionContext, executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { type ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import type { HarnessDefinition, HarnessProjectSnapshot, HarnessRevision, HarnessScope, ProjectProduct } from '../contracts.js'
import type { HarnessCodingTestPlan, prepareHarnessTask } from '../handoff.js'
import { createProjectHarnessTools } from '../tools.js'
import { currentAgentAccess, runWithAgentAccess } from '../../db/agent-access-context.js'

const id = (n: number) => `41000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const userId = id(1), workspaceId = id(2), projectId = id(3), frontendId = id(4), backendId = id(5)
const calendarId = id(6), logoId = id(7), apiId = id(8)
const project: HarnessScope = { kind: 'project' }
const frontend: HarnessScope = { kind: 'product', productId: frontendId }
const backend: HarnessScope = { kind: 'product', productId: backendId }
const calendar: HarnessScope = { kind: 'component', productId: frontendId, componentId: calendarId }
const logo: HarnessScope = { kind: 'component', productId: frontendId, componentId: logoId }
const api: HarnessScope = { kind: 'component', productId: backendId, componentId: apiId }
const now = '2026-01-01T00:00:00Z'
const empty = (): HarnessDefinition => ({ schemaVersion: 1, rules: [], codeChecks: [], acceptanceScenarios: [] })
const scenario = { key: 'accept', title: 'Calendar receives availability', preconditions: ['Test deployment and account available'],
  steps: ['Choose a date'], criteria: [{ key: 'available', observation: 'Availability appears', evidence: 'Observed response and screenshot' }] }
function node(nodeId: string, name: string): ProjectProduct {
  return { id: nodeId, name, description: null, workspaceId, projectId, revision: 1, status: 'active', createdAt: now, updatedAt: now }
}
function row(n: number, scope: HarnessScope, patch: Partial<HarnessDefinition>): HarnessRevision {
  return { id: id(n), workspaceId, projectId, scope, revision: 1, definition: { ...empty(), ...patch }, createdBy: userId, createdAt: now }
}
function fixture() {
  const revisions = [
    row(11, project, { rules: [{ key: 'security', kind: 'invariant', value: 'Authorize requests', override: false }],
      codeChecks: [{ key: 'baseline', kind: 'unit', instructions: 'Run baseline checks' }] }),
    row(12, frontend, { codeChecks: [{ key: 'browser', kind: 'integration', instructions: 'Exercise Frontend integration' }] }),
    row(13, backend, { rules: [{ key: 'backend', kind: 'default', value: 'Backend standards', override: false }] }),
    row(14, calendar, { rules: [{ key: 'width', kind: 'local', value: 'CALENDAR_LOCAL_RULE_NOT_API_INSTRUCTION', override: false }],
      codeChecks: [{ key: 'unit', kind: 'unit', instructions: 'Test changed calendar behavior', command: 'pnpm test calendar' }],
      acceptanceScenarios: [scenario], dependencies: [{ scope: api, contract: 'Calendar consumes availability contract' }],
      sourceMappings: [{ repository: 'web', pathPrefix: 'src/calendar' }] }),
    row(15, logo, { rules: [{ key: 'logo', kind: 'local', value: 'UNRELATED_LOGO_RULE', override: false }],
      codeChecks: [{ key: 'logo-test', kind: 'unit', instructions: 'UNRELATED_LOGO_TEST' }], acceptanceScenarios: [{ ...scenario, title: 'UNRELATED_LOGO_SCENARIO' }] }),
    row(16, api, { codeChecks: [{ key: 'contract', kind: 'contract', instructions: 'Test availability response schema', command: 'pnpm test availability-contract' }],
      sourceMappings: [{ repository: 'server', pathPrefix: 'src/availability' }] }),
  ]
  const snapshot: HarnessProjectSnapshot = { tree: { products: [node(frontendId, 'Frontend'), node(backendId, 'Backend')],
    components: [{ ...node(calendarId, 'Calendar Picker'), productId: frontendId }, { ...node(logoId, 'Logo'), productId: frontendId }, { ...node(apiId, 'Availability API'), productId: backendId }] }, revisions }
  const readSnapshot = vi.fn().mockResolvedValue(snapshot)
  const store = { lineage: vi.fn().mockRejectedValue(new Error('Do not mix separate lineage heads')), tree: vi.fn(), definition: vi.fn(), history: vi.fn() }
  const execution = { approvals: vi.fn(), runs: vi.fn() }
  const authority = { assertCurrent: vi.fn(async () => {}), execute: async <T>(work: () => Promise<T>) => work() }
  const ec = createExecutionContext({ identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId }, access: { userId, workspaceId, assistantId: id(9), assistantKind: 'standard', clearance: 'internal',
      compartments: [`project:${projectId}`, `project:${id(99)}`], mutationCompartments: [], projectIds: [projectId, id(99)], visibilityAssistantIds: [id(9)] },
    authority, writeDefaults: { compartments: [], projectIds: [projectId] },
    lifecycle: { sessionId: id(10), channelType: 'web', channelId: 'fixture', abortSignal: new AbortController().signal } })
  const context: ToolContext = { ...executionToolContext(ec, { appId: 'fixture' }), activeProjectId: projectId,
    scopeAccumulator: new ContextScopeAccumulator() }
  const tool = createProjectHarnessTools({ store, execution, snapshot: readSnapshot }).find(t => t.name === 'prepareProjectHarnessTask')!
  const input = { prompt: 'Update availability', runtimeProject: 'operator-checkout', scope: api }
  const invoke = (patch: Record<string, unknown> = {}) => tool.execute({ ...input, ...patch }, context)
  async function prepared(patch: Record<string, unknown> = {}) {
    const result = await invoke(patch)
    expect(result.isError).not.toBe(true)
    const data = result.data as ReturnType<typeof prepareHarnessTask>
    if (data.status !== 'prepared') throw new Error(`Expected prepared, got ${data.status}`)
    const plan = JSON.parse(data.arguments.context.constraints[1].split('\n').slice(1).join('\n')) as HarnessCodingTestPlan & { planId: string }
    return { data, plan }
  }
  return { snapshot, revisions, readSnapshot, store, execution, authority, context, input, invoke, prepared }
}

describe('impact-selected sidanCode coding/review handoff', () => {
  it('passes changed-source impact, ancestor and reverse-dependent tests, but no sibling implementation rules', async () => {
    const f = fixture()
    const changedSources = [{ repository: 'server', path: 'src/availability/schema.ts' }]
    const { data, plan } = await f.prepared({ changedSources })
    expect(plan.selection).toEqual({ changedSources })
    expect(plan.impact.status).toBe('ready')
    expect(plan.impact.codeChecks.map(c => c.key).sort()).toEqual(['baseline', 'browser', 'contract', 'unit'])
    expect(plan.impact.acceptanceScenarios).toMatchObject([{ ...scenario, origin: { revisionId: id(14), scope: calendar },
      qualifiedKey: `component:${frontendId}:${calendarId}/acceptanceScenario/accept` }])
    expect(plan.impact.acceptanceScenarios[0].reasonPaths[0].steps).toContainEqual({ kind: 'reverse_dependency', scope: calendar, contract: 'Calendar consumes availability contract' })
    const encoded = JSON.stringify(data)
    for (const unrelated of ['CALENDAR_LOCAL_RULE_NOT_API_INSTRUCTION', 'UNRELATED_LOGO_RULE', 'UNRELATED_LOGO_TEST', 'UNRELATED_LOGO_SCENARIO']) expect(encoded).not.toContain(unrelated)
    expect(plan.targets).toContainEqual({ scope: calendar, productName: 'Frontend', componentName: 'Calendar Picker',
      sourceMappings: [{ repository: 'web', pathPrefix: 'src/calendar' }] })
    expect(plan.targets).not.toContainEqual(expect.objectContaining({ scope: logo }))
    expect(data.arguments.context.product).toBe('Backend')
    expect(data.arguments.context.project).toBe('operator-checkout')
    expect(data.arguments.context.references).toHaveLength(5)
    expect(data.binding.revisions.map(r => r.revisionId).sort()).toEqual([11, 12, 13, 14, 16].map(id))
    expect(f.readSnapshot).toHaveBeenCalledExactlyOnceWith(userId, workspaceId, projectId)
    expect(f.store.lineage).not.toHaveBeenCalled()
    expect(f.store.tree).not.toHaveBeenCalled()
    expect(f.execution.approvals).not.toHaveBeenCalled()
    expect(f.execution.runs).not.toHaveBeenCalled()
  })
  it('generates nonempty verification bound to the exact plan, with honest per-check and per-criterion review obligations', async () => {
    const { data, plan } = await fixture().prepared()
    const { planId, ...body } = plan
    expect(data.binding.planId).toBe(createHash('sha256').update(JSON.stringify(body)).digest('hex'))
    expect(planId).toBe(data.binding.planId)
    const text = data.arguments.context.verification
    expect(text).toContain(planId)
    for (const phrase of ['actual unit and integration tests', 'contract tests', 'command actually run', 'each criterion', 'blocked or inconclusive', 'empty authored test list', 'request a fresh authorized impact selection', 'same checkout']) expect(text).toContain(phrase)
    const checklist = JSON.parse(text.split('\n').at(-1)!)
    expect(checklist.codeChecks.map((c: { qualifiedKey: string }) => c.qualifiedKey)).toEqual(plan.impact.codeChecks.map(c => c.qualifiedKey))
    expect(checklist.acceptanceScenarios[0].criterionKeys).toEqual(['available'])
    expect(data.notice).toContain('spawned_review_id')
    expect(data.notice).toContain('no task started')
    expect(data.notice).toContain('No Brian run, result or approval is written')
  })
  it('supports explicit impacted scopes, default coding scope, product name and no fictitious project-level product', async () => {
    const f = fixture()
    expect((await f.prepared()).plan.selection).toEqual({ scopes: [api] })
    const explicit = await f.prepared({ scope: calendar, scopes: [calendar] })
    expect(explicit.plan.selection).toEqual({ scopes: [calendar] })
    expect(explicit.data.arguments.context.product).toBe('Frontend')
    expect(explicit.data.arguments.context.constraints[0]).toContain('CALENDAR_LOCAL_RULE_NOT_API_INSTRUCTION')
    const projectOnly = await f.prepared({ scope: project })
    expect(projectOnly.data.arguments.context).not.toHaveProperty('product')
  })
  it.each([
    { changedSources: [], scopes: undefined }, { scopes: [] }, { changedSources: [{ repository: 'server', path: '../escape' }] },
    { changedSources: [{ repository: 'server', path: 'src/availability' }], scopes: [api] },
    { testPlan: { status: 'ready' } }, { impact: { status: 'ready' } }, { verification: 'approved' }, { product: 'Injected name' },
  ])('rejects invalid selection and caller-authored plans/review claims %j', async input => {
    const f = fixture()
    expect(await f.invoke(input)).toMatchObject({ isError: true, data: { error: 'harness_invalid_input' } })
    expect(f.readSnapshot).not.toHaveBeenCalled()
  })
  it('returns actionable blocked impact without handoff arguments for unmapped sources or a mismatched coding scope', async () => {
    const f = fixture()
    const uncovered = await f.invoke({ changedSources: [{ repository: 'server', path: 'not-mapped.ts' }] })
    expect(uncovered).toMatchObject({ data: { status: 'blocked', reason: 'harness_impact_blocked', impact: { uncovered: [{ reason: 'no_source_mapping' }] } } })
    expect(uncovered.data).not.toHaveProperty('arguments')
    const mismatch = await f.invoke({ scopes: [calendar] })
    expect(mismatch).toMatchObject({ data: { status: 'blocked', reason: 'harness_coding_scope_not_impacted' } })
    expect(mismatch.data).not.toHaveProperty('arguments')
  })
  it('blocks unresolved/archived dependencies and reverse-dependent inheritance conflicts without launching review', async () => {
    const f = fixture()
    f.snapshot.tree.components.find(n => n.id === apiId)!.status = 'archived'
    const archived = await f.invoke({ scope: calendar })
    expect(archived).toMatchObject({ data: { status: 'blocked', impact: { unresolvedDependencies: [{ target: api, reason: 'missing_or_archived_scope' }] } } })
    expect(archived.data).not.toHaveProperty('arguments')
    f.snapshot.tree.components.find(n => n.id === apiId)!.status = 'active'
    f.revisions.find(r => r.id === id(14))!.definition.rules = [{ key: 'security', kind: 'local', value: 'Skip authorization', override: true }]
    const conflict = await f.invoke()
    expect(conflict).toMatchObject({ data: { status: 'blocked', impact: { conflicts: [{ conflict: { reason: 'invariant_override' } }] } } })
    expect(conflict.data).not.toHaveProperty('arguments')
  })
  it('uses one coherent snapshot under the original ceiling, retains evidence and withholds output on revocation', async () => {
    const f = fixture()
    const access = { userId, workspaceId, clearance: 'internal', compartments: [`project:${projectId}`], projectIds: [projectId] }
    await runWithAgentAccess(access, async () => {
      const before = currentAgentAccess()
      f.readSnapshot.mockImplementation(async () => {
        expect(currentAgentAccess()).toEqual(before)
        f.authority.assertCurrent.mockRejectedValue(new Error('revoked'))
        return f.snapshot
      })
      expect(await f.invoke()).toMatchObject({ isError: true, data: { error: 'harness_unavailable' } })
      expect(currentAgentAccess()).toEqual(before)
    })
    expect(f.context.scopeAccumulator!.evidence.projectIds).toEqual([projectId])
    expect(f.store.lineage).not.toHaveBeenCalled()
  })
  it('rejects foreign snapshot heads rather than leaking them through the review plan', async () => {
    const f = fixture()
    f.revisions[3].projectId = id(99)
    expect(await f.invoke()).toMatchObject({ isError: true, data: { error: 'harness_unavailable' } })
  })
  it.each(['X', '漢'])('fails explicitly rather than truncating a large impacted-test plan (%s)', async character => {
    const f = fixture()
    f.revisions.find(r => r.id === id(14))!.definition.codeChecks = Array.from({ length: 20 }, (_, i) => ({
      key: `large-${i}`, kind: 'unit', instructions: character.repeat(3000),
    }))
    const result = await f.invoke()
    expect(result).toMatchObject({ isError: true, data: { error: 'harness_context_too_large' } })
    expect(result.data).not.toHaveProperty('arguments')
  })
})
