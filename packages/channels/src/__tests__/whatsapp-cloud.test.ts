import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWhatsAppCloudAdapter,
  createWhatsAppCloudApi,
  parseWhatsAppCloudGroupLifecycleEvents,
  parseWhatsAppCloudMessages,
  subscribeWhatsAppCloudApp,
  verifyWhatsAppCloudSignature,
  WhatsAppCloudApiError,
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

  it('keeps a group participant as the user while routing the conversation by group id', () => {
    const groupPayload = structuredClone(payload)
    groupPayload.entry[0].changes[0].value.messages[0] = {
      ...groupPayload.entry[0].changes[0].value.messages[0],
      group_id: 'group-1',
    } as never

    expect(parseWhatsAppCloudMessages(groupPayload)[0]).toMatchObject({
      userId: '15551234567',
      channelId: 'group-1',
      isGroupChat: true,
      raw: { groupId: 'group-1', senderName: 'Ada' },
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
    expect(body.recipient_type).toBe('individual')
    expect(body.to).toBe('15551234567')
    expect(body.text.body).toBe('Hello *Ada*')
  })

  it('sends group replies to the group recipient', async () => {
    fetchMock.mockResolvedValue({
      ok: true, json: async () => ({ messages: [{ id: 'wamid.group' }] }),
    })
    const adapter = createWhatsAppCloudAdapter({
      accessToken: 'token', phoneNumberId: 'phone-1', graphApiVersion: 'v26.0',
      recipientType: 'group',
    })

    await adapter.sendMessage('group-1', { text: 'Hello group' })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ recipient_type: 'group', to: 'group-1' })
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

  it('creates a group with the official request shape', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ request_id: 'request-1' }) })
    const api = createWhatsAppCloudApi({
      accessToken: 'token', phoneNumberId: 'phone-1', graphApiVersion: 'v26.0',
    })

    await expect(api.createGroup('Product team')).resolves.toBe('request-1')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v26.0/phone-1/groups',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ messaging_product: 'whatsapp', subject: 'Product team' }),
      }),
    )
  })

  it('gets an invite link and deletes a group with official request shapes', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ invite_link: 'https://chat.whatsapp.com/code' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => { throw new Error('no body') } })
    const api = createWhatsAppCloudApi({
      accessToken: 'token', phoneNumberId: 'phone-1', graphApiVersion: 'v26.0',
    })

    await expect(api.getGroupInviteLink('group/1')).resolves.toBe('https://chat.whatsapp.com/code')
    await expect(api.deleteGroup('group/1')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://graph.facebook.com/v26.0/group%2F1/invite_link',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://graph.facebook.com/v26.0/group%2F1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('rejects malformed group API responses', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    const api = createWhatsAppCloudApi({ accessToken: 'token', phoneNumberId: 'phone-1' })

    await expect(api.createGroup('Product team')).rejects.toThrow('request ID')
    await expect(api.getGroupInviteLink('group-1')).rejects.toThrow('invite link')
  })

  it('exposes a typed 404 from group deletion', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":"missing"}',
    })
    const api = createWhatsAppCloudApi({ accessToken: 'token', phoneNumberId: 'phone-1' })

    const error = await api.deleteGroup('missing').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WhatsAppCloudApiError)
    expect(error).toMatchObject({ status: 404 })
  })

  it('parses group lifecycle updates without affecting message parsing', () => {
    const lifecyclePayload = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{
        field: 'group_lifecycle_update',
        value: {
          metadata: { phone_number_id: 'phone-1' },
          groups: [{
            type: 'group_create', request_id: 'request-1', group_id: 'group-1',
            subject: 'Product team', invite_link: 'https://chat.whatsapp.com/code',
          }],
        },
      }] }],
    }

    expect(parseWhatsAppCloudGroupLifecycleEvents(lifecyclePayload)).toEqual([{
      phoneNumberId: 'phone-1',
      rows: [{
        type: 'group_create', requestId: 'request-1', groupId: 'group-1',
        subject: 'Product team', inviteLink: 'https://chat.whatsapp.com/code',
      }],
    }])
    expect(parseWhatsAppCloudMessages(lifecyclePayload)).toEqual([])

    expect(parseWhatsAppCloudGroupLifecycleEvents({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{
        field: 'group_lifecycle_update',
        value: {
          metadata: { phone_number_id: 'phone-1' },
          type: 'group_create', request_id: 'request-2',
          errors: [{ code: 131000, message: 'Create failed' }],
        },
      }] }],
    })).toEqual([{
      phoneNumberId: 'phone-1',
      rows: [{
        type: 'group_create', requestId: 'request-2',
        errors: [{ code: 131000, message: 'Create failed' }],
      }],
    }])
  })
})
