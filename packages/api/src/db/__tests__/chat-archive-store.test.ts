/** [COMP:api/chat-archive-store] Owner-gated hybrid chat archive retrieval. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryWithRLS } = vi.hoisted(() => ({ queryWithRLS: vi.fn() }))
vi.mock('../client.js', () => ({ queryWithRLS }))

import {
  getChatCoverage,
  getChatMessageWithContext,
  listChatConversations,
  searchChatArchive,
} from '../chat-archive-store.js'

const baseRow = {
  segment_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  message_id: '11111111-1111-4111-8111-111111111111',
  instance_id: '22222222-2222-4222-8222-222222222222',
  source: 'whatsapp',
  provider_message_id: 'wamid.1',
  conversation_id: 'chat-1',
  sender_id: 'sender-1',
  sender_display: 'Ada',
  sent_at: new Date('2026-08-04T10:00:00Z'),
  direction: 'inbound' as const,
  kind: 'text',
  body_text: 'The deposit is due Friday',
  media_ref: null,
  reply_to_provider_id: null,
  segment_index: 0,
  segment_text: 'The deposit is due Friday',
}

beforeEach(() => queryWithRLS.mockReset())

describe('[COMP:api/chat-archive-store] chat archive reads', () => {
  it('fuses vector and tokenized lexical arms while owner-binding every query', async () => {
    const second = {
      ...baseRow,
      segment_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      message_id: '33333333-3333-4333-8333-333333333333',
      provider_message_id: 'wamid.2',
      conversation_id: 'chat-2',
      sent_at: new Date('2026-08-03T10:00:00Z'),
      body_text: 'Payment timing',
      segment_text: 'Payment timing',
    }
    queryWithRLS.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[1] ?? '')
      if (sql.includes('s.embedding <=>')) return { rows: [{ ...baseRow, distance: 0.1 }] }
      if (sql.includes('AS term_hits')) return { rows: [baseRow, second] }
      if (sql.includes('count(*)::text')) return { rows: [{ n: '2' }] }
      return { rows: [] }
    })

    const result = await searchChatArchive(
      {
        ownerUserId: '99999999-9999-4999-8999-999999999999',
        query: 'when is the deposit due',
        source: 'whatsapp',
        sender: 'Ada',
        kind: 'text',
      },
      { embedder: { embed: async () => [[0.1, 0.2]] } },
    )

    expect(result.hits.map((hit) => hit.message_id)).toContain(baseRow.message_id)
    expect(result.hits.map((hit) => hit.message_id)).toContain(second.message_id)
    expect(result.embeddingCoverage.partial).toBe(true)
    for (const call of queryWithRLS.mock.calls) {
      expect(call[0]).toBe('99999999-9999-4999-8999-999999999999')
      expect(call[1]).toContain('m.owner_user_id')
    }
    const lexicalSql = queryWithRLS.mock.calls.find((call) => String(call[1]).includes('AS term_hits'))?.[1]
    expect(lexicalSql).toContain('s.segment_text ILIKE')
    expect(lexicalSql).toContain('m.kind =')
    expect(lexicalSql).not.toContain("ILIKE '%when is the deposit due%'")
  })

  it('focuses an exact sender-name lookup on that person instead of unrelated vector matches', async () => {
    const exactOlder = {
      ...baseRow,
      segment_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      message_id: '11111111-1111-4111-8111-111111111112',
      provider_message_id: 'wx-older',
      conversation_id: 'wx-person',
      sender_id: 'wxid-person',
      sender_display: '鄭運英',
      sent_at: new Date('2024-11-16T10:00:00Z'),
      body_text: '星期一返香港',
      segment_text: '星期一返香港',
    }
    const exactNewer = {
      ...exactOlder,
      segment_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      message_id: '11111111-1111-4111-8111-111111111113',
      provider_message_id: 'wx-newer',
      sent_at: new Date('2026-02-17T10:00:00Z'),
      body_text: '[transfer]',
      segment_text: '[transfer]',
    }
    const unrelatedVector = {
      ...baseRow,
      segment_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      message_id: '11111111-1111-4111-8111-111111111114',
      provider_message_id: 'wx-unrelated',
      sender_display: 'Someone Else',
    }
    queryWithRLS.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[1] ?? '')
      if (sql.includes('s.embedding <=>')) return { rows: [unrelatedVector] }
      if (sql.includes('AS term_hits')) return { rows: [exactNewer, exactOlder, unrelatedVector] }
      if (sql.includes('count(*)::text')) return { rows: [{ n: '0' }] }
      return { rows: [] }
    })

    const result = await searchChatArchive(
      { ownerUserId: '99999999-9999-4999-8999-999999999999', query: '鄭運英' },
      { embedder: { embed: async () => [[0.1, 0.2]] } },
    )

    expect(result.hits).toHaveLength(2)
    expect(result.hits.every((hit) => hit.sender_display === '鄭運英')).toBe(true)
    expect(result.hits.map((hit) => hit.provider_message_id)).not.toContain('wx-unrelated')
  })

  it('returns bounded chronological neighbors around a message', async () => {
    const target = { ...baseRow }
    const previous = {
      ...target,
      message_id: '00000000-0000-4000-8000-000000000001',
      provider_message_id: 'wamid.0',
      sent_at: new Date('2026-08-04T09:59:00Z'),
    }
    const following = {
      ...target,
      message_id: '44444444-4444-4444-8444-444444444444',
      provider_message_id: 'wamid.2',
      sent_at: new Date('2026-08-04T10:01:00Z'),
    }
    queryWithRLS
      .mockResolvedValueOnce({ rows: [target] })
      .mockResolvedValueOnce({ rows: [previous] })
      .mockResolvedValueOnce({ rows: [following] })

    const result = await getChatMessageWithContext({
      ownerUserId: 'owner-1',
      messageId: target.message_id,
      before: 1,
      after: 1,
    })
    expect(result?.messages.map((message) => message.provider_message_id)).toEqual([
      'wamid.0',
      'wamid.1',
      'wamid.2',
    ])
    expect(result?.targetIndex).toBe(1)
    expect(queryWithRLS.mock.calls.every((call) => call[0] === 'owner-1')).toBe(true)
  })

  it('lists conversations newest-first and normalizes aggregate values', async () => {
    queryWithRLS.mockResolvedValue({
      rows: [{
        instance_id: baseRow.instance_id,
        source: 'whatsapp',
        conversation_id: 'chat-1',
        message_count: '42',
        first_sent_at: new Date('2026-01-01T00:00:00Z'),
        last_sent_at: new Date('2026-08-04T10:00:00Z'),
        last_message_preview: 'hello',
        last_sender_id: 'sender-1',
        last_sender_display: 'Ada',
        last_direction: 'inbound',
      }],
    })
    const rows = await listChatConversations({ ownerUserId: 'owner-1' })
    expect(rows[0]?.message_count).toBe(42)
    expect(rows[0]?.last_sent_at).toBe('2026-08-04T10:00:00.000Z')
    expect(queryWithRLS.mock.calls[0]?.[1]).toContain('row_number() OVER')
  })

  it('reports only gaps between independently acquired windows', async () => {
    queryWithRLS.mockResolvedValue({
      rows: [
        {
          instance_id: baseRow.instance_id,
          conversation_id: 'chat-1',
          window_start: new Date('2026-01-01T00:00:00Z'),
          window_end: new Date('2026-01-31T00:00:00Z'),
          first_provider_message_id: 'a',
          last_provider_message_id: 'b',
        },
        {
          instance_id: baseRow.instance_id,
          conversation_id: 'chat-1',
          window_start: new Date('2026-03-01T00:00:00Z'),
          window_end: new Date('2026-04-01T00:00:00Z'),
          first_provider_message_id: 'c',
          last_provider_message_id: 'd',
        },
      ],
    })
    const rows = await getChatCoverage({ ownerUserId: 'owner-1' })
    expect(rows[0]?.gaps).toEqual([{
      from: '2026-01-31T00:00:00.000Z',
      to: '2026-03-01T00:00:00.000Z',
      evidence: 'between_acquired_windows',
    }])
  })
})
