import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMailboxTools,
  singleMailboxRouter,
  stitchMailboxThreads,
  MAILBOX_DEFAULT_LIMIT,
  MAILBOX_MAX_LIMIT,
  MAILBOX_SNIPPET_CHARS,
  type MailboxApi,
  type MailboxAccountRouter,
  type MailboxSearchHit,
} from '../base/mailbox.js'
import type { Tool, ToolContext } from '../types.js'

const EMAIL = 'me@corp.com'

/** The one-mailbox common case — wrap an api as the primary account. */
function toolsFor(api: MailboxApi): Tool[] {
  return createMailboxTools(singleMailboxRouter(api, EMAIL))
}

function hit(overrides: Partial<MailboxSearchHit> = {}): MailboxSearchHit {
  return {
    id: 'INBOX:1',
    folder: 'INBOX',
    from: 'Ada <ada@acme.com>',
    date: '2026-07-20T10:00:00.000Z',
    subject: 'Q3 numbers',
    ...overrides,
  }
}

function makeApi(overrides: Partial<MailboxApi> = {}): MailboxApi {
  return {
    searchMessages: vi.fn(async () => ({ hits: [hit()] })),
    getMessage: vi.fn(async () => ({
      id: 'INBOX:1',
      folder: 'INBOX',
      from: 'Ada <ada@acme.com>',
      to: ['me@corp.com'],
      date: '2026-07-20T10:00:00.000Z',
      subject: 'Q3 numbers',
      body: 'The numbers are up.',
      attachments: [{ filename: 'q3.pdf', mime: 'application/pdf', size: 1024 }],
    })),
    sendMessage: vi.fn(async () => ({ messageId: '<m1@corp.com>' })),
    ...overrides,
  }
}

function toolByName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

const CTX = { workspaceId: 'ws-1' } as unknown as ToolContext
const CONFIDENTIAL_CTX = {
  workspaceId: 'ws-1',
  sensitivity: { max: 'confidential' },
} as unknown as ToolContext

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:tools/mailbox-imap] Company mailbox tools', () => {
  it('declares the identity lane: sends as the user\'s corporate address, ask-gated, never a silent substitute', () => {
    const tools = toolsFor(makeApi())
    const send = toolByName(tools, 'imapSendMessage')
    expect(send.description).toContain('company mailbox')
    expect(send.description).toMatch(/never silently substitute/i)
    expect(send.requiresConfirmation).toBe(true)
    expect(send.isReadOnly).toBe(false)

    const search = toolByName(tools, 'imapSearchMessages')
    expect(search.isReadOnly).toBe(true)
    expect(search.requiresConfirmation).toBeFalsy()
    // D12 #3 — the description must say sent mail is in the default scope.
    expect(search.description).toMatch(/INBOX and Sent/i)

    const get = toolByName(tools, 'imapGetMessage')
    expect(get.isReadOnly).toBe(true)
  })

  it('applies the 90-day default window and default result cap (D12 #4)', async () => {
    const api = makeApi()
    const search = toolByName(toolsFor(api), 'imapSearchMessages')
    await search.execute({ keywords: ['invoice'] }, CTX)
    const params = (api.searchMessages as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(params.limit).toBe(MAILBOX_DEFAULT_LIMIT)
    expect(params.folder).toBeUndefined()  // impl default = INBOX + Sent
    const since = new Date(`${params.since}T00:00:00Z`).getTime()
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000
    expect(Math.abs(since - ninetyDaysAgo)).toBeLessThan(2 * 24 * 60 * 60 * 1000)
  })

  it('honors explicit since/folder and hard-caps maxResults', async () => {
    const api = makeApi()
    const search = toolByName(toolsFor(api), 'imapSearchMessages')
    await search.execute(
      { keywords: ['契約'], folder: 'Archive', since: '2024-01-01', maxResults: MAILBOX_MAX_LIMIT },
      CTX,
    )
    const params = (api.searchMessages as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(params.folder).toBe('Archive')
    expect(params.since).toBe('2024-01-01')
    expect(params.limit).toBe(MAILBOX_MAX_LIMIT)
  })

  it('truncates snippets and enforces the result cap on what the api returned', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      hit({ id: `INBOX:${i + 1}`, subject: `msg ${i}`, snippet: 'x'.repeat(500), date: `2026-07-${(i % 28) + 1}T00:00:00.000Z` }),
    )
    const api = makeApi({ searchMessages: vi.fn(async () => ({ hits: many })) })
    const search = toolByName(toolsFor(api), 'imapSearchMessages')
    const result = await search.execute({ maxResults: 5 }, CTX)
    const data = result.data as { threads: Array<{ messages: Array<{ snippet?: string }> }> }
    const messages = data.threads.flatMap((t) => t.messages)
    expect(messages.length).toBeLessThanOrEqual(5)
    for (const m of messages) {
      expect((m.snippet ?? '').length).toBeLessThanOrEqual(MAILBOX_SNIPPET_CHARS + 1)
    }
  })

  it('groups results into threads and surfaces the impl degradation note', async () => {
    const api = makeApi({
      searchMessages: vi.fn(async () => ({
        hits: [
          hit({ id: 'INBOX:1', messageId: '<a@x>', subject: 'Deal' }),
          hit({ id: 'INBOX:2', messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], subject: 'Re: Deal', date: '2026-07-21T10:00:00.000Z' }),
          hit({ id: 'INBOX:3', messageId: '<c@x>', subject: 'Unrelated' }),
        ],
        note: 'degraded',
      })),
    })
    const search = toolByName(toolsFor(api), 'imapSearchMessages')
    const result = await search.execute({}, CTX)
    const data = result.data as { threads: Array<{ messages: unknown[] }>; note?: string }
    expect(data.threads).toHaveLength(2)
    expect(data.threads[0].messages).toHaveLength(2)  // newest thread first
    expect(data.note).toBe('degraded')
  })

  it('refuses send on a confidential turn (egress gate) without touching the network', async () => {
    const api = makeApi()
    const send = toolByName(toolsFor(api), 'imapSendMessage')
    const result = await send.execute({ to: 'x@y.z', subject: 's', body: 'b' }, CONFIDENTIAL_CTX)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('confidential')
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it('passes inReplyTo through to the seam and returns the message id', async () => {
    const api = makeApi()
    const send = toolByName(toolsFor(api), 'imapSendMessage')
    const result = await send.execute(
      { to: 'x@y.z', subject: 'Re: Deal', body: 'On it.', inReplyTo: 'INBOX:7' },
      CTX,
    )
    expect(result.isError).toBeFalsy()
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyTo: 'INBOX:7', to: 'x@y.z' }),
    )
    expect(result.data).toEqual({ messageId: '<m1@corp.com>', from: EMAIL })
  })

  it('surfaces seam errors honestly', async () => {
    const api = makeApi({ getMessage: vi.fn(async () => { throw new Error('Message INBOX:9 not found.') }) })
    const get = toolByName(toolsFor(api), 'imapGetMessage')
    const result = await get.execute({ messageId: 'INBOX:9' }, CTX)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('not found')
  })
})

describe('[COMP:tools/mailbox-imap] Multi-account routing (account param, default primary)', () => {
  /** Two connected mailboxes: `me@corp.com` (primary) and `other@corp.com`. */
  function multiRouter(): { router: MailboxAccountRouter; primary: MailboxApi; other: MailboxApi } {
    const primary = makeApi({ sendMessage: vi.fn(async () => ({ messageId: '<primary@corp.com>' })) })
    const other = makeApi({ sendMessage: vi.fn(async () => ({ messageId: '<other@corp.com>' })) })
    const bound = [
      { email: 'me@corp.com', isPrimary: true, api: primary },
      { email: 'other@corp.com', isPrimary: false, api: other },
    ]
    const router: MailboxAccountRouter = {
      list: () => bound.map(({ email, isPrimary }) => ({ email, isPrimary })),
      get: (email) => bound.find((b) => b.email.toLowerCase() === email.trim().toLowerCase())?.api,
    }
    return { router, primary, other }
  }

  it('routes to the primary mailbox when `account` is omitted', async () => {
    const { router, primary, other } = multiRouter()
    const search = toolByName(createMailboxTools(router), 'imapSearchMessages')
    await search.execute({ keywords: ['x'] }, CTX)
    expect(primary.searchMessages).toHaveBeenCalledTimes(1)
    expect(other.searchMessages).not.toHaveBeenCalled()
  })

  it('routes to the named `account` and reports it as the sender', async () => {
    const { router, primary, other } = multiRouter()
    const send = toolByName(createMailboxTools(router), 'imapSendMessage')
    const result = await send.execute({ to: 'x@y.z', subject: 's', body: 'b', account: 'other@corp.com' }, CTX)
    expect(other.sendMessage).toHaveBeenCalledTimes(1)
    expect(primary.sendMessage).not.toHaveBeenCalled()
    expect(result.data).toEqual({ messageId: '<other@corp.com>', from: 'other@corp.com' })
  })

  it('matches `account` case-insensitively', async () => {
    const { router, other } = multiRouter()
    const get = toolByName(createMailboxTools(router), 'imapGetMessage')
    await get.execute({ messageId: 'INBOX:1', account: 'OTHER@CORP.COM' }, CTX)
    expect(other.getMessage).toHaveBeenCalledTimes(1)
  })

  it('errors with the connected list when `account` matches no mailbox (no network call)', async () => {
    const { router, primary, other } = multiRouter()
    const search = toolByName(createMailboxTools(router), 'imapSearchMessages')
    const result = await search.execute({ keywords: ['x'], account: 'ghost@corp.com' }, CTX)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('me@corp.com')
    expect(result.data).toContain('other@corp.com')
    expect(primary.searchMessages).not.toHaveBeenCalled()
    expect(other.searchMessages).not.toHaveBeenCalled()
  })

  it('errors when no mailbox is connected at all', async () => {
    const empty: MailboxAccountRouter = { list: () => [], get: () => undefined }
    const search = toolByName(createMailboxTools(empty), 'imapSearchMessages')
    const result = await search.execute({ keywords: ['x'] }, CTX)
    expect(result.isError).toBe(true)
    expect(result.data).toMatch(/no company mailbox/i)
  })
})

describe('[COMP:tools/mailbox-imap] Thread stitching (client-side, no server THREAD extension)', () => {
  it('links messages via References/In-Reply-To chains', () => {
    const threads = stitchMailboxThreads([
      hit({ id: 'INBOX:1', messageId: '<root@x>', subject: 'Plan', date: '2026-07-01T00:00:00.000Z' }),
      hit({ id: 'Sent:9', messageId: '<r1@x>', references: ['<root@x>'], subject: 'Re: Plan', date: '2026-07-02T00:00:00.000Z' }),
      hit({ id: 'INBOX:2', messageId: '<r2@x>', inReplyTo: '<r1@x>', references: ['<root@x>', '<r1@x>'], subject: 'Re: Plan', date: '2026-07-03T00:00:00.000Z' }),
    ])
    expect(threads).toHaveLength(1)
    expect(threads[0].messages.map((m) => m.id)).toEqual(['INBOX:1', 'Sent:9', 'INBOX:2'])
    expect(threads[0].lastDate).toBe('2026-07-03T00:00:00.000Z')
  })

  it('falls back to normalized-subject grouping when no reference headers exist', () => {
    const threads = stitchMailboxThreads([
      hit({ id: 'INBOX:1', subject: 'Invoice 42', date: '2026-07-01T00:00:00.000Z' }),
      hit({ id: 'INBOX:2', subject: 'Re: Invoice 42', date: '2026-07-02T00:00:00.000Z' }),
      hit({ id: 'INBOX:3', subject: '回复: Invoice 42', date: '2026-07-03T00:00:00.000Z' }),
      hit({ id: 'INBOX:4', subject: 'Other topic', date: '2026-07-04T00:00:00.000Z' }),
    ])
    expect(threads).toHaveLength(2)
    const invoice = threads.find((t) => t.messages.length === 3)
    expect(invoice).toBeDefined()
  })

  it('orders threads newest-first and messages oldest-first', () => {
    const threads = stitchMailboxThreads([
      hit({ id: 'INBOX:1', subject: 'Old', date: '2026-06-01T00:00:00.000Z' }),
      hit({ id: 'INBOX:2', subject: 'New', date: '2026-07-20T00:00:00.000Z' }),
    ])
    expect(threads[0].subject).toBe('New')
    expect(threads[1].subject).toBe('Old')
  })
})
