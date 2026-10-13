import { describe, expect, it } from 'vitest'
import {
  ContextScopeAccumulator,
  ContextScopeViolation,
  canonicalScopeGrant,
  createdRowEvidence,
  intersectScopeGrants,
  normalizeProjectName,
  resolveWriteScope,
  scopeEvidenceFromRows,
  scopeGrantContains,
  unionScopeRequirements,
} from '../context-scope.js'
import { bindScopeSource } from '../source-evidence.js'
import type { ScopeSource } from '../derived-scope.js'

describe('[COMP:security/context-scope] Team and Project scope algebra', () => {
  it('uses null as universe and [] as General-only', () => {
    expect(intersectScopeGrants(null, ['sales', 'finance'])).toEqual(['finance', 'sales'])
    expect(intersectScopeGrants(null, null)).toBeNull()
    expect(intersectScopeGrants([], null)).toEqual([])
    expect(scopeGrantContains(null, ['team:sales'])).toBe(true)
    expect(scopeGrantContains([], [])).toBe(true)
    expect(scopeGrantContains([], ['team:sales'])).toBe(false)
  })

  it('intersects member, assistant, and session grants without hierarchy', () => {
    expect(intersectScopeGrants(
      ['team:sales', 'team:strategy'],
      ['team:sales', 'team:finance'],
      ['team:sales'],
    )).toEqual(['team:sales'])
  })

  it('uses all-of row requirements and stable canonical order', () => {
    expect(scopeGrantContains(['finance', 'sales'], ['sales', 'finance'])).toBe(true)
    expect(scopeGrantContains(['sales'], ['sales', 'finance'])).toBe(false)
    expect(unionScopeRequirements(['sales'], ['finance', 'sales'])).toEqual(['finance', 'sales'])
    expect(canonicalScopeGrant(['sales', 'finance', 'sales'])).toEqual(['finance', 'sales'])
  })

  it('accumulates sensitivity, Team, and Project evidence monotonically', () => {
    const accumulator = new ContextScopeAccumulator()
    accumulator.note({ sensitivity: 'internal', compartments: ['team:sales'], projectIds: ['p-1'] })
    accumulator.note({ sensitivity: 'confidential', compartments: ['team:finance'], projectIds: ['p-2', 'p-1'] })
    accumulator.note({ sensitivity: 'public', compartments: [], projectIds: [] })

    expect(accumulator.max).toBe('confidential')
    expect(accumulator.compartments).toEqual(['team:finance', 'team:sales'])
    expect(accumulator.projectIds).toEqual(['p-1', 'p-2'])
  })

  it('unions defaults, explicit narrowing, and evidence into writes', () => {
    const accumulator = new ContextScopeAccumulator()
    accumulator.note({ sensitivity: 'confidential', compartments: ['team:source'], projectIds: ['p-source'] })

    expect(resolveWriteScope({
      sensitivity: 'internal',
      baseCompartments: ['team:default'],
      baseProjectIds: ['p-default'],
      explicitCompartments: [],
      explicitProjectIds: ['p-explicit'],
      evidence: accumulator,
      compartmentGrant: null,
      projectGrant: null,
    })).toEqual({
      sensitivity: 'confidential',
      compartments: ['team:default', 'team:source'],
      projectIds: ['p-default', 'p-explicit', 'p-source'],
    })
  })

  it('rejects inherited writes outside the effective Team or Project grant', () => {
    expect(() => resolveWriteScope({
      evidence: { compartments: ['team:finance'] },
      compartmentGrant: ['team:sales'],
      projectGrant: null,
    })).toThrow(ContextScopeViolation)
    expect(() => resolveWriteScope({
      evidence: { projectIds: ['p-2'] },
      compartmentGrant: null,
      projectGrant: ['p-1'],
    })).toThrow(/project scope is not granted/i)
  })

  it('matches the migration project normalizer', () => {
    expect(normalizeProjectName('  Project Atlas  ')).toBe('project atlas')
    expect(normalizeProjectName('')).toBe('')
  })
})

describe('[COMP:security/context-scope] re-reading a source within one turn', () => {
  const read = (version: string, compartments: string[]): ScopeSource => ({
    workspaceId: 'ws', userId: 'u', assistantId: null, sensitivity: 'internal',
    compartments, projectIds: [], resourceKind: 'workspace_file', resourceId: 'file-1', version,
  })

  it('accepts the newer version a tool returns after its own write, keeping the earlier labels', () => {
    const accumulator = new ContextScopeAccumulator()
    accumulator.noteSource(read('1', ['team:sales']))
    // fileRead then fileSetMeta: the tool result re-notes the same file.
    expect(() => accumulator.noteSource(read('2', []))).not.toThrow()
    expect(accumulator.evidence.sources?.map((s) => s.version)).toEqual(['2'])
    expect(accumulator.compartments).toEqual(['team:sales'])
  })
})

describe('[COMP:security/context-scope] a created row is not a read source', () => {
  // A personal note the model saved during a workspace room turn used to come
  // back as a source the turn had READ. The room's delivery check then refused
  // the finished answer for user_visibility (2026-10-12): the turn's own
  // output made the turn undeliverable.
  it('keeps the created row labels and drops its source', () => {
    const memory = bindScopeSource(
      { id: 'm-1', summary: 'note', sensitivity: 'confidential', compartments: ['team:a'], projectIds: ['p-1'] },
      {
        workspaceId: 'w-1', resourceKind: 'memory', resourceId: 'm-1', version: '1',
        userId: 'u-1', assistantId: null, sensitivity: 'confidential', compartments: ['team:a'], projectIds: ['p-1'],
      },
    )
    expect(scopeEvidenceFromRows([memory]).sources).toHaveLength(1)
    const created = createdRowEvidence([memory])
    expect(created.sources).toBeUndefined()
    expect(created).toMatchObject({ sensitivity: 'confidential', compartments: ['team:a'], projectIds: ['p-1'] })
  })
})
