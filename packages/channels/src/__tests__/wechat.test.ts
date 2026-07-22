/**
 * [COMP:channels/wechat-adapter] — WeChat (iLink bot) adapter.
 * parseIncoming normalization (DMs only — group events dropped whole), dedup
 * ids, chunked context-token-echoing sends, CDN AES key parsing + decrypt,
 * and the markdown filter. All iLink HTTP is mocked via global fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createCipheriv } from 'node:crypto'
import {
  createWechatAdapter,
  markdownToWechat,
  parseIlinkAesKey,
  decryptAesEcb,
  sniffImageMime,
  findWechatMediaItem,
  downloadWechatMediaItem,
  WeixinItemType,
  WeixinMessageState,
  WeixinMessageType,
  type WeixinMessage,
} from '../wechat/index.js'

function userMessage(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    seq: 7,
    message_id: 1234,
    from_user_id: 'wxid_peer@im.user',
    to_user_id: 'bot123@im.bot',
    create_time_ms: 1750000000000,
    message_type: WeixinMessageType.USER,
    message_state: WeixinMessageState.FINISH,
    item_list: [{ type: WeixinItemType.TEXT, text_item: { text: 'hello brian' } }],
    context_token: 'ctx-token-1',
    ...overrides,
  }
}

describe('[COMP:channels/wechat-adapter] WeChat adapter', () => {
  describe('parseIncoming', () => {
    const adapter = createWechatAdapter({ baseUrl: 'https://ilink.example', botToken: 'tok' })

    it('normalizes a text DM (peer id is both userId and channelId)', () => {
      const msg = adapter.parseIncoming(userMessage())
      expect(msg).not.toBeNull()
      expect(msg!.userId).toBe('wxid_peer@im.user')
      expect(msg!.channelId).toBe('wxid_peer@im.user')
      expect(msg!.messageId).toBe('1234')
      expect(msg!.text).toBe('hello brian')
      expect(msg!.isGroupChat).toBe(false)
      expect(msg!.timestamp).toBe(1750000000000)
      expect((msg!.raw as WeixinMessage).context_token).toBe('ctx-token-1')
    })

    it('drops group messages whole (DMs only)', () => {
      expect(adapter.parseIncoming(userMessage({ group_id: 'grp-1' }))).toBeNull()
    })

    it('drops BOT-type (own echo) and non-final messages', () => {
      expect(adapter.parseIncoming(userMessage({ message_type: WeixinMessageType.BOT }))).toBeNull()
      expect(
        adapter.parseIncoming(userMessage({ message_state: WeixinMessageState.GENERATING })),
      ).toBeNull()
    })

    it('uses voice STT text as the message body', () => {
      const msg = adapter.parseIncoming(
        userMessage({
          item_list: [
            { type: WeixinItemType.VOICE, voice_item: { text: '语音转文字', playtime: 3200 } },
          ],
        }),
      )
      expect(msg!.text).toBe('语音转文字')
    })

    it('prefixes quoted text messages', () => {
      const msg = adapter.parseIncoming(
        userMessage({
          item_list: [
            {
              type: WeixinItemType.TEXT,
              text_item: { text: 'what about this?' },
              ref_msg: { title: 'earlier note', message_item: { type: WeixinItemType.TEXT, text_item: { text: 'ship friday' } } },
            },
          ],
        }),
      )
      expect(msg!.text).toBe('[Quoted: earlier note | ship friday]\nwhat about this?')
    })

    it('maps media items to media hints', () => {
      const msg = adapter.parseIncoming(
        userMessage({
          item_list: [
            {
              type: WeixinItemType.FILE,
              file_item: { media: { encrypt_query_param: 'q', aes_key: 'k' }, file_name: 'plan.pdf', len: '2048' },
            },
          ],
        }),
      )
      expect(msg!.mediaType).toBe('document')
      expect(msg!.mediaName).toBe('plan.pdf')
      expect(msg!.mediaSizeBytes).toBe(2048)
      expect(msg!.text).toBe('')
    })

    it('drops payloads with neither text nor media', () => {
      expect(adapter.parseIncoming(userMessage({ item_list: [] }))).toBeNull()
      expect(adapter.parseIncoming({ not: 'a message' })).toBeNull()
    })
  })

  describe('deduplicateId', () => {
    const adapter = createWechatAdapter({ baseUrl: 'https://ilink.example', botToken: 'tok' })

    it('keys on sender + message_id, falling back to client_id then seq', () => {
      expect(adapter.deduplicateId(userMessage())).toBe('wxid_peer@im.user:1234')
      expect(adapter.deduplicateId(userMessage({ message_id: undefined, client_id: 'c9' }))).toBe(
        'wxid_peer@im.user:c9',
      )
      expect(
        adapter.deduplicateId(userMessage({ message_id: undefined, client_id: undefined })),
      ).toBe('wxid_peer@im.user:seq:7')
    })
  })

  describe('sendMessage', () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []

    beforeEach(() => {
      calls.length = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
          return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
        }),
      )
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('sends BOT/FINISH text echoing the context token', async () => {
      const adapter = createWechatAdapter({
        baseUrl: 'https://ilink.example',
        botToken: 'tok',
        getContextToken: () => 'ctx-echo',
      })
      const id = await adapter.sendMessage('wxid_peer@im.user', { text: 'hi there' })
      expect(id).not.toBe('')
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toContain('/ilink/bot/sendmessage')
      const msg = calls[0].body.msg as WeixinMessage
      expect(msg.to_user_id).toBe('wxid_peer@im.user')
      expect(msg.message_type).toBe(WeixinMessageType.BOT)
      expect(msg.message_state).toBe(WeixinMessageState.FINISH)
      expect(msg.context_token).toBe('ctx-echo')
      expect(msg.item_list).toEqual([{ type: WeixinItemType.TEXT, text_item: { text: 'hi there' } }])
    })

    it('chunks long replies into multiple sends', async () => {
      const adapter = createWechatAdapter({ baseUrl: 'https://ilink.example', botToken: 'tok' })
      const long = 'paragraph one.\n\n'.repeat(400)
      await adapter.sendMessage('peer', { text: long })
      expect(calls.length).toBeGreaterThan(1)
      for (const call of calls) {
        const msg = call.body.msg as WeixinMessage
        expect((msg.item_list?.[0].text_item?.text ?? '').length).toBeLessThanOrEqual(4000)
      }
    })

    it('throws on a non-zero ret', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ ret: -1, errmsg: 'nope' }), { status: 200 })),
      )
      const adapter = createWechatAdapter({ baseUrl: 'https://ilink.example', botToken: 'tok' })
      await expect(adapter.sendMessage('peer', { text: 'x' })).rejects.toThrow('ret=-1')
    })
  })

  describe('media helpers', () => {
    it('parses both aes_key encodings to 16 raw bytes', () => {
      const raw = Buffer.from('0123456789abcdef')
      expect(parseIlinkAesKey(raw.toString('base64'))).toEqual(raw)
      const hexEncoded = Buffer.from(raw.toString('hex'), 'ascii').toString('base64')
      expect(parseIlinkAesKey(hexEncoded)).toEqual(raw)
      expect(() => parseIlinkAesKey(Buffer.from('short').toString('base64'))).toThrow()
    })

    it('decrypts AES-128-ECB round-trip', () => {
      const key = Buffer.from('0123456789abcdef')
      const plaintext = Buffer.from('hello wechat media')
      const cipher = createCipheriv('aes-128-ecb', key, null)
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
      expect(decryptAesEcb(encrypted, key)).toEqual(plaintext)
    })

    it('sniffs image mimes from magic bytes', () => {
      expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
      expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
      expect(sniffImageMime(Buffer.from('random data here'))).toBe('image/jpeg')
    })

    it('prioritizes image > video > file > voice-without-STT', () => {
      const voiceWithStt = {
        type: WeixinItemType.VOICE,
        voice_item: { media: { encrypt_query_param: 'v' }, text: 'stt' },
      }
      const file = {
        type: WeixinItemType.FILE,
        file_item: { media: { encrypt_query_param: 'f', aes_key: 'k' }, file_name: 'a.txt' },
      }
      expect(findWechatMediaItem([voiceWithStt, file])).toBe(file)
      expect(findWechatMediaItem([voiceWithStt])).toBeNull()
    })

    it('downloads and decrypts an encrypted image item', async () => {
      const key = Buffer.from('0123456789abcdef')
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')])
      const cipher = createCipheriv('aes-128-ecb', key, null)
      const encrypted = Buffer.concat([cipher.update(png), cipher.final()])
      const fetchImpl = vi.fn(async (url: string | URL) => {
        expect(String(url)).toBe('https://cdn.example/full')
        return new Response(new Uint8Array(encrypted), { status: 200 })
      }) as unknown as typeof fetch

      const result = await downloadWechatMediaItem(
        {
          type: WeixinItemType.IMAGE,
          image_item: {
            media: { full_url: 'https://cdn.example/full', aes_key: key.toString('base64') },
          },
        },
        { fetchImpl },
      )
      expect(result!.kind).toBe('image')
      expect(result!.mime).toBe('image/png')
      expect(result!.data).toEqual(png)
    })
  })

  describe('markdownToWechat', () => {
    it('drops images, strips H5/H6, keeps bold and code fences', () => {
      const input = '##### Deep\n**bold** and ![alt](https://x/y.png) done\n```\n***码*** #####\n```'
      const out = markdownToWechat(input)
      expect(out).toContain('Deep')
      expect(out).not.toContain('##### Deep')
      expect(out).toContain('**bold**')
      expect(out).not.toContain('![alt]')
      // Fenced content is untouched.
      expect(out).toContain('***码*** #####')
    })

    it('strips italic markers around CJK but keeps them for Latin', () => {
      expect(markdownToWechat('*中文强调* and *latin emphasis*')).toBe('中文强调 and *latin emphasis*')
      expect(markdownToWechat('***重要***')).toBe('重要')
      expect(markdownToWechat('**加粗**')).toBe('**加粗**')
    })
  })
})
