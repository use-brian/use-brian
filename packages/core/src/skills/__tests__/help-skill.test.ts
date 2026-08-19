/**
 * Fixture test for the help built-in skill (the /help slash command's body).
 * Component tag: [COMP:skills/slash-command] (ships with the command seam).
 *
 * Asserts the load-bearing pieces: the slug /help resolves against, the
 * closed-world framing (answer only from the Available Skills listing), the
 * command syntax it teaches, and the honest empty-roster degrade.
 */

import { describe, it, expect } from 'vitest'
import { loadBuiltinSkills } from '../loader.js'

const skill = loadBuiltinSkills().find((s) => s.id === 'help')

describe('[COMP:skills/slash-command] help built-in skill', () => {
  it('is registered as a built-in productivity skill, surfaced in every app', () => {
    expect(skill).toBeDefined()
    expect(skill?.source).toBe('builtin')
    expect(skill?.category).toBe('productivity')
    expect(skill?.appliesToAppType).toBeUndefined()
  })

  it('answers only from the Available Skills listing and never names tools', () => {
    const body = skill?.content ?? ''
    expect(body).toMatch(/# Available Skills/)
    expect(body).toMatch(/never invent/i)
    expect(body).toMatch(/never name raw tools/i)
  })

  it('teaches the /slug invocation syntax and the plain-words alternative', () => {
    const body = skill?.content ?? ''
    expect(body).toMatch(/\/<slug> \[details\]/)
    expect(body).toMatch(/plain words/i)
  })

  it('degrades honestly on an empty roster', () => {
    const body = skill?.content ?? ''
    expect(body).toMatch(/no skills are enabled/i)
  })
})
