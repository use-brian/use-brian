/**
 * Fixture test for the goal built-in skill (the /goal slash command's body).
 * Component tag: [COMP:skills/slash-command] (the command and its skill ship
 * together; the parser test lives in slash-command.test.ts).
 *
 * Asserts the load-bearing pieces survive edits: the slug the /goal command
 * resolves against, the mint-then-arm tool chain (setGoal → workTask), the
 * never-work-inline rule, the outcome-is-the-whole-briefing rule (verify
 * iterations see only the outcome text), and the honest degrade when the
 * goals capability is disabled.
 */

import { describe, it, expect } from 'vitest'
import { loadBuiltinSkills } from '../loader.js'

const skill = loadBuiltinSkills().find((s) => s.id === 'goal')

describe('[COMP:skills/slash-command] goal built-in skill', () => {
  it('is registered as a built-in productivity skill, surfaced in every app', () => {
    expect(skill).toBeDefined()
    expect(skill?.source).toBe('builtin')
    expect(skill?.category).toBe('productivity')
    expect(skill?.appliesToAppType).toBeUndefined()
  })

  it('carries the mint-then-arm chain and never works inline', () => {
    const body = skill?.content ?? ''
    expect(body).toMatch(/setGoal/)
    expect(body).toMatch(/workTask/)
    expect(body).toMatch(/never start doing the work inline/i)
    expect(body).toMatch(/monitor/i) // setGoal without workTask = monitor
  })

  it('teaches that a verify iteration sees only the outcome text', () => {
    const body = skill?.content ?? ''
    expect(body).toMatch(/sees ONLY this text/)
    expect(body).toMatch(/"kind":"verify"/)
  })

  it('degrades honestly when the goals capability is disabled', () => {
    const body = skill?.content ?? ''
    expect(body).toMatch(/goals capability is disabled/i)
  })
})
