import { describe, it, expect } from 'vitest'
import {
  isSkillOfferable,
  type SkillGovernance,
  type SkillOfferableViewer,
} from '../route-helpers.js'

/**
 * Use-time clearance gate. Verifies the pure predicate that decides whether a
 * skill is OFFERED to an assistant for a turn. Offering SCOPE (which
 * assistants get the skill at all — including the suggested-skill
 * proposer-first default, seeded into `workspace_skill_enablement` at
 * creation, mig 264) lives in the enablement allowlist applied in
 * `injectSkills`, alongside the requiresConnectors + appType gating — so this
 * covers only the clearance ceiling.
 *
 * docs/architecture/engine/skill-system.md → "Sensitivity + clearance gate"
 */
describe('[COMP:api/skill-injection-gate] isSkillOfferable', () => {
  const viewer = (
    clearance: SkillOfferableViewer['assistantClearance'],
  ): SkillOfferableViewer => ({ assistantClearance: clearance })

  const gov = (
    sensitivity: SkillGovernance['sensitivity'],
  ): SkillGovernance => ({ sensitivity })

  it('offers a skill at or below the assistant clearance', () => {
    expect(isSkillOfferable(gov('internal'), viewer('internal'))).toBe(true)
    expect(isSkillOfferable(gov('public'), viewer('internal'))).toBe(true)
  })

  it('does NOT offer a confidential skill to an internal-clearance assistant', () => {
    expect(isSkillOfferable(gov('confidential'), viewer('internal'))).toBe(false)
  })

  it('does NOT offer an internal skill to a public-clearance assistant', () => {
    expect(isSkillOfferable(gov('internal'), viewer('public'))).toBe(false)
  })

  it('offers public + internal + confidential skills to a confidential-clearance assistant', () => {
    expect(isSkillOfferable(gov('public'), viewer('confidential'))).toBe(true)
    expect(isSkillOfferable(gov('internal'), viewer('confidential'))).toBe(true)
    expect(isSkillOfferable(gov('confidential'), viewer('confidential'))).toBe(true)
  })

  it('offers a built-in shape (public) to any clearance', () => {
    // Built-ins have no workspace_skills row; the caller surfaces them as
    // 'public', so they pass at every clearance tier.
    expect(isSkillOfferable(gov('public'), viewer('public'))).toBe(true)
    expect(isSkillOfferable(gov('public'), viewer('internal'))).toBe(true)
    expect(isSkillOfferable(gov('public'), viewer('confidential'))).toBe(true)
  })
})
