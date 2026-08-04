import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMailboxTools,
  singleMailboxRouter,
  stitchMailboxThreads,
  MAILBOX_DEFAULT_LIMIT,
  MAILBOX_MAX_LIMIT,
  MAILBOX_SNIPPET_CHARS,
  MAILBOX_ATTACHMENT_MAX_BYTES,
  MAX_MAILBOX_OUTGOING_ATTACHMENT_TOTAL_BYTES,
  type MailboxApi,
  type MailboxAccountRouter,
  type MailboxAttachmentDeps,
  type MailboxSearchHit,
} from '../base/mailbox.js'
import { MAX_EXTERNAL_DOCUMENT_BYTES } from '../../workspace-files/attachments.js'
import type { FilesApi } from '../../workspace-files/api.js'
import type { WorkspaceFile } from '../../workspace-files/types.js'
import type { Tool, ToolContext } from '../types.js'

const EMAIL = 'me@corp.com'

/** The one-mailbox common case — wrap an api as the primary account. */
function toolsFor(api: MailboxApi, opts?: { attachments?: MailboxAttachmentDeps }): Tool[] {
  return createMailboxTools(singleMailboxRouter(api, EMAIL), opts)
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
      attachments: [{ filename: 'q3.pdf', mime: 'application/pdf', size: 1024, partId: '2' }],
    })),
    getAttachment: vi.fn(async () => ({
      filename: 'q3.pdf',
      mime: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3, 4]),
    })),
    sendMessage: vi.fn(async () => ({ messageId: '<m1@corp.com>' })),
    ...overrides,
  }
}

/** Minimal workspace-file row — only the fields the tool reads back. */
function storedFile(over: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return {
    id: 'file-1',
    workspaceId: 'ws-1',
    path: '/uploads/email/2026-07-29T10-00-00-q3.pdf',
    name: 'q3.pdf',
    mime: 'application/pdf',
    sizeBytes: 4,
    sensitivity: 'internal',
    ...over,
  } as WorkspaceFile
}

function makeFilesApi(over: Partial<FilesApi> = {}): FilesApi {
  return {
    writeBytes: vi.fn(async () => ({ ok: true as const, value: storedFile() })),
    stat: vi.fn(async () => ({ ok: true as const, value: storedFile() })),
    readBytes: vi.fn(async () => ({
      ok: true as const,
      value: { file: storedFile(), bytes: new Uint8Array([1, 2, 3, 4]) },
    })),
    ...over,
  } as unknown as FilesApi
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
    const result = await send.execute({ to: ['x@y.z'], subject: 's', body: 'b' }, CONFIDENTIAL_CTX)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('confidential')
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it('passes inReplyTo through to the seam and returns the message id', async () => {
    const api = makeApi()
    const send = toolByName(toolsFor(api), 'imapSendMessage')
    const result = await send.execute(
      { to: ['x@y.z'], subject: 'Re: Deal', body: 'On it.', inReplyTo: 'INBOX:7' },
      CTX,
    )
    expect(result.isError).toBeFalsy()
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyTo: 'INBOX:7', to: ['x@y.z'] }),
    )
    expect(result.data).toEqual({ messageId: '<m1@corp.com>', from: EMAIL })
  })

  it('shows the resolved primary mailbox in the approval preview', async () => {
    const send = toolByName(toolsFor(makeApi()), 'imapSendMessage')
    expect(
      await send.describeConfirmation!(
        { to: ['client@example.com'], subject: 'Proposal', body: 'Attached.' },
        CTX,
      ),
    ).toEqual([
      `• From: ${EMAIL}`,
      '• To: client@example.com',
      '• Subject: Proposal',
      '• Body: Attached.',
    ])
  })

  it('forwards cc and bcc to the seam, omitting empty ones', async () => {
    const api = makeApi()
    const send = toolByName(toolsFor(api), 'imapSendMessage')
    await send.execute(
      { to: ['client@example.com'], cc: ['lead@corp.com'], bcc: ['audit@corp.com'], subject: 's', body: 'b' },
      CTX,
    )
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['client@example.com'],
        cc: ['lead@corp.com'],
        bcc: ['audit@corp.com'],
      }),
    )
    // A send with no cc/bcc must not pass empty arrays down (kept off the payload).
    await send.execute({ to: ['solo@example.com'], subject: 's', body: 'b' }, CTX)
    const lastCall = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
    expect(lastCall).not.toHaveProperty('cc')
    expect(lastCall).not.toHaveProperty('bcc')
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
    const result = await send.execute({ to: ['x@y.z'], subject: 's', body: 'b', account: 'other@corp.com' }, CTX)
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

  it('account-bound variants hide the router field and fix the sender identity', async () => {
    const api = makeApi()
    const tools = createMailboxTools(singleMailboxRouter(api, EMAIL), { boundAccountEmail: EMAIL })
    for (const tool of tools) {
      const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape
      expect(shape).not.toHaveProperty('account')
      expect(tool.description).toContain(`bound to ${EMAIL}`)
    }

    const send = toolByName(tools, 'imapSendMessage')
    const result = await send.execute({ to: ['x@y.z'], subject: 's', body: 'b' }, CTX)
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(result.data).toMatchObject({ from: EMAIL })
  })
})

describe('[COMP:tools/imap-attachments] imapSendMessage (workspace file → SMTP)', () => {
  it('resolves a workspace file to bytes and passes a real attachment across the seam', async () => {
    const api = makeApi()
    const filesApi = makeFilesApi()
    const send = toolByName(
      toolsFor(api, { attachments: { filesApi } }),
      'imapSendMessage',
    )

    const result = await send.execute(
      { to: ['client@example.com'], subject: 'Proposal', body: 'Attached.', attachments: ['file-1'] },
      CTX,
    )

    expect(filesApi.stat).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1' }), 'file-1')
    expect(filesApi.readBytes).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1' }), 'file-1')
    expect(api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{
        filename: 'q3.pdf',
        mime: 'application/pdf',
        data: new Uint8Array([1, 2, 3, 4]),
      }],
    }))
    expect(result.data).toEqual({
      messageId: '<m1@corp.com>',
      from: EMAIL,
      attached: ['q3.pdf'],
    })
  })

  it('fails honestly when workspace files are unavailable', async () => {
    const api = makeApi()
    const send = toolByName(toolsFor(api), 'imapSendMessage')
    const result = await send.execute(
      { to: ['client@example.com'], subject: 'Proposal', body: 'Attached.', attachments: ['file-1'] },
      CTX,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('not available in this context')
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses confidential files before reading bytes or sending', async () => {
    const api = makeApi()
    const filesApi = makeFilesApi({
      stat: vi.fn(async () => ({
        ok: true as const,
        value: storedFile({ path: '/hr/payroll.pdf', name: 'payroll.pdf', sensitivity: 'confidential' }),
      })),
    })
    const send = toolByName(toolsFor(api, { attachments: { filesApi } }), 'imapSendMessage')
    const result = await send.execute(
      { to: ['client@example.com'], subject: 'Proposal', body: 'Attached.', attachments: ['file-1'] },
      CTX,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('/hr/payroll.pdf is confidential')
    expect(filesApi.readBytes).not.toHaveBeenCalled()
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it('enforces the total-size cap before reading any attachment bytes', async () => {
    const api = makeApi()
    const first = storedFile({ id: 'file-1', sizeBytes: MAX_MAILBOX_OUTGOING_ATTACHMENT_TOTAL_BYTES })
    const second = storedFile({ id: 'file-2', path: '/uploads/two.pdf', name: 'two.pdf', sizeBytes: 1 })
    const filesApi = makeFilesApi({
      stat: vi.fn(async (_ctx: unknown, ref: string) => ({
        ok: true as const,
        value: ref === 'file-1' ? first : second,
      })),
    })
    const send = toolByName(toolsFor(api, { attachments: { filesApi } }), 'imapSendMessage')
    const result = await send.execute(
      {
        to: ['client@example.com'],
        subject: 'Proposal',
        body: 'Attached.',
        attachments: ['file-1', 'file-2'],
      },
      CTX,
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('over the 18 MB email limit')
    expect(filesApi.readBytes).not.toHaveBeenCalled()
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it('shows the resolved filename and size in the approval preview', async () => {
    const filesApi = makeFilesApi({
      stat: vi.fn(async () => ({ ok: true as const, value: storedFile({ sizeBytes: 2048 }) })),
    })
    const send = toolByName(
      toolsFor(makeApi(), { attachments: { filesApi } }),
      'imapSendMessage',
    )

    expect(await send.describeConfirmation!(
      { to: ['client@example.com'], subject: 'Proposal', body: 'Attached.', attachments: ['file-1'] },
      CTX,
    )).toEqual([
      `• From: ${EMAIL}`,
      '• To: client@example.com',
      '• Subject: Proposal',
      '• Body: Attached.',
      '• Attachment: q3.pdf (2 KB)',
    ])
  })
})

describe('[COMP:tools/imap-attachments] imapSaveAttachment (email bytes → workspace file)', () => {
  const ATTACH_CTX = {
    workspaceId: 'ws-1',
    userId: 'user-1',
    assistantId: 'asst-1',
  } as unknown as ToolContext

  function setup(over: { api?: MailboxApi; filesApi?: FilesApi } = {}) {
    const api = over.api ?? makeApi()
    const filesApi = over.filesApi ?? makeFilesApi()
    const enqueueIngest = vi.fn(async () => {})
    const tools = toolsFor(api, { attachments: { filesApi, enqueueIngest } })
    return { api, filesApi, enqueueIngest, tool: toolByName(tools, 'imapSaveAttachment') }
  }

  it('is not built at all when no workspace-file api is wired (never a tool that always errors)', () => {
    const names = toolsFor(makeApi()).map((t) => t.name)
    expect(names).not.toContain('imapSaveAttachment')
    expect(names).toContain('imapGetMessage')

    const { tool } = setup()
    expect(tool.name).toBe('imapSaveAttachment')
    // Read/allow, no confirmation (the syncMailboxNow precedent) — the write
    // lands inside the workspace; outbound delivery stays gated by sendFile.
    expect(tool.requiresConfirmation).toBeFalsy()
    expect(tool.requiresCapability).toBe('files')
    expect(tool.timeoutMs).toBe(60_000)
    // The description carries the chain — tool descriptions are the sanctioned
    // place for tool-name references (Layer 1 stays tool-agnostic).
    expect(tool.description).toContain('sendFile')
    expect(tool.description).toContain('imapGetMessage')
  })

  it('only advertises the save chain from imapGetMessage when attachments are wired', () => {
    const withoutFiles = toolByName(toolsFor(makeApi()), 'imapGetMessage')
    expect(withoutFiles.description).not.toContain('imapSaveAttachment')

    const { tool: _save } = setup()
    const withFiles = toolByName(
      toolsFor(makeApi(), { attachments: { filesApi: makeFilesApi() } }),
      'imapGetMessage',
    )
    expect(withFiles.description).toContain('imapSaveAttachment')
  })

  it('caps saves at the sendFile document limit so a successful save is always deliverable (D16)', () => {
    expect(MAILBOX_ATTACHMENT_MAX_BYTES).toBe(MAX_EXTERNAL_DOCUMENT_BYTES)
  })

  it('writes the bytes to /uploads/email as internal, enqueues ingest, and returns the file ref', async () => {
    const { api, filesApi, enqueueIngest, tool } = setup()
    const result = await tool.execute({ messageId: 'INBOX:7', partId: '2' }, ATTACH_CTX)

    expect(api.getAttachment).toHaveBeenCalledWith('INBOX:7', '2')
    const [ctx, params] = (filesApi.writeBytes as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(ctx).toMatchObject({ workspaceId: 'ws-1', userId: 'user-1', assistantId: 'asst-1' })
    expect(params.path).toMatch(/^\/uploads\/email\/.*q3\.pdf$/)
    expect(params.mime).toBe('application/pdf')
    expect(params.sensitivity).toBe('internal')
    expect(params.title).toBe('q3.pdf')
    expect(Array.from(params.bytes as Uint8Array)).toEqual([1, 2, 3, 4])

    expect(enqueueIngest).toHaveBeenCalledWith({
      fileId: 'file-1',
      workspaceId: 'ws-1',
      actingUserId: 'user-1',
      assistantId: 'asst-1',
    })
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({
      fileId: 'file-1',
      path: '/uploads/email/2026-07-29T10-00-00-q3.pdf',
      filename: 'q3.pdf',
      sizeBytes: 4,
    })
  })

  it('hands back a file id that resolves through FilesApi.stat, the shape sendFile needs', async () => {
    const { filesApi, tool } = setup()
    const result = await tool.execute({ messageId: 'INBOX:7', partId: '2' }, ATTACH_CTX)
    const { fileId } = result.data as { fileId: string }
    const stat = await filesApi.stat(
      { workspaceId: 'ws-1', userId: 'user-1' },
      fileId,
    )
    expect(stat.ok).toBe(true)
    expect(stat.ok && stat.value.id).toBe(fileId)
  })

  it('sanitises the stored filename and honors an explicit title', async () => {
    const api = makeApi({
      getAttachment: vi.fn(async () => ({
        filename: '../../etc/boarding pass?.pdf',
        mime: 'application/pdf',
        bytes: new Uint8Array([9]),
      })),
    })
    const { filesApi, tool } = setup({ api })
    await tool.execute({ messageId: 'INBOX:7', partId: '2', title: 'Boarding pass' }, ATTACH_CTX)
    const params = (filesApi.writeBytes as ReturnType<typeof vi.fn>).mock.calls[0][1]
    // Separators and shell-hostile characters are stripped, so the mail-supplied
    // name collapses to ONE leaf segment under /uploads/email — no traversal,
    // whatever the sender called the file. (Dots survive inside the leaf; the
    // stamp prefix means the leaf can never itself be "." or "..".)
    expect(params.path).toMatch(/^\/uploads\/email\/[^/]+$/)
    expect(params.path).not.toContain('?')
    expect(params.path.split('/').pop()).not.toBe('..')
    expect(params.title).toBe('Boarding pass')
  })

  it('refuses without a workspace, before touching the mailbox', async () => {
    const { api, tool } = setup()
    const result = await tool.execute({ messageId: 'INBOX:7', partId: '2' }, { userId: 'user-1' } as unknown as ToolContext)
    expect(result.isError).toBe(true)
    expect(api.getAttachment).not.toHaveBeenCalled()
  })

  it('surfaces a stale-ref seam error verbatim so the model re-searches', async () => {
    const api = makeApi({
      getAttachment: vi.fn(async () => {
        throw new Error('Message INBOX:7 is no longer in the mailbox (it may have been moved or deleted). Run imapSearchMessages again to get a current message id.')
      }),
    })
    const { filesApi, tool } = setup({ api })
    const result = await tool.execute({ messageId: 'INBOX:7', partId: '2' }, ATTACH_CTX)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('imapSearchMessages')
    expect(filesApi.writeBytes).not.toHaveBeenCalled()
  })

  it('names the storage limit when the workspace quota refuses the write', async () => {
    const filesApi = makeFilesApi({
      writeBytes: vi.fn(async () => ({
        ok: false as const,
        error: { kind: 'quota_exceeded' as const, currentBytes: 10, limitBytes: 20, attemptedBytes: 30 },
      })),
    })
    const { tool } = setup({ filesApi })
    const result = await tool.execute({ messageId: 'INBOX:7', partId: '2' }, ATTACH_CTX)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('quota')
  })

  it('still returns the saved file when the ingest enqueue fails (best-effort indexing)', async () => {
    const filesApi = makeFilesApi()
    const tools = toolsFor(makeApi(), {
      attachments: { filesApi, enqueueIngest: async () => { throw new Error('queue down') } },
    })
    const result = await toolByName(tools, 'imapSaveAttachment').execute(
      { messageId: 'INBOX:7', partId: '2' },
      ATTACH_CTX,
    )
    expect(result.isError).toBeFalsy()
    expect((result.data as { fileId: string }).fileId).toBe('file-1')
  })

  it('routes to the named account like every other mailbox tool', async () => {
    const primary = makeApi()
    const other = makeApi({
      getAttachment: vi.fn(async () => ({ filename: 'o.pdf', mime: 'application/pdf', bytes: new Uint8Array([7]) })),
    })
    const bound = [
      { email: 'me@corp.com', isPrimary: true, api: primary },
      { email: 'other@corp.com', isPrimary: false, api: other },
    ]
    const router: MailboxAccountRouter = {
      list: () => bound.map(({ email, isPrimary }) => ({ email, isPrimary })),
      get: (email) => bound.find((b) => b.email.toLowerCase() === email.trim().toLowerCase())?.api,
    }
    const tools = createMailboxTools(router, { attachments: { filesApi: makeFilesApi() } })
    await toolByName(tools, 'imapSaveAttachment').execute(
      { messageId: 'INBOX:7', partId: '2', account: 'other@corp.com' },
      ATTACH_CTX,
    )
    expect(other.getAttachment).toHaveBeenCalledTimes(1)
    expect(primary.getAttachment).not.toHaveBeenCalled()
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
