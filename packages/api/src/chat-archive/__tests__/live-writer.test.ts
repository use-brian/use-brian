/** [COMP:api/chat-archive-live-capture] Transactional live archive writer. */

import { describe, expect, it, vi } from 'vitest'
import { createLiveChatArchiveWriter } from '../live-writer.js'

const context = {
  source: 'slack' as const,
  ownerUserId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  assistantId: '33333333-3333-4333-8333-333333333333',
  assistantName: 'Brian',
  conversationId: 'channel-1',
}

function harness() {
  const order: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => {
      order.push(sql)
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(() => order.push('RELEASE')),
  }
  const pool = {
    query: vi.fn(async () => ({ rows: [{ id: 'instance-1' }], rowCount: 1 })),
    connect: vi.fn(async () => client),
  }
  const sinks = {
    ensureManagedLocalChatArchive: vi.fn(async () => ({ id: 'sink-1' })),
  }
  const fanout = {
    fanout: vi.fn(async () => ({ enqueued: [] })),
  }
  const writer = createLiveChatArchiveWriter({
    endpointUrl: 'http://127.0.0.1:8092',
    secret: 'secret',
    sinks: sinks as never,
    fanout: fanout as never,
    pool: pool as never,
  })
  return { writer, order, client, pool, sinks, fanout }
}

describe('[COMP:api/chat-archive-live-capture] live writer', () => {
  it('rejects any non-loopback destination', () => {
    expect(() => createLiveChatArchiveWriter({
      endpointUrl: 'https://archive.example.com',
      secret: 'secret',
      sinks: {} as never,
      fanout: {} as never,
      pool: {} as never,
    })).toThrow(/loopback/)
  })

  it('commits inbound session persistence and fanout in one transaction', async () => {
    const { writer, order, client, sinks, fanout } = harness()
    const persist = vi.fn(async () => {
      order.push('PERSIST')
      return { id: 'session-message-1' }
    })
    const result = await writer.persistInbound({
      ...context,
      message: {
        userId: 'slack-user', channelId: 'channel-1', messageId: 'slack-ts',
        text: 'hello', isGroupChat: false, timestamp: 1_700_000_000, raw: {},
      },
    }, persist)

    expect(result).toEqual({ id: 'session-message-1' })
    expect(order).toEqual(['BEGIN', 'PERSIST', 'COMMIT', 'RELEASE'])
    expect(persist).toHaveBeenCalledWith(client)
    expect(fanout.fanout).toHaveBeenCalledWith(expect.objectContaining({
      connectorInstanceId: 'instance-1',
      source: 'slack',
      messages: [expect.objectContaining({ provider_message_id: 'slack-ts' })],
    }), client)
    expect(sinks.ensureManagedLocalChatArchive).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl: 'http://127.0.0.1:8092/append',
    }))
  })

  it('binds archive delivery to the exact channel connector instance', async () => {
    const { writer, pool, fanout } = harness()
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'channel-instance-1' }], rowCount: 1 })
    await writer.persistInbound({
      ...context,
      connectorInstanceId: 'channel-instance-1',
      message: {
        userId: 'slack-user', channelId: 'channel-1', messageId: 'slack-ts',
        text: 'hello', isGroupChat: false, timestamp: 1_700_000_000, raw: {},
      },
    }, async () => ({ id: 'session-message-1' }))

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = $1 AND provider = $2'),
      [
        'channel-instance-1',
        'slack',
        context.workspaceId,
        context.ownerUserId,
      ],
    )
    expect(fanout.fanout).toHaveBeenCalledWith(expect.objectContaining({
      connectorInstanceId: 'channel-instance-1',
    }), expect.anything())
  })

  it('keeps session chat available when archive setup fails before BEGIN', async () => {
    const { writer, sinks, pool } = harness()
    sinks.ensureManagedLocalChatArchive.mockRejectedValueOnce(new Error('archive unavailable'))
    const persist = vi.fn(async () => ({ id: 'session-message-1' }))
    await expect(writer.persistInbound({
      ...context,
      message: {
        userId: 'u', channelId: 'channel-1', messageId: 'm', text: 'hello',
        isGroupChat: false, timestamp: 1, raw: {},
      },
    }, persist)).resolves.toEqual({ id: 'session-message-1' })
    expect(persist).toHaveBeenCalledWith()
    expect(pool.connect).not.toHaveBeenCalled()
  })
})
