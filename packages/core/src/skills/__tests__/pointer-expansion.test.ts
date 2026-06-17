/**
 * Unit tests for the Mustache `{{kind:name}}` pointer expansion (V2 S10).
 *
 * Verifies the three kinds (reference / template / script), the missing-
 * file fallback, no-pointer pass-through, deterministic order with
 * repeated pointers, and the dangling-pointer detection helper.
 */

import { describe, it, expect } from 'vitest'
import {
  expandPointers,
  expandSkillPointers,
  extractPointers,
  filterByState,
  POINTER_RE,
  type SkillFileLookup,
} from '../loader.js'
import type { SkillContent } from '../types.js'

function makeLookup(
  rows: Array<{ kind: 'reference' | 'template' | 'script'; name: string; content: string }>,
): SkillFileLookup {
  const map = new Map<string, (typeof rows)[number]>()
  for (const r of rows) map.set(`${r.kind}:${r.name}`, r)
  return {
    async getByPointer(_workspaceSkillId, p) {
      return map.get(`${p.kind}:${p.name}`) ?? null
    },
  }
}

describe('[COMP:skills/pointer-expansion] extractPointers', () => {
  it('returns empty list when no pointers present', () => {
    expect(extractPointers('plain markdown body')).toEqual([])
  })

  it('finds a single reference pointer', () => {
    const out = extractPointers('See {{reference:oauth-flow}} for details.')
    expect(out).toEqual([
      { kind: 'reference', name: 'oauth-flow', raw: '{{reference:oauth-flow}}' },
    ])
  })

  it('finds all three kinds in one body', () => {
    const body =
      'Use {{template:weekly-status.md}} and run {{script:clear-oauth.sh}}. ' +
      'Then read {{reference:oauth-error-recovery}}.'
    const ptrs = extractPointers(body)
    expect(ptrs.map((p) => p.kind)).toEqual(['template', 'script', 'reference'])
  })

  it('tolerates whitespace inside the braces', () => {
    const out = extractPointers('Use {{ template : foo.yaml }} now.')
    expect(out).toEqual([
      { kind: 'template', name: 'foo.yaml', raw: '{{ template : foo.yaml }}' },
    ])
  })

  it('resets lastIndex between calls (regex state hygiene)', () => {
    // The POINTER_RE is module-level + /g — extractPointers must reset
    // lastIndex or successive calls will yield empty results.
    extractPointers('{{reference:a}}')
    const second = extractPointers('{{reference:a}}')
    expect(second.length).toBe(1)
    expect(POINTER_RE.lastIndex).toBe(0) // restored
  })

  it('does NOT match unknown pointer kinds', () => {
    expect(extractPointers('{{foo:bar}}')).toEqual([])
    expect(extractPointers('{{prompt:x}}')).toEqual([])
  })
})

describe('[COMP:skills/pointer-expansion] expandPointers', () => {
  it('returns body unchanged when no pointers', async () => {
    const lookup = makeLookup([])
    const body = 'Just plain markdown.'
    const out = await expandPointers('skill-1', body, lookup)
    expect(out).toBe(body)
  })

  it('substitutes reference content inline', async () => {
    const lookup = makeLookup([
      { kind: 'reference', name: 'oauth-flow', content: 'OAUTH FLOW STEPS' },
    ])
    const body = 'See {{reference:oauth-flow}} for details.'
    const out = await expandPointers('skill-1', body, lookup)
    expect(out).toBe('See OAUTH FLOW STEPS for details.')
  })

  it('substitutes template content inline', async () => {
    const lookup = makeLookup([
      { kind: 'template', name: 'weekly.yaml', content: 'tone: friendly' },
    ])
    const body = 'Use {{template:weekly.yaml}} as the starter.'
    const out = await expandPointers('skill-1', body, lookup)
    expect(out).toBe('Use tone: friendly as the starter.')
  })

  it('wraps script content in a comment header (V2 content-only)', async () => {
    const lookup = makeLookup([
      { kind: 'script', name: 'clear-oauth.sh', content: '#!/bin/sh\necho hi' },
    ])
    const body = 'Run {{script:clear-oauth.sh}} before retrying.'
    const out = await expandPointers('skill-1', body, lookup)
    expect(out).toContain('<!-- script: clear-oauth.sh -->')
    expect(out).toContain('#!/bin/sh')
    expect(out).toContain('echo hi')
  })

  it("renders a comment when the pointer target is missing", async () => {
    const lookup = makeLookup([]) // empty store
    const body = 'See {{reference:missing-file}}.'
    const out = await expandPointers('skill-1', body, lookup)
    expect(out).toBe(`See <!-- support file 'reference:missing-file' missing -->.`)
  })

  it('substitutes the same pointer in multiple positions deterministically', async () => {
    const lookup = makeLookup([
      { kind: 'reference', name: 'note', content: 'XX' },
    ])
    const body = 'Top: {{reference:note}}. Bottom: {{reference:note}}.'
    const out = await expandPointers('skill-1', body, lookup)
    expect(out).toBe('Top: XX. Bottom: XX.')
  })

  it('mixes substituted and missing pointers in one body', async () => {
    const lookup = makeLookup([
      { kind: 'reference', name: 'have', content: 'OK' },
    ])
    const body = '{{reference:have}} and {{template:missing.yaml}}.'
    const out = await expandPointers('skill-1', body, lookup)
    expect(out).toContain('OK')
    expect(out).toContain(`<!-- support file 'template:missing.yaml' missing -->`)
  })
})

describe('[COMP:skills/pointer-expansion] expandSkillPointers', () => {
  function makeSkill(content: string): SkillContent {
    return {
      id: 'oauth-recovery',
      name: 'OAuth Recovery',
      description: 'recovery steps',
      category: 'custom',
      requiresConnectors: [],
      source: 'user',
      content,
    }
  }

  it('returns the skill unchanged when no workspaceSkillId is provided', async () => {
    const skill = makeSkill('See {{reference:x}}.')
    const out = await expandSkillPointers(skill, null, makeLookup([]))
    expect(out).toBe(skill)
  })

  it('returns the skill unchanged when no lookup is provided', async () => {
    const skill = makeSkill('See {{reference:x}}.')
    const out = await expandSkillPointers(skill, 'skill-1', null)
    expect(out).toBe(skill)
  })

  it('returns a new object with expanded content', async () => {
    const skill = makeSkill('See {{reference:x}}.')
    const lookup = makeLookup([{ kind: 'reference', name: 'x', content: 'EXPANDED' }])
    const out = await expandSkillPointers(skill, 'skill-1', lookup)
    expect(out).not.toBe(skill)
    expect(out.content).toBe('See EXPANDED.')
    expect(out.id).toBe(skill.id) // identity fields preserved
  })

  it('returns the original object when no pointers were present', async () => {
    const skill = makeSkill('Plain body.')
    const lookup = makeLookup([{ kind: 'reference', name: 'x', content: 'EXPANDED' }])
    const out = await expandSkillPointers(skill, 'skill-1', lookup)
    expect(out).toBe(skill) // referentially equal — no substitution happened
  })
})

describe('[COMP:skills/pointer-expansion] filterByState', () => {
  type RowShape = { id: string; state: 'active' | 'stale' | 'archived' }
  const rows: RowShape[] = [
    { id: 'a', state: 'active' },
    { id: 'b', state: 'stale' },
    { id: 'c', state: 'archived' },
  ]

  it("defaults to keeping 'active' and 'stale'", () => {
    expect(filterByState(rows).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it("accepts an explicit ['active'] filter", () => {
    expect(filterByState(rows, ['active']).map((r) => r.id)).toEqual(['a'])
  })

  it("accepts ['archived'] for the recently-archived UI surface", () => {
    expect(filterByState(rows, ['archived']).map((r) => r.id)).toEqual(['c'])
  })

  it('returns an empty list when the filter excludes everything', () => {
    expect(filterByState([], ['active'])).toEqual([])
  })
})
