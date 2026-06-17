/**
 * Fixture test for the onboarding-profile built-in skill.
 * Component tag: [COMP:engine/onboarding-profile-skill].
 *
 * Loads the built-in skill registry and asserts the onboarding-profile
 * skill's frontmatter (productivity category, builtin source, not
 * app-type-gated so it surfaces in the main chat) and that its recipe
 * body wires the real brain-write tools — so a rename of any tool, or a
 * copy-paste of the workflow-builder propose/confirm gate, breaks this
 * test rather than silently leaving the skill pointing at dead names.
 */

import { describe, it, expect } from 'vitest'
import { loadBuiltinSkills } from '../loader.js'

const skill = loadBuiltinSkills().find((s) => s.id === 'onboarding-profile')

describe('[COMP:engine/onboarding-profile-skill] onboarding-profile skill', () => {
  it('is registered as a built-in skill', () => {
    expect(skill).toBeDefined()
    expect(skill?.source).toBe('builtin')
  })

  it('is a productivity skill, surfaced in every app (not app-type-gated)', () => {
    expect(skill?.category).toBe('productivity')
    expect(skill?.appliesToAppType).toBeUndefined()
    expect((skill?.whenToUse ?? '').length).toBeGreaterThan(0)
  })

  it('wires the self-profile brain-write tools in its recipe body', () => {
    const body = skill?.content ?? ''
    expect(body).toContain('updateSelfProfile')
    expect(body).toContain('saveContact')
    expect(body).toContain('saveMemory')
  })

  it('suggests what helps identify a person it captures', () => {
    expect(skill?.content ?? '').toMatch(/full name|LinkedIn/i)
  })

  it('dedups against an existing profile rather than re-onboarding', () => {
    expect(skill?.content ?? '').toMatch(/already exists|don't re-onboard|offer to update/i)
  })

  it('does not create a company entity (that is the company skill)', () => {
    expect(skill?.content ?? '').toMatch(/do \*\*not\*\* create a company entity|not create a company entity/i)
  })

  it('does not copy the workflow-builder propose/confirm gate', () => {
    const body = skill?.content ?? ''
    expect(body).not.toContain('proposeWorkflow')
    expect(body).not.toContain('createWorkflow')
  })
})
