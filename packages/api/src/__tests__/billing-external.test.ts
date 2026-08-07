import { describe, it, expect, vi } from 'vitest'
import { encodeExternalCostMeta, flatSearchCostUsd } from '@use-brian/core'
import { recordExternalCostFromMeta } from '../billing-external.js'

const base = {
  userId: 'u-1',
  assistantId: 'a-1',
  sessionId: 's-1',
  analytics: undefined,
}

const braveMeta = {
  searchProvider: 'brave',
  ...encodeExternalCostMeta({ kind: 'flat', model: 'brave', flatCostUsd: flatSearchCostUsd('brave') }),
}

describe('[COMP:api/billing-external] external tool cost recording', () => {
  it('writes one flat-cost row with zero tokens', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined)
    await recordExternalCostFromMeta({
      ...base,
      toolMeta: braveMeta,
      usageStore: { recordUsage } as never,
      userMessageId: 'msg-1',
      userPlan: 'pro',
    })

    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0][0]).toMatchObject({
      userId: 'u-1',
      assistantId: 'a-1',
      sessionId: 's-1',
      model: 'brave',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      source: 'included',
      userMessageId: 'msg-1',
    })
    expect(recordUsage.mock.calls[0][0].actualCostUsd).toBeCloseTo(flatSearchCostUsd('brave'))
  })

  it('prices a per-token cost through the pricing table', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined)
    await recordExternalCostFromMeta({
      ...base,
      toolMeta: encodeExternalCostMeta({
        kind: 'per-token',
        model: 'grok-4-1-fast-non-reasoning',
        inputTokens: 500,
        outputTokens: 400,
        cacheReadTokens: 100,
      }),
      usageStore: { recordUsage } as never,
    })

    const row = recordUsage.mock.calls[0][0]
    expect(row).toMatchObject({ inputTokens: 500, outputTokens: 400, cacheReadTokens: 100 })
    expect(row.actualCostUsd).toBeGreaterThan(0)
  })

  it('records a free-plan turn against the free source', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined)
    await recordExternalCostFromMeta({
      ...base,
      toolMeta: braveMeta,
      usageStore: { recordUsage } as never,
      userPlan: 'free',
    })
    expect(recordUsage.mock.calls[0][0].source).toBe('free')
  })

  it('stamps a trigger key when the caller supplies one, and none otherwise', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined)
    await recordExternalCostFromMeta({
      ...base,
      toolMeta: braveMeta,
      usageStore: { recordUsage } as never,
      triggerKey: 'workflow_external_tool',
    })
    expect(recordUsage.mock.calls[0][0].triggerKey).toBe('workflow_external_tool')

    recordUsage.mockClear()
    await recordExternalCostFromMeta({
      ...base,
      toolMeta: braveMeta,
      usageStore: { recordUsage } as never,
    })
    expect(recordUsage.mock.calls[0][0].triggerKey).toBeUndefined()
  })

  it('no-ops on a tool result that carries no cost meta, and with no store wired', async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined)
    await recordExternalCostFromMeta({
      ...base,
      toolMeta: { searchProvider: 'brave' },
      usageStore: { recordUsage } as never,
    })
    expect(recordUsage).not.toHaveBeenCalled()

    await expect(
      recordExternalCostFromMeta({ ...base, toolMeta: braveMeta, usageStore: undefined }),
    ).resolves.toBeUndefined()
  })

  it('swallows a store failure and reports it as an analytics event on the caller channel', async () => {
    const logEvent = vi.fn()
    const recordUsage = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { name: 'DbError' }))

    await expect(
      recordExternalCostFromMeta({
        ...base,
        toolMeta: braveMeta,
        usageStore: { recordUsage } as never,
        channelType: 'workflow',
        analytics: { logEvent } as never,
      }),
    ).resolves.toBeUndefined()

    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'usage_tracking_error',
        channelType: 'workflow',
        metadata: { error_type: 'DbError', external_cost_model: 'brave' },
      }),
    )
  })
})
