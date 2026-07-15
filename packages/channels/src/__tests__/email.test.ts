import { describe, it, expect, vi } from 'vitest'
import { createEmailAdapter, type EmailWebhookMessage } from '../email/adapter.js'
import { parseEmailAddress, parseEmailDisplayName, isNoReplyAddress } from '../email/address.js'

const BASE_MSG: EmailWebhookMessage = {
  inbox_id: 'ada@agentmail.to',
  thread_id: 'thread_1',
  message_id: 'msg_1',
  timestamp: '2026-07-15T00:00:00Z',
  from: 'Sarah Chen <sarah@acme.com>',
  to: ['ada@agentmail.to'],
  subject: 'Q3 contract',
  text: 'Please review.\n> old quoted stuff',
  extracted_text: 'Please review.',
}

function makeAdapter(overrides: Partial<Parameters<typeof createEmailAdapter>[0]> = {}) {
  const reply = vi.fn().mockResolvedValue({ messageId: 'out_1', threadId: 'thread_1' })
  const sanitize = vi.fn((t: string) => t.replace('SCAFFOLD ', ''))
  const adapter = createEmailAdapter({
    inboxAddress: 'ada@agentmail.to',
    replyToMessageId: 'msg_1',
    send: { reply },
    sanitizeDeliveryText: sanitize,
    ...overrides,
  })
  return { adapter, reply, sanitize }
}

describe('[COMP:channels/email] Email channel adapter', () => {
  describe('address helpers', () => {
    it('parses angled and bare mailboxes to lowercase addresses', () => {
      expect(parseEmailAddress('Sarah Chen <Sarah@Acme.COM>')).toBe('sarah@acme.com')
      expect(parseEmailAddress('  bob@x.io ')).toBe('bob@x.io')
      expect(parseEmailAddress('not-an-address')).toBeNull()
      expect(parseEmailAddress(null)).toBeNull()
    })

    it('extracts display names when present', () => {
      expect(parseEmailDisplayName('Sarah Chen <sarah@acme.com>')).toBe('Sarah Chen')
      expect(parseEmailDisplayName('"Chen, Sarah" <sarah@acme.com>')).toBe('Chen, Sarah')
      expect(parseEmailDisplayName('sarah@acme.com')).toBeNull()
    })

    it('flags machine senders and fails closed on unparseable ones', () => {
      for (const addr of [
        'noreply@stripe.com',
        'no-reply@github.com',
        'donotreply@bank.com',
        'MAILER-DAEMON@mx.example.com',
        'postmaster@example.com',
        'bounces+123@mailgun.example.com',
        'notifications@github.com',
        'garbage-not-an-address',
      ]) {
        expect(isNoReplyAddress(addr), addr).toBe(true)
      }
      expect(isNoReplyAddress('sarah@acme.com')).toBe(false)
      expect(isNoReplyAddress('reply-desk@acme.com')).toBe(false)
    })
  })

  describe('parseIncoming', () => {
    it('normalizes an inbound message: extracted text preferred, subject prefixed, thread as channel', () => {
      const { adapter } = makeAdapter()
      const incoming = adapter.parseIncoming(BASE_MSG)
      expect(incoming).toMatchObject({
        userId: 'sarah@acme.com',
        channelId: 'thread_1',
        messageId: 'msg_1',
        text: 'Subject: Q3 contract\n\nPlease review.',
        isGroupChat: false,
      })
      expect(incoming?.timestamp).toBe(Date.parse('2026-07-15T00:00:00Z'))
    })

    it('drops self-mail (our own outbound echoed back)', () => {
      const { adapter } = makeAdapter()
      expect(adapter.parseIncoming({ ...BASE_MSG, from: 'Ada <ADA@agentmail.to>' })).toBeNull()
    })

    it('maps route-enriched attachments to files and skips unresolved ones', () => {
      const { adapter } = makeAdapter()
      const incoming = adapter.parseIncoming({
        ...BASE_MSG,
        attachments: [
          { attachment_id: 'a1', filename: 'contract.pdf', content_type: 'application/pdf', download_url: 'https://dl/a1' },
          { attachment_id: 'a2', filename: 'skipped.bin' },
        ],
      })
      expect(incoming?.files).toEqual([
        { url: 'https://dl/a1', mimeType: 'application/pdf', name: 'contract.pdf' },
      ])
    })

    it('returns null for empty bodies with no attachments and for malformed payloads', () => {
      const { adapter } = makeAdapter()
      expect(adapter.parseIncoming({ ...BASE_MSG, subject: '', text: '', extracted_text: '' })).toBeNull()
      expect(adapter.parseIncoming(null)).toBeNull()
      expect(adapter.parseIncoming({})).toBeNull()
    })

    it('deduplicates on message_id', () => {
      const { adapter } = makeAdapter()
      expect(adapter.deduplicateId(BASE_MSG)).toBe('msg_1')
      expect(adapter.deduplicateId(null)).toBeNull()
    })
  })

  describe('sendMessage (sanitize-at-send boundary)', () => {
    it('sanitizes the body through sanitizeDeliveryText before the port sees it', async () => {
      const { adapter, reply, sanitize } = makeAdapter()
      const id = await adapter.sendMessage('thread_1', { text: 'SCAFFOLD Hello Sarah' })
      expect(sanitize).toHaveBeenCalledWith('SCAFFOLD Hello Sarah')
      expect(reply).toHaveBeenCalledWith({
        inReplyToMessageId: 'msg_1',
        text: 'Hello Sarah',
      })
      expect(id).toBe('out_1')
    })

    it('maps outbound documents to base64 attachments', async () => {
      const { adapter, reply } = makeAdapter()
      await adapter.sendMessage('thread_1', {
        text: 'report attached',
        documents: [{ filename: 'q1.md', mime: 'text/markdown', data: new Uint8Array([104, 105]) }],
      })
      expect(reply.mock.calls[0][0].attachments).toEqual([
        { filename: 'q1.md', contentType: 'text/markdown', contentBase64: 'aGk=' },
      ])
    })

    it('skips the send entirely when sanitization leaves nothing', async () => {
      const { adapter, reply } = makeAdapter({ sanitizeDeliveryText: () => '   ' })
      const id = await adapter.sendMessage('thread_1', { text: 'whatever' })
      expect(reply).not.toHaveBeenCalled()
      expect(id).toBe('')
    })
  })
})
