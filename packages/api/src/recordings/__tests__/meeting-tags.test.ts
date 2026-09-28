import { describe, expect, it } from 'vitest'
import { applyTagRules, changeRules, emptyTagState, meetingTagCommand, setManualTags, suggestTagRules } from '../meeting-tags.js'

describe('[COMP:recordings/meeting-tags] opt-in rules and manual learning', () => {
  const rule = { id: 'rule', tag: 'Planning', phrases: ['roadmap', 'budget'] }
  it('starts with no tags or rules and never infers tags from content alone', () => {
    expect(applyTagRules(emptyTagState(), [], 'roadmap budget').tags).toEqual([])
    expect(emptyTagState().rules).toEqual([])
    expect(suggestTagRules([], emptyTagState())).toEqual([])
  })
  it('requires every phrase, handles case, boundaries and literal regex characters', () => {
    expect(applyTagRules(emptyTagState(), [rule], 'ROADMAP and Budget').tags).toEqual([{ name: 'Planning', source: 'rule' }])
    expect(applyTagRules(emptyTagState(), [rule], 'roadmap budgeting').tags).toEqual([])
    expect(applyTagRules(emptyTagState(), [rule], 'budget only').tags).toEqual([])
    expect(applyTagRules(emptyTagState(), [{ ...rule, phrases: ['C++', '預算'] }], 'C++項目的預算').tags).toHaveLength(1)
  })
  it('preserves manual tags and respects removal until an explicit re-add', () => {
    const state = setManualTags(emptyTagState(), ['Custom'])
    const tagged = applyTagRules(state, [rule], 'roadmap budget')
    expect(tagged.tags[0]).toEqual({ name: 'Custom', source: 'manual' })
    const removed = setManualTags(tagged, ['Custom'])
    expect(applyTagRules(removed, [rule], 'roadmap budget').tags).toEqual(state.tags)
    const restored = setManualTags(removed, ['Custom', 'Planning'])
    expect(restored.suppressed).toEqual([])
    expect(restored.tags[1].source).toBe('manual')
  })
  it('learns only from two distinct manual examples and requires acceptance', () => {
    const examples = ['a', 'b'].map((pageId) => ({ pageId, text: 'Roadmap budget planning', tags: [{ name: 'Planning', source: 'manual' as const }] }))
    const blank = emptyTagState()
    expect(suggestTagRules(examples.slice(0, 1), blank)).toEqual([])
    expect(suggestTagRules([examples[0], examples[0]], blank)).toEqual([])
    expect(suggestTagRules(examples.map((row) => ({ ...row, tags: [{ name: 'Planning', source: 'rule' as const }] })), blank)).toEqual([])
    const suggestions = suggestTagRules(examples, blank)
    expect(suggestions).toHaveLength(1)
    expect(blank.tags).toEqual([])
    expect(blank.rules).toEqual([])
    const accepted = changeRules(blank, { kind: 'accept-rule', id: suggestions[0].id }, suggestions)
    expect(accepted.rules).toHaveLength(1)
    expect(accepted.tags).toEqual([])
    expect(suggestTagRules(examples, accepted)).toEqual([])
    expect(suggestTagRules(examples, changeRules(blank, { kind: 'dismiss-rule', id: suggestions[0].id }, suggestions))).toEqual([])
    expect(() => changeRules(blank, { kind: 'accept-rule', id: 'stale' }, [])).toThrow('no longer supported')
  })
  it('rejects empty or oversized explicit rule definitions', () => {
    expect(meetingTagCommand.safeParse({ kind: 'create-rule', tag: ' ', phrases: ['budget'] }).success).toBe(false)
    expect(meetingTagCommand.safeParse({ kind: 'create-rule', tag: 'Topic', phrases: [] }).success).toBe(false)
    expect(meetingTagCommand.safeParse({ kind: 'set-tags', tags: ['X'.repeat(65)] }).success).toBe(false)
  })
})
