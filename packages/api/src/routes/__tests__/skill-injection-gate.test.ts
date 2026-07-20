import { describe, it, expect } from 'vitest'
import {
  injectSkills,
  isSkillOfferable,
  type SkillGovernance,
  type SkillOfferableViewer,
} from '../route-helpers.js'
import type { Tool } from '@use-brian/core'
import type { SkillStore } from '../../db/skill-store.js'

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

/**
 * `restrictToSlugs` is the workflow `assistant_call.skills` allow-list gate:
 * only skills whose slug is in the set are offered, on top of the governance
 * gates. Verifies the restriction filters everything else out — a workflow
 * step that names no real skill gets no `useSkill` surface at all.
 * docs/architecture/features/workflow.md → "assistant_call skills"
 */
describe('[COMP:api/skill-injection-gate] injectSkills restrictToSlugs', () => {
  const emptySkillStore = {
    listOwned: async () => [],
    listForAssistant: async () => [],
  } as unknown as SkillStore

  it('offers no skill surface when the allow-list names no real skill', async () => {
    const tools = new Map<string, Tool>()
    const { promptFragment } = await injectSkills({
      skillStore: emptySkillStore,
      connectorUserId: 'u1',
      assistantId: 'a1',
      tools,
      unavailableCapabilities: [],
      channel: 'workflow',
      // Restrict to a slug that matches no built-in and no workspace skill:
      // every candidate is out of scope, so nothing is injected.
      restrictToSlugs: ['definitely-not-a-real-skill-slug'],
    })

    expect(tools.has('useSkill')).toBe(false)
    expect(promptFragment).toBe('')
  })

  it('offers NOTHING when the allow-list is an explicit empty array', async () => {
    // `restrictToSlugs: []` is distinct from `undefined` (chat = offer all):
    // an empty allow-list must offer no skills, even though real built-ins
    // exist. This is the "enforce-only step" case.
    const tools = new Map<string, Tool>()
    const { promptFragment } = await injectSkills({
      skillStore: emptySkillStore,
      connectorUserId: 'u1',
      assistantId: 'a1',
      tools,
      unavailableCapabilities: [],
      channel: 'workflow',
      restrictToSlugs: [],
    })

    expect(tools.has('useSkill')).toBe(false)
    expect(promptFragment).toBe('')
  })

  it('injects enforced skills as a Required Skills prompt block without offering them', async () => {
    // Enforce a governance-passing built-in with an empty discovery allow-list:
    // no `useSkill` surface, but the skill's instructions ride in the enforced
    // fragment so the callee always runs them.
    const tools = new Map<string, Tool>()
    const { promptFragment, enforcedPromptFragment } = await injectSkills({
      skillStore: emptySkillStore,
      connectorUserId: 'u1',
      assistantId: 'a1',
      tools,
      unavailableCapabilities: [],
      channel: 'workflow',
      restrictToSlugs: [], // offer nothing for discovery
      enforceSlugs: ['doc-architect'], // a built-in with no connector/app-type gate
    })

    expect(tools.has('useSkill')).toBe(false)
    expect(promptFragment).toBe('')
    expect(enforcedPromptFragment).toContain('# Required Skills')
    expect(enforcedPromptFragment).toContain('doc-architect')
  })

  it('does not produce an enforced block when the enforced slug is not a real skill', async () => {
    const tools = new Map<string, Tool>()
    const { enforcedPromptFragment } = await injectSkills({
      skillStore: emptySkillStore,
      connectorUserId: 'u1',
      assistantId: 'a1',
      tools,
      unavailableCapabilities: [],
      channel: 'workflow',
      enforceSlugs: ['definitely-not-a-real-skill-slug'],
    })

    expect(enforcedPromptFragment).toBe('')
  })
})
