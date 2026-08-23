import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSlackAdapter, isHumanTextEdit } from '../slack/adapter.js'
import { createSlackApi } from '../slack/api.js'
import {
  describeSlackError,
  isSlackApiError,
  looksLikeSlackConversationId,
  looksLikeSlackMemberId,
  SlackApiError,
} from '../slack/errors.js'
import { verifySlackSignature } from '../slack/verify.js'
import { createHmac } from 'node:crypto'

describe('[COMP:channels/slack] verifySlackSignature', () => {
  const secret = 'test_signing_secret'

  function makeSignature(timestamp: string, body: string, signingSecret = secret): string {
    const baseString = `v0:${timestamp}:${body}`
    return 'v0=' + createHmac('sha256', signingSecret).update(baseString).digest('hex')
  }

  it('returns true for a valid current signature', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const body = '{"type":"event_callback"}'
    const signature = makeSignature(timestamp, body)
    expect(verifySlackSignature({ signingSecret: secret, signature, timestamp, body })).toBe(true)
  })

  it('rejects a missing signature', () => {
    expect(verifySlackSignature({
      signingSecret: secret,
      signature: undefined,
      timestamp: Math.floor(Date.now() / 1000).toString(),
      body: '',
    })).toBe(false)
  })

  it('rejects a missing timestamp', () => {
    expect(verifySlackSignature({
      signingSecret: secret,
      signature: 'v0=deadbeef',
      timestamp: undefined,
      body: '',
    })).toBe(false)
  })

  it('rejects an expired request (>5 minutes old)', () => {
    const oldTs = (Math.floor(Date.now() / 1000) - 400).toString()
    const body = 'payload'
    const signature = makeSignature(oldTs, body)
    expect(verifySlackSignature({ signingSecret: secret, signature, timestamp: oldTs, body })).toBe(false)
  })

  it('rejects a request with a tampered body', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = makeSignature(timestamp, 'original body')
    // Same signature but different body → mismatch
    expect(verifySlackSignature({
      signingSecret: secret,
      signature,
      timestamp,
      body: 'tampered body',
    })).toBe(false)
  })

  it('rejects a request signed with a different secret', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const body = 'payload'
    const wrongSig = makeSignature(timestamp, body, 'different_secret')
    expect(verifySlackSignature({
      signingSecret: secret,
      signature: wrongSig,
      timestamp,
      body,
    })).toBe(false)
  })

  it('rejects a non-numeric timestamp', () => {
    expect(verifySlackSignature({
      signingSecret: secret,
      signature: 'v0=abc',
      timestamp: 'not-a-number',
      body: '',
    })).toBe(false)
  })
})

describe('[COMP:channels/slack] createSlackAdapter parseIncoming', () => {
  const adapter = createSlackAdapter({
    botToken: 'xoxb-test',
    botUserId: 'U_BOT',
  })

  it('parses a direct message (DM channel starting with D)', () => {
    const event = {
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'hello bot',
        user: 'U_USER',
        channel: 'D123',
        ts: '1680000000.000100',
      },
    }
    const result = adapter.parseIncoming(event)
    expect(result).toMatchObject({
      userId: 'U_USER',
      channelId: 'D123',
      text: 'hello bot',
      isGroupChat: false,
      isMentioned: false,
    })
  })

  it('parses a channel message only when bot is mentioned', () => {
    const event = {
      type: 'event_callback',
      event: {
        type: 'message',
        text: '<@U_BOT> what time is it',
        user: 'U_USER',
        channel: 'C_CHANNEL',
        ts: '1680000000.000100',
      },
    }
    const result = adapter.parseIncoming(event)
    expect(result).not.toBeNull()
    expect(result!.text).toBe('what time is it')  // mention stripped
    expect(result!.isGroupChat).toBe(true)
    expect(result!.isMentioned).toBe(true)
  })

  it('returns null for channel messages without a bot mention', () => {
    const event = {
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'random chat',
        user: 'U_USER',
        channel: 'C_CHANNEL',
        ts: '1680000000.000100',
      },
    }
    expect(adapter.parseIncoming(event)).toBeNull()
  })

  it('can defer the mention gate to a route that resolves realtime thread targets', () => {
    const routeOwned = createSlackAdapter({
      botToken: 'xoxb-test',
      botUserId: 'U_BOT',
      deferMentionGate: true,
    })
    const result = routeOwned.parseIncoming({
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'This is done',
        user: 'U_USER',
        channel: 'C_CHANNEL',
        ts: '1680000001.000200',
        thread_ts: '1680000000.000100',
      },
    })
    expect(result).toMatchObject({
      text: 'This is done',
      isGroupChat: true,
      isMentioned: false,
      replyToMessageId: '1680000000.000100',
    })
  })

  it('ignores bot messages (bot_id present)', () => {
    const event = {
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'bot echo',
        user: 'U_USER',
        channel: 'D123',
        bot_id: 'B_BOT',
        ts: '1680000000.000100',
      },
    }
    expect(adapter.parseIncoming(event)).toBeNull()
  })

  it('returns null for non-message events', () => {
    const event = {
      type: 'event_callback',
      event: { type: 'reaction_added', user: 'U_USER' },
    }
    expect(adapter.parseIncoming(event)).toBeNull()
  })

  // ── message_changed: only a HUMAN text edit is an edit ─────────
  // Slack also emits `message_changed` for link unfurls (preview card
  // attached seconds after posting), thread metadata and pins. Those
  // used to parse as `isEdit: true`, which re-ran the message as a fresh
  // turn AND made the route abort whatever unrelated turn was in flight
  // (2026-08-18 "Something went wrong" on a "yes" confirmation).
  const changed = (
    message: Record<string, unknown>,
    previous?: Record<string, unknown>,
  ) => ({
    type: 'event_callback',
    event: {
      type: 'message',
      subtype: 'message_changed',
      channel: 'D123',
      ts: '1680000099.000900', // the change event's own ts
      message: { user: 'U_USER', ts: '1680000000.000100', ...message },
      ...(previous ? { previous_message: { user: 'U_USER', ts: '1680000000.000100', ...previous } } : {}),
    },
  })

  it('parses a message_changed with an `edited` stamp and new text as isEdit', () => {
    const result = adapter.parseIncoming(changed(
      { text: 'hello bot v2', edited: { user: 'U_USER', ts: '1680000099.000900' } },
      { text: 'hello bot' },
    ))
    expect(result).toMatchObject({
      userId: 'U_USER',
      channelId: 'D123',
      messageId: '1680000000.000100', // the ORIGINAL message ts, not the change event's
      text: 'hello bot v2',
      isEdit: true,
    })
  })

  it('ignores a link-unfurl message_changed (no `edited` stamp, text unchanged)', () => {
    const result = adapter.parseIncoming(changed(
      { text: 'see <https://app.example/x>', attachments: [{ title: 'preview' }] },
      { text: 'see <https://app.example/x>' },
    ))
    expect(result).toBeNull()
  })

  it('ignores an unfurl that arrives AFTER a real edit (stamp present, text unchanged)', () => {
    const result = adapter.parseIncoming(changed(
      { text: 'edited <https://app.example/x>', edited: { user: 'U_USER', ts: '1680000050.000500' }, attachments: [{}] },
      { text: 'edited <https://app.example/x>' },
    ))
    expect(result).toBeNull()
  })

  it('falls back to the `edited` stamp when Slack omits previous_message', () => {
    expect(adapter.parseIncoming(changed({ text: 'v2', edited: { user: 'U_USER' } }))).toMatchObject({ isEdit: true })
    expect(adapter.parseIncoming(changed({ text: 'v2' }))).toBeNull()
  })

  it('isHumanTextEdit: stamp AND changed text, never one alone', () => {
    expect(isHumanTextEdit({ text: 'b', edited: {} }, { text: 'a' })).toBe(true)
    expect(isHumanTextEdit({ text: 'a', edited: {} }, { text: 'a' })).toBe(false)
    expect(isHumanTextEdit({ text: 'b' }, { text: 'a' })).toBe(false)
    expect(isHumanTextEdit({ text: 'b', edited: {} }, undefined)).toBe(true)
    expect(isHumanTextEdit({ text: 'b' }, undefined)).toBe(false)
  })
})

describe('[COMP:channels/slack] createSlackAdapter handleEvent', () => {
  it('returns the challenge for url_verification events', () => {
    const adapter = createSlackAdapter({ botToken: 'xoxb-test' })
    const result = adapter.handleEvent({ type: 'url_verification', challenge: 'c123' })
    expect(result).toEqual({ challenge: 'c123' })
  })

  it('calls onMessage callback for parsed incoming messages', () => {
    const onMessage = vi.fn()
    const adapter = createSlackAdapter({
      botToken: 'xoxb-test',
      botUserId: 'U_BOT',
      onMessage,
    })
    adapter.handleEvent({
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'hello',
        user: 'U_USER',
        channel: 'D123',
        ts: '1680000000.000100',
      },
    })
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage.mock.calls[0][0]).toMatchObject({ text: 'hello', userId: 'U_USER' })
  })

  it('does not require onMessage when only used for sending', () => {
    const adapter = createSlackAdapter({ botToken: 'xoxb-test' })
    // Should not throw
    const result = adapter.handleEvent({
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'x',
        user: 'U_USER',
        channel: 'D123',
        ts: '1680000000.000100',
      },
    })
    expect(result).toBeNull()
  })
})

describe('[COMP:channels/slack] adapter interface', () => {
  it('declares expected ChannelAdapter properties', () => {
    const adapter = createSlackAdapter({ botToken: 'xoxb-test' })
    expect(adapter.type).toBe('slack')
    expect(adapter.supportsMarkdown).toBe(true)
    expect(adapter.supportsMessageEdit).toBe(true)
    expect(adapter.drainDelayMs).toBe(2000)
    expect(adapter.maxMessageLength).toBeGreaterThan(0)
  })
})

describe('[COMP:channels/slack] outbound audit hook', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  function mockSlackOk(ts: string) {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ ok: true, ts, channel: 'D123' }),
    } as unknown as Response)
  }

  function mockSlackFail(error = 'channel_not_found') {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ ok: false, error }),
    } as unknown as Response)
  }

  it('fires the audit hook after a successful postMessage', async () => {
    mockSlackOk('1680000000.000200')
    const onOutboundAudit = vi.fn().mockResolvedValue(undefined)
    const adapter = createSlackAdapter({ botToken: 'xoxb-test', onOutboundAudit })
    const ts = await adapter.sendMessage('D123', { text: 'hello' })
    expect(ts).toBe('1680000000.000200')
    expect(onOutboundAudit).toHaveBeenCalledTimes(1)
    const event = onOutboundAudit.mock.calls[0][0]
    expect(event.kind).toBe('post_message')
    expect(event.channel).toBe('D123')
    expect(event.text).toBe('hello')
    expect(event.status).toBe('executed')
    expect(event.externalTs).toBe('1680000000.000200')
  })

  it('fires the audit hook with status=failed on a Slack error', async () => {
    mockSlackFail('not_authed')
    const onOutboundAudit = vi.fn().mockResolvedValue(undefined)
    const adapter = createSlackAdapter({ botToken: 'xoxb-test', onOutboundAudit })
    await expect(adapter.sendMessage('D123', { text: 'hi' })).rejects.toThrow()
    expect(onOutboundAudit).toHaveBeenCalledTimes(1)
    expect(onOutboundAudit.mock.calls[0][0].status).toBe('failed')
    expect(onOutboundAudit.mock.calls[0][0].error).toContain('not_authed')
  })

  it('audit failures never crash the user-facing send', async () => {
    mockSlackOk('1680000000.000200')
    const onOutboundAudit = vi.fn().mockRejectedValue(new Error('audit blew up'))
    const adapter = createSlackAdapter({ botToken: 'xoxb-test', onOutboundAudit })
    // sendMessage should still resolve cleanly even though the audit hook rejected.
    const ts = await adapter.sendMessage('D123', { text: 'hello' })
    expect(ts).toBe('1680000000.000200')
  })

  it('chunks long text but each chunk fires the audit hook', async () => {
    const onOutboundAudit = vi.fn().mockResolvedValue(undefined)
    const adapter = createSlackAdapter({ botToken: 'xoxb-test', onOutboundAudit })
    // Slack chunks at SLACK_MAX_MESSAGE_LENGTH = 3000. Send a long message and confirm at least one audit fired.
    const long = 'word '.repeat(700)
    mockSlackOk('1680000000.000300')
    mockSlackOk('1680000000.000301')
    await adapter.sendMessage('C_PUBLIC', { text: long })
    expect(onOutboundAudit.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('suppresses link previews on bot outbound (unfurl off)', async () => {
    // A message full of app links (a digest) must not explode into a stack of
    // identical unfurl cards — every auth-gated app.usebrian.ai link unfurls to
    // the same generic OG card. postMessage always sends unfurl_links:false /
    // unfurl_media:false.
    mockSlackOk('1680000000.000400')
    const adapter = createSlackAdapter({ botToken: 'xoxb-test' })
    await adapter.sendMessage('C_PUBLIC', {
      text: 'see <https://app.usebrian.ai/w/x/brain?row=1|task one>',
    })
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('chat.postMessage'))
    expect(post).toBeDefined()
    const body = JSON.parse((post![1] as { body: string }).body)
    expect(body.unfurl_links).toBe(false)
    expect(body.unfurl_media).toBe(false)
  })
})

describe('[COMP:channels/slack] sendMessage documents', () => {
  type RecordedCall = { url: string; contentType?: string; body?: string }

  function setupFetchMock(opts?: { failUploadUrl?: boolean }) {
    const calls: RecordedCall[] = []
    const mock = vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: unknown }) => {
      calls.push({
        url,
        contentType: init?.headers?.['Content-Type'],
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      if (url.endsWith('chat.postMessage')) {
        return { json: async () => ({ ok: true, ts: '111.222', channel: 'D123' }) } as unknown as Response
      }
      if (url.endsWith('files.getUploadURLExternal')) {
        if (opts?.failUploadUrl) {
          return { json: async () => ({ ok: false, error: 'missing_scope' }) } as unknown as Response
        }
        return {
          json: async () => ({ ok: true, upload_url: 'https://files.slack.test/upload/abc', file_id: 'F123' }),
        } as unknown as Response
      }
      if (url === 'https://files.slack.test/upload/abc') {
        return { ok: true, json: async () => ({}) } as unknown as Response
      }
      if (url.endsWith('files.completeUploadExternal')) {
        return { json: async () => ({ ok: true, files: [{ id: 'F123' }] }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response
    })
    return { calls, mock }
  }

  it('delivers text, then runs the three-step external upload flow', async () => {
    const { calls, mock } = setupFetchMock()
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createSlackAdapter({ botToken: 'xoxb-test' })
      const ts = await adapter.sendMessage('D123', {
        text: 'Here is the report.',
        documents: [
          { filename: 'q1-recap.md', mime: 'text/markdown', data: new TextEncoder().encode('# Q1'), caption: 'Q1 recap' },
        ],
      }, { threadTs: '100.001' })

      const methods = calls.map((c) => c.url.split('/').pop())
      expect(methods).toEqual(['chat.postMessage', 'files.getUploadURLExternal', 'abc', 'files.completeUploadExternal'])

      // Step 1 is form-encoded (the method rejects JSON bodies).
      const getUrl = calls[1]
      expect(getUrl.contentType).toBe('application/x-www-form-urlencoded')
      expect(getUrl.body).toContain('filename=q1-recap.md')

      // Step 3 shares into the channel + thread with the caption as title.
      const complete = JSON.parse(calls[3].body!) as Record<string, unknown>
      expect(complete.channel_id).toBe('D123')
      expect(complete.thread_ts).toBe('100.001')
      expect(complete.files).toEqual([{ id: 'F123', title: 'Q1 recap' }])

      // The returned ts anchors the channel-id round-trip — text message's ts.
      expect(ts).toBe('111.222')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('degrades to a "Could not attach" notice on missing_scope instead of failing', async () => {
    const { calls, mock } = setupFetchMock({ failUploadUrl: true })
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createSlackAdapter({ botToken: 'xoxb-test' })
      const ts = await adapter.sendMessage('D123', {
        text: 'Here is the report.',
        documents: [{ filename: 'q1-recap.md', mime: 'text/markdown', data: new Uint8Array(4) }],
      })

      expect(ts).toBe('111.222')
      const lastPost = calls.filter((c) => c.url.endsWith('chat.postMessage')).at(-1)
      expect(lastPost?.body).toContain('Could not attach q1-recap.md.')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('sends documents even when the text is empty (docs-only send)', async () => {
    const { calls, mock } = setupFetchMock()
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createSlackAdapter({ botToken: 'xoxb-test' })
      await adapter.sendMessage('D123', {
        text: '',
        documents: [{ filename: 'a.txt', mime: 'text/plain', data: new Uint8Array(2) }],
      })
      const methods = calls.map((c) => c.url.split('/').pop())
      // No empty text bubble; upload flow still runs.
      expect(methods).toEqual(['files.getUploadURLExternal', 'abc', 'files.completeUploadExternal'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('[COMP:channels/slack] conversationsList', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  function mockPage(
    channels: Array<{ id: string; name?: string; is_private?: boolean; is_member?: boolean; is_archived?: boolean }>,
    nextCursor = '',
  ) {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ ok: true, channels, response_metadata: { next_cursor: nextCursor } }),
    } as unknown as Response)
  }

  it('maps Slack fields to the compact projection', async () => {
    mockPage([
      { id: 'C0BB4AK5BHB', name: 'deltadefi-dev', is_private: false, is_member: true },
      { id: 'G0PRIV', name: 'founders', is_private: true, is_member: false },
    ])
    const { channels } = await createSlackApi({ botToken: 'xoxb-test' }).conversationsList()
    expect(channels).toEqual([
      { id: 'C0BB4AK5BHB', name: 'deltadefi-dev', isPrivate: false, isMember: true, isArchived: false },
      { id: 'G0PRIV', name: 'founders', isPrivate: true, isMember: false, isArchived: false },
    ])
  })

  it('follows next_cursor across pages, then stops', async () => {
    mockPage([{ id: 'C1', name: 'one', is_member: true }], 'CURSOR2')
    mockPage([{ id: 'C2', name: 'two', is_member: true }], '')
    const { channels } = await createSlackApi({ botToken: 'xoxb-test' }).conversationsList()
    expect(channels.map((c) => c.id)).toEqual(['C1', 'C2'])
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
  })

  it('propagates a Slack error (e.g. missing_scope)', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ ok: false, error: 'missing_scope' }),
    } as unknown as Response)
    await expect(createSlackApi({ botToken: 'xoxb-test' }).conversationsList()).rejects.toThrow('missing_scope')
  })
})

describe('[COMP:channels/slack] read-method form encoding', () => {
  // Slack's GET-family read methods IGNORE a JSON body: a required arg goes
  // missing (`conversations.info` → unconditional `invalid_arguments`, prod
  // 2026-08-17) and an optional arg silently reverts to its default
  // (`conversations.list` lost `types`, hiding private channels). These tests
  // pin the content type so the regression cannot come back quietly.
  type Recorded = { url: string; contentType?: string; body?: string }
  let calls: Recorded[]

  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: unknown }) => {
      calls.push({
        url,
        contentType: init?.headers?.['Content-Type'],
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      return {
        json: async () => ({
          ok: true,
          channel: { id: 'C0TESTFORM1', name: 'test' },
          channels: [],
          members: [],
          messages: [],
        }),
      } as unknown as Response
    }))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('conversations.info sends the channel form-encoded, never as JSON', async () => {
    await createSlackApi({ botToken: 'xoxb-test' }).conversationsInfo('C0TESTFORM1')
    expect(calls).toHaveLength(1)
    expect(calls[0].contentType).toBe('application/x-www-form-urlencoded')
    expect(calls[0].body).toBe('channel=C0TESTFORM1')
  })

  it('conversations.list sends types/limit form-encoded and drops undefined cursor', async () => {
    await createSlackApi({ botToken: 'xoxb-test' }).conversationsList()
    expect(calls[0].contentType).toBe('application/x-www-form-urlencoded')
    const params = new URLSearchParams(calls[0].body)
    expect(params.get('types')).toBe('public_channel,private_channel')
    expect(params.get('exclude_archived')).toBe('true')
    expect(params.get('limit')).toBe('200')
    expect(params.has('cursor')).toBe(false)
  })

  it('users.list and conversations.history are form-encoded too', async () => {
    const api = createSlackApi({ botToken: 'xoxb-test' })
    await api.usersList()
    await api.conversationsHistory('C0TESTFORM1', { limit: 5 })
    expect(calls.map((c) => c.contentType)).toEqual([
      'application/x-www-form-urlencoded',
      'application/x-www-form-urlencoded',
    ])
    const history = new URLSearchParams(calls[1].body)
    expect(history.get('channel')).toBe('C0TESTFORM1')
    expect(history.get('limit')).toBe('5')
    expect(history.has('latest')).toBe(false)
  })
})

describe('[COMP:channels/slack-errors] SlackApiError + describeSlackError', () => {
  afterEach(() => vi.unstubAllGlobals())

  function slackFailure(body: Record<string, unknown>, init?: ResponseInit) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, ...init })))
  }

  it('keeps the code, the validator detail, and the call target on the thrown error', async () => {
    slackFailure({
      ok: false,
      error: 'invalid_arguments',
      response_metadata: { messages: ['[ERROR] invalid `channel` value'] },
    })
    const api = createSlackApi({ botToken: 'xoxb-test' })
    const err = await api.conversationsInfo('#general').catch((e: unknown) => e)
    expect(isSlackApiError(err)).toBe(true)
    if (!isSlackApiError(err)) return
    expect(err.method).toBe('conversations.info')
    expect(err.code).toBe('invalid_arguments')
    expect(err.detail).toEqual(['[ERROR] invalid `channel` value'])
    expect(err.target).toEqual({ channel: '#general' })
    // The legacy `Slack API <method>: <code>` prefix survives for log/grep parity.
    expect(err.message).toMatch(/^Slack API conversations\.info: invalid_arguments/)
  })

  it('invalid_arguments with a non-id channel names the value and points at listSlackChannels', async () => {
    slackFailure({ ok: false, error: 'invalid_arguments' })
    const err = await createSlackApi({ botToken: 'x' }).conversationsInfo('#general').catch((e: unknown) => e)
    const text = describeSlackError(err)
    expect(text).toContain('`#general` is not a Slack conversation id')
    expect(text).toContain('`listSlackChannels`')
    expect(text).toContain('invalid_arguments')
  })

  it('missing_scope carries needed/provided and says a retry cannot help', async () => {
    slackFailure({ ok: false, error: 'missing_scope', needed: 'channels:read', provided: 'chat:write,users:read' })
    const err = await createSlackApi({ botToken: 'x' }).conversationsList().catch((e: unknown) => e)
    const text = describeSlackError(err)
    expect(text).toContain('`channels:read`')
    expect(text).toContain('token has: chat:write,users:read')
    expect(text).toMatch(/retrying will not help/i)
  })

  it('ratelimited reads Retry-After and says how long to wait', async () => {
    slackFailure({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'retry-after': '7' } })
    const err = await createSlackApi({ botToken: 'x' }).conversationsList().catch((e: unknown) => e)
    expect(isSlackApiError(err) && err.retryAfterSec).toBe(7)
    expect(describeSlackError(err)).toMatch(/wait 7s, then retry the same call once/)
  })

  it('auth-class codes are diagnosed as a dead token with a reconnect remedy', async () => {
    slackFailure({ ok: false, error: 'token_revoked' })
    const err = await createSlackApi({ botToken: 'x' }).conversationsList().catch((e: unknown) => e)
    const text = describeSlackError(err)
    expect(text).toContain('token_revoked')
    expect(text).toMatch(/Reconnect Slack/)
    expect(text).toMatch(/retrying the same call will not help/)
  })

  it('a non-JSON transport failure becomes an http_<status> code instead of a JSON parse throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })))
    const err = await createSlackApi({ botToken: 'x' }).conversationsList().catch((e: unknown) => e)
    expect(isSlackApiError(err) && err.code).toBe('http_502')
    expect(describeSlackError(err)).toMatch(/HTTP 502/)
  })

  it('an unknown code still gets the what/where and a pointer to the method reference', async () => {
    slackFailure({ ok: false, error: 'some_new_code' })
    const err = await createSlackApi({ botToken: 'x' }).conversationsInfo('C123').catch((e: unknown) => e)
    const text = describeSlackError(err)
    expect(text).toContain('`some_new_code`')
    expect(text).toContain('conversations.info')
    expect(text).toContain('https://docs.slack.dev/reference/methods/conversations.info')
  })

  it('passes non-Slack errors through as their message', () => {
    expect(describeSlackError(new Error('fetch failed'))).toBe('fetch failed')
  })

  // ── Message / shape / file / reaction codes ────────────────────────────
  // These reach the model from the run-time senders (workflow delivery, A2A
  // relay, confirmation prompts, reactions), where the only thing it can act
  // on is the sentence. Each must name the target, diagnose, give the next
  // step, and state whether the same input can ever succeed.
  const err = (code: string, target?: { channel?: string; ts?: string }, method = 'chat.update') =>
    new SlackApiError({ method, code, target })

  it('message_not_found names the ts + channel and forbids the blind retry', () => {
    const text = describeSlackError(err('message_not_found', { channel: 'C0BB4AK5BHB', ts: '1751970000.111111' }))
    expect(text).toContain('`1751970000.111111`')
    expect(text).toContain('`C0BB4AK5BHB`')
    expect(text).toMatch(/per-channel message id/i)
    expect(text).toContain('Retrying this exact (channel, ts) pair will keep failing.')
  })

  it('invalid_ts_latest names the offending argument and the ts format', () => {
    const text = describeSlackError(err('invalid_ts_latest', { channel: 'C1' }, 'conversations.history'))
    expect(text).toContain('`latest`')
    expect(text).toContain('1751970000.111111')
    expect(text).toMatch(/same value will fail the same way/i)
  })

  it('invalid_ts_oldest names the oldest argument instead', () => {
    expect(describeSlackError(err('invalid_ts_oldest', {}, 'conversations.history'))).toContain('`oldest`')
  })

  it('cant_update_message explains bot-authored-only and says to post a new message', () => {
    const text = describeSlackError(err('cant_update_message', { channel: 'C1', ts: '1751970000.111111' }))
    expect(text).toMatch(/SAME bot token/)
    expect(text).toMatch(/Post a new message/i)
    expect(text).toMatch(/Retrying the edit will keep failing/i)
  })

  it('edit_window_closed is permanent — post a new message instead', () => {
    const text = describeSlackError(err('edit_window_closed', { channel: 'C1', ts: '1751970000.111111' }))
    expect(text).toMatch(/can never be edited again/i)
    expect(text).toMatch(/Post a NEW message/)
    expect(text).toMatch(/no retry of this edit can ever succeed/i)
  })

  it('no_text says nothing was posted and names the field to fill', () => {
    const text = describeSlackError(err('no_text', { channel: 'C1' }, 'chat.postMessage'))
    expect(text).toMatch(/no message text/i)
    expect(text).toMatch(/nothing was posted to `C1`/)
    expect(text).toContain('`text`')
    expect(text).toMatch(/will fail the same way/i)
  })

  it('invalid_blocks carries Slack detail and offers plain text as the fallback', () => {
    const text = describeSlackError(new SlackApiError({
      method: 'chat.postMessage',
      code: 'invalid_blocks',
      detail: ['[ERROR] missing required field: type'],
      target: { channel: 'C1' },
    }))
    expect(text).toContain('missing required field: type')
    expect(text).toContain('plain `text`')
    expect(text).toMatch(/nothing was posted/i)
  })

  it('invalid_cursor says to restart pagination with no cursor', () => {
    const text = describeSlackError(err('invalid_cursor', {}, 'conversations.list'))
    expect(text).toMatch(/with NO cursor/)
    expect(text).toContain('next_cursor')
    expect(text).toMatch(/Retrying with this cursor will keep failing/i)
  })

  it('file_not_found points at re-running the upload rather than reusing the id', () => {
    const text = describeSlackError(err('file_not_found', { channel: 'C1' }, 'files.completeUploadExternal'))
    expect(text).toMatch(/attachment was not delivered/i)
    expect(text).toMatch(/Re-run the upload/i)
    expect(text).toMatch(/Retrying with this id will keep failing/i)
  })

  it('file_uploads_disabled blames the workspace admin setting and says to tell the user', () => {
    const text = describeSlackError(err('file_uploads_disabled', { channel: 'C1' }, 'files.getUploadURLExternal'))
    expect(text).toMatch(/NOT delivered/)
    expect(text).toMatch(/workspace admin setting/i)
    expect(text).toMatch(/Tell the user/i)
  })

  it('thread_not_found explains thread_ts must be the parent message ts', () => {
    const text = describeSlackError(err('thread_not_found', { channel: 'C1', ts: '1751960000.000100' }, 'chat.postMessage'))
    expect(text).toContain('`1751960000.000100`')
    expect(text).toMatch(/PARENT message/)
    expect(text).toMatch(/post at top level/i)
    expect(text).toMatch(/nothing was posted/i)
  })

  it('already_reacted is a no-op: nothing to do, do not retry', () => {
    const text = describeSlackError(err('already_reacted', { channel: 'C1', ts: '1751970000.111111' }, 'reactions.add'))
    expect(text).toMatch(/already added that reaction/i)
    expect(text).toMatch(/nothing to do/i)
    expect(text).toMatch(/do not retry/i)
  })

  it('no_reaction is a no-op: the end state is already true', () => {
    const text = describeSlackError(err('no_reaction', { channel: 'C1', ts: '1751970000.111111' }, 'reactions.remove'))
    expect(text).toMatch(/no such reaction/i)
    expect(text).toMatch(/already true/i)
    expect(text).toMatch(/do not retry/i)
  })

  it('id shape helpers accept real ids and reject names / UUIDs', () => {
    expect(looksLikeSlackConversationId('C0123ABCD')).toBe(true)
    expect(looksLikeSlackConversationId('G0123ABCD')).toBe(true)
    expect(looksLikeSlackConversationId('D0123ABCD')).toBe(true)
    expect(looksLikeSlackConversationId('#general')).toBe(false)
    expect(looksLikeSlackConversationId('general')).toBe(false)
    expect(looksLikeSlackConversationId('3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c')).toBe(false)
    expect(looksLikeSlackMemberId('U0123ABCD')).toBe(true)
    expect(looksLikeSlackMemberId('@alice')).toBe(false)
  })
})
