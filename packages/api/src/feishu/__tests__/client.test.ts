import { describe, expect, it, vi } from 'vitest'
import type { FeishuChannelFactory } from '../client.js'
import {
  createFeishuApi,
  FeishuApiError,
  feishuDomainForBrand,
  validateFeishuCredentials,
} from '../client.js'

function fakeFactory(response: unknown = {
  code: 0,
  bot: { open_id: 'ou_bot', app_name: 'Brian' },
}) {
  const channel = {
    send: vi.fn(async () => ({ messageId: 'om_sent' })),
    editMessage: vi.fn(async () => {}),
    updateCard: vi.fn(async () => {}),
    recallMessage: vi.fn(async () => {}),
    addReaction: vi.fn(async () => 'reaction_1'),
    removeReactionByEmoji: vi.fn(async () => true),
    fetchMessage: vi.fn(async () => ({ chatId: 'oc_chat' })),
    downloadResourceWithMeta: vi.fn(async () => ({
      buffer: Buffer.from('hello'),
      contentType: 'text/plain',
    })),
    rawClient: {
      request: vi.fn(async () => response),
      im: { v1: { message: { update: vi.fn(async () => ({ code: 0, msg: 'ok' })) } } },
    },
  }
  const factory = vi.fn(() => channel) as unknown as FeishuChannelFactory
  return { factory, channel }
}

describe('[COMP:channels/feishu] official SDK client', () => {
  it('creates, streams and finalizes a CardKit entity with explicit sequences and thread identity', async () => {
    const { factory, channel } = fakeFactory({ code: 0, data: { card_id: 'card_1' } })
    const api = createFeishuApi({ appId: 'cli', appSecret: 's', brand: 'feishu' }, factory)
    const result = await api.streamingCards!.open('oc_chat', 'Thinking...', { replyTo: 'om_current', replyInThread: true })
    expect(result).toEqual({ cardId: 'card_1', messageId: 'om_sent' })
    expect(channel.send).toHaveBeenCalledWith('oc_chat', { cardId: 'card_1' }, { replyTo: 'om_current', replyInThread: true })
    await api.streamingCards!.update('card_1', '✓ Task saved', 1)
    await api.streamingCards!.finish('card_1', '**Done**', 2)
    const calls = channel.rawClient.request.mock.calls as unknown as Array<[{
      url: string; method: string; data: Record<string, any>
    }]>
    expect(JSON.parse(calls[0][0].data.data).config.streaming_mode).toBe(true)
    expect(calls[1][0]).toMatchObject({ method: 'PUT', url: '/open-apis/cardkit/v1/cards/card_1/elements/turn/content', data: { content: '✓ Task saved', sequence: 1 } })
    const final = JSON.parse(calls[2][0].data.card.data)
    expect(final.config).toEqual({ streaming_mode: false, summary: { content: '**Done**' } })
    expect(final.body.elements[0].content).toBe('**Done**')
    expect(calls[2][0].data.sequence).toBe(2)
  })

  it('rejects nonzero CardKit responses so the route can deliver its fallback', async () => {
    const { factory } = fakeFactory({ code: 99991672, msg: 'Access denied' })
    const api = createFeishuApi({ appId: 'cli', appSecret: 's', brand: 'lark' }, factory)
    await expect(api.streamingCards!.open('oc_chat', 'Thinking...')).rejects.toMatchObject({ name: 'FeishuApiError', providerCode: 99991672 })
    await expect(api.streamingCards!.finish('card_1', 'Done', 1)).rejects.toMatchObject({ name: 'FeishuApiError', operation: 'finish_streaming_card' })
  })

  it('uses a closed brand-to-domain mapping', () => {
    expect(feishuDomainForBrand('feishu')).toBe('https://open.feishu.cn')
    expect(feishuDomainForBrand('lark')).toBe('https://open.larksuite.com')
  })

  it('creates an outbound-only SDK client without a WebSocket', async () => {
    const { factory, channel } = fakeFactory()
    const api = createFeishuApi({
      appId: 'cli_app',
      appSecret: 'secret',
      brand: 'lark',
    }, factory)

    await expect(api.send('oc_chat', { markdown: 'hello' }, {
      replyTo: 'om_parent',
      replyInThread: true,
    })).resolves.toEqual({ messageId: 'om_sent' })
    expect(factory).toHaveBeenCalledWith({
      appId: 'cli_app',
      appSecret: 'secret',
      domain: 'https://open.larksuite.com',
      transport: 'webhook',
      httpTimeoutMs: 15_000,
      source: 'use-brian',
    })
    expect(channel.send).toHaveBeenCalledWith('oc_chat', { markdown: 'hello' }, {
      replyTo: 'om_parent',
      replyInThread: true,
    })
  })

  it('sends rich-text edits through the typed message update API', async () => {
    const { factory, channel } = fakeFactory()
    const api = createFeishuApi({ appId: 'cli', appSecret: 's', brand: 'feishu' }, factory)

    await api.editPost('om_status', '**Formatted answer**')

    expect(channel.rawClient.im.v1.message.update).toHaveBeenCalledWith({
      path: { message_id: 'om_status' },
      data: {
        msg_type: 'post',
        content: JSON.stringify({
          zh_cn: { title: '', content: [[{ tag: 'md', text: '**Formatted answer**' }]] },
        }),
      },
    })
  })

  it('surfaces a rejected rich-text edit as a sanitized provider error', async () => {
    const { factory, channel } = fakeFactory()
    channel.rawClient.im.v1.message.update.mockResolvedValueOnce({
      code: 230001,
      msg: 'Message cannot be edited',
    })
    const api = createFeishuApi({ appId: 'cli', appSecret: 's', brand: 'feishu' }, factory)

    await expect(api.editPost('om_status', '**Answer**')).rejects.toMatchObject({
      name: 'FeishuApiError',
      operation: 'edit_post',
      providerCode: 230001,
      message: 'Message cannot be edited',
    })
  })

  it('forwards plain edits, cards, recall, reactions, message lookup, and resource downloads', async () => {
    const { factory, channel } = fakeFactory()
    const api = createFeishuApi({ appId: 'cli', appSecret: 's', brand: 'feishu' }, factory)
    await api.editMessage('om_1', 'updated')
    await api.updateCard('om_2', { elements: [] })
    await api.recallMessage('om_3')
    await api.addReaction('om_4', 'EYES')
    await api.removeReactionByEmoji('om_4', 'EYES')
    const chatId = await api.getMessageChatId('om_4')
    const downloaded = await api.downloadResource('om_5', 'file_1', 'file')

    expect(channel.editMessage).toHaveBeenCalledWith('om_1', 'updated')
    expect(channel.updateCard).toHaveBeenCalledWith('om_2', { elements: [] })
    expect(channel.recallMessage).toHaveBeenCalledWith('om_3')
    expect(channel.addReaction).toHaveBeenCalledWith('om_4', 'EYES')
    expect(channel.removeReactionByEmoji).toHaveBeenCalledWith('om_4', 'EYES')
    expect(channel.fetchMessage).toHaveBeenCalledWith('om_4')
    expect(chatId).toBe('oc_chat')
    expect(new TextDecoder().decode(downloaded.data)).toBe('hello')
    expect(downloaded.contentType).toBe('text/plain')
  })

  it('resolves an open_id to a normalized email through the Contact API', async () => {
    const { factory, channel } = fakeFactory({
      code: 0,
      data: { user: { email: 'Member@Company.Example', name: 'Workspace Member' } },
    })
    const api = createFeishuApi({ appId: 'cli', appSecret: 's', brand: 'feishu' }, factory)

    await expect(api.getUserProfile('ou_sender')).resolves.toEqual({
      email: 'member@company.example',
      displayName: 'Workspace Member',
    })
    expect(channel.rawClient.request).toHaveBeenCalledWith({
      url: '/open-apis/contact/v3/users/ou_sender?user_id_type=open_id',
      method: 'GET',
    })
  })

  it('surfaces a Contact API permission refusal as a sanitized provider error', async () => {
    const { factory } = fakeFactory({ code: 99991672, msg: 'Access denied' })
    const api = createFeishuApi({ appId: 'cli', appSecret: 's', brand: 'lark' }, factory)
    await expect(api.getUserProfile('ou_sender')).rejects.toMatchObject({
      name: 'FeishuApiError',
      operation: 'fetch_user_profile',
      providerCode: 99991672,
      message: 'Access denied',
    })
  })

  it('rethrows rejected SDK calls without credential-bearing request state', async () => {
    const { factory, channel } = fakeFactory()
    const transportError = Object.assign(new Error('Request failed with status code 400'), {
      config: {
        url: 'https://open.feishu.cn/open-apis/im/v1/messages/omt_topic/reply?tenant_access_token=query-secret',
        headers: { Authorization: 'Bearer header-secret' },
      },
      response: {
        status: 400,
        data: {
          code: 99992354,
          msg: 'open_message_id is invalid',
          log_id: '202609250001',
        },
      },
    })
    const rejected = Object.assign(new Error('open_message_id is invalid'), {
      name: 'LarkChannelError',
      code: 'format_error',
      cause: transportError,
      context: { to: 'oc_chat' },
    })
    channel.send.mockRejectedValueOnce(rejected)
    const api = createFeishuApi({ appId: 'cli', appSecret: 'app-secret', brand: 'feishu' }, factory)

    const error = await api.send('oc_chat', { text: 'hello' }, {
      replyTo: 'om_current',
      replyInThread: true,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(FeishuApiError)
    expect(error).toMatchObject({
      providerCode: 99992354,
      httpStatus: 400,
      logId: '202609250001',
      operation: 'send',
      endpoint: '/open-apis/im/v1/messages/:message_id/reply',
      message: 'open_message_id is invalid',
    })
    const serialized = JSON.stringify(error)
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('header-secret')
    expect(serialized).not.toContain('query-secret')
    expect(serialized).not.toContain('app-secret')
    expect(serialized).not.toContain('omt_topic')
    expect(serialized).toContain('99992354')
    expect(serialized).toContain('202609250001')
  })

  it('validates credentials with bot/v3/info and returns identity', async () => {
    const { factory, channel } = fakeFactory()
    await expect(validateFeishuCredentials({
      appId: 'cli',
      appSecret: 's',
      brand: 'feishu',
    }, factory)).resolves.toEqual({ botOpenId: 'ou_bot', botName: 'Brian' })
    expect(channel.rawClient.request).toHaveBeenCalledWith({
      url: '/open-apis/bot/v3/info',
      method: 'GET',
    })
  })

  it('rejects provider errors and malformed successful responses', async () => {
    await expect(validateFeishuCredentials(
      { appId: 'cli', appSecret: 'bad', brand: 'feishu' },
      fakeFactory({ code: 999, msg: 'invalid app secret' }).factory,
    )).rejects.toThrow('invalid app secret')

    await expect(validateFeishuCredentials(
      { appId: 'cli', appSecret: 'bad', brand: 'feishu' },
      fakeFactory({ code: 0, bot: {} }).factory,
    )).rejects.toThrow('bot.open_id')
  })
})
