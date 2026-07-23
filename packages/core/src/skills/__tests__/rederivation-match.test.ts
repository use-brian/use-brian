import { describe, it, expect } from 'vitest'
import { matchInducedSkill, matchSkillAgainstWorkflows } from '../rederivation-match.js'

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

describe('[COMP:skills/rederivation-match] matchSkillAgainstWorkflows', () => {
  const workflows = [
    { id: 'w1', name: 'Daily team standup' },
    { id: 'w2', name: 'Weekly investor digest' },
  ]

  it('matches the canonical mirror shape — "<workflow name> workflow" (containment)', () => {
    expect(
      matchSkillAgainstWorkflows({ name: 'Daily team standup workflow' }, workflows)?.id,
    ).toBe('w1')
  })

  it('matches an exact workflow name', () => {
    expect(matchSkillAgainstWorkflows({ name: 'Weekly investor digest' }, workflows)?.id).toBe('w2')
  })

  it('matches a near-identical name via similarity', () => {
    expect(matchSkillAgainstWorkflows({ name: 'Daily team standups' }, workflows)?.id).toBe('w1')
  })

  it('does NOT match a genuinely different technique name', () => {
    expect(
      matchSkillAgainstWorkflows({ name: 'Paging through GitHub activity' }, workflows),
    ).toBeNull()
  })

  it('does NOT treat a short common word as containment', () => {
    expect(matchSkillAgainstWorkflows({ name: 'Digest' }, workflows)).toBeNull()
  })

  it('returns null on an empty corpus', () => {
    expect(matchSkillAgainstWorkflows({ name: 'Daily team standup workflow' }, [])).toBeNull()
  })
})
