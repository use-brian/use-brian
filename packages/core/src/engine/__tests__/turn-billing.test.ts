import { describe, expect, it } from 'vitest'
import { billableTurnUsage } from '../turn-billing.js'

describe('ordinary turn billing projection', () => {
  const response = { model: 'unknown-image-model', usageAccounting: 'native_image' as const }
  it('does not create a zero-cost ordinary row for independently accounted image-only usage', () => {
    expect(billableTurnUsage({ response, totalUsage: { inputTokens: 0, outputTokens: 0 } })).toBeNull()
  })
  it('prices the ordinary remainder under its own model without mutating observed metrics', () => {
    const event = {
      response: { ...response, billableModel: 'gemini-flash', usage: { inputTokens: 100, outputTokens: 20 } },
      totalUsage: { inputTokens: 13, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 3 },
    }
    const original = structuredClone(event)
    expect(billableTurnUsage(event)).toEqual({ model: 'gemini-flash', usage: event.totalUsage })
    expect(event).toEqual(original)
  })
  it.each(['cacheReadTokens', 'cacheWriteTokens'] as const)('retains a cache-only ordinary remainder (%s)', (key) => {
    const usage = { inputTokens: 0, outputTokens: 0, [key]: 5 }
    expect(billableTurnUsage({ response: { ...response, billableModel: 'gemini-flash' }, totalUsage: usage }))
      .toEqual({ model: 'gemini-flash', usage })
  })
  it('preserves ordinary legacy zero-usage rows and model fallback', () => {
    const usage = { inputTokens: 0, outputTokens: 0 }
    expect(billableTurnUsage({ response: { model: 'gemini-flash' }, totalUsage: usage }))
      .toEqual({ model: 'gemini-flash', usage })
  })
  it('does not synthesize missing usage', () => {
    expect(billableTurnUsage({ response })).toBeNull()
  })
})
