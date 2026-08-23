import { describe, expect, it, vi } from 'vitest'
import {
  createRealtimeThreadTargetTools,
  resolveRealtimeThreadAddressing,
  type RealtimeThreadTarget,
  type RealtimeThreadTargetStore,
} from '../realtime-thread-targets.js'

const NOW = new Date('2026-08-23T00:00:00.000Z')

function target(over: Partial<RealtimeThreadTarget> = {}): RealtimeThreadTarget {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    workspaceId: '22222222-2222-2222-2222-222222222222',
    assistantId: '33333333-3333-3333-3333-333333333333',
    channelType: 'discord',
    conversationRef: 'conversation-7',
    threadRef: 'thread-9',
    taskIds: ['44444444-4444-4444-4444-444444444444'],
    contextText: 'Daily workflow: ship the release',
    expiresAt: new Date('2026-08-30T00:00:00.000Z'),
    createdByUserId: '55555555-5555-5555-5555-555555555555',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

function fakeStore(): RealtimeThreadTargetStore & { set: ReturnType<typeof vi.fn> } {
  return {
    set: vi.fn(async (_userId, input) => target({
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      channelType: input.channelType,
      conversationRef: input.conversationRef,
      threadRef: input.threadRef,
      taskIds: input.taskIds,
      contextText: input.contextText,
      expiresAt: input.expiresAt,
      createdByUserId: input.createdByUserId,
    })),
    list: vi.fn(async () => [target()]),
    remove: vi.fn(async () => true),
    findActive: vi.fn(async () => target()),
  } as never
}

const context = {
  userId: '55555555-5555-5555-5555-555555555555',
  assistantId: '33333333-3333-3333-3333-333333333333',
  workspaceId: '22222222-2222-2222-2222-222222222222',
  sessionId: 'session-1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'web-1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:brain/realtime-thread-targets] management tools', () => {
  it('sets an opaque non-Slack target with a bounded one-week expiry', async () => {
    const store = fakeStore()
    const tools = createRealtimeThreadTargetTools(store, () => NOW)
    const result = await tools.setRealtimeThreadTarget.execute({
      channel_type: 'discord',
      conversation_ref: 'conversation-7',
      thread_ref: 'thread-9',
      timeout_minutes: 10_080,
      task_ids: [
        '44444444-4444-4444-4444-444444444444',
        '44444444-4444-4444-4444-444444444444',
      ],
      context_text: 'Daily workflow: ship the release',
    }, context)

    expect(result.isError).toBeFalsy()
    expect(store.set).toHaveBeenCalledWith(context.userId, expect.objectContaining({
      channelType: 'discord',
      conversationRef: 'conversation-7',
      threadRef: 'thread-9',
      taskIds: ['44444444-4444-4444-4444-444444444444'],
      expiresAt: new Date('2026-08-30T00:00:00.000Z'),
    }))
  })

  it('fails closed without a workspace', async () => {
    const store = fakeStore()
    const tools = createRealtimeThreadTargetTools(store, () => NOW)
    const result = await tools.setRealtimeThreadTarget.execute({
      channel_type: 'feishu',
      conversation_ref: 'chat-1',
      thread_ref: 'message-1',
      timeout_minutes: 60,
    }, { ...context, workspaceId: null })
    expect(result.isError).toBe(true)
    expect(store.set).not.toHaveBeenCalled()
  })
})

describe('[COMP:brain/realtime-thread-targets] channel-neutral addressing', () => {
  it('admits an unaddressed Feishu reply through the exact active target', async () => {
    const findActive = vi.fn(async () => target({
      channelType: 'feishu',
      conversationRef: 'chat-1',
      threadRef: 'message-1',
    }))
    const result = await resolveRealtimeThreadAddressing({
      explicitlyAddressed: false,
      workspaceId: context.workspaceId,
      assistantId: context.assistantId,
      channelType: 'Feishu',
      conversationRef: 'chat-1',
      threadRef: 'message-1',
      targetStore: { findActive },
    })

    expect(result.accepted).toBe(true)
    expect(findActive).toHaveBeenCalledWith({
      workspaceId: context.workspaceId,
      assistantId: context.assistantId,
      channelType: 'feishu',
      conversationRef: 'chat-1',
      threadRef: 'message-1',
    })
  })

  it('keeps direct and explicitly addressed turns outside delegated authority', async () => {
    const findActive = vi.fn(async () => target())
    const result = await resolveRealtimeThreadAddressing({
      explicitlyAddressed: true,
      workspaceId: context.workspaceId,
      assistantId: context.assistantId,
      channelType: 'discord',
      conversationRef: 'conversation-7',
      threadRef: 'thread-9',
      targetStore: { findActive },
    })

    expect(result).toEqual({ accepted: true, target: null })
    expect(findActive).not.toHaveBeenCalled()
  })
})
