import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTelegramAdapter, createDiscordAdapter, createSlackAdapter, createMsTeamsAdapter,
  createEmailAdapter, createWhatsAppAdapter, createWhatsAppCloudAdapter, createWechatAdapter,
  createCustomAdapter, createFeishuAdapter, denormalizeActions, normalizeActionInput,
  type ChannelAdapter, type OutgoingAction,
} from '../index.js'

const actions: OutgoingAction[] = [
  { id: 'choice', label: 'Choose', data: 'opaque-secret', replyText: '/choose token_123' },
  { kind: 'web_app', label: 'Details', url: 'https://example.com/details' },
  { id: 'cancel', label: 'Cancel', data: 'opaque-cancel' },
]

function harness(name: string, rejectNative = false) {
  const delivered: string[] = []
  const calls: unknown[] = []
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : {}
    calls.push(body)
    if (rejectNative && (body.components || body.reply_markup)) {
      return new Response(JSON.stringify({ ok: false, description: 'rejected', message: 'rejected' }), { status: 400 })
    }
    delivered.push(JSON.stringify(body))
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, id: '1', ts: '1',
      messageId: '1', messages: [{ id: '1' }], ret: 0, access_token: 'token', expires_in: 3600, members: [] }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  const record = async (body: unknown) => { delivered.push(JSON.stringify(body)); return '1' }
  let adapter: ChannelAdapter
  switch (name) {
    case 'telegram': adapter = createTelegramAdapter({ token: 'x' }); break
    case 'discord': adapter = createDiscordAdapter({ token: 'x' }); break
    case 'slack': adapter = createSlackAdapter({ botToken: 'x' }); break
    case 'teams': adapter = createMsTeamsAdapter({ appId: 'x', appPassword: 'x', tenantId: 'x', serviceUrl: 'https://teams.example', fetchImpl: fetchMock as typeof fetch }); break
    case 'email': adapter = createEmailAdapter({ inboxAddress: 'bot@example.com', replyToMessageId: 'parent', sanitizeDeliveryText: x => x, send: { reply: async body => ({ messageId: await record(body), threadId: '1' }) } }); break
    case 'whatsapp': adapter = createWhatsAppAdapter({ connectorUrl: 'https://wa.example', connectorSecret: 'x', connectionId: 'x' }); break
    case 'cloud': adapter = createWhatsAppCloudAdapter({ accessToken: 'x', phoneNumberId: 'x' }); break
    case 'wechat': adapter = createWechatAdapter({ baseUrl: 'https://wechat.example', botToken: 'x' }); break
    case 'custom': adapter = createCustomAdapter({ enqueue: record }); break
    case 'feishu': adapter = createFeishuAdapter({ api: {
      send: async (_id, body) => {
        calls.push(body)
        if (rejectNative && 'card' in body) throw new Error('card rejected')
        return { messageId: await record(body) }
      },
      updateCard: async (_id, body) => { if (rejectNative) throw new Error('rejected'); await record(body) },
      editMessage: async (_id, body) => { await record(body) },
    } as Parameters<typeof createFeishuAdapter>[0]['api'] }); break
    default: throw new Error(name)
  }
  return { adapter, delivered, calls }
}

afterEach(() => vi.unstubAllGlobals())

describe('outbound action conformance', () => {
  for (const name of ['telegram', 'discord', 'slack', 'teams', 'email', 'whatsapp', 'cloud', 'wechat', 'custom', 'feishu']) {
    for (const text of ['', 'Choose an option']) {
      it(`${name} preserves callbacks and links (${text ? 'body' : 'action-only'})`, async () => {
        const { adapter, delivered } = harness(name)
        await adapter.sendMessage('123', { text, actions })
        const wire = delivered.join('\n')
        expect(wire).toContain('/choose token_123')
        expect(wire).toContain('https://example.com/details')
        expect(wire).toContain('Cancel — reply: Cancel')
      })
    }
    it(`${name} retains overflow actions`, async () => {
      const { adapter, delivered } = harness(name)
      await adapter.sendMessage('123', { text: 'x'.repeat(5000), actions: Array.from({ length: 40 }, (_, i) => ({ id: String(i), label: `Choice ${i}`, data: `opaque-${i}`, replyText: `token-${i}` })) })
      for (let i = 0; i < 40; i++) expect(delivered.join('\n')).toContain(`reply: token-${i}`)
    })
    if (['telegram', 'discord', 'slack', 'teams', 'whatsapp', 'feishu'].includes(name)) {
      it(`${name} retains actions when an edit exceeds the platform limit`, async () => {
        const { adapter, delivered } = harness(name)
        await adapter.editMessage('123', '1', { text: 'x'.repeat(adapter.maxMessageLength + 1), actions })
        expect(delivered.join('\n')).toContain('/choose token_123')
      })
    }
  }
  for (const name of ['telegram', 'discord', 'feishu']) {
    it(`${name} sends native buttons and retains text on rejection`, async () => {
      const { adapter, delivered, calls } = harness(name, true)
      await adapter.sendMessage('123', { text: '', actions })
      expect(JSON.stringify(calls)).toContain('opaque-secret')
      expect(delivered.join('\n')).toContain('/choose token_123')
      await adapter.editMessage('123', '1', { text: '', actions })
      expect(delivered.join('\n')).toContain('https://example.com/details')
    })
  }
  it('passes custom reply targets through the existing protocol', async () => {
    const { adapter, delivered } = harness('custom')
    await adapter.sendMessage('123', { text: '', actions }, { threadTs: 'parent' })
    expect(JSON.parse(delivered[0]).payload.replyToMessageId).toBe('parent')
  })
  it('keeps data opaque and defaults reply tokens to labels', () => {
    expect(normalizeActionInput('opaque', '1')).toEqual({ data: 'opaque', messageId: '1' })
    expect(normalizeActionInput({ command: 'x' })).toBeNull()
    const result = denormalizeActions({ text: '', actions })
    expect(result.text).not.toContain('opaque')
    expect(result.format).toBe('plain')
  })
})
