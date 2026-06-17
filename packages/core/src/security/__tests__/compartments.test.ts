import { describe, it, expect } from 'vitest'
import { CompartmentAccumulator, unionCompartments, subsetCompartments } from '../compartments.js'

describe('[COMP:security/compartments] compartment write helpers', () => {
  describe('CompartmentAccumulator', () => {
    it('starts empty', () => {
      expect(new CompartmentAccumulator().compartments).toEqual([])
    })
    it('unions noted compartments, deduped, ignoring null/undefined/empty', () => {
      const a = new CompartmentAccumulator()
      a.note(['research'])
      a.note(['finance', 'research'])
      a.note(null)
      a.note(undefined)
      a.note([])
      expect(a.compartments.sort()).toEqual(['finance', 'research'])
    })
  })

  describe('unionCompartments', () => {
    it('dedupes the union of all grants, skipping null/empty', () => {
      expect(unionCompartments(['a'], ['a', 'b'], null, undefined, []).sort()).toEqual(['a', 'b'])
    })
    it('returns [] for no inputs', () => {
      expect(unionCompartments()).toEqual([])
    })
  })

  describe('subsetCompartments (write-gate test)', () => {
    it('universe grant (null/undefined) always passes', () => {
      expect(subsetCompartments(null, ['x'])).toBe(true)
      expect(subsetCompartments(undefined, ['x'])).toBe(true)
    })
    it('empty requested always passes (∅ ⊆ anything)', () => {
      expect(subsetCompartments(['a'], [])).toBe(true)
      expect(subsetCompartments([], [])).toBe(true)
      expect(subsetCompartments(['a'], null)).toBe(true)
    })
    it('requested ⊆ grant passes; a key outside the grant fails', () => {
      expect(subsetCompartments(['a', 'b'], ['a'])).toBe(true)
      expect(subsetCompartments(['a', 'b'], ['a', 'b'])).toBe(true)
      expect(subsetCompartments(['a'], ['a', 'b'])).toBe(false)
      expect(subsetCompartments([], ['a'])).toBe(false)
    })
  })
})
