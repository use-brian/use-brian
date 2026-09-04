import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { createDiscordAdapter } from '../discord/adapter.js'
import {
  createDiscordApi,
  DISCORD_APPLICATION_COMMANDS,
  respondToInteraction,
} from '../discord/api.js'
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

  it('preserves explicit skill and workflow command namespaces', () => {
    const base = {
      application_id: 'APP_1', type: 2, channel_id: 'DM_CHAN',
      user: { id: 'USER_2', username: 'bob' },
    }
    expect(adapter.parseIncoming({
      ...base, id: '7208',
      data: { name: 'skill', options: [
        { name: 'slug', type: 3, value: 'goal' },
        { name: 'arguments', type: 3, value: 'register it' },
      ] },
    })?.text).toBe('/skill goal register it')
    expect(adapter.parseIncoming({
      ...base, id: '7209',
      data: { name: 'workflow', options: [
        { name: 'workflow', type: 3, value: 'Daily Digest' },
        { name: 'arguments', type: 3, value: 'region=apac' },
      ] },
    })?.text).toBe('/workflow "Daily Digest" region=apac')
  })

  it('preserves a generated command name for shared dispatch', () => {
    const result = adapter.parseIncoming({
      id: '7210',
      application_id: 'APP_1',
      type: 2,
      channel_id: 'DM_CHAN',
      user: { id: 'USER_2', username: 'bob' },
      data: {
        name: 'workflow_daily_digest',
        options: [{ name: 'arguments', type: 3, value: 'region=apac' }],
      },
    })
    expect(result?.text).toBe('/workflow_daily_digest region=apac')
  })

  it('returns null for a PING interaction (handled by the route, not as a message)', () => {
    expect(adapter.parseIncoming({ id: '1', application_id: 'APP_1', type: 1 })).toBeNull()
  })

  it('deduplicates by interaction id', () => {
    expect(adapter.deduplicateId({ id: '7207', application_id: 'APP_1', type: 2 })).toBe('7207')
  })
})

describe('[COMP:channels/discord] application command registration', () => {
  afterEach(() => vi.restoreAllMocks())

  it('replaces global commands with the shared roster', async () => {
    const calls: CapturedCall[] = []
    mockFetch(calls, 200, DISCORD_APPLICATION_COMMANDS)
    await createDiscordApi({ token: 'bot-token' }).replaceGlobalApplicationCommands('APP_1')
    expect(calls[0].url).toContain('/applications/APP_1/commands')
    expect(calls[0].init.method).toBe('PUT')
    expect(JSON.parse(String(calls[0].init.body))).toEqual(DISCORD_APPLICATION_COMMANDS)
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

// ── Confirmation buttons: outbound components ──────────────────

type CapturedCall = { url: string; init: RequestInit }

function captureAndCount(captured: CapturedCall[], url: unknown, init: RequestInit | undefined) {
  captured.push({ url: String(url), init: init ?? {} })
}

function mockFetch(captured: CapturedCall[], status = 200, json: unknown = { id: 'msg-1', channel_id: 'C1' }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    captured.push({ url: String(url), init: init ?? {} })
    return status === 204
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  })
}

describe('[COMP:channels/discord] sendMessage confirmation buttons', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders OutgoingAction[] as one action row of custom_id buttons', async () => {
    const calls: CapturedCall[] = []
    mockFetch(calls)
    const adapter = createDiscordAdapter({ token: 't' })
    await adapter.sendMessage('C1', {
      text: 'Allow this action?',
      actions: [
        { id: 'allow', label: 'Allow', data: 'mcp_confirm:tc1:allow' },
        { id: 'deny', label: 'Deny', data: 'mcp_confirm:tc1:deny' },
        { id: 'always', label: 'Always Allow', data: 'mcp_confirm:tc1:always_allow' },
        { id: 'never', label: 'Always Deny', data: 'mcp_confirm:tc1:always_deny' },
      ],
    })
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Allow', custom_id: 'mcp_confirm:tc1:allow' },
          { type: 2, style: 4, label: 'Deny', custom_id: 'mcp_confirm:tc1:deny' },
          { type: 2, style: 1, label: 'Always Allow', custom_id: 'mcp_confirm:tc1:always_allow' },
          { type: 2, style: 2, label: 'Always Deny', custom_id: 'mcp_confirm:tc1:always_deny' },
        ],
      },
    ])
  })

  it('omits components when no actions are present', async () => {
    const calls: CapturedCall[] = []
    mockFetch(calls)
    const adapter = createDiscordAdapter({ token: 't' })
    await adapter.sendMessage('C1', { text: 'plain reply' })
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.components).toBeUndefined()
  })

  it('maps a web_app action to a Discord link button', async () => {
    const calls: CapturedCall[] = []
    mockFetch(calls)
    const adapter = createDiscordAdapter({ token: 't' })
    await adapter.sendMessage('C1', {
      text: 'open',
      actions: [{ kind: 'web_app', label: 'Open', url: 'https://x.test' }],
    })
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.components[0].components[0]).toEqual({ type: 2, style: 5, label: 'Open', url: 'https://x.test' })
  })

  it('clears buttons on editMessage when actions is an empty array', async () => {
    const calls: CapturedCall[] = []
    mockFetch(calls)
    const adapter = createDiscordAdapter({ token: 't' })
    await adapter.editMessage('C1', 'M1', { text: 'Tool action: Allowed', actions: [] })
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.components).toEqual([])
  })
})

describe('[COMP:channels/discord] sendMessage outbound documents', () => {
  afterEach(() => vi.restoreAllMocks())

  const doc = { filename: 'boarding-pass.pdf', mime: 'application/pdf', data: new Uint8Array([1, 2, 3]) }

  it('uploads the document as multipart after the text, linking payload_json to files[0]', async () => {
    const calls: CapturedCall[] = []
    mockFetch(calls)
    const adapter = createDiscordAdapter({ token: 't' })

    const id = await adapter.sendMessage('C1', { text: 'Here it is.', documents: [doc] })

    expect(calls).toHaveLength(2)
    // Text first, JSON as before — the document must not disturb it.
    expect(String(calls[0].init.headers ? (calls[0].init.headers as Record<string, string>)['Content-Type'] : '')).toBe('application/json')
    expect(JSON.parse(String(calls[0].init.body)).content).toBe('Here it is.')

    // Upload: multipart, so fetch owns the boundary — we must NOT set Content-Type.
    const upload = calls[1]
    const headers = (upload.init.headers ?? {}) as Record<string, string>
    expect(headers['Content-Type']).toBeUndefined()
    expect(upload.init.body).toBeInstanceOf(FormData)
    const form = upload.init.body as FormData
    const payload = JSON.parse(String(form.get('payload_json')))
    // Discord links the JSON attachment entry to the file part by index.
    expect(payload.attachments).toEqual([{ id: 0, filename: 'boarding-pass.pdf' }])
    const file = form.get('files[0]') as File
    expect(file).toBeInstanceOf(Blob)
    expect(file.type).toBe('application/pdf')
    expect(await file.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer)

    // The returned id stays the LAST TEXT chunk's — the reaction round-trip anchor.
    expect(id).toBe('msg-1')
  })

  it('delivers a documents-only reply (no text) instead of returning early', async () => {
    const calls: CapturedCall[] = []
    mockFetch(calls)
    const adapter = createDiscordAdapter({ token: 't' })

    const id = await adapter.sendMessage('C1', { text: '', documents: [doc] })

    expect(calls).toHaveLength(1)
    expect(calls[0].init.body).toBeInstanceOf(FormData)
    // No text chunk ran, so the anchor falls back to the document's message.
    expect(id).toBe('msg-1')
  })

  it('surfaces a notice when an upload fails — never a silent drop', async () => {
    const calls: CapturedCall[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      captureAndCount(calls, url, init)
      // The multipart upload fails; the plain text sends fine.
      if (init?.body instanceof FormData) {
        return new Response(JSON.stringify({ message: 'Request entity too large' }), {
          status: 413,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ id: 'msg-1', channel_id: 'C1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const adapter = createDiscordAdapter({ token: 't' })

    await adapter.sendMessage('C1', { text: 'Here it is.', documents: [doc] })

    const notice = calls.filter((c) => !(c.init.body instanceof FormData)).map((c) => JSON.parse(String(c.init.body)).content)
    expect(notice).toContain('Could not attach boarding-pass.pdf.')
  })

  it('refuses a file over Discord\'s unboosted upload ceiling before touching the API', async () => {
    const calls: CapturedCall[] = []
    mockFetch(calls)
    const adapter = createDiscordAdapter({ token: 't' })

    await adapter.sendMessage('C1', {
      text: 'Here it is.',
      documents: [{ ...doc, data: new Uint8Array(10 * 1024 * 1024 + 1) }],
    })

    // Text + notice only — no multipart request was ever made.
    expect(calls.some((c) => c.init.body instanceof FormData)).toBe(false)
    const contents = calls.map((c) => JSON.parse(String(c.init.body)).content)
    expect(contents).toContain('Could not attach boarding-pass.pdf.')
  })
})

// ── Confirmation buttons: interaction ack ──────────────────────

describe('[COMP:channels/discord] respondToInteraction', () => {
  afterEach(() => vi.restoreAllMocks())

  it('POSTs a type-7 callback to the interaction endpoint with no bot auth', async () => {
    const calls: CapturedCall[] = []
    mockFetch(calls, 204)
    await respondToInteraction('IID', 'ITOKEN', {
      type: 7,
      data: { content: 'Tool action: Allowed', components: [] },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://discord.com/api/v10/interactions/IID/ITOKEN/callback')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined()
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.type).toBe(7)
    expect(body.data.components).toEqual([])
  })

  it('throws on a non-2xx callback (e.g. already acknowledged)', async () => {
    mockFetch([], 400, { message: 'already acked', code: 40060 })
    await expect(respondToInteraction('IID', 'ITOKEN', { type: 6 })).rejects.toThrow()
  })
})
