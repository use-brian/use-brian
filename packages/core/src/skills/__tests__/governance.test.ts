import { describe, it, expect } from 'vitest'
import {
  shouldActivateSkill,
  bornConfidence,
  bornActivated,
  bornVerified,
  nextUsageConfidence,
  SKILL_ACTIVATION_THRESHOLD,
  SKILL_SELF_BORN_CONFIDENCE,
  SKILL_USAGE_CONFIDENCE_INCREMENT,
  SKILL_USAGE_CONFIDENCE_CAP,
} from '../governance.js'

describe('[COMP:skills/activation-governance] shouldActivateSkill', () => {
  it('authored skills are always active', () => {
    expect(shouldActivateSkill({ inductionSource: 'authored', humanConfirmed: false })).toBe(true)
  })

  it('human-confirmed skills are active regardless of source', () => {
    expect(shouldActivateSkill({ inductionSource: 'ingested', humanConfirmed: true })).toBe(true)
    expect(shouldActivateSkill({ inductionSource: 'self', humanConfirmed: true })).toBe(true)
  })

  it('self skills are born active (approval gate admits them as usable)', () => {
    expect(shouldActivateSkill({ inductionSource: 'self', humanConfirmed: false })).toBe(true)
  })

  it('ingested skills NEVER activate without human confirmation (poisoning defense)', () => {
    expect(shouldActivateSkill({ inductionSource: 'ingested', humanConfirmed: false })).toBe(false)
  })
})

describe('[COMP:skills/activation-governance] graded confidence', () => {
  it('birth confidence: authored certified, self medium, ingested zero', () => {
    expect(bornConfidence('authored')).toBe(SKILL_ACTIVATION_THRESHOLD)
    expect(bornConfidence('self')).toBe(SKILL_SELF_BORN_CONFIDENCE)
    expect(bornConfidence('ingested')).toBe(0.0)
  })

  it('only authored is born certified/verified; self is admitted but uncertified', () => {
    expect(bornVerified('authored')).toBe(true)
    expect(bornVerified('self')).toBe(false)
    expect(bornVerified('ingested')).toBe(false)
  })

  it('authored + self are born active; ingested is born suggested', () => {
    expect(bornActivated('authored')).toBe(true)
    expect(bornActivated('self')).toBe(true)
    expect(bornActivated('ingested')).toBe(false)
  })

  it('usage nudges confidence up slightly', () => {
    expect(nextUsageConfidence(SKILL_SELF_BORN_CONFIDENCE)).toBeCloseTo(
      SKILL_SELF_BORN_CONFIDENCE + SKILL_USAGE_CONFIDENCE_INCREMENT,
    )
  })

  it('usage can never reach the certified threshold — it caps below full trust', () => {
    let c = SKILL_SELF_BORN_CONFIDENCE
    for (let i = 0; i < 100; i++) c = nextUsageConfidence(c)
    expect(c).toBe(SKILL_USAGE_CONFIDENCE_CAP)
    expect(c).toBeLessThan(SKILL_ACTIVATION_THRESHOLD)
  })

  it('the usage cap is strictly below the certified threshold', () => {
    expect(SKILL_USAGE_CONFIDENCE_CAP).toBeLessThan(SKILL_ACTIVATION_THRESHOLD)
  })
})
