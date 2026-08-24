import { describe, expect, it, vi } from 'vitest'
import type { FeishuChannelFactory } from '../client.js'
import {
  createFeishuApi,
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
    rawClient: { request: vi.fn(async () => response) },
  }
  const factory = vi.fn(() => channel) as unknown as FeishuChannelFactory
  return { factory, channel }
}

describe('[COMP:channels/feishu] official SDK client', () => {
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

  it('forwards edits, cards, recall, reactions, message lookup, and resource downloads', async () => {
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
