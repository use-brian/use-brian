import { describe, expect, it } from 'vitest'

import {
  BUILTIN_SKILL_GROUPS,
  SKILL_GROUP_MAX_LENGTH,
  UNSORTED_SKILL_GROUP,
  distinctSkillGroups,
  isBuiltinSkillGroup,
  normalizeSkillGroup,
  skillGroupKey,
} from '../skill-groups.js'

describe('[COMP:shared/skill-groups] Normalization', () => {
  it('keeps a workspace-defined name as written', () => {
    expect(normalizeSkillGroup('Gym & Training')).toBe('Gym & Training')
  })

  it('trims and collapses whitespace', () => {
    expect(normalizeSkillGroup('  Gym   &  Training \n')).toBe('Gym & Training')
  })

  it('strips control characters rather than storing them in a heading', () => {
    expect(normalizeSkillGroup('Gym\u0000&\u001fTraining')).toBe('Gym & Training')
  })

  it('folds a built-in onto its canonical slug whatever the casing', () => {
    expect(normalizeSkillGroup('Research')).toBe('research')
    expect(normalizeSkillGroup('  PRODUCTIVITY ')).toBe('productivity')
  })

  // Normalize, never reject: a write path that 400s on an over-long name
  // turns a tidy-up into an outage for whatever caller was already sending it.
  it('caps an over-long name instead of refusing it', () => {
    const long = 'A'.repeat(SKILL_GROUP_MAX_LENGTH + 20)
    expect(normalizeSkillGroup(long)).toHaveLength(SKILL_GROUP_MAX_LENGTH)
  })

  it('reads anything empty or non-string as the unsorted sink', () => {
    for (const value of ['', '   ', null, undefined, 42, {}]) {
      expect(normalizeSkillGroup(value)).toBe(UNSORTED_SKILL_GROUP)
    }
  })
})

describe('[COMP:shared/skill-groups] Identity', () => {
  it('treats case and spacing as the same group, and nothing else', () => {
    expect(skillGroupKey('Gym & Training')).toBe(skillGroupKey('gym  &  training'))
    // Deliberately NOT folded: a wrong merge silently moves a user's skills
    // between headings, and the review dialog can say they are the same.
    expect(skillGroupKey('Gym & Training')).not.toBe(skillGroupKey('Gym and Training'))
  })

  it('knows which groups have translated labels', () => {
    for (const group of BUILTIN_SKILL_GROUPS) expect(isBuiltinSkillGroup(group)).toBe(true)
    expect(isBuiltinSkillGroup('Nutrition')).toBe(false)
  })
})

describe('[COMP:shared/skill-groups] Distinct groups', () => {
  it('collapses same-group spellings and keeps the FIRST as the label', () => {
    expect(distinctSkillGroups(['Nutrition', 'nutrition', 'Gym & Training'])).toEqual([
      'Nutrition',
      'Gym & Training',
    ])
  })

  it('folds an empty value onto the sink rather than dropping it', () => {
    expect(distinctSkillGroups(['Nutrition', null, undefined])).toEqual([
      'Nutrition',
      UNSORTED_SKILL_GROUP,
    ])
  })
})
