import { describe, expect, it } from 'vitest'
import { ContextScopeAccumulator, resolveWriteScope } from '../context-scope.js'
import { deriveResourceScope, resourceScopeKey, type ScopeSource } from '../derived-scope.js'

const source = (overrides: Partial<ScopeSource> = {}): ScopeSource => ({
  resourceKind: 'memory', resourceId: 'source-a', version: 'v1',
  workspaceId: 'workspace-a', userId: null, assistantId: null,
  sensitivity: 'internal', compartments: [], projectIds: [], ...overrides,
})
const derive = (...sources: ScopeSource[]) => deriveResourceScope({ producer: 'consolidation', sources })

describe('[COMP:security/derived-scope] complete evidence for derived content', () => {
  it('retains every input restriction, including an uncited previous pattern', () => {
    const inputs = [
      source({ compartments: ['team:product'], projectIds: ['project-a'] }),
      source({ resourceId: 'uncited-pattern', sensitivity: 'confidential', compartments: ['team:finance'], projectIds: ['project-b'] }),
    ]
    expect(derive(...inputs)).toEqual({
      workspaceId: 'workspace-a', userId: null, assistantId: null,
      sensitivity: 'confidential', compartments: ['team:finance', 'team:product'],
      projectIds: ['project-a', 'project-b'],
    })
    expect(derive(...inputs.slice().reverse())).toEqual(derive(...inputs))
  })

  it('accepts explicit General and does not treat it as a widening instruction', () => {
    expect(derive(source()).compartments).toEqual([])
    expect(derive(source(), source({ resourceId: 'b', compartments: ['team:finance'] })).compartments)
      .toEqual(['team:finance'])
  })

  it.each(['workspaceId', 'userId', 'assistantId', 'sensitivity', 'compartments', 'projectIds', 'resourceKind', 'resourceId', 'version'])
    ('refuses a missing %s instead of assuming General', (field) => {
      const incomplete = source()
      delete (incomplete as unknown as Record<string, unknown>)[field]
      expect(() => derive(incomplete)).toThrow('scope_evidence_missing')
    })

  it('rejects empty evidence, unrecognized tiers, and malformed labels at runtime', () => {
    expect(() => derive()).toThrow('scope_evidence_missing')
    expect(() => derive(source({ sensitivity: 'toString' as 'internal' }))).toThrow('scope_evidence_missing')
    expect(() => derive(source({ compartments: [''] }))).toThrow('scope_evidence_missing')
    expect(() => deriveResourceScope({ producer: '', sources: [source()] })).toThrow('scope_evidence_missing')
  })

  it('intersects personal and assistant visibility without widening either', () => {
    expect(derive(source({ userId: 'user-a' }), source({ resourceId: 'b', assistantId: 'assistant-a' })))
      .toMatchObject({ userId: 'user-a', assistantId: 'assistant-a' })
    expect(() => derive(source({ userId: 'user-a' }), source({ resourceId: 'b', userId: 'user-b' })))
      .toThrow('scope_visibility_incompatible')
    expect(() => derive(source({ assistantId: 'a' }), source({ resourceId: 'b', assistantId: 'b' })))
      .toThrow('scope_visibility_incompatible')
  })

  it('rejects cross-workspace inputs even when their department names match', () => {
    expect(() => derive(source(), source({ workspaceId: 'workspace-b' }))).toThrow('scope_workspace_mismatch')
  })

  it('refuses different snapshots of the same source and deduplicates equal snapshots', () => {
    expect(() => derive(source(), source({ version: 'v2' }))).toThrow('scope_source_changed')
    expect(() => derive(source(), source({ compartments: ['team:finance'] }))).toThrow('scope_source_changed')
    expect(derive(source(), source())).toEqual(derive(source()))
  })

  it('allows requested narrowing but cannot downgrade an inherited envelope', () => {
    const evidence = source({ userId: 'a', sensitivity: 'confidential', compartments: ['team:finance'] })
    expect(deriveResourceScope({ producer: 'copy', sources: [evidence] }, source({ sensitivity: 'public', compartments: ['team:product'] })))
      .toMatchObject({ userId: 'a', sensitivity: 'confidential', compartments: ['team:finance', 'team:product'] })
  })

  it('buckets on every authority dimension with stable sorted sets', () => {
    const original = source({ compartments: ['b', 'a', 'a'], projectIds: ['z', 'y'] })
    expect(resourceScopeKey(original)).toEqual(resourceScopeKey({ ...original, compartments: ['a', 'b'], projectIds: ['y', 'z'] }))
    for (const variant of [
      source({ workspaceId: 'b' }), source({ userId: 'b' }), source({ assistantId: 'b' }),
      source({ sensitivity: 'confidential' }), source({ compartments: ['b'] }), source({ projectIds: ['b'] }),
    ]) expect(resourceScopeKey(variant)).not.toEqual(resourceScopeKey(source()))
  })

  it('snapshots accumulated evidence and fails atomically on incompatible input', () => {
    const accumulator = new ContextScopeAccumulator()
    const original = source({ userId: 'a', compartments: ['team:finance'] })
    accumulator.noteSource(original)
    original.compartments.length = 0
    expect(accumulator.evidence.sources?.[0].compartments).toEqual(['team:finance'])
    expect(() => accumulator.noteSource(source({ resourceId: 'b', userId: 'b', sensitivity: 'confidential' })))
      .toThrow('scope_visibility_incompatible')
    expect(accumulator.sensitivity).toBe('internal')
    expect(accumulator.evidence.sources).toHaveLength(1)
    const snapshot = accumulator.evidence
    snapshot.sources![0].compartments.push('unexpected')
    expect(accumulator.evidence.sources![0].compartments).toEqual(['team:finance'])
  })

  it('the ordinary write resolver also enforces full evidence over partial labels', () => {
    expect(resolveWriteScope({ evidence: { sensitivity: 'public',compartments: [],
      sources: [source({ sensitivity: 'confidential',compartments: ['team:finance'] })],
    } })).toEqual({ sensitivity: 'confidential',compartments: ['team:finance'],projectIds: [] })
  })
})
