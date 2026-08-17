import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWhatsAppCloudAdapter,
  parseWhatsAppCloudMessages,
  subscribeWhatsAppCloudApp,
  verifyWhatsAppCloudSignature,
} from '../whatsapp/cloud-api.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const payload = {
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'phone-1' },
    contacts: [{ wa_id: '15551234567', profile: { name: 'Ada' } }],
    messages: [{
      from: '15551234567', id: 'wamid.1', timestamp: '1700000000', type: 'text',
      context: { id: 'wamid.parent' }, text: { body: 'Hello' },
    }],
  } }] }],
}

describe('[COMP:channels/whatsapp-cloud]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('verifies Meta webhook signatures in constant-time form', () => {
    const body = JSON.stringify(payload)
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
    expect(verifyWhatsAppCloudSignature({ appSecret: 'secret', signature, body })).toBe(true)
    expect(verifyWhatsAppCloudSignature({ appSecret: 'wrong', signature, body })).toBe(false)
  })

  it('normalizes inbound messages and reply context', () => {
    expect(parseWhatsAppCloudMessages(payload)[0]).toMatchObject({
      userId: '15551234567', channelId: '15551234567', messageId: 'wamid.1',
      text: 'Hello', replyToMessageId: 'wamid.parent', isGroupChat: false,
      raw: { phoneNumberId: 'phone-1', senderName: 'Ada' },
    })
  })

  it('normalizes media IDs without exposing Meta bearer URLs', () => {
    const mediaPayload = structuredClone(payload)
    mediaPayload.entry[0].changes[0].value.messages[0] = {
      from: '15551234567', id: 'wamid.2', timestamp: '1700000001', type: 'document',
      document: { id: 'media-1', mime_type: 'application/pdf', filename: 'report.pdf', caption: 'Review' },
    } as never
    expect(parseWhatsAppCloudMessages(mediaPayload)[0]).toMatchObject({
      mediaUrl: 'whatsapp-cloud:media-1', mediaType: 'document',
      mediaMime: 'application/pdf', mediaName: 'report.pdf', text: 'Review',
    })
  })

  it('sends chunked text through the official messages endpoint', async () => {
    fetchMock.mockResolvedValue({
      ok: true, json: async () => ({ messages: [{ id: 'wamid.sent' }] }),
    })
    const adapter = createWhatsAppCloudAdapter({
      accessToken: 'token', phoneNumberId: 'phone-1', graphApiVersion: 'v26.0',
    })
    const id = await adapter.sendMessage('+15551234567', { text: 'Hello **Ada**', format: 'markdown' })
    expect(id).toBe('wamid.sent')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v26.0/phone-1/messages',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.to).toBe('15551234567')
    expect(body.text.body).toBe('Hello *Ada*')
  })

  it('subscribes the Meta app to the WABA', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    await subscribeWhatsAppCloudApp(
      { accessToken: 'token', phoneNumberId: 'phone-1', graphApiVersion: 'v26.0' },
      'waba-1',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v26.0/waba-1/subscribed_apps',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
