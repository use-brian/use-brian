import { describe, expect, it } from 'vitest'
import { bindScopeSource, boundScopeSource } from '../source-evidence.js'
import { ContextScopeAccumulator, scopeEvidenceFromRows } from '../context-scope.js'
import { deriveResourceScope, type ScopeSource } from '../derived-scope.js'

const source = (): ScopeSource => ({ workspaceId: 'fixture-workspace', userId: null,
  assistantId: null, sensitivity: 'confidential', compartments: ['finance'], projectIds: [],
  resourceKind: 'memory', resourceId: 'fixture-memory', version: '1' })

describe('[COMP:security/source-evidence] canonical reader bindings', () => {
  it('carries source evidence through nested results without adding serialized fields', () => {
    const row = bindScopeSource({ summary: 'A protected fact' }, source())
    expect(JSON.stringify(row)).toBe('{"summary":"A protected fact"}')
    const evidence = scopeEvidenceFromRows([{ results: [row] }])
    expect(evidence).toMatchObject({ sensitivity: 'confidential', compartments: ['finance'], sources: [source()] })
    const accumulator = new ContextScopeAccumulator()
    accumulator.note(evidence)
    expect(accumulator.evidence.sources).toEqual([source()])
  })

  it('does not trust source-shaped fields in user content', () => {
    const forged = { scopeSource: source(), sources: [source()], resourceKind: 'memory', resourceId: 'fixture-memory', version: '1' }
    expect(boundScopeSource(forged)).toBeUndefined()
    expect(scopeEvidenceFromRows([forged]).sources).toBeUndefined()
  })

  it('does not transfer a binding by cloning, spreading or serializing content', () => {
    const row = bindScopeSource({ summary: 'A fact', scopeSource: source() }, source())
    for (const copy of [{ ...row }, structuredClone(row), JSON.parse(JSON.stringify(row))]) {
      expect(boundScopeSource(copy)).toBeUndefined()
      expect(scopeEvidenceFromRows([copy]).sources).toBeUndefined()
    }
  })

  it('keeps source snapshots independent of caller mutation', () => {
    const input = source(), row = bindScopeSource({}, input)
    input.compartments.length = 0
    const output = boundScopeSource(row)!
    output.compartments.length = 0
    expect(boundScopeSource(row)?.compartments).toEqual(['finance'])
  })

  it('rejects missing canonical axes rather than inventing General', () => {
    expect(() => bindScopeSource({}, { ...source(), projectIds: undefined } as unknown as ScopeSource)).toThrow('scope_evidence_missing')
    expect(() => bindScopeSource({}, { ...source(), version: '' })).toThrow('scope_evidence_missing')
  })

  it('notes a repeated object once and safely traverses cycles', () => {
    const row = bindScopeSource({ self: null as unknown }, source())
    row.self = row
    expect(scopeEvidenceFromRows([row, row]).sources).toEqual([source()])
  })

  it('keeps every partition\'s private visibility for the derived write to judge', () => {
    const first = bindScopeSource({}, { ...source(), userId: 'first-user' })
    const second = bindScopeSource({}, { ...source(), resourceId: 'other-memory', userId: 'second-user' })
    const evidence = scopeEvidenceFromRows([first, second])
    expect(evidence.sources?.map(s => s.userId)).toEqual(['first-user', 'second-user'])
    expect(() => deriveResourceScope({ producer: 'turn', sources: evidence.sources! }))
      .toThrow('scope_visibility_incompatible')
  })
})
