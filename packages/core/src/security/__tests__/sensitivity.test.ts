import { describe, it, expect } from 'vitest'
import {
  RANK,
  SensitivityAccumulator,
  canRead,
  isSensitivity,
  maxSensitivity,
  minSensitivity,
  researchWriteFloor,
} from '../sensitivity.js'

describe('[COMP:security/sensitivity] Sensitivity utilities', () => {
  describe('RANK', () => {
    it('orders public < internal < confidential', () => {
      expect(RANK.public).toBeLessThan(RANK.internal)
      expect(RANK.internal).toBeLessThan(RANK.confidential)
    })
  })

  describe('isSensitivity', () => {
    it('accepts all three tiers', () => {
      expect(isSensitivity('public')).toBe(true)
      expect(isSensitivity('internal')).toBe(true)
      expect(isSensitivity('confidential')).toBe(true)
    })

    it('rejects unknown strings and non-strings', () => {
      expect(isSensitivity('secret')).toBe(false)
      expect(isSensitivity('')).toBe(false)
      expect(isSensitivity(null)).toBe(false)
      expect(isSensitivity(undefined)).toBe(false)
      expect(isSensitivity(2)).toBe(false)
    })
  })

  describe('maxSensitivity', () => {
    it('returns public for empty input', () => {
      expect(maxSensitivity()).toBe('public')
    })

    it('returns the single value when only one is passed', () => {
      expect(maxSensitivity('internal')).toBe('internal')
    })

    it('returns the highest tier across inputs', () => {
      expect(maxSensitivity('public', 'internal')).toBe('internal')
      expect(maxSensitivity('internal', 'public')).toBe('internal')
      expect(maxSensitivity('public', 'confidential', 'internal')).toBe('confidential')
    })
  })

  describe('minSensitivity', () => {
    it('returns confidential (highest) for empty input — a missing arg never widens access', () => {
      expect(minSensitivity()).toBe('confidential')
    })

    it('returns the single value when only one is passed', () => {
      expect(minSensitivity('internal')).toBe('internal')
    })

    it('returns the lowest (most-restrictive) tier across inputs', () => {
      // The read-side clearance use: min(member, assistant).
      expect(minSensitivity('internal', 'confidential')).toBe('internal')
      expect(minSensitivity('confidential', 'internal')).toBe('internal')
      expect(minSensitivity('public', 'confidential')).toBe('public')
      expect(minSensitivity('confidential', 'confidential')).toBe('confidential')
    })
  })

  describe('canRead', () => {
    it('lets clearance read equal-or-lower tiers only', () => {
      expect(canRead('public', 'public')).toBe(true)
      expect(canRead('public', 'internal')).toBe(false)
      expect(canRead('public', 'confidential')).toBe(false)

      expect(canRead('internal', 'public')).toBe(true)
      expect(canRead('internal', 'internal')).toBe(true)
      expect(canRead('internal', 'confidential')).toBe(false)

      expect(canRead('confidential', 'public')).toBe(true)
      expect(canRead('confidential', 'internal')).toBe(true)
      expect(canRead('confidential', 'confidential')).toBe(true)
    })
  })

  describe('SensitivityAccumulator', () => {
    it('starts at public', () => {
      const acc = new SensitivityAccumulator()
      expect(acc.max).toBe('public')
    })

    it('upgrades on note()', () => {
      const acc = new SensitivityAccumulator()
      acc.note('internal')
      expect(acc.max).toBe('internal')
    })

    it('never downgrades', () => {
      const acc = new SensitivityAccumulator()
      acc.note('confidential')
      acc.note('public')
      acc.note('internal')
      expect(acc.max).toBe('confidential')
    })

    it('ignores null/undefined', () => {
      const acc = new SensitivityAccumulator()
      acc.note('internal')
      acc.note(null)
      acc.note(undefined)
      expect(acc.max).toBe('internal')
    })
  })

  describe('researchWriteFloor', () => {
    it('passes the accumulator max through on a normal (non-research) turn', () => {
      expect(researchWriteFloor('public')).toBe('public')
      expect(researchWriteFloor('internal')).toBe('internal')
      expect(researchWriteFloor('confidential')).toBe('confidential')
      expect(researchWriteFloor('internal', false)).toBe('internal')
    })

    it('defaults a missing accumulator to public', () => {
      expect(researchWriteFloor(undefined)).toBe('public')
      expect(researchWriteFloor(null)).toBe('public')
      expect(researchWriteFloor(undefined, true)).toBe('public')
    })

    it('drops internal-tier orientation reads to public in research mode', () => {
      // The reported bug: brain-first reads bump the accumulator to internal,
      // over-stamping public web findings. Research provenance is public web.
      expect(researchWriteFloor('internal', true)).toBe('public')
      expect(researchWriteFloor('public', true)).toBe('public')
    })

    it('keeps confidential as a hard floor even in research mode', () => {
      // Never launder a confidential source into a public research note.
      expect(researchWriteFloor('confidential', true)).toBe('confidential')
    })
  })
})
