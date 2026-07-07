import { describe, it, expect } from 'vitest'
import { calculateCost, isOverheadSource, OVERHEAD_SOURCES } from '../cost-tracker.js'

describe('[COMP:billing/cost-tracker] isOverheadSource', () => {
  it('returns true for every enshrined overhead source', () => {
    for (const src of OVERHEAD_SOURCES) {
      expect(isOverheadSource(src)).toBe(true)
    }
  })

  it('returns false for billable source values', () => {
    expect(isOverheadSource('included')).toBe(false)
    expect(isOverheadSource('free')).toBe(false)
    expect(isOverheadSource('credits')).toBe(false)
  })

  it('returns true for any future overhead:* label', () => {
    expect(isOverheadSource('overhead:auto-titler')).toBe(true)
    expect(isOverheadSource('overhead:preflight')).toBe(true)
  })

  it('does not match strings that merely contain overhead', () => {
    expect(isOverheadSource('my-overhead')).toBe(false)
    expect(isOverheadSource('')).toBe(false)
  })

  it('enumerates the migration-305 additions (CHECK-constraint parity)', () => {
    for (const src of [
      'overhead:embedding',
      'overhead:synthesis',
      'overhead:goal-clarity',
      'overhead:goal-verify',
    ]) {
      expect(OVERHEAD_SOURCES).toContain(src)
    }
  })
})

describe('[COMP:billing/cost-tracker] calculateCost', () => {
  it('prices the embedding model at input-only $0.025/M via its namespaced alias', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 }
    expect(calculateCost('gemini-embedding-001', usage)).toBeCloseTo(0.025, 6)
    expect(calculateCost('gemini:gemini-embedding-001', usage)).toBeCloseTo(0.025, 6)
  })

  it('calculates Gemini Flash cost', () => {
    const cost = calculateCost('gemini-flash', {
      inputTokens: 1000,
      outputTokens: 500,
    })
    // 1000/1M * 0.50 + 500/1M * 3.00 = 0.0005 + 0.0015 = 0.0020
    expect(cost).toBeCloseTo(0.0020, 6)
  })

  it('calculates with cache tokens', () => {
    const cost = calculateCost('gemini-flash', {
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 10000,
      cacheWriteTokens: 0,
    })
    // 500/1M * 0.50 + 200/1M * 3.00 + 10000/1M * 0.05 = 0.00025 + 0.0006 + 0.0005 = 0.00135
    expect(cost).toBeCloseTo(0.00135, 6)
  })

  it('calculates cost with separated cache-read tokens', () => {
    // Simulates provider decomposition: 10K prompt, 8K cached, 500 output, 200 thoughts
    // Provider reports: inputTokens=2000, outputTokens=700, cacheReadTokens=8000
    const cost = calculateCost('gemini-flash', {
      inputTokens: 2000,
      outputTokens: 700,
      cacheReadTokens: 8000,
    })
    // 2000/1M * 0.50 + 700/1M * 3.00 + 8000/1M * 0.05
    // = 0.001 + 0.0021 + 0.0004 = 0.0035
    expect(cost).toBeCloseTo(0.0035, 6)
  })

  it('uses alias resolution', () => {
    const cost1 = calculateCost('gemini-flash', { inputTokens: 1000, outputTokens: 500 })
    const cost2 = calculateCost('gemini-3-flash-preview', { inputTokens: 1000, outputTokens: 500 })
    expect(cost1).toBe(cost2)
  })

  it('prices the synthetic Standard chat-tier id at Flash 3 rates', () => {
    // `gemini-3-flash-standard` (MODEL_MAP.standard) is recorded on Standard
    // chat turns; COGS must resolve to the real Flash 3 (gemini-3-flash-preview)
    // rate, not the unknown-model fallback. Drift here silently misprices the
    // Standard tier's COGS on the admin dashboard.
    const usage = { inputTokens: 12_345, outputTokens: 6_789, cacheReadTokens: 4_000 }
    expect(calculateCost('gemini-3-flash-standard', usage))
      .toBe(calculateCost('gemini-3-flash-preview', usage))
  })

  it('prices the synthetic Research-tier id at Gemini Pro 3.1 rates', () => {
    // `gemini-3-pro-research` (MODEL_MAP.research) is recorded on research
    // turns; COGS must resolve to the real Pro 3.1 (gemini-3.1-pro-preview)
    // rate. Pro 3.1 is pricier than Flash 3.5, so this must NOT collapse to a
    // Flash rate — that would understate research COGS and inflate margins.
    const usage = { inputTokens: 50_000, outputTokens: 8_000 }
    expect(calculateCost('gemini-3-pro-research', usage))
      .toBe(calculateCost('gemini-3.1-pro-preview', usage))
    // Sanity: Pro 3.1 output ($12/M) is dearer than Flash 3 output ($3/M).
    expect(calculateCost('gemini-3-pro-research', usage))
      .toBeGreaterThan(calculateCost('gemini-3-flash-standard', usage))
  })

  it('falls back to Flash pricing for unknown models', () => {
    const cost = calculateCost('unknown-model', { inputTokens: 1000, outputTokens: 500 })
    expect(cost).toBeGreaterThan(0)
  })

  it('calculates Grok xSearch cost (reasoning variant)', () => {
    // Rate: input $0.20/Mtok, output $0.50/Mtok, cache-read $0.05/Mtok.
    // 500/1M * 0.20 + 400/1M * 0.50 + 100/1M * 0.05
    //   = 0.0001 + 0.0002 + 0.000005 = 0.000305
    const cost = calculateCost('grok-4-1-fast', {
      inputTokens: 500,
      outputTokens: 400,
      cacheReadTokens: 100,
    })
    expect(cost).toBeCloseTo(0.000305, 7)
  })

  it('Grok reasoning and non-reasoning variants price identically', () => {
    const u = { inputTokens: 1000, outputTokens: 1000 }
    expect(calculateCost('grok-4-1-fast', u)).toBe(
      calculateCost('grok-4-1-fast-non-reasoning', u),
    )
  })
})
