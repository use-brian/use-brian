import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { createWhatsAppAdapter } from '../whatsapp/adapter.js'

const defaultOptions = {
  connectorUrl: 'http://localhost:3001',
  connectorSecret: 'test-secret',
  connectionId: 'a_1',
}

describe('[COMP:channels/whatsapp] createWhatsAppAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parseIncomingPayload: maps payload fields correctly', () => {
    const adapter = createWhatsAppAdapter(defaultOptions)

    const payload = {
      messageId: 'wamid_123',
      channelId: 'a_1',
      chatJid: '1234@s.whatsapp.net',
      senderJid: '5678@s.whatsapp.net',
      senderName: 'Test User',
      text: 'Hello from WhatsApp',
      isGroup: false,
      timestamp: 1700000000,
    }

    const result = adapter.parseIncomingPayload(payload)

    expect(result).toMatchObject({
      userId: '5678@s.whatsapp.net',
      channelId: '1234@s.whatsapp.net',
      messageId: 'wamid_123',
      text: 'Hello from WhatsApp',
      isGroupChat: false,
      timestamp: 1700000000,
    })
  })

  it('parseIncoming: returns null (not used for WhatsApp)', () => {
    const adapter = createWhatsAppAdapter(defaultOptions)
    expect(adapter.parseIncoming({})).toBeNull()
  })

  it('sendMessage: calls connectorFetch with correct URL and body, returns messageId', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messageId: 'wamid_sent_1' }),
    })

    const adapter = createWhatsAppAdapter(defaultOptions)

    // sendMessage(channelId, OutgoingMessage)
    const result = await adapter.sendMessage('15559876543', {
      text: 'Reply from assistant',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3001/send/a_1',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Connector-Secret': 'test-secret',
        }),
      }),
    )
    // Verify body contains jid and text
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.jid).toBe('15559876543')
    expect(body.text).toBe('Reply from assistant')

    expect(result).toBe('wamid_sent_1')
  })

  it('sendMessage with markdown: applies WhatsApp formatting', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messageId: 'wamid_fmt' }),
    })

    const adapter = createWhatsAppAdapter(defaultOptions)

    await adapter.sendMessage('15559876543', {
      text: 'This is **bold** and [a link](https://example.com)',
      format: 'markdown',
    })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.text).toBe('This is *bold* and a link (https://example.com)')
  })

  it('sendMessage without format: sends text as-is', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messageId: 'wamid_plain' }),
    })

    const adapter = createWhatsAppAdapter(defaultOptions)

    await adapter.sendMessage('15559876543', {
      text: '**raw markdown** not converted',
    })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.text).toBe('**raw markdown** not converted')
  })

  it('sendMessage with long text: chunks text and sends multiple requests', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: 'wamid_chunk' }),
    })

    const adapter = createWhatsAppAdapter(defaultOptions)

    // 5000 chars will require chunking (max 4096)
    const longText = 'A'.repeat(5000)
    await adapter.sendMessage('15559876543', { text: longText })

    expect(mockFetch.mock.calls.length).toBeGreaterThan(1)
  })

  it('sendMessage error: throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    })

    const adapter = createWhatsAppAdapter(defaultOptions)

    await expect(
      adapter.sendMessage('15559876543', { text: 'This should fail' }),
    ).rejects.toThrow('wa-connector send failed')
  })

  it('sendTypingIndicator: calls connector, does not throw on failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const adapter = createWhatsAppAdapter(defaultOptions)

    // sendTypingIndicator catches errors internally
    await expect(
      adapter.sendTypingIndicator('15559876543'),
    ).resolves.not.toThrow()
  })

  it('editMessage: calls connector /edit endpoint', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true })

    const adapter = createWhatsAppAdapter(defaultOptions)

    await adapter.editMessage('15559876543', 'wamid_old', { text: 'Edited text' })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3001/edit/a_1',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.jid).toBe('15559876543')
    expect(body.messageId).toBe('wamid_old')
    expect(body.text).toBe('Edited text')
  })

  it('editMessage with markdown: applies WhatsApp formatting', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true })

    const adapter = createWhatsAppAdapter(defaultOptions)

    await adapter.editMessage('15559876543', 'wamid_old', {
      text: 'This is **bold**',
      format: 'markdown',
    })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.text).toBe('This is *bold*')
  })

  it('editMessage: does not throw on failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const adapter = createWhatsAppAdapter(defaultOptions)

    await expect(
      adapter.editMessage('15559876543', 'wamid_old', { text: 'Edit' }),
    ).resolves.not.toThrow()
  })

  it('parseIncomingPayload: maps reply and edit fields', () => {
    const adapter = createWhatsAppAdapter(defaultOptions)

    const payload = {
      messageId: 'wamid_456',
      channelId: 'a_1',
      chatJid: '1234@s.whatsapp.net',
      senderJid: '5678@s.whatsapp.net',
      text: 'Edited text',
      isGroup: false,
      timestamp: 1700000000,
      quotedMessageId: 'wamid_original',
      quotedBody: 'The original message',
      isEdit: true,
      editedMessageId: 'wamid_original',
    }

    const result = adapter.parseIncomingPayload(payload)

    expect(result.replyToMessageId).toBe('wamid_original')
    expect(result.isEdit).toBe(true)
  })

  it('has correct adapter properties', () => {
    const adapter = createWhatsAppAdapter(defaultOptions)

    expect(adapter.type).toBe('whatsapp')
    expect(adapter.maxMessageLength).toBe(4096)
    expect(adapter.supportsMarkdown).toBe(true)
    expect(adapter.supportsMessageEdit).toBe(true)
    expect(adapter.drainDelayMs).toBe(2000)
  })
})
