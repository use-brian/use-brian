import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { createDiscordAdapter } from '../discord/adapter.js'
import { verifyDiscordSignature, isPingInteraction } from '../discord/verify.js'
import { markdownToDiscord } from '../discord/markdown.js'

// ── Ed25519 interaction signature verification ─────────────────

describe('[COMP:channels/discord] verifyDiscordSignature', () => {
  // Generate a real Ed25519 keypair and expose the raw 32-byte public key as
  // hex (strip the 12-byte SPKI/DER prefix), the same form Discord gives you.
  function makeKeypair(): { publicKeyHex: string; privateKey: KeyObject } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const der = publicKey.export({ type: 'spki', format: 'der' })
    const publicKeyHex = der.subarray(der.length - 32).toString('hex')
    return { publicKeyHex, privateKey }
  }

  function signRequest(privateKey: KeyObject, timestamp: string, body: string): string {
    return cryptoSign(null, Buffer.from(`${timestamp}${body}`, 'utf-8'), privateKey).toString('hex')
  }

  it('returns true for a valid signature', () => {
    const { publicKeyHex, privateKey } = makeKeypair()
    const timestamp = '1700000000'
    const body = '{"type":1}'
    const signature = signRequest(privateKey, timestamp, body)
    expect(verifyDiscordSignature({ publicKey: publicKeyHex, signature, timestamp, body })).toBe(true)
  })

  it('rejects a tampered body', () => {
    const { publicKeyHex, privateKey } = makeKeypair()
    const timestamp = '1700000000'
    const signature = signRequest(privateKey, timestamp, '{"type":1}')
    expect(verifyDiscordSignature({ publicKey: publicKeyHex, signature, timestamp, body: '{"type":2}' })).toBe(false)
  })

  it('rejects a signature made with a different key', () => {
    const a = makeKeypair()
    const b = makeKeypair()
    const timestamp = '1700000000'
    const body = 'payload'
    const signature = signRequest(b.privateKey, timestamp, body)
    expect(verifyDiscordSignature({ publicKey: a.publicKeyHex, signature, timestamp, body })).toBe(false)
  })

  it('rejects a missing signature or timestamp', () => {
    const { publicKeyHex } = makeKeypair()
    expect(verifyDiscordSignature({ publicKey: publicKeyHex, signature: undefined, timestamp: '1', body: 'x' })).toBe(false)
    expect(verifyDiscordSignature({ publicKey: publicKeyHex, signature: 'deadbeef', timestamp: undefined, body: 'x' })).toBe(false)
  })

  it('rejects a malformed (wrong-length) signature without throwing', () => {
    const { publicKeyHex } = makeKeypair()
    expect(verifyDiscordSignature({ publicKey: publicKeyHex, signature: 'zz', timestamp: '1', body: 'x' })).toBe(false)
  })

  it('detects a PING interaction', () => {
    expect(isPingInteraction({ type: 1 })).toBe(true)
    expect(isPingInteraction({ type: 2 })).toBe(false)
    expect(isPingInteraction(null)).toBe(false)
  })
})

// ── parseIncoming: Gateway MESSAGE_CREATE ──────────────────────

describe('[COMP:channels/discord] createDiscordAdapter parseIncoming (gateway)', () => {
  const adapter = createDiscordAdapter({ token: 'bot-token', botUserId: 'BOT_1' })

  function dispatch(message: Record<string, unknown>) {
    return { op: 0, t: 'MESSAGE_CREATE', d: { type: 0, ...message } }
  }

  it('parses a DM (no guild_id) without requiring a mention', () => {
    const result = adapter.parseIncoming(dispatch({
      id: '100',
      channel_id: 'DM_CHAN',
      author: { id: 'USER_1', username: 'alice' },
      content: 'hello bot',
      timestamp: '2024-01-01T00:00:00.000Z',
    }))
    expect(result).toMatchObject({
      userId: 'USER_1',
      channelId: 'DM_CHAN',
      messageId: '100',
      text: 'hello bot',
      isGroupChat: false,
      isMentioned: false,
    })
    expect(result!.timestamp).toBe(Date.parse('2024-01-01T00:00:00.000Z'))
  })

  it('accepts a bare message object (connector forwards only `d`)', () => {
    const result = adapter.parseIncoming({
      type: 0,
      id: '101',
      channel_id: 'DM_CHAN',
      author: { id: 'USER_1', username: 'alice' },
      content: 'bare shape',
    })
    expect(result).not.toBeNull()
    expect(result!.text).toBe('bare shape')
  })

  it('ignores a server message with no mention', () => {
    const result = adapter.parseIncoming(dispatch({
      id: '102',
      channel_id: 'GUILD_CHAN',
      guild_id: 'GUILD_1',
      author: { id: 'USER_1', username: 'alice' },
      content: 'just chatting',
    }))
    expect(result).toBeNull()
  })

  it('responds to a server message that mentions the bot and strips the mention', () => {
    const result = adapter.parseIncoming(dispatch({
      id: '103',
      channel_id: 'GUILD_CHAN',
      guild_id: 'GUILD_1',
      author: { id: 'USER_1', username: 'alice' },
      content: '<@BOT_1> what time is it',
      mentions: [{ id: 'BOT_1', username: 'sidanbot' }],
    }))
    expect(result).not.toBeNull()
    expect(result!.text).toBe('what time is it')
    expect(result!.isGroupChat).toBe(true)
    expect(result!.isMentioned).toBe(true)
  })

  it('responds to a server reply to the bot even without a mention', () => {
    const result = adapter.parseIncoming(dispatch({
      id: '104',
      channel_id: 'GUILD_CHAN',
      guild_id: 'GUILD_1',
      author: { id: 'USER_1', username: 'alice' },
      content: 'thanks',
      referenced_message: { id: '90', author: { id: 'BOT_1', username: 'sidanbot' } },
      message_reference: { message_id: '90' },
    }))
    expect(result).not.toBeNull()
    expect(result!.isMentioned).toBe(true)
    expect(result!.replyToMessageId).toBe('90')
  })

  it('ignores messages authored by a bot (loop protection)', () => {
    const result = adapter.parseIncoming(dispatch({
      id: '105',
      channel_id: 'DM_CHAN',
      author: { id: 'OTHER_BOT', username: 'spammer', bot: true },
      content: 'beep boop',
    }))
    expect(result).toBeNull()
  })

  it('ignores webhook messages', () => {
    const result = adapter.parseIncoming(dispatch({
      id: '106',
      channel_id: 'DM_CHAN',
      author: { id: 'USER_1', username: 'alice' },
      content: 'via webhook',
      webhook_id: 'WH_1',
    }))
    expect(result).toBeNull()
  })

  it('skips system messages (non DEFAULT/REPLY type)', () => {
    const result = adapter.parseIncoming({
      op: 0,
      t: 'MESSAGE_CREATE',
      d: {
        type: 7, // GUILD_MEMBER_JOIN
        id: '107',
        channel_id: 'GUILD_CHAN',
        guild_id: 'GUILD_1',
        author: { id: 'USER_1', username: 'alice' },
        content: '',
      },
    })
    expect(result).toBeNull()
  })

  it('extracts attachments into files and the single-media fields', () => {
    const result = adapter.parseIncoming(dispatch({
      id: '108',
      channel_id: 'DM_CHAN',
      author: { id: 'USER_1', username: 'alice' },
      content: 'look',
      attachments: [
        { id: 'A1', filename: 'photo.png', content_type: 'image/png', size: 1234, url: 'https://cdn/photo.png' },
      ],
    }))
    expect(result!.files).toEqual([
      { url: 'https://cdn/photo.png', mimeType: 'image/png', name: 'photo.png' },
    ])
    expect(result!.mediaUrl).toBe('https://cdn/photo.png')
    expect(result!.mediaType).toBe('photo')
  })

  it('flags a MESSAGE_UPDATE as an edit', () => {
    const result = adapter.parseIncoming({
      op: 0,
      t: 'MESSAGE_UPDATE',
      d: {
        type: 0,
        id: '109',
        channel_id: 'DM_CHAN',
        author: { id: 'USER_1', username: 'alice' },
        content: 'edited text',
      },
    })
    expect(result!.isEdit).toBe(true)
  })

  it('deduplicates by message id', () => {
    expect(adapter.deduplicateId(dispatch({ id: '110', channel_id: 'C', author: { id: 'U' } }))).toBe('110')
  })
})

// ── parseIncoming: HTTP interaction (slash command) ────────────

describe('[COMP:channels/discord] createDiscordAdapter parseIncoming (interaction)', () => {
  const adapter = createDiscordAdapter({ token: 'bot-token', botUserId: 'BOT_1' })

  it('parses an APPLICATION_COMMAND in a guild (user under member)', () => {
    const result = adapter.parseIncoming({
      id: '7205',
      application_id: 'APP_1',
      token: 'interaction-token',
      type: 2,
      channel_id: 'GUILD_CHAN',
      guild_id: 'GUILD_1',
      member: { user: { id: 'USER_1', username: 'alice' } },
      data: { id: 'CMD', name: 'ask', options: [{ name: 'question', type: 3, value: 'what is the weather' }] },
    })
    expect(result).toMatchObject({
      userId: 'USER_1',
      channelId: 'GUILD_CHAN',
      text: 'what is the weather',
      isGroupChat: true,
      isMentioned: true,
    })
  })

  it('parses an APPLICATION_COMMAND in a DM (top-level user)', () => {
    const result = adapter.parseIncoming({
      id: '7206',
      application_id: 'APP_1',
      type: 2,
      channel_id: 'DM_CHAN',
      user: { id: 'USER_2', username: 'bob' },
      data: { name: 'ask', options: [{ name: 'q', type: 3, value: 'hi' }] },
    })
    expect(result).toMatchObject({ userId: 'USER_2', isGroupChat: false, text: 'hi' })
  })

  it('returns null for a PING interaction (handled by the route, not as a message)', () => {
    expect(adapter.parseIncoming({ id: '1', application_id: 'APP_1', type: 1 })).toBeNull()
  })

  it('deduplicates by interaction id', () => {
    expect(adapter.deduplicateId({ id: '7207', application_id: 'APP_1', type: 2 })).toBe('7207')
  })
})

// ── Markdown conversion ────────────────────────────────────────

describe('[COMP:channels/discord] markdownToDiscord', () => {
  it('clamps headers deeper than ### to ###', () => {
    expect(markdownToDiscord('#### Deep')).toBe('### Deep')
    expect(markdownToDiscord('###### Deepest')).toBe('### Deepest')
  })

  it('preserves the 3 supported header levels', () => {
    expect(markdownToDiscord('## Kept')).toBe('## Kept')
  })

  it('rewrites GFM bold __x__ to Discord bold **x**', () => {
    expect(markdownToDiscord('__bold__')).toBe('**bold**')
  })

  it('drops horizontal rules', () => {
    expect(markdownToDiscord('a\n\n---\n\nb')).toBe('a\n\n\n\nb')
  })

  it('flattens a table into key-value blocks', () => {
    const md = '| Model | Speed |\n|---|---|\n| A | fast |\n| B | slow |'
    const out = markdownToDiscord(md)
    expect(out).toContain('**Model:** A')
    expect(out).toContain('**Speed:** fast')
    expect(out).toContain('**Model:** B')
    expect(out).not.toContain('|---|')
  })

  it('leaves fenced code blocks untouched (including # and | inside)', () => {
    const md = '```\n#### not a header\n| a | b |\n```'
    expect(markdownToDiscord(md)).toBe(md)
  })

  it('passes native markdown (bold, italic, links, lists) through unchanged', () => {
    const md = '**bold** *italic* [link](https://x.com)\n- one\n- two'
    expect(markdownToDiscord(md)).toBe(md)
  })
})
