/**
 * Unit tests for the budget-aware skill listing formatter.
 * Component tag: [COMP:skills/listing].
 *
 * Verifies formatSkillListing: the empty case, the `- id: description`
 * shape, the `description — whenToUse` join, multi-skill newlining,
 * per-entry truncation at MAX_ENTRY_CHARS, and the over-budget path that
 * re-truncates every description to fit SKILL_LISTING_BUDGET_CHARS.
 */

import { describe, it, expect } from 'vitest'
import {
  formatSkillListing,
  MAX_ENTRY_CHARS,
  SKILL_LISTING_BUDGET_CHARS,
} from '../listing.js'
import type { SkillMeta } from '../types.js'

function skill(over: Partial<SkillMeta> = {}): SkillMeta {
  return {
    id: 'skill-1',
    name: 'Skill One',
    description: 'Does a thing.',
    category: 'custom',
    requiresConnectors: [],
    source: 'builtin',
    ...over,
  }
}

describe('[COMP:skills/listing] formatSkillListing', () => {
  it('returns an empty string for no skills', () => {
    expect(formatSkillListing([])).toBe('')
  })

  it('formats a single skill as "- id: description"', () => {
    expect(formatSkillListing([skill({ id: 'a', description: 'Does A.' })])).toBe('- a: Does A.')
  })

  it('joins description and whenToUse with an em-dash', () => {
    const out = formatSkillListing([
      skill({ id: 'a', description: 'Does A.', whenToUse: 'when you need A' }),
    ])
    expect(out).toBe('- a: Does A. — when you need A')
  })

  it('newline-joins multiple skills', () => {
    const out = formatSkillListing([
      skill({ id: 'a', description: 'Does A.' }),
      skill({ id: 'b', description: 'Does B.' }),
    ])
    expect(out).toBe('- a: Does A.\n- b: Does B.')
  })

  it('truncates an over-long entry at MAX_ENTRY_CHARS with an ellipsis', () => {
    const out = formatSkillListing([skill({ id: 'a', description: 'd'.repeat(300) })])
    const descPart = out.slice('- a: '.length)
    expect(descPart.length).toBe(MAX_ENTRY_CHARS)
    expect(descPart.endsWith('…')).toBe(true)
  })

  it('re-truncates every entry when the full listing exceeds the budget', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      skill({ id: `skill-${String(i).padStart(2, '0')}`, description: 'd'.repeat(300) }),
    )
    const out = formatSkillListing(many)
    // Budget path engaged: 25×~262 chars naive would be ~6500 — well over.
    expect(out.length).toBeLessThanOrEqual(SKILL_LISTING_BUDGET_CHARS)
    // No skills dropped — every row is re-truncated, not removed.
    expect(out.split('\n')).toHaveLength(25)
  })
})
