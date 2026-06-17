import { describe, it, expect } from 'vitest'
import {
  shouldActivateSkill,
  SKILL_ACTIVATION_THRESHOLD,
  SKILL_REDERIVATION_INCREMENT,
} from '../governance.js'

describe('[COMP:skills/activation-governance] shouldActivateSkill', () => {
  it('authored skills are always active', () => {
    expect(shouldActivateSkill({ inductionSource: 'authored', confidence: 0, humanConfirmed: false })).toBe(true)
  })

  it('human-confirmed skills are active regardless of source', () => {
    expect(shouldActivateSkill({ inductionSource: 'ingested', confidence: 0, humanConfirmed: true })).toBe(true)
    expect(shouldActivateSkill({ inductionSource: 'self', confidence: 0, humanConfirmed: true })).toBe(true)
  })

  it('ingested skills NEVER activate without human confirmation (poisoning defense)', () => {
    expect(shouldActivateSkill({ inductionSource: 'ingested', confidence: 99, humanConfirmed: false })).toBe(false)
  })

  it('self skills activate only when confidence reaches the threshold', () => {
    expect(
      shouldActivateSkill({ inductionSource: 'self', confidence: SKILL_ACTIVATION_THRESHOLD, humanConfirmed: false }),
    ).toBe(true)
    expect(
      shouldActivateSkill({
        inductionSource: 'self',
        confidence: SKILL_ACTIVATION_THRESHOLD - SKILL_REDERIVATION_INCREMENT,
        humanConfirmed: false,
      }),
    ).toBe(false)
  })

  it('two independent re-derivations reach the activation threshold', () => {
    expect(SKILL_REDERIVATION_INCREMENT * 2).toBeGreaterThanOrEqual(SKILL_ACTIVATION_THRESHOLD)
  })
})
