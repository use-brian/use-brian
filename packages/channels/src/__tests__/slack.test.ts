import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSlackAdapter } from '../slack/adapter.js'
import { createSlackApi } from '../slack/api.js'
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
