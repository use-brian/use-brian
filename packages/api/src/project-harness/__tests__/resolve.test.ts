import { describe, expect, it } from 'vitest'
import { harnessDefinitionSchema, harnessScopeSchema, putHarnessDefinitionSchema, updateEngineeringNodeSchema,
  type HarnessDefinition, type HarnessRevision, type HarnessRule, type HarnessScope } from '../contracts.js'
import { resolveHarness, scopeLineage } from '../resolve.js'

const workspaceId = '10000000-0000-4000-8000-000000000001'
const projectId = '10000000-0000-4000-8000-000000000002'
const productId = '10000000-0000-4000-8000-000000000003'
const componentId = '10000000-0000-4000-8000-000000000004'
const root: HarnessScope = { kind: 'project' }
const product: HarnessScope = { kind: 'product', productId }
const component: HarnessScope = { kind: 'component', productId, componentId }
const target = { workspaceId, projectId, scope: component }
const empty = (): HarnessDefinition => ({ schemaVersion: 1, rules: [], codeChecks: [], acceptanceScenarios: [] })
const rule = (key: string, value: string, kind: HarnessRule['kind'] = 'default', override = false): HarnessRule => ({ key, value, kind, override })
function revision(scope: HarnessScope, rules: HarnessRule[] = []): HarnessRevision {
  return { id: scope.kind === 'project' ? projectId : scope.kind === 'product' ? productId : componentId,
    workspaceId, projectId, scope, revision: 1, definition: { ...empty(), rules }, createdBy: null, createdAt: '2026-11-18T00:00:00Z' }
}
const resolve = (rows: HarnessRevision[], scope: HarnessScope = component) => resolveHarness({ ...target, scope }, rows)
const scenario = { key: 'booking', title: 'Book a date', preconditions: ['Signed in'], steps: ['Choose available date'],
  criteria: [{ key: 'confirmed', observation: 'Booking confirmed', evidence: 'Confirmation screenshot' }] }

describe('[COMP:api/project-harness] scope contracts', () => {
  it('requires a complete typed ancestry and rejects extra actor/context fields', () => {
    expect(harnessScopeSchema.safeParse({ kind: 'component', componentId }).success).toBe(false)
    expect(harnessScopeSchema.safeParse({ kind: 'project', productId }).success).toBe(false)
    expect(putHarnessDefinitionSchema.safeParse({ scope: root, expectedRevision: 0, definition: empty(), actor: workspaceId }).success).toBe(false)
  })
  it('requires revisions, accepts zero only for harness creation and rejects empty updates', () => {
    expect(putHarnessDefinitionSchema.safeParse({ scope: root, definition: empty() }).success).toBe(false)
    expect(putHarnessDefinitionSchema.safeParse({ scope: root, expectedRevision: 0, definition: empty() }).success).toBe(true)
    expect(updateEngineeringNodeSchema.safeParse({ expectedRevision: 0, name: 'Frontend' }).success).toBe(false)
    expect(updateEngineeringNodeSchema.safeParse({ expectedRevision: 1 }).success).toBe(false)
  })
  it.each(['rules', 'codeChecks', 'acceptanceScenarios'] as const)('rejects duplicate %s keys within one scope', field => {
    const sample = field === 'rules' ? rule('width', '300px') : field === 'codeChecks' ? { key: 'unit', kind: 'unit', instructions: 'Write tests' } : scenario
    expect(harnessDefinitionSchema.safeParse({ ...empty(), [field]: [sample, sample] }).success).toBe(false)
  })
  it('rejects duplicate, missing or non-observable acceptance criteria', () => {
    for (const criteria of [[], [scenario.criteria[0], scenario.criteria[0]], [{ key: 'ok', observation: '', evidence: '' }]]) {
      expect(harnessDefinitionSchema.safeParse({ ...empty(), acceptanceScenarios: [{ ...scenario, criteria }] }).success).toBe(false)
    }
  })
  it('does not accept an approval claim or executable arbitrary test kind', () => {
    expect(harnessDefinitionSchema.safeParse({ ...empty(), approved: true }).success).toBe(false)
    expect(harnessDefinitionSchema.safeParse({ ...empty(), codeChecks: [{ key: 'all', kind: 'shell', instructions: 'Run it' }] }).success).toBe(false)
  })
  it.each(['\u0000', '\uD800', '\uDC00'])('rejects text PostgreSQL JSON cannot represent', value => {
    expect(harnessDefinitionSchema.safeParse({ ...empty(), rules: [rule('width', value)] }).success).toBe(false)
  })
  it('bounds total definition text budget as well as individual fields', () => {
    expect(harnessDefinitionSchema.safeParse({ ...empty(), rules: Array.from({ length: 40 }, (_, i) => rule(`rule-${i}`, 'x'.repeat(4000))) }).success).toBe(false)
  })
})

describe('[COMP:api/project-harness] deterministic inheritance', () => {
  it('orders definitions Project → Product → Component regardless of storage order', () => {
    const result = resolve([revision(component, [rule('date.width', '300px', 'local')]), revision(root, [rule('security', 'Required', 'invariant')]), revision(product, [rule('font', 'Inter')])])
    expect(result.sources.map(s => s.scope.kind)).toEqual(['project', 'product', 'component'])
    expect(result.rules.map(r => r.key)).toEqual(['security', 'font', 'date.width'])
    expect(result.status).toBe('resolved')
  })
  it('allows explicit default specialization and records the winning origin', () => {
    const result = resolve([revision(product, [rule('control.width', '240px')]), revision(component, [rule('control.width', '300px', 'local', true)])])
    expect(result.rules[0]).toMatchObject({ value: '300px', origin: { scope: component } })
    expect(result.conflicts).toEqual([])
  })
  it('refuses implicit specialization instead of last-writer-wins', () => {
    const result = resolve([revision(product, [rule('width', '240px')]), revision(component, [rule('width', '300px', 'local')])])
    expect(result.status).toBe('conflicted')
    expect(result.conflicts[0].reason).toBe('override_required')
    expect(result.rules[0].value).toBe('240px')
  })
  it.each(['invariant', 'default', 'local'] as const)('refuses weakening an invariant using %s', kind => {
    const result = resolve([revision(root, [rule('accessibility', 'Required', 'invariant')]), revision(component, [rule('accessibility', 'Optional', kind, true)])])
    expect(result.conflicts[0].reason).toBe('invariant_override')
    expect(result.rules[0].value).toBe('Required')
  })
  it('deduplicates an unchanged invariant without changing its provenance', () => {
    const result = resolve([revision(root, [rule('a11y', 'Required', 'invariant')]), revision(component, [rule('a11y', 'Required', 'invariant')])])
    expect(result.conflicts).toEqual([])
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0].origin.scope.kind).toBe('project')
  })
  it('reports an override with no inherited default', () => {
    expect(resolve([revision(component, [rule('width', '300px', 'local', true)])]).conflicts[0].reason).toBe('override_without_default')
  })
  it('keeps local rules at their exact scope, without accidental inheritance', () => {
    const row = revision(product, [rule('overview.width', '1200px', 'local')])
    expect(resolve([row]).rules).toEqual([])
    expect(resolve([row], product).rules[0].key).toBe('overview.width')
  })
  it('never lets calendar rules affect the logo or the frontend root', () => {
    const calendar = revision(component, [rule('date.width', '300px', 'local')])
    expect(() => resolve([calendar], { ...component, componentId: projectId })).toThrow('harness_lineage_invalid')
    expect(() => resolve([calendar], product)).toThrow('harness_lineage_invalid')
    expect(resolve([revision(product)], { ...component, componentId: projectId }).rules).toEqual([])
  })
  it('rejects foreign workspace/project/product ancestry and duplicate heads', () => {
    const row = revision(component)
    for (const bad of [{ ...row, workspaceId: projectId }, { ...row, projectId: workspaceId },
      { ...row, scope: { ...component, productId: projectId } }]) {
      expect(() => resolve([bad])).toThrow('harness_lineage_invalid')
    }
    expect(() => resolve([row, row])).toThrow('harness_lineage_invalid')
  })
  it('keeps checks and acceptance scenarios additive and source-qualified', () => {
    const parent = revision(product), child = revision(component)
    for (const row of [parent, child]) {
      row.definition.codeChecks = [{ key: 'unit', kind: 'unit', instructions: 'Prepare tests' }]
      row.definition.acceptanceScenarios = [structuredClone(scenario)]
    }
    const result = resolve([parent, child])
    expect(result.codeChecks).toHaveLength(2)
    expect(result.acceptanceScenarios.map(s => s.origin.scope.kind)).toEqual(['product', 'component'])
  })
  it('clones input payloads and permits scopes with no definitions', () => {
    const row = revision(component, [rule('width', '300px')])
    row.definition.acceptanceScenarios = [structuredClone(scenario)]
    const result = resolve([row])
    result.acceptanceScenarios[0].steps[0] = 'Changed'
    expect(row.definition.acceptanceScenarios[0].steps[0]).toBe('Choose available date')
    expect(resolve([])).toMatchObject({ status: 'resolved', sources: [], rules: [], conflicts: [] })
    expect(scopeLineage(component)).toEqual([root, product, component])
  })
})
