import { describe, expect, it } from 'vitest'
import {
  buildCategorizePrompt,
  existingGroupsOf,
  MAX_NEW_GROUPS_PER_PASS,
  parseCategorySuggestions,
  selectCategorizableSkills,
  type CategorizableSkill,
} from '../categorize.js'

function skill(over: Partial<CategorizableSkill> = {}): CategorizableSkill {
  return {
    rowId: 'row-1',
    name: 'Weekly status',
    description: 'How we write the weekly update',
    whenToUse: 'On Fridays',
    category: 'custom',
    ...over,
  }
}

describe('[COMP:api/skill-categorize] Candidate selection', () => {
  // `custom` is the sink the server writes when nobody said otherwise, so it
  // is the only bucket a bulk action may touch. A skill sitting in
  // `research` was put there by an import declaration or a human, and
  // second-guessing that in bulk is exactly the presumption to avoid.
  it('takes only skills currently in the custom sink', () => {
    const picked = selectCategorizableSkills([
      skill({ rowId: 'a', category: 'custom' }),
      skill({ rowId: 'b', category: 'research' }),
      skill({ rowId: 'c', category: 'productivity' }),
    ])
    expect(picked.map((s) => s.rowId)).toEqual(['a'])
  })

  // A workspace-defined group is a deliberate choice, exactly like a
  // built-in one - only an absent value reads as unsorted.
  it('leaves a workspace-defined group alone and takes a missing one', () => {
    const picked = selectCategorizableSkills([
      skill({ rowId: 'a', category: 'Gym & Training' }),
      skill({ rowId: 'b', category: undefined as unknown as string }),
    ])
    expect(picked.map((s) => s.rowId)).toEqual(['b'])
  })

  // The opt-in wider scope, which is how a library filed under the old coarse
  // buckets can be improved at all: those buckets were, technically, chosen.
  it('takes every skill when the scope is `all`', () => {
    const picked = selectCategorizableSkills(
      [
        skill({ rowId: 'a', category: 'custom' }),
        skill({ rowId: 'b', category: 'research' }),
        skill({ rowId: 'c', category: 'Nutrition' }),
      ],
      'all',
    )
    expect(picked.map((s) => s.rowId)).toEqual(['a', 'b', 'c'])
  })
})

describe('[COMP:api/skill-categorize] Existing groups', () => {
  it('lists the groups in use, most-used first, and never the sink', () => {
    expect(
      existingGroupsOf([
        { category: 'custom' },
        { category: 'Nutrition' },
        { category: 'Gym & Training' },
        { category: 'nutrition' },
      ]),
    ).toEqual(['Nutrition', 'Gym & Training'])
  })
})

describe('[COMP:api/skill-categorize] Prompt', () => {
  it('numbers the skills and carries name, description, and when-to-use', () => {
    const prompt = buildCategorizePrompt([
      skill({ rowId: 'a', name: 'Weekly status' }),
      skill({ rowId: 'b', name: 'Lead research', description: 'Digs into a company', whenToUse: null }),
    ])
    expect(prompt).toContain('1.')
    expect(prompt).toContain('2.')
    expect(prompt).toContain('Weekly status')
    expect(prompt).toContain('Digs into a company')
    expect(prompt).toContain('On Fridays')
    // The row ids are internal — never worth the tokens, and never something
    // the model should be able to echo back as a target.
    expect(prompt).not.toContain('row-1')
  })

  it('names the built-in groups, which are always available', () => {
    const prompt = buildCategorizePrompt([skill()])
    for (const c of ['productivity', 'communication', 'research', 'custom']) {
      expect(prompt).toContain(c)
    }
  })

  // Reuse is the whole game: a model that cannot see the library's own group
  // names will coin a near-synonym of one on every pass.
  it('offers the groups the library already uses, spelled exactly', () => {
    const prompt = buildCategorizePrompt([skill()], ['Gym & Training', 'Nutrition'])
    expect(prompt).toContain('Gym & Training')
    expect(prompt).toContain('Nutrition')
    expect(prompt).toContain('reuse these before inventing anything')
  })

  it('tells the model a skill already has a group, so it can leave it there', () => {
    const prompt = buildCategorizePrompt([skill({ category: 'Nutrition' })])
    expect(prompt).toContain('currently in: Nutrition')
  })
})

describe('[COMP:api/skill-categorize] Response parsing', () => {
  const skills = [
    skill({ rowId: 'a', name: 'Weekly status' }),
    skill({ rowId: 'b', name: 'Lead research' }),
  ]

  it('maps 1-based indexes back onto row ids', () => {
    const out = parseCategorySuggestions(
      JSON.stringify([
        { i: 1, category: 'communication', why: 'It writes an update.' },
        { i: 2, category: 'research', why: 'It digs into a company.' },
      ]),
      skills,
    )
    expect(out).toEqual([
      {
        skillRowId: 'a',
        name: 'Weekly status',
        current: 'custom',
        suggested: 'communication',
        rationale: 'It writes an update.',
      },
      {
        skillRowId: 'b',
        name: 'Lead research',
        current: 'custom',
        suggested: 'research',
        rationale: 'It digs into a company.',
      },
    ])
  })

  it('reads a fenced JSON block', () => {
    const out = parseCategorySuggestions(
      '```json\n[{"i":1,"category":"research"}]\n```',
      skills,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.suggested).toBe('research')
  })

  // A suggestion that changes nothing is noise in a review list the user has
  // to read row by row.
  it('drops a suggestion equal to the current category', () => {
    expect(parseCategorySuggestions('[{"i":1,"category":"custom"}]', skills)).toEqual([])
  })

  it('drops an out-of-range index and a group that is not a string', () => {
    const out = parseCategorySuggestions(
      JSON.stringify([
        { i: 0, group: 'research' },
        { i: 3, group: 'research' },
        { i: 1, group: '   ' },
        { i: 2, group: 'research' },
      ]),
      skills,
    )
    expect(out.map((s) => s.skillRowId)).toEqual(['b'])
  })

  // The point of the open vocabulary: a name outside the four built-ins used
  // to be discarded, so the model could not propose the group a library
  // actually wanted no matter how obvious it was.
  it('keeps a group the model invents', () => {
    const out = parseCategorySuggestions('[{"i":1,"group":"Gym & Training"}]', skills)
    expect(out[0]!.suggested).toBe('Gym & Training')
  })

  it('folds a proposal onto an existing group that differs only in case', () => {
    const out = parseCategorySuggestions(
      '[{"i":1,"group":"gym  &  training"}]',
      skills,
      ['Gym & Training'],
    )
    expect(out[0]!.suggested).toBe('Gym & Training')
  })

  // Without this the second row forks the name the first row just coined.
  it('reuses the spelling of a group it coined earlier in the same answer', () => {
    const out = parseCategorySuggestions(
      JSON.stringify([
        { i: 1, group: 'Gym & Training' },
        { i: 2, group: 'gym & training' },
      ]),
      skills,
    )
    expect(out.map((s) => s.suggested)).toEqual(['Gym & Training', 'Gym & Training'])
  })

  it('drops a suggestion whose group differs from the current one only in case', () => {
    expect(
      parseCategorySuggestions('[{"i":1,"group":"Custom"}]', skills),
    ).toEqual([])
  })

  // Fifteen near-synonyms is a worse library than one coarse heap, because
  // now nothing is where you look for it.
  it('stops minting new groups past the per-pass cap', () => {
    const many = Array.from({ length: MAX_NEW_GROUPS_PER_PASS + 3 }, (_, i) =>
      skill({ rowId: `r${i}`, name: `Skill ${i}` }),
    )
    const answer = many.map((_, i) => ({ i: i + 1, group: `Group ${i}` }))
    const out = parseCategorySuggestions(JSON.stringify(answer), many)
    expect(out).toHaveLength(MAX_NEW_GROUPS_PER_PASS)
  })

  // An existing group is not a new one, so filing into it is never capped.
  it('does not count an existing group against the cap', () => {
    const existing = Array.from({ length: MAX_NEW_GROUPS_PER_PASS + 3 }, (_, i) => `Group ${i}`)
    const many = Array.from({ length: MAX_NEW_GROUPS_PER_PASS + 3 }, (_, i) =>
      skill({ rowId: `r${i}`, name: `Skill ${i}` }),
    )
    const answer = many.map((_, i) => ({ i: i + 1, group: `Group ${i}` }))
    const out = parseCategorySuggestions(JSON.stringify(answer), many, existing)
    expect(out).toHaveLength(MAX_NEW_GROUPS_PER_PASS + 3)
  })

  it('accepts the older `category` key so an echoing model is not lost', () => {
    const out = parseCategorySuggestions('[{"i":1,"category":"research"}]', skills)
    expect(out[0]!.suggested).toBe('research')
  })

  it('keeps the first suggestion when the model repeats an index', () => {
    const out = parseCategorySuggestions(
      JSON.stringify([
        { i: 1, category: 'research' },
        { i: 1, category: 'communication' },
      ]),
      skills,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.suggested).toBe('research')
  })

  it('returns nothing for unparseable, non-array, or empty output', () => {
    for (const raw of ['', 'I could not classify these.', '{"i":1}', '[]']) {
      expect(parseCategorySuggestions(raw, skills)).toEqual([])
    }
  })

  it('drops a non-string rationale rather than failing the row', () => {
    const out = parseCategorySuggestions('[{"i":1,"category":"research","why":42}]', skills)
    expect(out).toEqual([
      { skillRowId: 'a', name: 'Weekly status', current: 'custom', suggested: 'research' },
    ])
  })
})
