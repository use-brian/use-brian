import { describe, expect, it, vi } from 'vitest'
import type { ToolContext, UsageStore } from '@use-brian/core'
import { createBrowserAgentUsageRecorder } from '../browser-agent-metering.js'

const context: ToolContext = {
  userId: '00000000-0000-4000-8000-000000000001',
  assistantId: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000003',
  workspaceId: '00000000-0000-4000-8000-000000000004',
  appId: 'app-fixture',
  channelType: 'web',
  channelId: 'channel-fixture',
  abortSignal: new AbortController().signal,
}

describe('[COMP:sandbox/bu-fallback] Jev browser-agent usage metering', () => {
  it('records Jev and helper lines with exact attribution and BYO-zero cost', async () => {
    const rows: Array<Parameters<UsageStore['recordUsage']>[0]> = []
    const recordUsage: UsageStore['recordUsage'] = vi.fn(async (params) => { rows.push(params) })
    const usageStore = { recordUsage } as UsageStore
    await createBrowserAgentUsageRecorder(usageStore)([
      {
        kind: 'jev',
        model: 'jev-1.13.0',
        inputTokens: 1_000,
        outputTokens: 0,
        providerKeySource: 'platform',
      },
      {
        kind: 'text_helper',
        model: 'gemini-3-flash-preview',
        inputTokens: 200,
        outputTokens: 25,
        providerKeySource: 'user',
      },
    ], context)

    expect(recordUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workspaceId: context.workspaceId,
      userId: context.userId,
      actorUserId: context.userId,
      assistantId: context.assistantId,
      sessionId: context.sessionId,
      model: 'jev-1.13.0',
      source: 'included',
      triggerKey: 'computer_use:jev_ultrafast',
      providerKeySource: 'platform',
    }))
    expect(rows[0]?.actualCostUsd).toBeGreaterThan(0)
    expect(recordUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: 'gemini-3-flash-preview',
      triggerKey: 'computer_use:jev_text_helper',
      providerKeySource: 'user',
      actualCostUsd: 0,
    }))
  })

  it('keeps the browser result independent from a ledger failure', async () => {
    const recordUsage = vi.fn(async () => { throw new Error('fixture ledger down') })
    const usageStore = { recordUsage } as unknown as UsageStore
    await expect(createBrowserAgentUsageRecorder(usageStore)([{
      kind: 'jev',
      model: 'jev-1.13.0',
      inputTokens: 10,
      outputTokens: 0,
      providerKeySource: 'platform',
    }], context)).resolves.toBeUndefined()
  })
})
