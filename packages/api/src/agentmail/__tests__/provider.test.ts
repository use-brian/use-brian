import { describe, it, expect, vi } from 'vitest'
import {
  createAgentmailEmailProvider,
  createEmailInboxProvider,
  AGENTMAIL_SUBSCRIBED_EVENTS,
} from '../provider.js'
import type { AgentmailClient } from '../client.js'

function stubClient(overrides: Partial<AgentmailClient> = {}): AgentmailClient {
  const unstubbed = () => Promise.reject(new Error('unexpected call'))
  return {
    createInbox: unstubbed,
    getInbox: unstubbed,
    deleteInbox: unstubbed,
    sendMessage: unstubbed,
    replyToMessage: unstubbed,
    getMessage: unstubbed,
    getAttachment: unstubbed,
    listThreads: unstubbed,
    createDraft: unstubbed,
    sendDraft: unstubbed,
    deleteDraft: unstubbed,
    createDomain: unstubbed,
    getDomain: unstubbed,
    verifyDomain: unstubbed,
    deleteDomain: unstubbed,
    createWebhook: unstubbed,
    deleteWebhook: unstubbed,
    ...overrides,
  }
}

describe('[COMP:api/agentmail-provider] Email inbox provider seam', () => {
  it('factory returns null without a key (surface stays dark) and a provider with one', () => {
    expect(createEmailInboxProvider({})).toBeNull()
    expect(createEmailInboxProvider({ AGENTMAIL_API_KEY: '' })).toBeNull()
    expect(createEmailInboxProvider({ AGENTMAIL_API_KEY: 'k' })?.kind).toBe('agentmail')
  })

  it('createInbox normalizes and falls back to inbox_id for the address', async () => {
    const createInbox = vi.fn().mockResolvedValue({ inbox_id: 'ada@agentmail.to' })
    const provider = createAgentmailEmailProvider(stubClient({ createInbox }))

    const inbox = await provider.createInbox({
      username: 'ada',
      clientId: 'ck',
      metadata: { workspace_id: 'ws1' },
    })

    expect(inbox).toEqual({ inboxId: 'ada@agentmail.to', email: 'ada@agentmail.to', displayName: null })
    expect(createInbox).toHaveBeenCalledWith({
      username: 'ada',
      domain: undefined,
      display_name: undefined,
      client_id: 'ck',
      metadata: { workspace_id: 'ws1' },
    })
  })

  it('getMessage surfaces Talon extracted_text alongside the raw body', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      inbox_id: 'ada@agentmail.to',
      thread_id: 't1',
      message_id: 'm1',
      labels: ['received'],
      timestamp: '2026-07-15T00:00:00Z',
      from: 'user@acme.com',
      to: ['ada@agentmail.to'],
      subject: 'Contract',
      text: 'body\n> quoted history',
      extracted_text: 'body',
      attachments: [{ attachment_id: 'a1', filename: 'contract.pdf', content_type: 'application/pdf', size: 100 }],
      in_reply_to: 'm0',
    })
    const provider = createAgentmailEmailProvider(stubClient({ getMessage }))

    const m = await provider.getMessage('ada@agentmail.to', 'm1')

    expect(m?.extractedText).toBe('body')
    expect(m?.text).toBe('body\n> quoted history')
    expect(m?.inReplyTo).toBe('m0')
    expect(m?.attachments).toEqual([
      { attachmentId: 'a1', filename: 'contract.pdf', contentType: 'application/pdf', size: 100 },
    ])
  })

  it('normalizes vendor domain statuses onto pending/verified/failed', async () => {
    const mk = (status: string) => ({
      domain_id: 'd1',
      domain: 'mail.acme.com',
      status,
      records: [{ type: 'MX', name: 'mail.acme.com', value: 'in.agentmail.to', priority: 10 }],
    })
    const createDomain = vi.fn().mockResolvedValue(mk('PENDING'))
    const verifyDomain = vi
      .fn()
      .mockResolvedValueOnce(mk('VERIFYING'))
      .mockResolvedValueOnce(mk('VERIFIED'))
      .mockResolvedValueOnce(mk('FAILED'))
    const provider = createAgentmailEmailProvider(stubClient({ createDomain, verifyDomain }))

    expect((await provider.createDomain('mail.acme.com')).status).toBe('pending')
    expect((await provider.verifyDomain('d1')).status).toBe('pending')
    expect((await provider.verifyDomain('d1')).status).toBe('verified')
    const failed = await provider.verifyDomain('d1')
    expect(failed.status).toBe('failed')
    expect(failed.providerStatus).toBe('FAILED')
    expect(failed.records[0]).toMatchObject({ type: 'MX', priority: 10 })
  })

  it('registers webhooks with the subscribed event set only (no spam/blocked variants)', async () => {
    const createWebhook = vi.fn().mockResolvedValue({
      webhook_id: 'w1',
      url: 'https://api.example.com/webhook/agentmail',
      event_types: [...AGENTMAIL_SUBSCRIBED_EVENTS],
      secret: 'whsec_abc',
    })
    const provider = createAgentmailEmailProvider(stubClient({ createWebhook }))

    const w = await provider.createWebhook('ada@agentmail.to', {
      url: 'https://api.example.com/webhook/agentmail',
    })

    expect(w).toEqual({ webhookId: 'w1', secret: 'whsec_abc' })
    const eventTypes: string[] = createWebhook.mock.calls[0][1].event_types
    expect(eventTypes).toContain('message.received')
    expect(eventTypes).toContain('message.bounced')
    expect(eventTypes).toContain('message.complained')
    expect(eventTypes).toContain('domain.verified')
    expect(eventTypes.some((e) => e.includes('.spam') || e.includes('.blocked') || e.includes('.unauthenticated'))).toBe(
      false,
    )
  })

  it('maps attachments to base64 vendor shape on send and reply', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 'm1', thread_id: 't1' })
    const replyToMessage = vi.fn().mockResolvedValue({ message_id: 'm2', thread_id: 't1' })
    const provider = createAgentmailEmailProvider(stubClient({ sendMessage, replyToMessage }))

    await provider.sendMessage('ada@agentmail.to', {
      to: ['x@y.z'],
      subject: 's',
      text: 'body',
      attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'aGk=' }],
    })
    expect(sendMessage.mock.calls[0][1].attachments).toEqual([
      { filename: 'a.txt', content_type: 'text/plain', content: 'aGk=' },
    ])

    const reply = await provider.replyToMessage('ada@agentmail.to', 'm1', { text: 'pong' })
    expect(reply).toEqual({ messageId: 'm2', threadId: 't1' })
  })
})
