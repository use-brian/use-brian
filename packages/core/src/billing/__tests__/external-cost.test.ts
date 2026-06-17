import { describe, it, expect } from 'vitest'
import { encodeExternalCostMeta, decodeExternalCostMeta } from '../external-cost.js'

describe('[COMP:billing/external-cost] encode/decode round-trip', () => {
  it('per-token cost survives a round-trip', () => {
    const encoded = encodeExternalCostMeta({
      kind: 'per-token',
      model: 'grok-4-1-fast',
      inputTokens: 523,
      outputTokens: 487,
      cacheReadTokens: 40,
    })
    expect(encoded).toEqual({
      externalCost_kind: 'per-token',
      externalCost_model: 'grok-4-1-fast',
      externalCost_inputTokens: 523,
      externalCost_outputTokens: 487,
      externalCost_cacheReadTokens: 40,
    })
    expect(decodeExternalCostMeta(encoded)).toEqual({
      kind: 'per-token',
      model: 'grok-4-1-fast',
      inputTokens: 523,
      outputTokens: 487,
      cacheReadTokens: 40,
    })
  })

  it('per-token cost defaults cacheReadTokens to 0 when omitted', () => {
    const encoded = encodeExternalCostMeta({
      kind: 'per-token',
      model: 'grok-4-1-fast',
      inputTokens: 10,
      outputTokens: 20,
    })
    expect(encoded.externalCost_cacheReadTokens).toBe(0)
    const decoded = decodeExternalCostMeta(encoded)
    expect(decoded).toEqual({
      kind: 'per-token',
      model: 'grok-4-1-fast',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
    })
  })

  it('flat cost survives a round-trip', () => {
    const encoded = encodeExternalCostMeta({
      kind: 'flat',
      model: 'brave',
      flatCostUsd: 0.005,
    })
    expect(encoded).toEqual({
      externalCost_kind: 'flat',
      externalCost_model: 'brave',
      externalCost_flatCostUsd: 0.005,
    })
    expect(decodeExternalCostMeta(encoded)).toEqual({
      kind: 'flat',
      model: 'brave',
      flatCostUsd: 0.005,
    })
  })

  it('undefined / missing meta decodes to undefined', () => {
    expect(decodeExternalCostMeta(undefined)).toBeUndefined()
    expect(decodeExternalCostMeta({})).toBeUndefined()
    expect(decodeExternalCostMeta({ searchProvider: 'brave' })).toBeUndefined()
  })

  it('malformed per-token meta (missing required field) decodes to undefined', () => {
    expect(
      decodeExternalCostMeta({
        externalCost_kind: 'per-token',
        externalCost_model: 'grok-4-1-fast',
        // Missing inputTokens / outputTokens
      }),
    ).toBeUndefined()
  })

  it('malformed flat meta (missing flatCostUsd) decodes to undefined', () => {
    expect(
      decodeExternalCostMeta({
        externalCost_kind: 'flat',
        externalCost_model: 'brave',
      }),
    ).toBeUndefined()
  })

  it('unknown kind decodes to undefined', () => {
    expect(
      decodeExternalCostMeta({
        externalCost_kind: 'mystery',
        externalCost_model: 'x',
        externalCost_flatCostUsd: 1,
      }),
    ).toBeUndefined()
  })
})
