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

  it('stores the sender display name so the agent can search by name', () => {
    const withName = normalizeInboundChatMessage({
      source: 'whatsapp',
      message: incoming({ userId: '15551230000@s.whatsapp.net', senderDisplay: 'Alice Chen' }),
    })
    expect(withName.sender_display).toBe('Alice Chen')
    // absent name -> null (unchanged for channels that supply none)
    const noName = normalizeInboundChatMessage({ source: 'whatsapp', message: incoming() })
    expect(noName.sender_display).toBeNull()
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

  it('preserves a durable video asset for the managed v2 sink', () => {
    const result = normalizeInboundChatMessage({
      source: 'whatsapp',
      message: incoming({
        mediaType: 'video',
        mediaMime: 'video/mp4',
        mediaName: 'walkthrough.mp4',
        archiveMediaRef: {
          assetId: '4a1e6bd8-0000-4000-8000-000000000004',
          sha256: 'b'.repeat(64),
          filename: 'walkthrough.mp4',
          mime: 'video/mp4',
          sizeBytes: 4096,
        },
      }),
    })
    expect(result.kind).toBe('video')
    expect(result.media_ref).toMatchObject({ availability: 'stored', asset_id: expect.any(String) })
  })

  it('keeps an explicit failed media state instead of a placeholder-only success', () => {
	const result = normalizeInboundChatMessage({
		source: 'wechat',
		message: incoming({
			text: '', mediaType: 'voice', mediaMime: 'audio/silk', mediaName: 'voice.silk',
			archiveMediaAvailability: 'failed',
		}),
	})
	expect(result).toMatchObject({
		kind: 'voice', body_text: null,
		media_ref: { availability: 'failed', filename: 'voice.silk', mime: 'audio/silk' },
	})
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

  it('normalizes an outbound self message with a STAGED archive asset as a stored v2 ref', () => {
    // The owner's own photo relayed by a bridge: bytes were staged before the
    // append, so the ref must carry asset identity + availability=stored —
    // that is what lets the store link the bytes and run extraction.
    const result = normalizeOutboundChatMessage({
      providerMessageId: 'wx-self-9',
      conversationId: 'c-1',
      assistantId: 'me',
      assistantName: 'Ken',
      text: '',
      archiveMedia: {
        kind: 'image',
        ref: { assetId: 'asset-1', sha256: 'f'.repeat(64), filename: 'sent.jpg', mime: 'image/jpeg', sizeBytes: 123 },
      },
    })
    expect(result).toMatchObject({
      direction: 'outbound',
      kind: 'image',
      body_text: null,
      media_ref: {
        asset_id: 'asset-1',
        sha256: 'f'.repeat(64),
        availability: 'stored',
        filename: 'sent.jpg',
        mime: 'image/jpeg',
        size_bytes: 123,
      },
    })
  })

  it('normalizes an outbound self message whose staging failed as availability=failed, never silently text-only', () => {
    const result = normalizeOutboundChatMessage({
      providerMessageId: 'wx-self-10',
      conversationId: 'c-1',
      assistantId: 'me',
      assistantName: 'Ken',
      text: '',
      archiveMedia: {
        kind: 'image',
        ref: null,
        availability: 'failed',
        filename: 'sent.jpg',
        mime: 'image/jpeg',
        sizeBytes: 0,
      },
    })
    expect(result).toMatchObject({
      kind: 'image',
      media_ref: { availability: 'failed', filename: 'sent.jpg', mime: 'image/jpeg' },
    })
  })
})
