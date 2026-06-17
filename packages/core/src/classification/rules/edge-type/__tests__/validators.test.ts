import { describe, expect, it } from 'vitest'

import { validateEdgeKindTriple } from '../validators.js'

describe('[COMP:classification/edge-type] validateEdgeKindTriple', () => {
  it('works_at(person → company) passes', () => {
    expect(validateEdgeKindTriple('works_at', 'person', 'company').ok).toBe(true)
  })

  it('works_at(company → company) rejects', () => {
    const r = validateEdgeKindTriple('works_at', 'company', 'company')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.rule_id).toBe('validate-works-at-requires-person-company')
    }
  })

  it('works_at(person → project) rejects', () => {
    expect(validateEdgeKindTriple('works_at', 'person', 'project').ok).toBe(false)
  })

  it('depends_on(repository → repository) passes', () => {
    expect(validateEdgeKindTriple('depends_on', 'repository', 'repository').ok).toBe(true)
  })

  it('depends_on(project → repository) rejects (different kinds)', () => {
    expect(validateEdgeKindTriple('depends_on', 'project', 'repository').ok).toBe(false)
  })

  it('unknown edge_type passes by default (permissive when no rule)', () => {
    expect(validateEdgeKindTriple('mentioned', 'person', 'project').ok).toBe(true)
  })
})
