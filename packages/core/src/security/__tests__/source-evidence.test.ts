import { describe, expect, it } from 'vitest'
import { bindScopeSource, boundScopeSource, bindScopeSources, boundScopeSources } from '../source-evidence.js'
import { ContextScopeAccumulator, scopeEvidenceFromRows } from '../context-scope.js'
import { deriveResourceScope, type ScopeSource } from '../derived-scope.js'

const source = (): ScopeSource => ({ workspaceId: 'fixture-workspace', userId: null,
  assistantId: null, sensitivity: 'confidential', compartments: ['finance'], projectIds: [],
  resourceKind: 'memory', resourceId: 'fixture-memory', version: '1' })

describe('[COMP:security/source-evidence] canonical reader bindings', () => {
  it('preserves contributors outside a displayed page without serializing their identities', () => {
    const first = source(), hidden = { ...source(), resourceId: 'aggregate-contributor' }
    const result = bindScopeSources({ records: [{ name: 'Visible fictional row' }], total: '37.25' }, [first,hidden])
    expect(scopeEvidenceFromRows([result]).sources).toEqual([first,hidden])
    expect(() => boundScopeSource(result)).toThrow('scope_evidence_missing')
    expect(JSON.stringify(result)).not.toContain('aggregate-contributor')
    bindScopeSource(result,first); bindScopeSources(result,[])
    expect(boundScopeSources(result)).toEqual([first,hidden])
  })

  it('collects bindings on arrays and terminates cyclic array/object graphs', () => {
    const values: unknown[] = []
    const result = bindScopeSources(values,[source(),{ ...source(),resourceId: 'second-observation' }])
    values.push({ values },result)
    expect(scopeEvidenceFromRows([result]).sources).toEqual(boundScopeSources(result))
  })

  it('keeps older labels when one trusted result is rebound to its newer source version', () => {
    const row = bindScopeSource({},source())
    bindScopeSource(row,{ ...source(),version: '2',sensitivity: 'public',compartments: [] })
    expect(scopeEvidenceFromRows([row])).toMatchObject({ sensitivity: 'confidential',compartments: ['finance'],
      sources: [{ ...source(),version: '2',sensitivity: 'public',compartments: [] }] })
  })

  it('rejects an invalid batch atomically and detaches every accepted input/output snapshot', () => {
    const row = bindScopeSource({},source()), next = { ...source(),resourceId: 'second-observation' }
    expect(() => bindScopeSources(row,[next,{ ...source(),version: '' }])).toThrow('scope_evidence_missing')
    expect(boundScopeSources(row)).toEqual([source()])
    bindScopeSources(row,[next]); next.compartments.length = 0
    const exposed = boundScopeSources(row)
    exposed[1].compartments.length = 0; exposed.length = 0
    expect(boundScopeSources(row)).toEqual([source(),{ ...source(),resourceId: 'second-observation' }])
  })

  it('does not transfer several bindings through a JSON round trip, clone or spread', () => {
    const result = bindScopeSources({ total: 2 },[source(),{ ...source(),resourceId: 'second-observation' }])
    for (const copy of [{ ...result },structuredClone(result),JSON.parse(JSON.stringify(result))]) {
      expect(boundScopeSources(copy)).toEqual([])
      expect(scopeEvidenceFromRows([copy]).sources).toBeUndefined()
    }
  })

  it('preserves distinct private contributors for the derived writer to judge', () => {
    const result = bindScopeSources({ total: 2 },[{ ...source(),userId: 'first-user' },{ ...source(),resourceId: 'second-observation',userId: 'second-user' }])
    const evidence = scopeEvidenceFromRows([result])
    expect(evidence.sources).toHaveLength(2)
    expect(() => deriveResourceScope({ producer: 'aggregate-result',sources: evidence.sources! })).toThrow('scope_visibility_incompatible')
  })

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
