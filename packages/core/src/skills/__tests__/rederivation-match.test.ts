import { describe, it, expect } from 'vitest'
import { matchInducedSkill } from '../rederivation-match.js'

const existing = [
  {
    rowId: 'r1',
    slug: 'weekly-investor-update',
    name: 'Weekly Investor Update',
    whenToUse: 'when sending the weekly investor email',
  },
]

describe('[COMP:skills/rederivation-match] matchInducedSkill', () => {
  it('matches on exact slug regardless of name', () => {
    expect(
      matchInducedSkill({ slug: 'weekly-investor-update', name: 'Totally Different Name' }, existing)?.rowId,
    ).toBe('r1')
  })

  it('matches on high name + trigger similarity', () => {
    expect(
      matchInducedSkill(
        {
          slug: 'weekly-inv-update',
          name: 'Weekly Investor Updates',
          whenToUse: 'when sending the weekly investor email',
        },
        existing,
      )?.rowId,
    ).toBe('r1')
  })

  it('does NOT match a clearly different skill', () => {
    expect(matchInducedSkill({ slug: 'daily-standup', name: 'Daily Standup Summary' }, existing)).toBeNull()
  })

  it('does NOT match same name but different trigger (collision guard)', () => {
    expect(
      matchInducedSkill(
        { slug: 'x', name: 'Weekly Investor Update', whenToUse: 'when onboarding a new engineer' },
        existing,
      ),
    ).toBeNull()
  })

  it('returns null when there are no existing skills', () => {
    expect(matchInducedSkill({ slug: 's', name: 'n' }, [])).toBeNull()
  })
})
