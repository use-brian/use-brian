import { describe, expect, it } from 'vitest'
import { calculateCost } from '@use-brian/core'
import { nativePrice } from './accounting-capability.js'

describe('native price provenance', () => {
  it.each([null, 'unknown-native-model'])('never prices %s from an adapter override or a requested-model fallback', model => {
    const quote = nativePrice(model, { inputTokens: 10,outputTokens: 4,calculatedCostUsd: 0.25 }, 'platform')
    expect(quote).toMatchObject({ incurred: null,estimated: null,price: null })
  })
  it('uses only known actual-model rates, stripping adapter and unprovenanced decision cost overrides', () => {
    const usage = { inputTokens: 10,outputTokens: 4,calculatedCostUsd: 999,costUsd: 888 }
    const quote = nativePrice('gpt-5.2', usage, 'platform')
    const expected = calculateCost('gpt-5.2', { inputTokens: 10,outputTokens: 4 })
    expect(quote.incurred).toBe(expected)
    expect(quote.price).toMatchObject({ basis: 'registry',amountUsd: expected.toFixed(10),rateSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
  })
  it('current Jev pricing is registry-based, not a claim that costUsd came from the provider', () => {
    const usage = { inputTokens: 8,outputTokens: 1,costUsd: 99 }
    const quote = nativePrice('jev-1.13.0', usage, 'platform')
    expect(quote.price?.basis).toBe('registry')
    expect(quote.incurred).toBe(calculateCost('jev-1.13.0', { inputTokens: 8,outputTokens: 1 }))
  })
  it('unprovenanced decision costs cannot price an unknown actual Jev identity', () => {
    const usage = { inputTokens: 8,outputTokens: 1,costUsd: 99 }
    expect(nativePrice('unknown-jev-model', usage, 'platform')).toMatchObject({ incurred: null,estimated: null,price: null })
  })
  it('explicit BYOK zero is distinct from unknown incurred cost, and still requires usage/actual identity', () => {
    expect(nativePrice('unknown-native-model', { inputTokens: 10,outputTokens: 4,calculatedCostUsd: 99 }, 'user'))
      .toMatchObject({ incurred: null,estimated: 0,price: { basis: 'byok',amountUsd: '0.0000000000',rateSnapshotHash: null } })
    expect(nativePrice(null, undefined, 'user')).toMatchObject({ incurred: null,estimated: null,price: null })
    expect(nativePrice('gpt-5.2', undefined, 'platform')).toMatchObject({ incurred: null,estimated: null,price: null })
  })
})
