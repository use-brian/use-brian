import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query, queryWithRLS } = vi.hoisted(() => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

vi.mock('../client.js', () => ({ query, queryWithRLS }))

import { createRealtimeThreadTargetStore } from '../realtime-thread-target-store.js'

const row = {
  id: '11111111-1111-1111-1111-111111111111',
  workspaceId: '22222222-2222-2222-2222-222222222222',
  assistantId: '33333333-3333-3333-3333-333333333333',
  channelType: 'feishu',
  conversationRef: 'chat-7',
  threadRef: 'message-9',
  taskIds: ['44444444-4444-4444-4444-444444444444'],
  contextText: 'Daily task',
  expiresAt: new Date('2026-08-30T00:00:00Z'),
  createdByUserId: '55555555-5555-5555-5555-555555555555',
  createdAt: new Date('2026-08-23T00:00:00Z'),
  updatedAt: new Date('2026-08-23T00:00:00Z'),
}

beforeEach(() => {
  query.mockReset()
  queryWithRLS.mockReset()
})

describe('[COMP:api/realtime-thread-target-store] PostgreSQL adapter', () => {
  it('upserts one channel-neutral tuple under the acting user RLS view', async () => {
    queryWithRLS.mockResolvedValue({ rows: [row], rowCount: 1 })
    const store = createRealtimeThreadTargetStore()
    const result = await store.set(row.createdByUserId, {
      workspaceId: row.workspaceId,
      assistantId: row.assistantId,
      channelType: row.channelType,
      conversationRef: row.conversationRef,
      threadRef: row.threadRef,
      taskIds: row.taskIds,
      contextText: row.contextText,
      expiresAt: row.expiresAt,
      createdByUserId: row.createdByUserId,
    })

    expect(result).toMatchObject({ channelType: 'feishu', threadRef: 'message-9' })
    expect(queryWithRLS).toHaveBeenCalledWith(
      row.createdByUserId,
      expect.stringContaining('ON CONFLICT (workspace_id, assistant_id, channel_type, conversation_ref, thread_ref)'),
      expect.arrayContaining(['feishu', 'chat-7', 'message-9']),
    )
    expect(queryWithRLS.mock.calls[0]?.[1]).toContain('unnest($6::uuid[])')
  })

  it('looks up only an unexpired exact tuple on the trusted inbound path', async () => {
    query.mockResolvedValue({ rows: [row], rowCount: 1 })
    const store = createRealtimeThreadTargetStore()
    const now = new Date('2026-08-24T00:00:00Z')
    const result = await store.findActive({
      workspaceId: row.workspaceId,
      assistantId: row.assistantId,
      channelType: 'feishu',
      conversationRef: 'chat-7',
      threadRef: 'message-9',
      now,
    })

    expect(result?.id).toBe(row.id)
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('AND expires_at > $6'),
      [row.workspaceId, row.assistantId, 'feishu', 'chat-7', 'message-9', now],
    )
  })
})
