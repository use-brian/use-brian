import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTelegramAdapter, parseTopicChannelId } from '../telegram/adapter.js'
import { createTelegramApi } from '../telegram/api.js'

const message = (extra = {}) => ({
  message_id: 81, date: 100, from: { id: 42, first_name: 'Casey' },
  chat: { id: -10020, type: 'supergroup' }, text: '@testbot hello',
  entities: [{ type: 'mention', offset: 0, length: 8 }], ...extra,
})
const adapter = (extra = {}) => createTelegramAdapter({ token: '99:test', botUsername: 'testbot', ...extra })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Telegram broadcasts and linked discussions', () => {
  it('registers new posts, not edits', async () => {
    const fetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, result: true }) })
    vi.stubGlobal('fetch', fetch)
    await createTelegramApi({ token: 'test' }).setWebhook('https://bot.example/webhook')
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.allowed_updates).toContain('channel_post')
    expect(body.allowed_updates).not.toContain('edited_channel_post')
  })

  it('normalizes broadcast chat identity, ignoring fake from and author signatures', () => {
    const a = adapter()
    const post = message({ chat: { id: -10010, type: 'channel', title: 'News' }, from: { id: 42 }, author_signature: 'Owner' })
    expect(a.parseIncoming({ channel_post: post })).toMatchObject({ userId: 'chat:-10010', senderDisplay: 'News', isGroupChat: true, channelId: '-10010' })
    expect(a.parseIncoming({ edited_channel_post: post })).toBeNull()
    expect(a.parseIncoming({ edited_message: post })).toBeNull()
    expect(adapter({ config: { requireMention: false } }).parseIncoming({ channel_post: { ...post, text: 'news', entities: [] } })).toBeNull()
  })

  it('drops auto-forwards and bots; anonymous senders use sender_chat', () => {
    const a = adapter({ config: { requireMention: false } })
    expect(a.parseIncoming({ message: message({ is_automatic_forward: true }) })).toBeNull()
    expect(a.parseIncoming({ message: message({ from: { id: 99, is_bot: true } }) })).toBeNull()
    expect(a.parseIncoming({ message: message({ sender_chat: { id: -10020, title: 'Anonymous' }, from: { id: 108, is_bot: true } }) })).toMatchObject({ userId: 'chat:-10020', senderDisplay: 'Anonymous' })
  })

  it('separates direct and nested comments without changing ordinary groups or forums', () => {
    const a = adapter({ config: { discussionChatIds: ['-10020'] } })
    expect(a.parseIncoming({ message: message({ message_thread_id: 30 }) })?.channelId).toBe('-10020:discussion:30')
    expect(a.parseIncoming({ message: message({ message_thread_id: 40 }) })?.channelId).toBe('-10020:discussion:40')
    expect(a.parseIncoming({ message: message() })?.channelId).toBe('-10020')
    expect(adapter().parseIncoming({ message: message({ message_thread_id: 30 }) })?.channelId).toBe('-10020')
    expect(adapter().parseIncoming({ message: message({ reply_to_message: { message_id: 30, is_automatic_forward: true } }) })?.channelId).toBe('-10020:discussion:30')
    expect(a.parseIncoming({ message: message({ chat: { id: -10020, type: 'supergroup', is_forum: true }, message_thread_id: 30 }) })?.channelId).toBe('-10020:topic:30')
  })

  it('uses discussion scope for callbacks, never inventories comments as forum topics', () => {
    const onCallbackQuery = vi.fn(), onChatSeen = vi.fn(), onMessage = vi.fn()
    const a = adapter({ config: { discussionChatIds: ['-10020'] }, onCallbackQuery, onChatSeen, onMessage })
    a.handleWebhook({ callback_query: { id: 'q', from: { id: 42 }, message: message({ message_thread_id: 30 }), data: 'ok' } })
    expect(onCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ chatId: '-10020:discussion:30' }))
    a.handleWebhook({ message: message({ message_thread_id: 30 }) })
    expect(onChatSeen).toHaveBeenCalledWith(expect.objectContaining({ topicId: null, isForum: false }))
    a.handleWebhook({ channel_post: message({ chat: { id: -10010, type: 'channel' } }) })
    expect(onMessage).toHaveBeenLastCalledWith(expect.objectContaining({ channelId: '-10010' }))
  })

  it('routes every text chunk, status and document via a strict root reply, not a forum thread', async () => {
    const fetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, result: { message_id: 90 } }) })
    vi.stubGlobal('fetch', fetch)
    const a = adapter()
    expect(parseTopicChannelId('-10020:discussion:1')).toEqual({ chatId: '-10020', messageThreadId: undefined, discussionRootId: 1 })
    await a.sendMessage('-10020:discussion:1', { text: 'x'.repeat(5000), documents: [{ filename: 'note.txt', mime: 'text/plain', data: new Uint8Array([1]) }] }, { threadTs: '81' })
    await a.sendStatus!('-10020:discussion:1', 'Thinking')
    for (const [, init] of fetch.mock.calls) {
      const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body)
      expect(body.chat_id).toBe('-10020')
      expect(body.message_thread_id).toBeUndefined()
      const reply = typeof body.reply_parameters === 'string' ? JSON.parse(body.reply_parameters) : body.reply_parameters
      expect(reply).toEqual({ message_id: 1, allow_sending_without_reply: false })
    }
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('unwraps discussion destinations for edits, typing, reactions, deletion and pins', async () => {
    const fetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, result: true }) })
    vi.stubGlobal('fetch', fetch)
    const a = adapter()
    await a.editMessage('-10020:discussion:30', '81', { text: 'Edited' })
    await a.sendTypingIndicator('-10020:discussion:30')
    await a.reactToMessage!('-10020:discussion:30', '81', '👍')
    await a.deleteMessage!('-10020:discussion:30', '81')
    await a.pinMessage!('-10020:discussion:30', '81')
    await a.unpinMessage!('-10020:discussion:30', '81')
    for (const [, init] of fetch.mock.calls) {
      expect(JSON.parse(init.body)).toMatchObject({ chat_id: '-10020' })
      expect(JSON.parse(init.body).message_thread_id).toBeUndefined()
    }
  })

  it('keeps parallel discussion text fragments and different senders separate', async () => {
    vi.useFakeTimers()
    const onMessage = vi.fn()
    const a = adapter({ config: { requireMention: false, discussionChatIds: ['-10020'] }, onMessage })
    for (const [id, root, sender] of [[81, 30, 42], [82, 40, 42], [83, 30, 43]]) {
      a.handleWebhook({ message: message({ message_id: id, message_thread_id: root,
        from: { id: sender }, text: 'x'.repeat(4000), entities: [],
      }) })
    }
    await vi.advanceTimersByTimeAsync(1600)
    expect(onMessage.mock.calls.map(([m]) => [m.channelId, m.userId, m.text.length])).toEqual([
      ['-10020:discussion:30', '42', 4000], ['-10020:discussion:40', '42', 4000], ['-10020:discussion:30', '43', 4000],
    ])
  })

  it('fails closed when a discussion root was deleted, without spilling into the group', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 400, json: async () => ({ ok: false, error_code: 400, description: 'message to be replied not found' }) })
    vi.stubGlobal('fetch', fetch)
    await expect(adapter().sendMessage('-10020:discussion:30', { text: 'Hello' })).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
