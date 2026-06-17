/**
 * Fixture test for the onboarding-company built-in skill.
 * Component tag: [COMP:engine/onboarding-company-skill].
 *
 * Asserts the onboarding-company skill's frontmatter (research category,
 * builtin source, not app-type-gated) and the two load-bearing parts of
 * its recipe: the deferResearch two-turn cadence guard (so a rewrite that
 * lets the model research before it has the company name fails here and
 * stops wasting the user's research credit) and the brain-write tools it
 * commits findings with.
 */

import { describe, it, expect } from 'vitest'
import { loadBuiltinSkills } from '../loader.js'

const skill = loadBuiltinSkills().find((s) => s.id === 'onboarding-company')

describe('[COMP:engine/onboarding-company-skill] onboarding-company skill', () => {
  it('is registered as a built-in skill', () => {
    expect(skill).toBeDefined()
    expect(skill?.source).toBe('builtin')
  })

  it('is a research skill, surfaced in every app (not app-type-gated)', () => {
    expect(skill?.category).toBe('research')
    expect(skill?.appliesToAppType).toBeUndefined()
    expect((skill?.whenToUse ?? '').length).toBeGreaterThan(0)
  })

  it('guards the deferResearch two-turn cadence (no web search before the name)', () => {
    expect(skill?.content ?? '').toMatch(/Never search the web before you know the company name/)
  })

  it('shows findings before writing them (prune-before-it-lands)', () => {
    expect(skill?.content ?? '').toMatch(/show the findings, then write|before writing anything|drop anything/i)
  })

  it('suggests what information helps the research (company + person signals)', () => {
    const body = skill?.content ?? ''
    expect(body).toMatch(/domain/i)
    expect(body).toMatch(/LinkedIn/i)
  })

  it('wires the company brain-write tools in its recipe body', () => {
    const body = skill?.content ?? ''
    expect(body).toContain('saveCompany')
    expect(body).toContain('saveContact')
    expect(body).toContain('saveMemory')
  })

  it('does not copy the workflow-builder propose/confirm gate', () => {
    const body = skill?.content ?? ''
    expect(body).not.toContain('proposeWorkflow')
    expect(body).not.toContain('createWorkflow')
  })
})
