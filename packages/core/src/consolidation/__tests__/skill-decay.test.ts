/**
 * CL-8 skill decay tests.
 * Component tag: [COMP:consolidation/skill-decay].
 *
 * Covers:
 *  - each of five demote rules (inactive, low_success, frequent_correction,
 *    broken_reference, superseded_conflict)
 *  - rule-priority ordering (frequent_correction > broken_reference >
 *    superseded_conflict > low_success > inactive)
 *  - broken_reference / superseded_conflict flow through runSkillDecay and
 *    surface conflictsWithRowId in the skill_deprecated event detail
 *  - pinned exempt + foreground exempt (defensive — the eligible filter
 *    already excludes them at the store, but the pass re-checks)
 *  - resurrection store contract: softDeprecate is the demote primitive;
 *    markUserVerified (the resurrection counterpart) lives on WS-A's
 *    store and is not in scope for this module
 *  - skipped event when no candidates
 */

import { describe, it, expect, vi } from 'vitest'
import {
  runSkillDecay,
  evaluateDemoteRule,
  type SkillDecayStore,
  type SkillDecayEvent,
  type SkillDecayCandidate,
} from '../skill-decay.js'

// ── Fixtures ─────────────────────────────────────────────────────

function makeSkill(over: Partial<SkillDecayCandidate>): SkillDecayCandidate {
  return {
    rowId: 'row-1',
    id: 'slug-1',
    workspaceId: 'ws-1',
    slug: 'slug-1',
    name: 'Skill 1',
    description: 'Default description',
    content: '# body',
    category: 'custom',
    requiresConnectors: [],
    source: 'auto-generated',
    published: false,
    writeOrigin: 'background_review',
    state: 'active',
    stateTransitionedAt: new Date('2026-01-01'),
    pinned: false,
    invocations: 0,
    succeeded: 0,
    userCorrectedAfter: 0,
    validFrom: new Date('2026-01-01'),
    ...over,
  }
}

function makeStore(skills: SkillDecayCandidate[]): SkillDecayStore & {
  deprecations: Array<{ rowId: string; reason: string }>
} {
  const deprecations: Array<{ rowId: string; reason: string }> = []
  return {
    deprecations,
    async listCuratorEligible() {
      return skills
    },
    async softDeprecate(skillRowId, reason) {
      deprecations.push({ rowId: skillRowId, reason })
    },
  }
}

const NOW = new Date('2026-05-24T00:00:00Z')

// ── Rule evaluator unit tests ────────────────────────────────────

describe('[COMP:consolidation/skill-decay] evaluateDemoteRule', () => {
  it('inactive: zero invocations + age >= 30 days', () => {
    const skill = makeSkill({
      invocations: 0,
      lastInvokedAt: undefined,
      validFrom: new Date('2026-04-01'), // ~53 days before NOW
    })
    expect(evaluateDemoteRule(skill, NOW)).toBe('inactive')
  })

  it('inactive: declines when age < 30 days', () => {
    const skill = makeSkill({
      invocations: 0,
      lastInvokedAt: undefined,
      validFrom: new Date('2026-05-10'), // 14 days before NOW
    })
    expect(evaluateDemoteRule(skill, NOW)).toBeNull()
  })

  it('low_success: invocations >= 10 + success rate < 50%', () => {
    const skill = makeSkill({
      invocations: 10,
      succeeded: 3,
      lastInvokedAt: new Date('2026-05-20'),
    })
    expect(evaluateDemoteRule(skill, NOW)).toBe('low_success')
  })

  it('low_success: declines when success rate >= 50%', () => {
    const skill = makeSkill({
      invocations: 10,
      succeeded: 5,
      lastInvokedAt: new Date('2026-05-20'),
    })
    expect(evaluateDemoteRule(skill, NOW)).toBeNull()
  })

  it('frequent_correction: user_corrected_after >= 3', () => {
    const skill = makeSkill({
      invocations: 5,
      succeeded: 5,
      userCorrectedAfter: 3,
      lastInvokedAt: new Date('2026-05-20'),
    })
    expect(evaluateDemoteRule(skill, NOW)).toBe('frequent_correction')
  })

  it('frequent_correction beats low_success when both fire', () => {
    const skill = makeSkill({
      invocations: 10,
      succeeded: 2, // low_success qualifies
      userCorrectedAfter: 4, // frequent_correction qualifies
      lastInvokedAt: new Date('2026-05-20'),
    })
    expect(evaluateDemoteRule(skill, NOW)).toBe('frequent_correction')
  })

  it('low_success beats inactive when both fire', () => {
    // 10 invocations + 0 successes + lastInvokedAt > 30 days ago — both
    // low_success AND (since invocations > 0) the inactive clause does
    // NOT actually fire because inactive requires invocations === 0.
    // This test asserts the priority structure: invocations > 0 means
    // inactive is off, so we get low_success regardless.
    const skill = makeSkill({
      invocations: 10,
      succeeded: 0,
      lastInvokedAt: new Date('2026-03-01'), // 84 days ago
    })
    expect(evaluateDemoteRule(skill, NOW)).toBe('low_success')
  })

  it('broken_reference: hasBrokenReference true fires', () => {
    const skill = makeSkill({
      invocations: 5,
      succeeded: 5,
      lastInvokedAt: new Date('2026-05-20'),
      hasBrokenReference: true,
    })
    expect(evaluateDemoteRule(skill, NOW)).toBe('broken_reference')
  })

  it('broken_reference beats low_success when both fire', () => {
    const skill = makeSkill({
      invocations: 10,
      succeeded: 2, // low_success qualifies
      lastInvokedAt: new Date('2026-05-20'),
      hasBrokenReference: true, // higher severity
    })
    expect(evaluateDemoteRule(skill, NOW)).toBe('broken_reference')
  })

  it('broken_reference beats inactive when both fire', () => {
    const skill = makeSkill({
      invocations: 0, // inactive qualifies (age >= 30d below)
      lastInvokedAt: undefined,
      validFrom: new Date('2026-04-01'), // ~53 days before NOW
      hasBrokenReference: true, // higher severity
    })
    expect(evaluateDemoteRule(skill, NOW)).toBe('broken_reference')
  })

  it('frequent_correction beats broken_reference when both fire', () => {
    const skill = makeSkill({
      invocations: 6,
      succeeded: 6,
      userCorrectedAfter: 4, // frequent_correction qualifies
      lastInvokedAt: new Date('2026-05-20'),
      hasBrokenReference: true, // lower severity than correction
    })
    expect(evaluateDemoteRule(skill, NOW)).toBe('frequent_correction')
  })

  it('superseded_conflict: conflictsWithRowId set fires', () => {
    const skill = makeSkill({
      invocations: 5,
      succeeded: 5,
      lastInvokedAt: new Date('2026-05-20'),
      conflictsWithRowId: 'row-newer',
    })
    expect(evaluateDemoteRule(skill, NOW)).toBe('superseded_conflict')
  })

  it('superseded_conflict beats low_success but loses to broken_reference', () => {
    // conflict + low_success both fire → conflict wins.
    const conflictWins = makeSkill({
      invocations: 10,
      succeeded: 2, // low_success qualifies
      lastInvokedAt: new Date('2026-05-20'),
      conflictsWithRowId: 'row-newer',
    })
    expect(evaluateDemoteRule(conflictWins, NOW)).toBe('superseded_conflict')
    // conflict + broken_reference both fire → broken_reference wins.
    const brokenWins = makeSkill({
      invocations: 5,
      succeeded: 5,
      lastInvokedAt: new Date('2026-05-20'),
      conflictsWithRowId: 'row-newer',
      hasBrokenReference: true,
    })
    expect(evaluateDemoteRule(brokenWins, NOW)).toBe('broken_reference')
  })

  it('ignores empty-string / null conflictsWithRowId', () => {
    const emptyStr = makeSkill({
      invocations: 5,
      succeeded: 5,
      lastInvokedAt: new Date('2026-05-20'),
      conflictsWithRowId: '',
    })
    expect(evaluateDemoteRule(emptyStr, NOW)).toBeNull()
    const nullConflict = makeSkill({
      invocations: 5,
      succeeded: 5,
      lastInvokedAt: new Date('2026-05-20'),
      conflictsWithRowId: null,
    })
    expect(evaluateDemoteRule(nullConflict, NOW)).toBeNull()
  })

  it('returns null for a healthy skill', () => {
    const skill = makeSkill({
      invocations: 15,
      succeeded: 12,
      userCorrectedAfter: 0,
      lastInvokedAt: new Date('2026-05-20'),
    })
    expect(evaluateDemoteRule(skill, NOW)).toBeNull()
  })

  it('honours custom thresholds', () => {
    const skill = makeSkill({ invocations: 5, succeeded: 0 })
    // Default min is 10 — rule does not fire.
    expect(evaluateDemoteRule(skill, NOW)).toBeNull()
    // Tightened min to 5 — rule fires.
    expect(
      evaluateDemoteRule(skill, NOW, {
        inactiveDays: 30,
        lowSuccessMinInvocations: 5,
        lowSuccessRateThreshold: 0.5,
        frequentCorrectionThreshold: 3,
      }),
    ).toBe('low_success')
  })
})

// ── Run pass integration tests ───────────────────────────────────

describe('[COMP:consolidation/skill-decay] runSkillDecay', () => {
  it('emits skipped event when no candidates', async () => {
    const store = makeStore([])
    const events: SkillDecayEvent[] = []
    const res = await runSkillDecay({
      workspaceId: 'ws-1',
      store,
      onEvent: (e) => events.push(e),
      now: () => NOW,
    })
    expect(res.deprecated).toBe(0)
    expect(events).toContainEqual({
      type: 'skill_decay_skipped',
      workspaceId: 'ws-1',
      reason: 'no_candidates',
    })
  })

  it('soft-deprecates each matching skill exactly once', async () => {
    const skills = [
      // inactive
      makeSkill({
        rowId: 'r-inactive',
        invocations: 0,
        validFrom: new Date('2026-04-01'),
      }),
      // low_success
      makeSkill({
        rowId: 'r-low',
        invocations: 12,
        succeeded: 3,
        lastInvokedAt: new Date('2026-05-20'),
      }),
      // frequent_correction
      makeSkill({
        rowId: 'r-corrected',
        invocations: 6,
        succeeded: 6,
        userCorrectedAfter: 5,
        lastInvokedAt: new Date('2026-05-20'),
      }),
      // healthy — must NOT be deprecated
      makeSkill({
        rowId: 'r-healthy',
        invocations: 20,
        succeeded: 18,
        userCorrectedAfter: 0,
        lastInvokedAt: new Date('2026-05-22'),
      }),
    ]
    const store = makeStore(skills)
    const events: SkillDecayEvent[] = []
    const res = await runSkillDecay({
      workspaceId: 'ws-1',
      store,
      onEvent: (e) => events.push(e),
      now: () => NOW,
    })
    expect(res.deprecated).toBe(3)
    expect(store.deprecations).toEqual([
      { rowId: 'r-inactive', reason: 'inactive' },
      { rowId: 'r-low', reason: 'low_success' },
      { rowId: 'r-corrected', reason: 'frequent_correction' },
    ])
    expect(res.reasons.find((r) => r.skillRowId === 'r-healthy')).toBeUndefined()
    // Three skill_deprecated events emitted with detail payload.
    const deprecatedEvents = events.filter((e) => e.type === 'skill_deprecated')
    expect(deprecatedEvents.length).toBe(3)
    expect(deprecatedEvents[0]).toMatchObject({
      workspaceId: 'ws-1',
      skillRowId: 'r-inactive',
      reason: 'inactive',
    })
  })

  it('flows new reasons through the pass + surfaces conflictsWithRowId in the event detail', async () => {
    const skills = [
      // broken_reference
      makeSkill({
        rowId: 'r-broken',
        invocations: 5,
        succeeded: 5,
        lastInvokedAt: new Date('2026-05-20'),
        hasBrokenReference: true,
      }),
      // superseded_conflict
      makeSkill({
        rowId: 'r-superseded',
        invocations: 5,
        succeeded: 5,
        lastInvokedAt: new Date('2026-05-20'),
        conflictsWithRowId: 'r-newer',
      }),
    ]
    const store = makeStore(skills)
    const events: SkillDecayEvent[] = []
    const res = await runSkillDecay({
      workspaceId: 'ws-1',
      store,
      onEvent: (e) => events.push(e),
      now: () => NOW,
    })
    expect(res.deprecated).toBe(2)
    expect(store.deprecations).toEqual([
      { rowId: 'r-broken', reason: 'broken_reference' },
      { rowId: 'r-superseded', reason: 'superseded_conflict' },
    ])
    const deprecatedEvents = events.filter((e) => e.type === 'skill_deprecated')
    // broken_reference event: no conflictsWithRowId in detail.
    const brokenEvent = deprecatedEvents.find(
      (e) => e.type === 'skill_deprecated' && e.skillRowId === 'r-broken',
    )
    expect(brokenEvent).toMatchObject({ reason: 'broken_reference' })
    expect(
      brokenEvent?.type === 'skill_deprecated'
        ? brokenEvent.detail.conflictsWithRowId
        : 'unset',
    ).toBeUndefined()
    // superseded_conflict event: conflictsWithRowId surfaced in detail.
    const supersededEvent = deprecatedEvents.find(
      (e) => e.type === 'skill_deprecated' && e.skillRowId === 'r-superseded',
    )
    expect(supersededEvent).toMatchObject({
      reason: 'superseded_conflict',
      detail: { conflictsWithRowId: 'r-newer' },
    })
  })

  it('defensive: refuses to deprecate a pinned skill even if listed', async () => {
    // listCuratorEligible should never return pinned rows, but the
    // pass re-checks as a hard guard.
    const skills = [
      makeSkill({
        rowId: 'r-pinned',
        pinned: true,
        invocations: 0,
        validFrom: new Date('2026-04-01'),
      }),
    ]
    const store = makeStore(skills)
    const res = await runSkillDecay({
      workspaceId: 'ws-1',
      store,
      now: () => NOW,
    })
    expect(res.deprecated).toBe(0)
    expect(store.deprecations.length).toBe(0)
  })

  it('defensive: refuses to deprecate a foreground-origin skill even if listed', async () => {
    const skills = [
      makeSkill({
        rowId: 'r-fg',
        writeOrigin: 'foreground',
        invocations: 0,
        validFrom: new Date('2026-04-01'),
      }),
    ]
    const store = makeStore(skills)
    const res = await runSkillDecay({
      workspaceId: 'ws-1',
      store,
      now: () => NOW,
    })
    expect(res.deprecated).toBe(0)
    expect(store.deprecations.length).toBe(0)
  })

  it('isolates per-skill failures — one bad row does not abort the run', async () => {
    const skills = [
      makeSkill({
        rowId: 'r-bad',
        invocations: 0,
        validFrom: new Date('2026-04-01'),
      }),
      makeSkill({
        rowId: 'r-good',
        invocations: 12,
        succeeded: 3,
        lastInvokedAt: new Date('2026-05-20'),
      }),
    ]
    const store: SkillDecayStore = {
      async listCuratorEligible() {
        return skills
      },
      async softDeprecate(rowId, reason) {
        if (rowId === 'r-bad') throw new Error('boom')
        // r-good succeeds silently
        void reason
      },
    }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await runSkillDecay({
      workspaceId: 'ws-1',
      store,
      now: () => NOW,
    })
    expect(res.deprecated).toBe(1) // r-good only
    expect(res.reasons).toEqual([{ skillRowId: 'r-good', reason: 'low_success' }])
    consoleSpy.mockRestore()
  })
})
