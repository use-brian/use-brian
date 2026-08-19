// [COMP:api/channel-tool-observability] — the channel pipeline's per-tool
// analytics + external-cost seam.
//
// Until this existed, `tool_executed` was emitted ONLY by `routes/chat.ts`
// (with `channelType` hardcoded to `'web'`) and by the callee executor. Every
// messaging channel therefore wrote NOTHING per tool call while genuinely
// running tools: between 2026-08-12 and 2026-08-19 production logged 123
// Telegram turns / 0 tool events and 52 Slack turns / 0, against 142 persisted
// session messages carrying `tool_use` blocks on those same Telegram sessions.
// Nothing surfaced it, because a missing row is indistinguishable from a tool
// that was never called — so every rollup built on that table reported
// "channels never use tools" as fact.
//
// The same blindness had a billing half: `recordExternalCostFromMeta` is the
// one seam turning `ToolResult.meta.externalCost_*` into a `usage_tracking`
// row, and the channel lane never called it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AnalyticsLogger, ContentBlock, UsageStore } from '@use-brian/core'
import { encodeExternalCostMeta } from '@use-brian/core'

// The realtime repaint is a fire-and-forget LISTEN/NOTIFY against the pool;
// mocked so the suite asserts the call without touching a database.
vi.mock('../../brain-stream/notify.js', () => ({
  notifyBrainWriteIfMatch: vi.fn(),
}))

import { notifyBrainWriteIfMatch } from '../../brain-stream/notify.js'
import { recordChannelToolResults } from '../channel-pipeline.js'

type LoggedEvent = {
  userId: string
  assistantId: string
  sessionId: string
  eventName: string
  channelType?: string
  metadata: Record<string, unknown>
}

function makeAnalytics(): { logger: AnalyticsLogger; events: LoggedEvent[] } {
  const events: LoggedEvent[] = []
  return {
    events,
    logger: { logEvent: (e: LoggedEvent) => events.push(e) } as unknown as AnalyticsLogger,
  }
}

type RecordedUsage = Parameters<UsageStore['recordUsage']>[0]

function makeUsageStore(): { store: UsageStore; rows: RecordedUsage[] } {
  const rows: RecordedUsage[] = []
  return {
    rows,
    store: {
      recordUsage: async (params: RecordedUsage) => {
        rows.push(params)
      },
    } as unknown as UsageStore,
  }
}

function toolResult(over: Partial<Extract<ContentBlock, { type: 'tool_result' }>> = {}): ContentBlock {
  return {
    type: 'tool_result',
    toolUseId: 'tu_1',
    name: 'webSearch',
    content: 'ok',
    ...over,
  }
}

const base = {
  userId: 'u_channel_user',
  billingUserId: 'u_workspace_owner',
  assistantId: 'a_1',
  sessionId: 's_1',
  workspaceId: 'ws_1',
  userMessageId: 'msg_1',
  userPlan: 'pro',
  channelType: 'telegram',
}

describe('[COMP:api/channel-tool-observability] Channel tool observability', () => {
  beforeEach(() => {
    vi.mocked(notifyBrainWriteIfMatch).mockClear()
  })

  it('emits tool_executed on the pipeline channel, never the hardcoded web literal', () => {
    const { logger, events } = makeAnalytics()
    for (const channelType of ['telegram', 'slack', 'whatsapp', 'discord']) {
      recordChannelToolResults({
        ...base,
        channelType,
        results: [toolResult()],
        analytics: logger,
        usageStore: undefined,
      })
    }
    expect(events.map((e) => e.channelType)).toEqual(['telegram', 'slack', 'whatsapp', 'discord'])
    expect(events.every((e) => e.eventName === 'tool_executed')).toBe(true)
    expect(events.some((e) => e.channelType === 'web')).toBe(false)
  })

  it('keys the analytics event on the channel user, and the cost row on the billing party', async () => {
    const { logger, events } = makeAnalytics()
    const { store, rows } = makeUsageStore()
    recordChannelToolResults({
      ...base,
      results: [toolResult()],
      metaByToolUseId: {
        tu_1: encodeExternalCostMeta({ kind: 'flat', model: 'brave', flatCostUsd: 0.005 }),
      },
      analytics: logger,
      usageStore: store,
    })
    // The cost recording is fire-and-forget, so let its microtasks drain.
    await Promise.resolve()
    await Promise.resolve()

    // Activity follows the person who typed. This is the same split the main
    // turn already makes: usage on the billing party, analytics on the actor.
    expect(events[0]?.userId).toBe('u_channel_user')
    // Spend follows the payer. `ownerId` (assistants.owner_user_id) is NULL for
    // a workspace-owned assistant, which is what broke the overhead rows.
    expect(rows[0]?.userId).toBe('u_workspace_owner')
    expect(rows[0]?.model).toBe('brave')
    expect(rows[0]?.actualCostUsd).toBe(0.005)
    // Stamped so the tool's spend folds into the same credit unit as the turn
    // that spent it (the derivation groups by COALESCE(user_message_id, id)).
    expect(rows[0]?.userMessageId).toBe('msg_1')
  })

  it('records a flat-rate and a per-token external cost, and nothing when the tool spent nothing', async () => {
    const { logger } = makeAnalytics()
    const { store, rows } = makeUsageStore()
    recordChannelToolResults({
      ...base,
      results: [
        toolResult({ toolUseId: 'tu_flat', name: 'webSearch' }),
        toolResult({ toolUseId: 'tu_tokens', name: 'xSearch' }),
        toolResult({ toolUseId: 'tu_free', name: 'listTasks' }),
      ],
      metaByToolUseId: {
        tu_flat: encodeExternalCostMeta({ kind: 'flat', model: 'serper', flatCostUsd: 0.003 }),
        tu_tokens: encodeExternalCostMeta({
          kind: 'per-token',
          model: 'grok-4-fast',
          inputTokens: 1_000,
          outputTokens: 200,
        }),
      },
      analytics: logger,
      usageStore: store,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(rows.map((r) => r.model)).toEqual(['serper', 'grok-4-fast'])
    expect(rows[1]?.inputTokens).toBe(1_000)
    expect(rows[1]?.outputTokens).toBe(200)
  })

  it('carries a short error excerpt on failure and no error key on success', () => {
    const { logger, events } = makeAnalytics()
    recordChannelToolResults({
      ...base,
      results: [
        toolResult({ toolUseId: 'tu_ok', name: 'listTasks' }),
        toolResult({
          toolUseId: 'tu_bad',
          name: 'gmailSendMessage',
          isError: true,
          content: `boom\n  ${'x'.repeat(400)}`,
        }),
      ],
      analytics: logger,
      usageStore: undefined,
    })

    expect(events[0]?.metadata).toMatchObject({ tool_name: 'listTasks', success: true })
    expect(events[0]?.metadata).not.toHaveProperty('error_message')

    expect(events[1]?.metadata).toMatchObject({ tool_name: 'gmailSendMessage', success: false })
    const excerpt = events[1]?.metadata.error_message as string
    expect(excerpt.startsWith('boom ')).toBe(true)
    // Whitespace collapsed and capped, exactly like the chat / callee lanes.
    expect(excerpt.length).toBeLessThanOrEqual(200)
    expect(excerpt).not.toContain('\n')
  })

  it('merges the tool result meta but never tool content, and never the worker-lane marker', () => {
    const { logger, events } = makeAnalytics()
    recordChannelToolResults({
      ...base,
      results: [toolResult({ content: 'SECRET RESULT PAYLOAD' })],
      metaByToolUseId: { tu_1: { searchProvider: 'brave', resultCount: 7, cached: true } },
      analytics: logger,
      usageStore: undefined,
    })

    expect(events[0]?.metadata).toMatchObject({
      tool_name: 'webSearch',
      success: true,
      searchProvider: 'brave',
      resultCount: 7,
      cached: true,
    })
    // `in_worker` marks the chat route's sub-agent lane; this pipeline has none.
    expect(events[0]?.metadata).not.toHaveProperty('in_worker')
    expect(JSON.stringify(events[0]?.metadata)).not.toContain('SECRET RESULT PAYLOAD')
  })

  it('repaints the brain for every result block, matching the web chat lane', () => {
    const { logger } = makeAnalytics()
    recordChannelToolResults({
      ...base,
      results: [
        toolResult({ toolUseId: 'tu_a', name: 'saveMemory' }),
        toolResult({ toolUseId: 'tu_b', name: 'saveTask', isError: true }),
      ],
      analytics: logger,
      usageStore: undefined,
    })

    expect(vi.mocked(notifyBrainWriteIfMatch).mock.calls).toEqual([
      ['ws_1', 'saveMemory', false],
      ['ws_1', 'saveTask', true],
    ])
  })

  it('skips blocks that are not tool results, and no-ops without an analytics logger', () => {
    const { logger, events } = makeAnalytics()
    recordChannelToolResults({
      ...base,
      results: [
        { type: 'text', text: 'thinking out loud' },
        toolResult(),
      ],
      analytics: logger,
      usageStore: undefined,
    })
    expect(events).toHaveLength(1)

    expect(() =>
      recordChannelToolResults({
        ...base,
        results: [toolResult()],
        analytics: undefined,
        usageStore: undefined,
      }),
    ).not.toThrow()
  })
})
