import { describe, expect, it } from 'vitest'
import {
  buildCategorizePrompt,
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

  it('treats an unknown or missing category as the custom sink', () => {
    const picked = selectCategorizableSkills([
      skill({ rowId: 'a', category: 'sales-enablement' }),
      skill({ rowId: 'b', category: undefined as unknown as string }),
    ])
    expect(picked.map((s) => s.rowId)).toEqual(['a', 'b'])
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

  it('names every allowed category so the model cannot invent one', () => {
    const prompt = buildCategorizePrompt([skill()])
    for (const c of ['productivity', 'communication', 'research', 'custom']) {
      expect(prompt).toContain(c)
    }
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

  it('drops an out-of-range index and an invented category', () => {
    const out = parseCategorySuggestions(
      JSON.stringify([
        { i: 0, category: 'research' },
        { i: 3, category: 'research' },
        { i: 1, category: 'sales' },
        { i: 2, category: 'research' },
      ]),
      skills,
    )
    expect(out.map((s) => s.skillRowId)).toEqual(['b'])
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
