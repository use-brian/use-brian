import { describe, expect, it, vi } from 'vitest'
import { calculateCost, type UsageStore } from '@use-brian/core'
import { recordChannelTurnUsage } from '../channel-pipeline.js'

describe('channel native-image ordinary billing boundary', () => {
  const attribution = {
    userId: 'billing-owner', actorUserId: 'channel-user', assistantId: 'assistant', sessionId: 'session',
    modelTier: 'standard', userMessageId: 'credit-bearing-message', source: 'included' as const,
    providerKeySource: 'platform' as const,
  }
  const imageResponse = {
    model: 'unknown-native-image-model', usageAccounting: 'native_image' as const,
    usage: { inputTokens: 100, outputTokens: 20 },
  }
  function store() {
    const recordUsage = vi.fn().mockResolvedValue(undefined)
    return { recordUsage, usageStore: { recordUsage } as unknown as UsageStore }
  }
  it('never prices or records image-only unknown-model usage as ordinary/free usage', () => {
    const { usageStore, recordUsage } = store()
    const cost = recordChannelTurnUsage({
      event: { response: imageResponse, totalUsage: { inputTokens: 0, outputTokens: 0 } },
      usageStore, channelType: 'telegram', attribution,
    })
    expect(recordUsage).not.toHaveBeenCalled()
    expect(cost).toBeNull() // unknown/separately settled is not a fabricated free cost
  })
  it('records the mixed-turn remainder exactly once under the text model and original billing identity', () => {
    const { usageStore, recordUsage } = store()
    const usage = { inputTokens: 13, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 3 }
    const event = { response: { ...imageResponse, billableModel: 'gemini-flash' }, totalUsage: usage }
    const original = structuredClone(event)
    const cost = recordChannelTurnUsage({ event, usageStore, channelType: 'slack', attribution })
    expect(cost).toBe(calculateCost('gemini-flash', usage))
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith({
      ...attribution, model: 'gemini-flash', ...usage, actualCostUsd: cost, triggerKey: 'main_response',
    })
    expect(event).toEqual(original) // observed model and native counters remain available to analytics
  })
  it('retains BYO billing policy for the ordinary remainder', () => {
    const { usageStore, recordUsage } = store()
    expect(recordChannelTurnUsage({
      event: { response: { ...imageResponse, billableModel: 'gemini-flash' }, totalUsage: { inputTokens: 13, outputTokens: 7 } },
      usageStore, channelType: 'telegram', attribution: { ...attribution, providerKeySource: 'user' },
    })).toBe(0)
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({ model: 'gemini-flash', actualCostUsd: 0, providerKeySource: 'user' })
  })
  it('still computes ordinary telemetry without an optional usage store', () => {
    const usage = { inputTokens: 13, outputTokens: 7 }
    expect(recordChannelTurnUsage({
      event: { response: { model: 'gemini-flash' }, totalUsage: usage }, channelType: 'telegram', attribution,
    })).toBe(calculateCost('gemini-flash', usage))
  })
})
