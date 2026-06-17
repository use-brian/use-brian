/**
 * Fixture test for the scan-inspiration built-in skill.
 * Component tag: [COMP:feed/inspiration-skill].
 *
 * Loads the built-in skill registry and asserts the scan-inspiration
 * skill's frontmatter (distribution-gated, communication category,
 * builtin source) and that its recipe body wires the three inspiration
 * tools + the `inspiration:*` config keys — so a rename of either the
 * tools or the memory keys breaks this test rather than silently
 * leaving the skill pointing at dead names.
 */

import { describe, it, expect } from 'vitest'
import { loadBuiltinSkills } from '../../skills/loader.js'

const skill = loadBuiltinSkills().find((s) => s.id === 'scan-inspiration')

describe('[COMP:feed/inspiration-skill] scan-inspiration skill', () => {
  it('is registered as a built-in skill', () => {
    expect(skill).toBeDefined()
    expect(skill?.source).toBe('builtin')
  })

  it('is gated to distribution assistants and tagged communication', () => {
    expect(skill?.appliesToAppType).toBe('distribution')
    expect(skill?.category).toBe('communication')
    expect((skill?.whenToUse ?? '').length).toBeGreaterThan(0)
  })

  it('wires the three inspiration tools in its recipe body', () => {
    const body = skill?.content ?? ''
    expect(body).toContain('twitterListHomeTimeline')
    expect(body).toContain('twitterListFromList')
    expect(body).toContain('twitterSearchTopic')
  })

  it('documents the inspiration:* configuration memory keys', () => {
    const body = skill?.content ?? ''
    expect(body).toContain('inspiration:include_timeline')
    expect(body).toContain('inspiration:list_id')
    expect(body).toContain('inspiration:search_query')
    expect(body).toContain('inspiration:result_count')
  })

  it('forbids auto-drafting — replies stay on the approval-gated path', () => {
    expect(skill?.content ?? '').toMatch(/Do NOT auto-draft|Don't auto-draft/)
  })
})
