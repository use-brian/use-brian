import { describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { loadHarnessContext, MAX_HARNESS_PROMPT_CHARS, renderHarnessContext } from '../context.js'
import type { HarnessDefinition, HarnessRevision, HarnessScope } from '../contracts.js'
import { currentAgentAccess, runWithAgentAccess } from '../../db/agent-access-context.js'

const userId = '10000000-0000-4000-8000-000000000001'
const workspaceId = '10000000-0000-4000-8000-000000000002'
const projectId = '10000000-0000-4000-8000-000000000003'
const productId = '10000000-0000-4000-8000-000000000004'
const componentId = '10000000-0000-4000-8000-000000000005'
const siblingId = '10000000-0000-4000-8000-000000000006'
const scope: HarnessScope = { kind: 'component', productId, componentId }
const empty = (): HarnessDefinition => ({ schemaVersion: 1, rules: [], codeChecks: [], acceptanceScenarios: [] })
function revision(target: HarnessScope, definition: HarnessDefinition = empty()): HarnessRevision {
  return { id: target.kind === 'project' ? projectId : target.kind === 'product' ? productId : target.componentId,
    workspaceId, projectId, scope: target, revision: 1, definition, createdBy: userId, createdAt: '2026-01-01T00:00:00Z' }
}
function fixture(rows: HarnessRevision[] = []) {
  return { userId, workspaceId, projectId, scope, store: { lineage: vi.fn().mockResolvedValue(rows) },
    authority: { assertCurrent: vi.fn().mockResolvedValue(undefined) }, scopeAccumulator: new ContextScopeAccumulator() }
}

describe('canonical harness context', () => {
  it('reads only lineage; includes inherited provenance and only exact target references', async () => {
    const parent = revision({ kind: 'project' }, { ...empty(), rules: [{ key: 'safety', kind: 'invariant', value: 'Preserve access checks', override: false }],
      sourceMappings: [{ repository: 'private-parent', pathPrefix: 'parent' }], dependencies: [{ scope: { kind: 'product', productId }, contract: 'parent-only metadata' }] })
    const child = revision(scope, { ...empty(), sourceMappings: [{ repository: 'app', pathPrefix: 'calendar' }],
      dependencies: [{ scope: { kind: 'component', productId, componentId: siblingId }, contract: 'Public interface reference only' }] })
    const options = fixture([child, parent])
    const result = await loadHarnessContext(options)
    expect(options.store.lineage).toHaveBeenCalledExactlyOnceWith(userId, workspaceId, projectId, scope)
    expect(result.context.effective.sources.map(s => s.scope.kind)).toEqual(['project', 'component'])
    expect(result.context.effective.rules[0].origin.scope).toEqual({ kind: 'project' })
    expect(result.context.sourceMappings).toEqual(child.definition.sourceMappings)
    expect(result.context.dependencies).toEqual(child.definition.dependencies)
    expect(result.prompt).not.toContain('private-parent')
    expect(result.prompt).not.toContain('parent-only metadata')
    expect(result.prompt).toContain('not repository/source ACL grants')
    expect(result.prompt).toContain('actual unit tests and integration tests')
    expect(result.context).not.toHaveProperty('authority')
    expect(options.authority.assertCurrent).toHaveBeenCalledTimes(2)
    expect(options.scopeAccumulator.evidence).toMatchObject({ sensitivity: 'internal', compartments: [`project:${projectId}`], projectIds: [projectId] })
    expect(result.scopeEvidence).toMatchObject(options.scopeAccumulator.evidence)
  })
  it('defaults to project scope and does not label an absent contract ready', async () => {
    const options = fixture()
    const result = await loadHarnessContext({ ...options, scope: undefined })
    expect(options.store.lineage).toHaveBeenCalledWith(userId, workspaceId, projectId, { kind: 'project' })
    expect(result.context.status).toBe('unconfigured')
    expect(result.context.effective.sources).toEqual([])
  })
  it.each([{ kind: 'project', componentId }, { kind: 'component', componentId }, { kind: 'project', authority: true }])('strictly rejects scope %j before storage', async badScope => {
    const options = fixture()
    await expect(loadHarnessContext({ ...options, scope: badScope as HarnessScope })).rejects.toBeDefined()
    expect(options.store.lineage).not.toHaveBeenCalled()
  })
  it('rejects a sibling body instead of leaking it in conflicts or prompt', async () => {
    const options = fixture([revision({ kind: 'component', productId, componentId: siblingId })])
    await expect(loadHarnessContext(options)).rejects.toThrow('harness_lineage_invalid')
  })
  it('discloses structural conflict and retains the inherited invariant', async () => {
    const rule = { key: 'security', kind: 'invariant' as const, value: 'Must authorize', override: false }
    const options = fixture([revision({ kind: 'project' }, { ...empty(), rules: [rule] }),
      revision(scope, { ...empty(), rules: [{ ...rule, value: 'Skip authorization', override: true }] })])
    const { context, prompt } = await loadHarnessContext(options)
    expect(context.status).toBe('conflicted')
    expect(context.effective.conflicts[0].reason).toBe('invariant_override')
    expect(context.effective.rules[0].value).toBe('Must authorize')
    expect(prompt).toContain('Structural conflicts block')
    expect(prompt).not.toContain('"status":"ready"')
  })
  it.each(['pre', 'post'] as const)('does not release context after %s-read revocation', async when => {
    const options = fixture([revision(scope)])
    options.authority.assertCurrent = when === 'pre' ? vi.fn().mockRejectedValue(new Error('revoked'))
      : vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('revoked'))
    await expect(loadHarnessContext(options)).rejects.toThrow('revoked')
    expect(options.store.lineage).toHaveBeenCalledTimes(when === 'pre' ? 0 : 1)
  })
  it('requires a live boundary even with an injected store', async () => {
    const options = fixture()
    await expect(loadHarnessContext({ ...options, authority: undefined! })).rejects.toMatchObject({ code: 'harness_authority_required' })
    expect(options.store.lineage).not.toHaveBeenCalled()
  })
  it('fails explicitly on excess size instead of silently truncating invariants', async () => {
    const options = fixture([revision(scope, { ...empty(), rules: Array.from({ length: 10 }, (_, i) => ({
      key: `invariant-${i}`, kind: 'invariant', value: 'X'.repeat(3000), override: false,
    })) })])
    await expect(loadHarnessContext(options)).rejects.toMatchObject({ code: 'harness_context_too_large' })
    const small = await loadHarnessContext(fixture())
    expect(() => renderHarnessContext(small.context, small.prompt.length - 1)).toThrow()
    expect(() => renderHarnessContext(small.context, MAX_HARNESS_PROMPT_CHARS + 1)).toThrow()
    expect(renderHarnessContext(small.context, small.prompt.length)).toBe(small.prompt)
  })
  it('retains the native access ceiling and treats commands/dependencies as data only', async () => {
    const options = fixture([revision(scope, { ...empty(), codeChecks: [{ key: 'test', kind: 'unit', instructions: 'Review first', command: 'DO_NOT_EXECUTE' }],
      dependencies: [{ scope: { kind: 'component', productId, componentId: siblingId }, contract: 'not a grant' }] })])
    const access = { userId, workspaceId, clearance: 'internal', compartments: [`project:${projectId}`], projectIds: [projectId] }
    await runWithAgentAccess(access, async () => {
      const before = currentAgentAccess()
      const rows = await options.store.lineage()
      options.store.lineage.mockImplementation(async () => { expect(currentAgentAccess()).toEqual(before); return rows })
      const result = await loadHarnessContext(options)
      expect(result.context.effective.codeChecks[0].command).toBe('DO_NOT_EXECUTE')
      expect(result.context.dependencies[0].scope).toEqual({ kind: 'component', productId, componentId: siblingId })
      expect(result.prompt).toContain('nothing here executes automatically')
      expect(currentAgentAccess()).toEqual(before)
    })
    expect(currentAgentAccess()).toBeUndefined()
  })
})
