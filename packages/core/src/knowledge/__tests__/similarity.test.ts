/**
 * Unit tests for the Jaccard word-set similarity primitive.
 * Component tag: [COMP:knowledge/dedup].
 *
 * computeSimilarity is the shared dedup primitive used by the
 * consolidation Light phase and the KB dedup layers. Verifies the
 * identical / disjoint / partial-overlap ratio, the empty-input zero
 * case, case-insensitivity, and whitespace collapsing.
 */

import { describe, it, expect } from 'vitest'
import { computeSimilarity } from '../similarity.js'

describe('[COMP:knowledge/dedup] computeSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(computeSimilarity('the quick brown fox', 'the quick brown fox')).toBe(1)
  })

  it('returns 0 for fully disjoint word sets', () => {
    expect(computeSimilarity('alpha beta', 'gamma delta')).toBe(0)
  })

  it('returns intersection / union for partial overlap', () => {
    // A = {the,quick,brown,fox}, B = {the,slow,brown,turtle}
    // intersection {the,brown} = 2, union = 6 → 1/3
    expect(computeSimilarity('the quick brown fox', 'the slow brown turtle')).toBeCloseTo(1 / 3)
  })

  it('returns 0 when both strings are empty', () => {
    expect(computeSimilarity('', '')).toBe(0)
  })

  it('returns 0 when one string is empty', () => {
    expect(computeSimilarity('alpha beta', '')).toBe(0)
  })

  it('is case-insensitive', () => {
    expect(computeSimilarity('HELLO World', 'hello WORLD')).toBe(1)
  })

  it('collapses runs of whitespace when tokenizing', () => {
    expect(computeSimilarity('alpha   beta', 'alpha\tbeta')).toBe(1)
  })
})
