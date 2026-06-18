import { describe, it, expect, vi } from 'vitest'
import { createTelegramAdapter, parseTopicChannelId } from '../telegram/adapter.js'
import { createTelegramApi, isTelegramThreadNotFoundError, TelegramApiError } from '../telegram/api.js'
import { chunkText } from '../chunking.js'
import { createDedupBuffer } from '../dedup.js'
import { verifyTelegramWebhook } from '../telegram/webhook.js'
import { escapeHtml, markdownToTelegramHTML, stripMarkdown } from '../telegram/markdown.js'

// ── Chunking ───────────────────────────────────────────────────

describe('[COMP:channels/chunking] chunkText', () => {
  it('returns single chunk for short text', () => {
    expect(chunkText('Hello world', 100)).toEqual(['Hello world'])
  })

  it('splits at paragraph boundaries', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
    const chunks = chunkText(text, 30)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toBe('First paragraph.')
  })

  it('splits at sentence boundaries when no paragraph break', () => {
    const text = 'First sentence. Second sentence. Third sentence. Fourth sentence.'
    const chunks = chunkText(text, 40)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toContain('First sentence.')
  })

  it('hard splits when no good break point', () => {
    const text = 'a'.repeat(100)
    const chunks = chunkText(text, 30)
    expect(chunks.length).toBe(4)
  })
})

// ── Deduplication ──────────────────────────────────────────────

describe('[COMP:channels/dedup] createDedupBuffer', () => {
  it('detects duplicates', () => {
    const dedup = createDedupBuffer()
    expect(dedup.isDuplicate('1')).toBe(false)
    expect(dedup.isDuplicate('1')).toBe(true)
    expect(dedup.isDuplicate('2')).toBe(false)
  })

  it('evicts oldest when full', () => {
    const dedup = createDedupBuffer()
    for (let i = 0; i < 1001; i++) {
      dedup.isDuplicate(String(i))
    }
    // Entry "0" should have been evicted
    expect(dedup.isDuplicate('0')).toBe(false)
    // Entry "1000" should still be there
    expect(dedup.isDuplicate('1000')).toBe(true)
  })
})

// ── Webhook verification ───────────────────────────────────────

describe('[COMP:channels/telegram] verifyTelegramWebhook', () => {
  it('accepts matching secret token', () => {
    expect(verifyTelegramWebhook('my-secret', 'my-secret')).toBe(true)
  })

  it('rejects mismatched token', () => {
    expect(verifyTelegramWebhook('my-secret', 'wrong-secret')).toBe(false)
  })

  it('rejects undefined header', () => {
    expect(verifyTelegramWebhook('my-secret', undefined)).toBe(false)
  })
})

// ── Markdown → HTML ────────────────────────────────────────────

describe('[COMP:channels/telegram] escapeHtml', () => {
  it('escapes &, <, > for HTML parse_mode', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })
})

describe('[COMP:channels/telegram] markdownToTelegramHTML', () => {
  it('converts ### headers to <b> lines', () => {
    // Headers are Telegram's #1 rendering failure — LLMs emit them constantly
    // and Telegram has no header tag.
    expect(markdownToTelegramHTML('### 1. Section')).toBe('<b>1. Section</b>')
    expect(markdownToTelegramHTML('# Title')).toBe('<b>Title</b>')
  })

  it('converts **bold** / *italic* / ~~strike~~', () => {
    expect(markdownToTelegramHTML('**bold** and *italic*')).toBe('<b>bold</b> and <i>italic</i>')
    expect(markdownToTelegramHTML('~~gone~~')).toBe('<s>gone</s>')
    expect(markdownToTelegramHTML('***both***')).toBe('<b><i>both</i></b>')
  })

  it('converts `*   ` bullet markers to • ', () => {
    // The real-world Telegram bug: the model emits `*   Votee AI: ...`
    // and Telegram renders the raw asterisk. `•` reads cleanly instead.
    const input = '*   Votee AI: a HK-based leader\n*   Huawei Cloud: infra provider'
    const expected = '• Votee AI: a HK-based leader\n• Huawei Cloud: infra provider'
    expect(markdownToTelegramHTML(input)).toBe(expected)
  })

  it('converts markdown links to <a href>, preserving safe schemes', () => {
    expect(markdownToTelegramHTML('[Google](https://google.com)'))
      .toBe('<a href="https://google.com">Google</a>')
    expect(markdownToTelegramHTML('[mail](mailto:a@b.com)'))
      .toBe('<a href="mailto:a@b.com">mail</a>')
  })

  it('degrades unsafe link schemes to plain text', () => {
    // `javascript:` must never reach Telegram's href parser.
    expect(markdownToTelegramHTML('[click](javascript:alert(1))'))
      .toBe('click (javascript:alert(1))')
  })

  it('escapes HTML in plain text and inside code', () => {
    expect(markdownToTelegramHTML('x < y & z > 0')).toBe('x &lt; y &amp; z &gt; 0')
    expect(markdownToTelegramHTML('`<b>raw</b>`')).toBe('<code>&lt;b&gt;raw&lt;/b&gt;</code>')
  })

  it('wraps fenced code blocks in <pre>', () => {
    const out = markdownToTelegramHTML('```ts\nconst x = 1\n```')
    expect(out).toBe('<pre><code class="language-ts">const x = 1</code></pre>')
  })

  it('converts > blockquotes', () => {
    expect(markdownToTelegramHTML('> quoted line\n> second line'))
      .toBe('<blockquote>quoted line\nsecond line</blockquote>\n')
  })

  it('converts tables to key-value blocks with bold labels', () => {
    const input = '| Model | Speed |\n|---|---|\n| A | fast |\n| B | slow |'
    const out = markdownToTelegramHTML(input)
    expect(out).toContain('<b>Model:</b> A')
    expect(out).toContain('<b>Speed:</b> fast')
    expect(out).toContain('<b>Model:</b> B')
  })

  it('converts the real Telegram failure case cleanly', () => {
    // Repro from the screenshot in the bug report: `###` + asterisk bullets +
    // bold headers. Pre-fix the user saw literal `###` and `*   ` in the chat.
    const input = [
      '### 1. Cantonese LLM & Enterprise Integration',
      '*   **Votee AI**: A HK-based leader.',
      '*   **Huawei Cloud**: Provides infra.',
    ].join('\n')
    const out = markdownToTelegramHTML(input)
    expect(out).toContain('<b>1. Cantonese LLM &amp; Enterprise Integration</b>')
    expect(out).toContain('• <b>Votee AI</b>: A HK-based leader.')
    expect(out).toContain('• <b>Huawei Cloud</b>: Provides infra.')
    expect(out).not.toContain('###')
    expect(out).not.toMatch(/^\*   /m)
  })
})

describe('[COMP:channels/telegram] stripMarkdown', () => {
  it('strips bold, italic, strike, links', () => {
    expect(stripMarkdown('**bold** and *italic* and ~~gone~~')).toBe('bold and italic and gone')
    expect(stripMarkdown('[click here](https://example.com)')).toBe('click here (https://example.com)')
  })

  it('strips headers and bullet markers as last-ditch fallback', () => {
    // Pre-fix, `stripMarkdown` only handled inline markers — so when the HTML
    // send failed the user saw raw `###` / `*   `. Guard against regression.
    expect(stripMarkdown('### Heading')).toBe('Heading')
    expect(stripMarkdown('*   item one\n*   item two')).toBe('• item one\n• item two')
  })
})

// ── Telegram adapter parsing ───────────────────────────────────

describe('[COMP:channels/telegram] createTelegramAdapter', () => {
  const onMessage = vi.fn()
  const adapter = createTelegramAdapter({
    token: 'test-token',
    botUsername: 'testbot',
    onMessage,
  })

  it('parses a DM text message', () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 42, first_name: 'Alice' },
        chat: { id: 42, type: 'private' },
        date: 1700000000,
        text: 'Hello bot',
      },
    }

    const msg = adapter.parseIncoming(update)
    expect(msg).not.toBeNull()
    expect(msg!.userId).toBe('42')
    expect(msg!.channelId).toBe('42')
    expect(msg!.text).toBe('Hello bot')
    expect(msg!.isGroupChat).toBe(false)
  })

  it('extracts dedup ID from update', () => {
    const update = { update_id: 123 }
    expect(adapter.deduplicateId(update)).toBe('123')
  })

  it('ignores group messages without mention', () => {
    const update = {
      update_id: 2,
      message: {
        message_id: 101,
        from: { id: 42, first_name: 'Alice' },
        chat: { id: -100, type: 'group' },
        date: 1700000000,
        text: 'Hello everyone',
      },
    }

    const msg = adapter.parseIncoming(update)
    expect(msg).toBeNull()
  })

  it('parses group messages with bot mention', () => {
    const update = {
      update_id: 3,
      message: {
        message_id: 102,
        from: { id: 42, first_name: 'Alice' },
        chat: { id: -100, type: 'supergroup' },
        date: 1700000000,
        text: '@testbot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
      },
    }

    const msg = adapter.parseIncoming(update)
    expect(msg).not.toBeNull()
    expect(msg!.text).toBe('what time is it?')
    expect(msg!.isGroupChat).toBe(true)
    expect(msg!.isMentioned).toBe(true)
  })

  it('parses photo messages', () => {
    const update = {
      update_id: 4,
      message: {
        message_id: 103,
        from: { id: 42, first_name: 'Alice' },
        chat: { id: 42, type: 'private' },
        date: 1700000000,
        caption: 'Check this out',
        photo: [
          { file_id: 'small_id' },
          { file_id: 'large_id' },
        ],
      },
    }

    const msg = adapter.parseIncoming(update)
    expect(msg).not.toBeNull()
    expect(msg!.text).toBe('Check this out')
    expect(msg!.mediaUrl).toBe('large_id')
    expect(msg!.mediaType).toBe('photo')
    // Telegram re-encodes all photos to JPEG — the adapter populates the hint
    // so the route can build an `image` content block without an extra round trip.
    expect(msg!.mediaMime).toBe('image/jpeg')
  })

  it('parses document messages with mime + filename hints', () => {
    const update = {
      update_id: 5,
      message: {
        message_id: 104,
        from: { id: 42, first_name: 'Alice' },
        chat: { id: 42, type: 'private' },
        date: 1700000000,
        document: {
          file_id: 'doc_id',
          mime_type: 'application/pdf',
          file_name: 'invoice.pdf',
        },
      },
    }

    const msg = adapter.parseIncoming(update)
    expect(msg).not.toBeNull()
    expect(msg!.mediaType).toBe('document')
    expect(msg!.mediaUrl).toBe('doc_id')
    expect(msg!.mediaMime).toBe('application/pdf')
    expect(msg!.mediaName).toBe('invoice.pdf')
  })

  it('drops group @mentions when botUsername is missing (regression for BYO bot silence)', () => {
    // Repro: BYO Telegram bot in a supergroup forum topic. The user writes
    // `@gm_bro_bot hello` which Telegram tags as a mention entity — but if
    // the adapter was constructed without a botUsername (e.g. a legacy
    // channel_integrations row predating migration 064), isBotMentioned()
    // short-circuits to false and the message is silently dropped.
    // See docs/architecture/channels/adapter-pattern.md → "Telegram group mentions".
    const unnamedAdapter = createTelegramAdapter({ token: 'test-token' })
    const update = {
      update_id: 99,
      message: {
        message_id: 999,
        from: { id: 42, first_name: 'Hinson' },
        chat: { id: -100, type: 'supergroup' },
        date: 1700000000,
        text: '@gm_bro_bot hello',
        entities: [{ type: 'mention', offset: 0, length: 11 }],
        message_thread_id: 2,
      },
    }
    expect(unnamedAdapter.parseIncoming(update)).toBeNull()
  })

  it('parses supergroup forum-topic @mentions when botUsername is set', () => {
    // Same update as above, now with botUsername present — the fix.
    const update = {
      update_id: 100,
      message: {
        message_id: 1000,
        from: { id: 42, first_name: 'Hinson' },
        chat: { id: -100, type: 'supergroup' },
        date: 1700000000,
        text: '@testbot hello',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        message_thread_id: 2,
      },
    }
    const msg = adapter.parseIncoming(update)
    expect(msg).not.toBeNull()
    expect(msg!.text).toBe('hello')
    expect(msg!.isGroupChat).toBe(true)
    expect(msg!.isMentioned).toBe(true)
  })

  it('downloadMedia resolves file_id to bytes + mime via getFile + downloadFile', async () => {
    // Two-step Telegram flow: getFile returns a file_path; downloadFile fetches
    // the bytes from a different host. Adapter stitches both calls together
    // and falls back to extension-derived mime when no hint is supplied.
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/getFile')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'photos/file_42.jpg' } }),
        } as unknown as Response
      }
      // Second call: downloadFile against the file host
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
      } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const downloader = createTelegramAdapter({ token: 'test-token' })
      const got = await downloader.downloadMedia('large_id')
      expect(got.buffer.length).toBe(3)
      expect(got.mime).toBe('image/jpeg')
      expect(got.name).toBe('file_42.jpg')
      // hint wins over extension inference
      const got2 = await downloader.downloadMedia('large_id', { mimeHint: 'image/png' })
      expect(got2.mime).toBe('image/png')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ignores service messages', () => {
    const update = {
      update_id: 5,
      message: {
        message_id: 104,
        from: { id: 42, first_name: 'Alice' },
        chat: { id: -100, type: 'group' },
        date: 1700000000,
        new_chat_members: [{ id: 99 }],
      },
    }

    const msg = adapter.parseIncoming(update)
    expect(msg).toBeNull()
  })
})

// ── Telegram adapter inline keyboards ─────────────────────────

describe('[COMP:channels/telegram] sendMessage actions', () => {
  function setupFetchMock() {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const mock = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      const parsed = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      // Infer method from URL suffix (sendMessage / editMessageText / etc).
      const method = typeof _url === 'string' ? _url.split('/').pop() ?? '' : ''
      calls.push({ method, body: parsed })
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      } as unknown as Response
    })
    return { calls, mock }
  }

  it('emits web_app inline-keyboard button for web_app actions', async () => {
    const { calls, mock } = setupFetchMock()
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      await adapter.sendMessage('42', {
        text: 'Welcome',
        actions: [{ kind: 'web_app', label: 'Sign in', url: 'https://app.example/tg-link' }],
      })

      const editCall = calls.find((c) => c.method === 'editMessageText')
      expect(editCall, 'button-bearing edit call').toBeDefined()
      const replyMarkup = editCall!.body.reply_markup as {
        inline_keyboard: Array<Array<Record<string, unknown>>>
      }
      expect(replyMarkup.inline_keyboard[0][0]).toEqual({
        text: 'Sign in',
        web_app: { url: 'https://app.example/tg-link' },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('emits callback_data inline-keyboard button for legacy actions without kind', async () => {
    const { calls, mock } = setupFetchMock()
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      await adapter.sendMessage('42', {
        text: 'Choose',
        actions: [{ id: 'yes', label: 'Yes', data: 'confirm:yes' }],
      })

      const editCall = calls.find((c) => c.method === 'editMessageText')
      expect(editCall).toBeDefined()
      const replyMarkup = editCall!.body.reply_markup as {
        inline_keyboard: Array<Array<Record<string, unknown>>>
      }
      expect(replyMarkup.inline_keyboard[0][0]).toEqual({
        text: 'Yes',
        callback_data: 'confirm:yes',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('puts each web_app action on its own row so descriptive labels do not truncate', async () => {
    const { calls, mock } = setupFetchMock()
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      await adapter.sendMessage('42', {
        text: 'Which service?',
        actions: [
          { kind: 'web_app', label: 'Google Calendar', url: 'https://a/1' },
          { kind: 'web_app', label: 'Gmail', url: 'https://a/2' },
          { kind: 'web_app', label: 'Notion', url: 'https://a/3' },
          { kind: 'web_app', label: 'Google Docs', url: 'https://a/4' },
          { kind: 'web_app', label: 'GitHub', url: 'https://a/5' },
        ],
      })

      const editCall = calls.find((c) => c.method === 'editMessageText')
      const replyMarkup = editCall!.body.reply_markup as {
        inline_keyboard: Array<Array<Record<string, unknown>>>
      }
      expect(replyMarkup.inline_keyboard).toHaveLength(5)
      for (const row of replyMarkup.inline_keyboard) expect(row).toHaveLength(1)
      expect(replyMarkup.inline_keyboard[0][0]).toEqual({
        text: 'Google Calendar',
        web_app: { url: 'https://a/1' },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps callback actions packed together on one row (Allow/Deny pattern)', async () => {
    const { calls, mock } = setupFetchMock()
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      await adapter.sendMessage('42', {
        text: 'Allow this action?',
        actions: [
          { id: 'allow', label: 'Allow', data: 'mcp_confirm:x:allow' },
          { id: 'deny', label: 'Deny', data: 'mcp_confirm:x:deny' },
        ],
      })

      const editCall = calls.find((c) => c.method === 'editMessageText')
      const replyMarkup = editCall!.body.reply_markup as {
        inline_keyboard: Array<Array<Record<string, unknown>>>
      }
      expect(replyMarkup.inline_keyboard).toHaveLength(1)
      expect(replyMarkup.inline_keyboard[0]).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ── Outbound documents ────────────────────────────────────────

describe('[COMP:channels/telegram] sendMessage documents', () => {
  type RecordedCall = { method: string; json?: Record<string, unknown>; form?: FormData }

  function setupFetchMock(failDocument = false) {
    const calls: RecordedCall[] = []
    const mock = vi.fn(async (_url: string, init?: { method?: string; body?: string | FormData }) => {
      const method = typeof _url === 'string' ? _url.split('/').pop() ?? '' : ''
      const call: RecordedCall = { method }
      if (init?.body instanceof FormData) {
        call.form = init.body
      } else if (typeof init?.body === 'string') {
        call.json = JSON.parse(init.body) as Record<string, unknown>
      }
      calls.push(call)
      if (method === 'sendDocument' && failDocument) {
        return {
          ok: true,
          json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: file too big' }),
        } as unknown as Response
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: method === 'sendDocument' ? 99 : 1 } }),
      } as unknown as Response
    })
    return { calls, mock }
  }

  it('delivers text first, then each document via sendDocument multipart', async () => {
    const { calls, mock } = setupFetchMock()
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      const messageId = await adapter.sendMessage('42', {
        text: 'Here is the report.',
        documents: [
          { filename: 'q1-recap.md', mime: 'text/markdown', data: new TextEncoder().encode('# Q1'), caption: 'Q1 recap' },
        ],
      })

      expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'sendDocument'])
      const docCall = calls[1]
      expect(docCall.form).toBeDefined()
      expect(docCall.form!.get('chat_id')).toBe('42')
      expect(docCall.form!.get('caption')).toBe('Q1 recap')
      const blob = docCall.form!.get('document') as File
      expect(blob.name).toBe('q1-recap.md')
      expect(blob.type).toBe('text/markdown')
      // The returned id anchors the channel-id round-trip — it must be the
      // TEXT message's id, not the document's.
      expect(messageId).toBe('1')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('sends a "Could not attach" notice instead of failing when a document errors', async () => {
    const { calls, mock } = setupFetchMock(true)
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      const messageId = await adapter.sendMessage('42', {
        text: 'Here is the report.',
        documents: [
          { filename: 'big.pdf', mime: 'application/pdf', data: new Uint8Array(8) },
        ],
      })

      // Text → failed sendDocument → plain-text notice. No throw.
      expect(messageId).toBe('1')
      const notice = calls.filter((c) => c.method === 'sendMessage').at(-1)
      expect(notice?.json?.text).toBe('Could not attach big.pdf.')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ── Telegram API retry on 429 ─────────────────────────────────

describe('[COMP:channels/telegram] api 429 retry', () => {
  function make429(retryAfter?: number) {
    return {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 0',
      parameters: retryAfter === undefined ? undefined : { retry_after: retryAfter },
    }
  }

  it('retries on 429 with retry_after=0 and eventually succeeds', async () => {
    let calls = 0
    const responses = [
      make429(0),
      make429(0),
      { ok: true, result: { message_id: 42 } },
    ]
    const mock = vi.fn(async () => {
      const body = responses[calls++]
      return { ok: true, json: async () => body } as unknown as Response
    })
    vi.stubGlobal('fetch', mock)
    try {
      const api = createTelegramApi({ token: 'test-token' })
      const result = await api.sendMessage('42', 'hi')
      expect(result).toEqual({ message_id: 42 })
      expect(calls).toBe(3)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('throws after exhausting retries on sustained 429', async () => {
    let calls = 0
    const mock = vi.fn(async () => {
      calls++
      return { ok: true, json: async () => make429(0) } as unknown as Response
    })
    vi.stubGlobal('fetch', mock)
    try {
      const api = createTelegramApi({ token: 'test-token' })
      await expect(api.sendMessage('42', 'hi')).rejects.toThrow(/Too Many Requests/)
      expect(calls).toBe(3) // MAX_RETRY_ATTEMPTS
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not retry on non-429 errors (so markdown fallback still fires)', async () => {
    let calls = 0
    const mock = vi.fn(async () => {
      calls++
      return {
        ok: true,
        json: async () => ({
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities",
        }),
      } as unknown as Response
    })
    vi.stubGlobal('fetch', mock)
    try {
      const api = createTelegramApi({ token: 'test-token' })
      await expect(api.sendMessage('42', 'hi', { parseMode: 'MarkdownV2' }))
        .rejects.toThrow(/can't parse entities/)
      expect(calls).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not retry sendChatAction (typing keepalive)', async () => {
    let calls = 0
    const mock = vi.fn(async () => {
      calls++
      return { ok: true, json: async () => make429(0) } as unknown as Response
    })
    vi.stubGlobal('fetch', mock)
    try {
      const api = createTelegramApi({ token: 'test-token' })
      await expect(api.sendChatAction('42', 'typing')).rejects.toThrow(/Too Many Requests/)
      expect(calls).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ── Chunked-reply truncation marker ───────────────────────────

describe('[COMP:channels/telegram] sendMessage truncation marker', () => {
  it('marks last successful chunk when a later chunk fails', async () => {
    // Build text that definitely splits into 2+ chunks (maxLength = 4000).
    const longText = 'a'.repeat(4000) + '\n\n' + 'b'.repeat(4000) + '\n\n' + 'c'.repeat(4000)
    const editCalls: Array<Record<string, unknown>> = []
    let sendCount = 0

    const mock = vi.fn(async (url: string, init?: { body?: string }) => {
      const method = url.split('/').pop() ?? ''
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      if (method === 'sendMessage') {
        sendCount++
        if (sendCount === 2) {
          // Second chunk fails permanently — not 429, so no retries.
          return {
            ok: true,
            json: async () => ({ ok: false, error_code: 400, description: 'Bad Request' }),
          } as unknown as Response
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 100 + sendCount } }),
        } as unknown as Response
      }
      if (method === 'editMessageText') {
        editCalls.push(body)
        return {
          ok: true,
          json: async () => ({ ok: true, result: true }),
        } as unknown as Response
      }
      return { ok: true, json: async () => ({ ok: true, result: true }) } as unknown as Response
    })

    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      await expect(adapter.sendMessage('42', { text: longText })).rejects.toThrow(/Bad Request/)

      // First chunk succeeded (message_id 101); second failed.
      // The truncation marker should be an edit on the first chunk's message.
      expect(editCalls.length).toBeGreaterThan(0)
      const truncationEdit = editCalls.find((c) =>
        typeof c.text === 'string' && (c.text as string).includes('cut off'),
      )
      expect(truncationEdit, 'truncation edit').toBeDefined()
      expect(truncationEdit!.message_id).toBe(101)
      // Plain edit — no parse_mode so arbitrary content is safe.
      expect(truncationEdit!.parse_mode).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not add marker when the first chunk itself fails', async () => {
    const longText = 'z'.repeat(50) // one chunk
    const editCalls: Array<Record<string, unknown>> = []

    const mock = vi.fn(async (url: string, init?: { body?: string }) => {
      const method = url.split('/').pop() ?? ''
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      if (method === 'sendMessage') {
        return {
          ok: true,
          json: async () => ({ ok: false, error_code: 400, description: 'Bad Request' }),
        } as unknown as Response
      }
      if (method === 'editMessageText') {
        editCalls.push(body)
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: true }),
      } as unknown as Response
    })

    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      await expect(adapter.sendMessage('42', { text: longText })).rejects.toThrow(/Bad Request/)
      // No prior chunk landed, so no truncation edit should have been attempted.
      expect(editCalls).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ── Forum-topic support ───────────────────────────────────────
//
// See docs/architecture/channels/adapter-pattern.md → "Telegram forum topics".

describe('[COMP:channels/telegram] parseTopicChannelId', () => {
  it('unpacks topic-qualified channel ids', () => {
    expect(parseTopicChannelId('-1001234567890:topic:42')).toEqual({
      chatId: '-1001234567890',
      messageThreadId: 42,
    })
  })

  it('returns bare chat id and undefined topic for plain channel ids', () => {
    expect(parseTopicChannelId('-1001234567890')).toEqual({
      chatId: '-1001234567890',
      messageThreadId: undefined,
    })
    expect(parseTopicChannelId('42')).toEqual({ chatId: '42', messageThreadId: undefined })
  })
})

describe('[COMP:channels/telegram] forum-topic inbound channelId', () => {
  it('embeds :topic:<id> in channelId when chat.is_forum is true', () => {
    const adapter = createTelegramAdapter({ token: 'test-token', botUsername: 'testbot' })
    const msg = adapter.parseIncoming({
      update_id: 201,
      message: {
        message_id: 500,
        from: { id: 42, first_name: 'Hinson' },
        chat: { id: -1001234567890, type: 'supergroup', is_forum: true },
        date: 1700000000,
        text: '@testbot hi',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        message_thread_id: 42,
      },
    })
    expect(msg).not.toBeNull()
    expect(msg!.channelId).toBe('-1001234567890:topic:42')
  })

  it('embeds :topic:1 for the General topic in a forum group (sessions stay uniform)', () => {
    const adapter = createTelegramAdapter({ token: 'test-token', botUsername: 'testbot' })
    const msg = adapter.parseIncoming({
      update_id: 202,
      message: {
        message_id: 501,
        from: { id: 42, first_name: 'Hinson' },
        chat: { id: -1001234567890, type: 'supergroup', is_forum: true },
        date: 1700000000,
        text: '@testbot hi',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        message_thread_id: 1,
      },
    })
    expect(msg).not.toBeNull()
    expect(msg!.channelId).toBe('-1001234567890:topic:1')
  })

  it('omits :topic: for forum groups when message_thread_id is missing (General, pinned-like messages)', () => {
    const adapter = createTelegramAdapter({ token: 'test-token', botUsername: 'testbot' })
    const msg = adapter.parseIncoming({
      update_id: 203,
      message: {
        message_id: 502,
        from: { id: 42, first_name: 'Hinson' },
        chat: { id: -1001234567890, type: 'supergroup', is_forum: true },
        date: 1700000000,
        text: '@testbot hi',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
      },
    })
    expect(msg).not.toBeNull()
    expect(msg!.channelId).toBe('-1001234567890')
  })

  it('uses bare channelId for non-forum supergroups even when message_thread_id is set (reply chains are not topics)', () => {
    const adapter = createTelegramAdapter({ token: 'test-token', botUsername: 'testbot' })
    const msg = adapter.parseIncoming({
      update_id: 204,
      message: {
        message_id: 503,
        from: { id: 42, first_name: 'Hinson' },
        chat: { id: -1001234567890, type: 'supergroup' }, // no is_forum
        date: 1700000000,
        text: '@testbot hi',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        message_thread_id: 7,
      },
    })
    expect(msg).not.toBeNull()
    expect(msg!.channelId).toBe('-1001234567890')
  })
})

describe('[COMP:channels/telegram] forum-topic outbound threading', () => {
  function setupSendCapture() {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const mock = vi.fn(async (url: string, init?: { body?: string }) => {
      const method = url.split('/').pop() ?? ''
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      calls.push({ method, body })
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      } as unknown as Response
    })
    return { calls, mock }
  }

  it('passes message_thread_id to Telegram sendMessage when channelId carries a topic', async () => {
    const { calls, mock } = setupSendCapture()
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      await adapter.sendMessage('-1001234567890:topic:42', { text: 'hello' })
      const send = calls.find((c) => c.method === 'sendMessage')
      expect(send).toBeDefined()
      expect(send!.body.chat_id).toBe('-1001234567890')
      expect(send!.body.message_thread_id).toBe(42)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('omits message_thread_id for the General topic (id=1) because Telegram rejects it', async () => {
    const { calls, mock } = setupSendCapture()
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      await adapter.sendMessage('-1001234567890:topic:1', { text: 'hello' })
      const send = calls.find((c) => c.method === 'sendMessage')
      expect(send).toBeDefined()
      expect(send!.body.chat_id).toBe('-1001234567890')
      expect(send!.body.message_thread_id).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('threads typing indicators into the topic', async () => {
    const { calls, mock } = setupSendCapture()
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      await adapter.sendTypingIndicator('-1001234567890:topic:42')
      const action = calls.find((c) => c.method === 'sendChatAction')
      expect(action).toBeDefined()
      expect(action!.body.chat_id).toBe('-1001234567890')
      expect(action!.body.message_thread_id).toBe(42)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('routes editMessage, deleteMessage, reactToMessage to the real chat id (no thread param)', async () => {
    const { calls, mock } = setupSendCapture()
    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      await adapter.editMessage('-1001234567890:topic:42', '555', { text: 'updated' })
      await adapter.reactToMessage!('-1001234567890:topic:42', '555', '👍')
      await adapter.deleteMessage!('-1001234567890:topic:42', '555')
      const edit = calls.find((c) => c.method === 'editMessageText')
      const react = calls.find((c) => c.method === 'setMessageReaction')
      const del = calls.find((c) => c.method === 'deleteMessage')
      expect(edit!.body.chat_id).toBe('-1001234567890')
      expect(edit!.body.message_thread_id).toBeUndefined()
      expect(react!.body.chat_id).toBe('-1001234567890')
      expect(react!.body.message_thread_id).toBeUndefined()
      expect(del!.body.chat_id).toBe('-1001234567890')
      expect(del!.body.message_thread_id).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retries once without message_thread_id when Telegram rejects with "message thread not found"', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    let sendAttempts = 0
    const mock = vi.fn(async (url: string, init?: { body?: string }) => {
      const method = url.split('/').pop() ?? ''
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      calls.push({ method, body })
      if (method === 'sendMessage') {
        sendAttempts++
        if (sendAttempts === 1) {
          return {
            ok: true,
            json: async () => ({
              ok: false,
              error_code: 400,
              description: 'Bad Request: message thread not found',
            }),
          } as unknown as Response
        }
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 777 } }),
        } as unknown as Response
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: true }),
      } as unknown as Response
    })

    vi.stubGlobal('fetch', mock)
    try {
      const adapter = createTelegramAdapter({ token: 'test-token' })
      const msgId = await adapter.sendMessage('-1001234567890:topic:9999', { text: 'hi' })
      expect(msgId).toBe('777')
      const sends = calls.filter((c) => c.method === 'sendMessage')
      expect(sends).toHaveLength(2)
      expect(sends[0].body.message_thread_id).toBe(9999)
      expect(sends[1].body.message_thread_id).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('[COMP:channels/telegram] isTelegramThreadNotFoundError', () => {
  it('matches the Telegram description for a missing topic', () => {
    const err = new TelegramApiError('sendMessage', 'Bad Request: message thread not found', 400)
    expect(isTelegramThreadNotFoundError(err)).toBe(true)
  })

  it('does not match unrelated errors', () => {
    const bad = new TelegramApiError('sendMessage', 'Bad Request: chat not found', 400)
    expect(isTelegramThreadNotFoundError(bad)).toBe(false)
    expect(isTelegramThreadNotFoundError(new Error('boom'))).toBe(false)
  })
})

describe('[COMP:channels/telegram] text-fragment buffering partitions by topic', () => {
  it('does not merge fragments posted in different topics of the same forum chat', async () => {
    vi.useFakeTimers()
    const delivered: string[] = []
    const onMessage = vi.fn((msg: { channelId: string; text: string }) => {
      delivered.push(`${msg.channelId}::${msg.text}`)
    })
    const adapter = createTelegramAdapter({ token: 'test-token', botUsername: 'testbot', onMessage })

    const longA = 'A'.repeat(4001)
    const longB = 'B'.repeat(4001)

    adapter.handleWebhook({
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 42, first_name: 'Hinson' },
        chat: { id: -100, type: 'supergroup', is_forum: true },
        date: 1700000000,
        text: '@testbot ' + longA,
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        message_thread_id: 42,
      },
    })
    adapter.handleWebhook({
      update_id: 2,
      message: {
        message_id: 101,
        from: { id: 42, first_name: 'Hinson' },
        chat: { id: -100, type: 'supergroup', is_forum: true },
        date: 1700000000,
        text: '@testbot ' + longB,
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        message_thread_id: 99,
      },
    })

    // Flush both fragment buffers by advancing the fragment gap timer.
    await vi.advanceTimersByTimeAsync(2000)

    expect(delivered.some((d) => d.startsWith('-100:topic:42::'))).toBe(true)
    expect(delivered.some((d) => d.startsWith('-100:topic:99::'))).toBe(true)
    // Topic 42's text must not appear in topic 99's delivery, and vice versa.
    const deliveredA = delivered.find((d) => d.startsWith('-100:topic:42::'))!
    const deliveredB = delivered.find((d) => d.startsWith('-100:topic:99::'))!
    expect(deliveredA).not.toContain('B'.repeat(100))
    expect(deliveredB).not.toContain('A'.repeat(100))

    vi.useRealTimers()
  })
})

// ── Group mention overrides + chat observation ─────────────────

describe('[COMP:channels/telegram] requireMention overrides', () => {
  function buildGroupMessage(params: {
    chatId: number
    isForum: boolean
    threadId?: number
    text: string
    mention?: boolean
  }): Record<string, unknown> {
    const text = params.mention ? `@testbot ${params.text}` : params.text
    return {
      update_id: params.chatId + (params.threadId ?? 0),
      message: {
        message_id: 1,
        from: { id: 42, first_name: 'U' },
        chat: {
          id: params.chatId,
          type: 'supergroup',
          title: 'Team Chat',
          is_forum: params.isForum,
        },
        date: Math.floor(Date.now() / 1000),
        text,
        ...(params.mention
          ? { entities: [{ type: 'mention', offset: 0, length: 8 }] }
          : {}),
        ...(params.threadId != null ? { message_thread_id: params.threadId } : {}),
      },
    }
  }

  it('drops un-mentioned messages with default requireMention=true', () => {
    const seen: Array<{ channelId: string }> = []
    const adapter = createTelegramAdapter({
      token: 'tok',
      botUsername: 'testbot',
      config: { requireMention: true },
      onMessage: (m) => { seen.push({ channelId: m.channelId }) },
    })
    adapter.handleWebhook(
      buildGroupMessage({ chatId: -100, isForum: false, text: 'hi' }),
    )
    expect(seen).toEqual([])
  })

  it('delivers un-mentioned messages when an override flips the default for a whole chat', () => {
    const seen: Array<{ channelId: string }> = []
    const adapter = createTelegramAdapter({
      token: 'tok',
      botUsername: 'testbot',
      config: {
        requireMention: {
          default: true,
          overrides: [{ chatId: '-100', topicId: null }],
        },
      },
      onMessage: (m) => { seen.push({ channelId: m.channelId }) },
    })
    adapter.handleWebhook(
      buildGroupMessage({ chatId: -100, isForum: false, text: 'hi' }),
    )
    expect(seen).toEqual([{ channelId: '-100' }])
  })

  it('applies topic-scoped overrides only to the listed topic', () => {
    const seen: Array<{ channelId: string }> = []
    const adapter = createTelegramAdapter({
      token: 'tok',
      botUsername: 'testbot',
      config: {
        requireMention: {
          default: true,
          overrides: [{ chatId: '-100', topicId: 42 }],
        },
      },
      onMessage: (m) => { seen.push({ channelId: m.channelId }) },
    })
    // Topic 42 — flipped, should deliver.
    adapter.handleWebhook(
      buildGroupMessage({ chatId: -100, isForum: true, threadId: 42, text: 'hi' }),
    )
    // Topic 99 — not flipped, should be dropped.
    adapter.handleWebhook(
      buildGroupMessage({ chatId: -100, isForum: true, threadId: 99, text: 'hi' }),
    )
    expect(seen).toEqual([{ channelId: '-100:topic:42' }])
  })

  it('supports both-direction overrides: default=false with a mention-required override', () => {
    const seen: Array<{ channelId: string }> = []
    const adapter = createTelegramAdapter({
      token: 'tok',
      botUsername: 'testbot',
      config: {
        requireMention: {
          default: false,
          overrides: [{ chatId: '-100', topicId: null }],
        },
      },
      onMessage: (m) => { seen.push({ channelId: m.channelId }) },
    })
    // Global default = false → un-mentioned message delivers.
    adapter.handleWebhook(
      buildGroupMessage({ chatId: -200, isForum: false, text: 'hi' }),
    )
    // Override on -100 flips to true → un-mentioned is dropped.
    adapter.handleWebhook(
      buildGroupMessage({ chatId: -100, isForum: false, text: 'hi' }),
    )
    expect(seen.map((s) => s.channelId)).toEqual(['-200'])
  })
})

describe('[COMP:channels/telegram] onChatSeen observation', () => {
  it('emits chatTitle and topic info for an inbound group message', () => {
    const events: Array<Record<string, unknown>> = []
    const adapter = createTelegramAdapter({
      token: 'tok',
      botUsername: 'testbot',
      config: { requireMention: false },
      onMessage: () => {},
      onChatSeen: (evt) => { events.push(evt as unknown as Record<string, unknown>) },
    })

    adapter.handleWebhook({
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 42, first_name: 'U' },
        chat: { id: -1001, type: 'supergroup', title: 'Eng', is_forum: true },
        date: Math.floor(Date.now() / 1000),
        text: 'hi',
        message_thread_id: 7,
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      chatId: '-1001',
      chatTitle: 'Eng',
      chatType: 'supergroup',
      isForum: true,
      topicId: 7,
      topicName: null,
    })
  })

  it('captures topic name from a forum_topic_edited service message', () => {
    const events: Array<Record<string, unknown>> = []
    const adapter = createTelegramAdapter({
      token: 'tok',
      botUsername: 'testbot',
      config: { requireMention: false },
      onMessage: () => {},
      onChatSeen: (evt) => { events.push(evt as unknown as Record<string, unknown>) },
    })

    adapter.handleWebhook({
      update_id: 2,
      message: {
        message_id: 11,
        from: { id: 42, first_name: 'U' },
        chat: { id: -1001, type: 'supergroup', title: 'Eng', is_forum: true },
        date: Math.floor(Date.now() / 1000),
        message_thread_id: 7,
        forum_topic_edited: { name: 'standups' },
      },
    })

    expect(events[0]).toMatchObject({ topicId: 7, topicName: 'standups' })
  })

  it('emits for my_chat_member in a group, with no topic', () => {
    const events: Array<Record<string, unknown>> = []
    const adapter = createTelegramAdapter({
      token: 'tok',
      botUsername: 'testbot',
      config: { requireMention: false },
      onMessage: () => {},
      onMyChatMember: () => {},
      onChatSeen: (evt) => { events.push(evt as unknown as Record<string, unknown>) },
    })

    adapter.handleWebhook({
      update_id: 3,
      my_chat_member: {
        chat: { id: -1002, type: 'supergroup', title: 'Ops' },
        from: { id: 42, first_name: 'U' },
        date: Math.floor(Date.now() / 1000),
        old_chat_member: { status: 'left', user: { id: 9, is_bot: true } },
        new_chat_member: { status: 'member', user: { id: 9, is_bot: true } },
      },
    })

    expect(events).toEqual([
      expect.objectContaining({ chatId: '-1002', chatTitle: 'Ops', topicId: null }),
    ])
  })

  it('does not emit for private chats', () => {
    const events: Array<unknown> = []
    const adapter = createTelegramAdapter({
      token: 'tok',
      botUsername: 'testbot',
      config: { requireMention: false },
      onMessage: () => {},
      onChatSeen: (evt) => events.push(evt),
    })

    adapter.handleWebhook({
      update_id: 4,
      message: {
        message_id: 12,
        from: { id: 42, first_name: 'U' },
        chat: { id: 42, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'hi',
      },
    })

    expect(events).toEqual([])
  })
})
