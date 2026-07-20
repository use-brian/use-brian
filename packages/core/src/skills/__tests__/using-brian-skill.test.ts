/**
 * Fixture test for the using-brian built-in skill.
 * Component tag: [COMP:engine/using-brian-skill].
 *
 * The skill is the consult-first grounding for "can Use Brian do X?"
 * questions (2026-07-07 capability-hallucination fix). This asserts the
 * load-bearing pieces survive edits: the activation trigger, the
 * validate-don't-assert protocol (proposeWorkflow as the oracle), the
 * closed-world framing, and the pointers to the deeper skills. The
 * enumerations themselves (trigger kinds / event sources / task actions) are
 * graded against the canonical schema constants by `pnpm check`
 * (invariants/capability-surface), so they are not re-asserted here.
 */

import { describe, it, expect } from 'vitest'
import { loadBuiltinSkills } from '../loader.js'

const skill = loadBuiltinSkills().find((s) => s.id === 'using-brian')

describe('[COMP:engine/using-brian-skill] using-brian skill', () => {
  it('is registered as a built-in productivity skill, surfaced in every app', () => {
    expect(skill).toBeDefined()
    expect(skill?.source).toBe('builtin')
    expect(skill?.category).toBe('productivity')
    expect(skill?.appliesToAppType).toBeUndefined()
  })

  it('triggers on capability questions, before answering', () => {
    expect(skill?.whenToUse).toMatch(/BEFORE answering/i)
    expect(skill?.description).toMatch(/ALWAYS activate/i)
  })

  it('carries the validate-don\'t-assert protocol and the closed-world framing', () => {
    const body = skill?.content ?? ''
    expect(body).toMatch(/proposeWorkflow/)
    expect(body).toMatch(/exact and complete/i)
    expect(body).toMatch(/Unavailable capabilities/)
    expect(body).toMatch(/does NOT exist/i)
  })

  it('routes deep work to the specialist skills instead of restating them', () => {
    const body = skill?.content ?? ''
    expect(body).toMatch(/workflow-builder/)
    expect(body).toMatch(/skill-builder/)
  })
})
