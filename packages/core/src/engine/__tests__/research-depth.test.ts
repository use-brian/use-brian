import { describe, it, expect } from 'vitest'
import {
  resolveResearchBudget,
  ResearchDepthConfigSchema,
  RESEARCH_DEPTH_TIERS,
  RESEARCH_BUDGET_CEILING,
  RESEARCH_BUDGET_FLOOR,
  ASSISTANT_CALL_DEFAULT_BUDGET,
  DEFAULT_ASSISTANT_CALL_TIMEOUT_MS,
  parseAssistantCallTimeoutMs,
} from '../research-depth.js'

describe('[COMP:engine/research-depth] resolveResearchBudget', () => {
  it('returns the caller fallback when the config is absent', () => {
    expect(resolveResearchBudget(undefined, ASSISTANT_CALL_DEFAULT_BUDGET)).toEqual(
      ASSISTANT_CALL_DEFAULT_BUDGET,
    )
    expect(resolveResearchBudget(null, ASSISTANT_CALL_DEFAULT_BUDGET)).toEqual(
      ASSISTANT_CALL_DEFAULT_BUDGET,
    )
  })

  it('returns the fallback for an empty config object', () => {
    expect(resolveResearchBudget({}, ASSISTANT_CALL_DEFAULT_BUDGET)).toEqual(
      ASSISTANT_CALL_DEFAULT_BUDGET,
    )
  })

  it('a named tier replaces the fallback as the base for every field', () => {
    // `deep` from the tight assistant_call fallback — a real upgrade.
    expect(resolveResearchBudget({ tier: 'deep' }, ASSISTANT_CALL_DEFAULT_BUDGET)).toEqual({
      maxTurns: 40,
      maxToolCalls: 35,
      timeoutMs: 300_000,
    })
    // `standard` from the 5-turn assistant_call fallback is also an upgrade.
    expect(resolveResearchBudget({ tier: 'standard' }, ASSISTANT_CALL_DEFAULT_BUDGET)).toEqual({
      maxTurns: 15,
      maxToolCalls: 10,
      timeoutMs: 30_000,
    })
  })

  it('a numeric override wins over the fallback, field-by-field', () => {
    expect(resolveResearchBudget({ maxTurns: 25 }, ASSISTANT_CALL_DEFAULT_BUDGET)).toEqual({
      maxTurns: 25,
      maxToolCalls: ASSISTANT_CALL_DEFAULT_BUDGET.maxToolCalls,
      timeoutMs: ASSISTANT_CALL_DEFAULT_BUDGET.timeoutMs,
    })
  })

  it('a numeric override wins over the tier preset, field-by-field', () => {
    expect(
      resolveResearchBudget({ tier: 'deep', maxToolCalls: 20 }, ASSISTANT_CALL_DEFAULT_BUDGET),
    ).toEqual({
      maxTurns: 40, // from `deep`
      maxToolCalls: 20, // override
      timeoutMs: 300_000, // from `deep`
    })
  })

  it('clamps an over-ceiling override down to the ceiling', () => {
    const resolved = resolveResearchBudget(
      { maxTurns: 9_999, maxToolCalls: 9_999, timeoutMs: 9_999_999 },
      ASSISTANT_CALL_DEFAULT_BUDGET,
    )
    expect(resolved).toEqual(RESEARCH_BUDGET_CEILING)
  })

  it('clamps a below-floor override up to the floor', () => {
    const resolved = resolveResearchBudget(
      { maxTurns: 0, maxToolCalls: -3, timeoutMs: 0 },
      ASSISTANT_CALL_DEFAULT_BUDGET,
    )
    expect(resolved).toEqual(RESEARCH_BUDGET_FLOOR)
  })

  it('ASSISTANT_CALL_DEFAULT_BUDGET is the 5-turn step budget with the 90s default wall-clock', () => {
    expect(ASSISTANT_CALL_DEFAULT_BUDGET).toEqual({
      maxTurns: 5,
      maxToolCalls: 10,
      timeoutMs: DEFAULT_ASSISTANT_CALL_TIMEOUT_MS,
    })
    expect(DEFAULT_ASSISTANT_CALL_TIMEOUT_MS).toBe(90_000)
  })
})

describe('[COMP:engine/research-depth] parseAssistantCallTimeoutMs', () => {
  it('falls back to the 90s default when unset, blank, or non-numeric', () => {
    expect(parseAssistantCallTimeoutMs(undefined)).toBe(DEFAULT_ASSISTANT_CALL_TIMEOUT_MS)
    expect(parseAssistantCallTimeoutMs('')).toBe(DEFAULT_ASSISTANT_CALL_TIMEOUT_MS)
    expect(parseAssistantCallTimeoutMs('   ')).toBe(DEFAULT_ASSISTANT_CALL_TIMEOUT_MS)
    expect(parseAssistantCallTimeoutMs('soon')).toBe(DEFAULT_ASSISTANT_CALL_TIMEOUT_MS)
  })

  it('honours a valid numeric override', () => {
    expect(parseAssistantCallTimeoutMs('120000')).toBe(120_000)
  })

  it('clamps to the same [FLOOR, CEILING] as every other budget', () => {
    expect(parseAssistantCallTimeoutMs('999999999')).toBe(RESEARCH_BUDGET_CEILING.timeoutMs)
    expect(parseAssistantCallTimeoutMs('1')).toBe(RESEARCH_BUDGET_FLOOR.timeoutMs)
  })
})

describe('[COMP:engine/research-depth] ResearchDepthConfigSchema', () => {
  it('accepts a tier-only config', () => {
    expect(ResearchDepthConfigSchema.safeParse({ tier: 'deep' }).success).toBe(true)
  })

  it('accepts numeric overrides within range', () => {
    expect(
      ResearchDepthConfigSchema.safeParse({ maxTurns: 40, maxToolCalls: 30, timeoutMs: 120_000 })
        .success,
    ).toBe(true)
  })

  it('rejects an unknown tier', () => {
    expect(ResearchDepthConfigSchema.safeParse({ tier: 'turbo' }).success).toBe(false)
  })

  it('rejects an over-ceiling override', () => {
    expect(ResearchDepthConfigSchema.safeParse({ maxTurns: 999 }).success).toBe(false)
  })

  it('rejects unknown keys (strict)', () => {
    expect(ResearchDepthConfigSchema.safeParse({ depth: 'deep' }).success).toBe(false)
  })

  it('exposes both tier names', () => {
    expect(RESEARCH_DEPTH_TIERS).toEqual(['standard', 'deep'])
  })
})
