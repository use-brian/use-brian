/** [COMP:api/chat-archive-live-capture] Shared channel normalization. */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from '@use-brian/channels'
import { normalizeInboundChatMessage, normalizeOutboundChatMessage } from '../normalize.js'

function incoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    userId: 'provider-user-1',
    channelId: 'conversation-1',
    text: 'hello',
    isGroupChat: false,
    timestamp: 1_700_000_000,
    raw: { token: 'must-not-survive' },
    ...overrides,
  }
}

describe('[COMP:api/chat-archive-live-capture] normalizer', () => {
  it('preserves canonical inbound identity while dropping the raw webhook', () => {
    const result = normalizeInboundChatMessage({
      source: 'wechat',
      message: incoming({ messageId: 'wx-1', replyToMessageId: 'wx-0' }),
    })
    expect(result).toMatchObject({
      provider_message_id: 'wx-1',
      conversation_id: 'conversation-1',
      sender_id: 'provider-user-1',
      sent_at: '2023-11-14T22:13:20.000Z',
      direction: 'inbound',
      kind: 'text',
      body_text: 'hello',
      reply_to_provider_id: 'wx-0',
      raw_provider_blob: null,
    })
  })

  it('derives a stable id when a channel supplies none', () => {
    const message = incoming()
    const first = normalizeInboundChatMessage({ source: 'email', message })
    const second = normalizeInboundChatMessage({ source: 'email', message })
    expect(first.provider_message_id).toBe(second.provider_message_id)
    expect(first.provider_message_id).toMatch(/^derived:[a-f0-9]{64}$/)
  })

  it('maps attachment metadata without copying bytes or URLs', () => {
    const result = normalizeInboundChatMessage({
      source: 'telegram',
      message: incoming({
        mediaType: 'voice',
        mediaUrl: 'https://signed.example/secret',
        mediaMime: 'audio/ogg',
        mediaName: 'note.ogg',
        mediaSizeBytes: 1234,
      }),
    })
    expect(result.kind).toBe('voice')
    expect(result.media_ref).toEqual({ filename: 'note.ogg', mime: 'audio/ogg', size_bytes: 1234 })
    expect(JSON.stringify(result)).not.toContain('signed.example')
  })

  it('normalizes final outbound text and document metadata', () => {
    const result = normalizeOutboundChatMessage({
      providerMessageId: 'slack-ts-1',
      conversationId: 'c-1',
      assistantId: 'a-1',
      assistantName: 'Brian',
      text: 'report attached',
      sentAt: new Date('2026-08-04T00:00:00Z'),
      documents: [{ filename: 'report.pdf', mime: 'application/pdf', data: new Uint8Array(7) }],
    })
    expect(result).toMatchObject({
      provider_message_id: 'slack-ts-1',
      sender_display: 'Brian',
      direction: 'outbound',
      kind: 'file',
      media_ref: { filename: 'report.pdf', mime: 'application/pdf', size_bytes: 7 },
    })
  })
})
