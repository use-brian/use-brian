/**
 * [COMP:channels/custom-adapter] — bridge-driven custom channel adapter.
 *
 * The adapter never sends anything itself: every outbound action is an
 * outbox item the operator-run bridge pulls. These tests pin the mapping
 * from `BridgeInboundMessage` → `IncomingMessage` and the outbox items each
 * adapter method enqueues.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createCustomAdapter,
  base64DecodedLength,
  bridgeInboundOversize,
  BRIDGE_INBOUND_MEDIA_MAX_BYTES,
  BRIDGE_INBOUND_TEXT_MAX_BYTES,
  type BridgeInboundMessage,
} from '../custom/index.js'

function inbound(over: Partial<BridgeInboundMessage> = {}): BridgeInboundMessage {
  return {
    peerId: 'peer-1',
    senderId: 'peer-1',
    messageId: 'm-1',
    text: 'hello',
    timestamp: 1_700_000_000_000,
    isGroupChat: false,
    ...over,
  }
}

function build() {
  const enqueue = vi.fn(async (_item: unknown) => 'outbox-item-1')
  return { adapter: createCustomAdapter({ enqueue }), enqueue }
}

describe('[COMP:channels/custom-adapter] adapter shape', () => {
  it('declares the custom channel contract', () => {
    const { adapter } = build()
    expect(adapter.type).toBe('custom')
    expect(adapter.maxMessageLength).toBe(4000)
    expect(adapter.supportsMarkdown).toBe(true)
    expect(adapter.supportsMessageEdit).toBe(false)
    expect(adapter.drainDelayMs).toBeGreaterThan(0)
  })
})

describe('[COMP:channels/custom-adapter] parseIncoming', () => {
  it('maps a DM: userId = senderId, channelId = peerId, mentioned by default', () => {
    const { adapter } = build()
    const msg = adapter.parseIncoming(inbound({ replyToMessageId: 'm-0' }))
    expect(msg).toMatchObject({
      userId: 'peer-1',
      channelId: 'peer-1',
      messageId: 'm-1',
      text: 'hello',
      isGroupChat: false,
      isMentioned: true,
      replyToMessageId: 'm-0',
      timestamp: 1_700_000_000_000,
    })
    expect(msg?.raw).toEqual(inbound({ replyToMessageId: 'm-0' }))
  })

  it('a group message is mentioned only when the bridge says so', () => {
    const { adapter } = build()
    expect(adapter.parseIncoming(inbound({ peerId: 'g-1', senderId: 'u-9', isGroupChat: true }))?.isMentioned).toBe(false)
    expect(adapter.parseIncoming(inbound({ peerId: 'g-1', senderId: 'u-9', isGroupChat: true, isMentioned: true }))?.isMentioned).toBe(true)
    expect(adapter.parseIncoming(inbound({ peerId: 'g-1', senderId: 'u-9', isGroupChat: true }))?.channelId).toBe('g-1')
  })

  it('carries the first media item as hints', () => {
    const { adapter } = build()
    const msg = adapter.parseIncoming(inbound({
      text: '',
      media: [{ kind: 'image', mime: 'image/png', name: 'a.png', dataBase64: 'AAAA', sizeBytes: 3 }],
    }))
    expect(msg).toMatchObject({ mediaType: 'photo', mediaMime: 'image/png', mediaName: 'a.png', mediaSizeBytes: 3 })
  })

  it('rejects malformed payloads and empty messages', () => {
    const { adapter } = build()
    expect(adapter.parseIncoming(null)).toBeNull()
    expect(adapter.parseIncoming({ peerId: 'p' })).toBeNull()
    expect(adapter.parseIncoming(inbound({ text: '' }))).toBeNull()
  })

  it('dedups on peerId:messageId', () => {
    const { adapter } = build()
    expect(adapter.deduplicateId(inbound())).toBe('peer-1:m-1')
    expect(adapter.deduplicateId({})).toBeNull()
  })
})

describe('[COMP:channels/custom-adapter] outbox items', () => {
  it('sendMessage enqueues a message item and returns the outbox id', async () => {
    const { adapter, enqueue } = build()
    const id = await adapter.sendMessage('peer-1', { text: '**hi**', format: 'markdown' })
    expect(id).toBe('outbox-item-1')
    expect(enqueue).toHaveBeenCalledWith({
      type: 'message',
      peerId: 'peer-1',
      payload: { text: '**hi**', format: 'markdown' },
    })
  })

  it('defaults format to plain and encodes documents as base64', async () => {
    const { adapter, enqueue } = build()
    await adapter.sendMessage('peer-1', {
      text: 'file',
      documents: [{ filename: 'a.txt', mime: 'text/plain', data: new TextEncoder().encode('abc'), caption: 'cap' }],
    })
    expect(enqueue.mock.calls[0]?.[0]).toEqual({
      type: 'message',
      peerId: 'peer-1',
      payload: {
        text: 'file',
        format: 'plain',
        documents: [{ filename: 'a.txt', mime: 'text/plain', dataBase64: Buffer.from('abc').toString('base64'), caption: 'cap' }],
      },
    })
  })

  it('an empty send enqueues nothing', async () => {
    const { adapter, enqueue } = build()
    expect(await adapter.sendMessage('peer-1', { text: '   ' })).toBe('')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('sendTypingIndicator enqueues typing on; editMessage is unsupported; sendStatus is a no-op', async () => {
    const { adapter, enqueue } = build()
    await adapter.sendTypingIndicator('peer-1')
    expect(enqueue).toHaveBeenCalledWith({ type: 'typing', peerId: 'peer-1', payload: { on: true } })
    await expect(adapter.editMessage('peer-1', 'x', { text: 'y' })).rejects.toThrow(/edit/)
    expect(await adapter.sendStatus('peer-1', 'thinking')).toBe('')
  })
})

describe('[COMP:channels/custom-adapter] inbound limits', () => {
  it('computes decoded base64 length', () => {
    expect(base64DecodedLength('')).toBe(0)
    expect(base64DecodedLength(Buffer.from('a').toString('base64'))).toBe(1)
    expect(base64DecodedLength(Buffer.from('abcd').toString('base64'))).toBe(4)
  })

  it('flags oversize text and media', () => {
    expect(bridgeInboundOversize({ message: inbound() })).toBeNull()
    expect(bridgeInboundOversize({ message: inbound({ text: 'x'.repeat(BRIDGE_INBOUND_TEXT_MAX_BYTES + 1) }) })).toMatch(/text/)
    expect(bridgeInboundOversize({ message: inbound({
      media: [{ kind: 'document', mime: 'application/octet-stream', name: 'big.bin', url: 'https://example.com/big.bin', sizeBytes: BRIDGE_INBOUND_MEDIA_MAX_BYTES + 1 }],
    }) })).toMatch(/big\.bin/)
  })
})
