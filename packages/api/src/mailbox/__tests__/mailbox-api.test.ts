import { describe, it, expect, vi } from 'vitest'
import { MAILBOX_ATTACHMENT_MAX_BYTES } from '@use-brian/core'
import {
  createMailboxApi,
  resolveSenderAddress,
  parseMessageRef,
  parseReferencesHeader,
  htmlToText,
  collectAttachmentParts,
  findPartNode,
} from '../mailbox-api.js'
import {
  createMailboxSessionCache,
  type ImapBodyStructureNode,
  type ImapClientLike,
  type ImapFetchedMessage,
} from '../imap-session.js'
import type { MailboxAccountSettings } from '../types.js'

const SETTINGS: MailboxAccountSettings = {
  email: 'me@corp.com',
  appPassword: 'p',
  imapHost: 'imap.corp.com',
  imapPort: 993,
  smtpHost: 'smtp.corp.com',
  smtpPort: 465,
}

type FakePart = {
  /** Chunks `download()` streams, in order. */
  chunks: Buffer[]
  meta?: { contentType?: string; filename?: string }
}

type FakeFolder = {
  /** UIDs the server search returns for this folder (any criteria). */
  uids: number[]
  messages: Record<number, ImapFetchedMessage>
  /** When set, the FIRST search with keyword criteria throws (BADCHARSET). */
  rejectKeywordSearch?: boolean
  /** AliMail failure shape: selective string criteria succeed with no UIDs. */
  emptyKeywordSearch?: boolean
  /** Downloadable body parts, keyed `${uid}:${partId}`. */
  parts?: Record<string, FakePart>
  specialUse?: string
  flags?: Set<string>
  lockError?: string
}

function rfc822(body: string, headers: Record<string, string>): Buffer {
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
  return Buffer.from(`${head}\r\n\r\n${body}`, 'utf8')
}

function makeFakeClient(folders: Record<string, FakeFolder>, opts?: { specialUseSent?: string }) {
  const searches: Array<{ folder: string; query: Record<string, unknown> }> = []
  const appends: Array<{ path: string; content: Buffer }> = []
  const fetchOnes: Array<{ folder: string; id: string; query: Record<string, unknown> }> = []
  const downloads: Array<{ folder: string; range: string; part: string }> = []
  let destroyed = false
  let openFolder = ''
  const client = {
    usable: true,
    async connect() {},
    async logout() {},
    close() {},
    async list() {
      return Object.entries(folders).map(([path, folder]) => ({
        path,
        ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
        ...(opts?.specialUseSent === path ? { specialUse: '\\Sent' } : {}),
        ...(folder.flags ? { flags: folder.flags } : {}),
      }))
    },
    async getMailboxLock(path: string) {
      if (!folders[path]) throw new Error(`no such folder ${path}`)
      if (folders[path].lockError) throw new Error(folders[path].lockError)
      openFolder = path
      return { release() {} }
    },
    async search(query: Record<string, unknown>) {
      const folder = folders[openFolder]
      searches.push({ folder: openFolder, query })
      const hasKeywordCriteria = 'text' in query || 'or' in query || 'from' in query || 'subject' in query
      if (folder.rejectKeywordSearch && hasKeywordCriteria) {
        throw new Error('NO [BADCHARSET (US-ASCII)] SEARCH failed')
      }
      if (folder.emptyKeywordSearch && hasKeywordCriteria) return []
      return [...folder.uids]
    },
    fetch(range: string) {
      const folder = folders[openFolder]
      const uids = range.split(',').map(Number)
      return (async function* () {
        for (const uid of uids) {
          if (folder.messages[uid]) yield folder.messages[uid]
        }
      })()
    },
    async fetchOne(id: string, query: Record<string, unknown>) {
      const folder = folders[openFolder]
      fetchOnes.push({ folder: openFolder, id, query })
      return folder.messages[Number(id)] ?? false
    },
    async status() {
      return { path: openFolder }
    },
    async append(path: string, content: Buffer) {
      appends.push({ path, content })
      return {}
    },
    async download(range: string, part: string) {
      const folder = folders[openFolder]
      downloads.push({ folder: openFolder, range, part })
      const payload = folder.parts?.[`${range}:${part}`]
      if (!payload) throw new Error(`no such part ${part}`)
      return {
        meta: payload.meta ?? {},
        content: Object.assign(
          (async function* () {
            for (const chunk of payload.chunks) yield chunk
          })(),
          { destroy: () => { destroyed = true } },
        ),
      }
    },
  } as unknown as ImapClientLike
  return { client, searches, appends, fetchOnes, downloads, wasDestroyed: () => destroyed }
}

function msg(uid: number, over: Partial<ImapFetchedMessage['envelope']> = {}, source?: Buffer): ImapFetchedMessage {
  return {
    uid,
    envelope: {
      date: new Date(`2026-07-${String((uid % 27) + 1).padStart(2, '0')}T10:00:00Z`),
      subject: `msg ${uid}`,
      messageId: `<m${uid}@x>`,
      from: [{ name: 'Ada', address: 'ada@acme.com' }],
      to: [{ address: 'me@corp.com' }],
      ...over,
    },
    ...(source ? { source } : {}),
  }
}

function makeApi(
  client: ImapClientLike,
  over: {
    sendComposed?: ReturnType<typeof vi.fn>
    saveSentCopy?: boolean
    settings?: MailboxAccountSettings
    sendAsAliases?: string[]
    knownFolderPaths?: string[]
    searchArchivedMessages?: ReturnType<typeof vi.fn>
  } = {},
) {
  const sessions = createMailboxSessionCache({ createClient: () => client })
  return createMailboxApi({
    cacheKey: 'inst-1',
    getSettings: async () => over.settings ?? SETTINGS,
    sessions,
    sendComposed: (over.sendComposed ?? vi.fn(async () => {})) as never,
    ...(over.saveSentCopy !== undefined ? { saveSentCopy: over.saveSentCopy } : {}),
    ...(over.sendAsAliases ? { getSendAsAliases: async () => over.sendAsAliases! } : {}),
    ...(over.knownFolderPaths ? { getKnownFolderPaths: async () => over.knownFolderPaths! } : {}),
    ...(over.searchArchivedMessages ? { searchArchivedMessages: over.searchArchivedMessages } : {}),
  })
}

const BASE_PARAMS = { since: '2026-01-01', limit: 20 }

describe('[COMP:api/mailbox-imap-client] searchMessages folder scope', () => {
  it('searches INBOX, Sent, and regular custom folders by default (D12 #3)', async () => {
    const { client, searches } = makeFakeClient(
      {
        INBOX: { uids: [1], messages: { 1: msg(1) } },
        'Sent Messages': { uids: [2], messages: { 2: msg(2, { subject: 'my reply' }) } },
        'Client correspondence': { uids: [3], messages: { 3: msg(3, { subject: 'moved by rule' }) } },
      },
      { specialUseSent: 'Sent Messages' },
    )
    const api = makeApi(client)
    const { hits } = await api.searchMessages({ ...BASE_PARAMS, keywords: ['reply'] })
    const searchedFolders = [...new Set(searches.map((s) => s.folder))]
    expect(searchedFolders).toEqual(['INBOX', 'Sent Messages', 'Client correspondence'])
    expect(hits.map((h) => h.folder)).toEqual(expect.arrayContaining([
      'INBOX',
      'Sent Messages',
      'Client correspondence',
    ]))
  })

  it('searches a cursor/archive-known custom folder omitted from a truncated LIST response', async () => {
    const fake = makeFakeClient({
      INBOX: { uids: [1], messages: { 1: msg(1) } },
      'Client correspondence': { uids: [2], messages: { 2: msg(2) } },
    })
    ;(fake.client as { list: ImapClientLike['list'] }).list = async () => [{ path: 'INBOX' }]
    const result = await makeApi(fake.client, {
      knownFolderPaths: ['INBOX', 'Client correspondence'],
    }).searchMessages({ ...BASE_PARAMS })

    expect([...new Set(fake.searches.map((search) => search.folder))]).toEqual([
      'INBOX',
      'Client correspondence',
    ])
    expect(result.hits.map((hit) => hit.folder)).toEqual(expect.arrayContaining([
      'INBOX',
      'Client correspondence',
    ]))
  })

  it('excludes Junk, Trash, Drafts, All Mail, and non-selectable containers from the default scope', async () => {
    const { client, searches } = makeFakeClient({
      INBOX: { uids: [1], messages: { 1: msg(1) } },
      Archive: { uids: [], messages: {} },
      Junk: { uids: [], messages: {}, specialUse: '\\Junk' },
      Trash: { uids: [], messages: {}, specialUse: '\\Trash' },
      Drafts: { uids: [], messages: {}, specialUse: '\\Drafts' },
      'All Mail': { uids: [], messages: {}, specialUse: '\\All' },
      Container: { uids: [], messages: {}, flags: new Set(['\\Noselect']) },
    })
    const api = makeApi(client)
    await api.searchMessages({ ...BASE_PARAMS })
    expect([...new Set(searches.map((s) => s.folder))]).toEqual(['INBOX', 'Archive'])
  })

  it('searches only the explicit folder when one is given', async () => {
    const explicit = makeFakeClient({ INBOX: { uids: [], messages: {} }, Archive: { uids: [3], messages: { 3: msg(3) } } })
    await makeApi(explicit.client).searchMessages({ ...BASE_PARAMS, folder: 'Archive' })
    expect([...new Set(explicit.searches.map((s) => s.folder))]).toEqual(['Archive'])
  })

  it('returns healthy-folder results with an honest note when one default folder fails', async () => {
    const { client } = makeFakeClient({
      INBOX: { uids: [1], messages: { 1: msg(1) } },
      'Broken custom folder': { uids: [], messages: {}, lockError: 'cannot select folder' },
    })
    const result = await makeApi(client).searchMessages({ ...BASE_PARAMS })
    expect(result.hits.map((hit) => hit.folder)).toEqual(['INBOX'])
    expect(result.note).toMatch(/1 mailbox folder.*incomplete/i)
  })

  it('throws when every default folder fails instead of returning a false empty result', async () => {
    const { client } = makeFakeClient({
      INBOX: { uids: [], messages: {}, lockError: 'server unavailable' },
    })
    await expect(makeApi(client).searchMessages({ ...BASE_PARAMS })).rejects.toThrow('server unavailable')
  })

  it('caps per-folder fetches to the limit (an unindexed scan cannot flood the turn)', async () => {
    const uids = Array.from({ length: 300 }, (_, i) => i + 1)
    const messages = Object.fromEntries(uids.map((u) => [u, msg(u)]))
    const { client } = makeFakeClient({ INBOX: { uids, messages } })
    const api = makeApi(client)
    const { hits } = await api.searchMessages({ since: '2026-01-01', limit: 10 })
    expect(hits).toHaveLength(10)
  })
})

describe('[COMP:api/mailbox-imap-client] BADCHARSET degradation (§4 empirical fallback)', () => {
  it('falls back to a date-bounded header scan filtered client-side, with an honest note', async () => {
    const messages = {
      1: msg(1, { subject: '合同草稿', from: [{ name: '陈小姐', address: 'chen@client.cn' }] }),
      2: msg(2, { subject: 'Weekly digest' }),
    }
    const { client, searches } = makeFakeClient({
      INBOX: { uids: [1, 2], messages, rejectKeywordSearch: true },
    })
    const api = makeApi(client)
    const result = await api.searchMessages({ ...BASE_PARAMS, folder: 'INBOX', keywords: ['合同'] })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].subject).toBe('合同草稿')
    expect(result.note).toMatch(/client-side/i)
    // First search carried criteria (threw), second was the date-only rescan.
    expect(searches.length).toBe(2)
  })

  it('rethrows a search failure when every term is ASCII (not a charset problem)', async () => {
    const { client } = makeFakeClient({
      INBOX: { uids: [1], messages: { 1: msg(1) }, rejectKeywordSearch: true },
    })
    const api = makeApi(client)
    await expect(api.searchMessages({ ...BASE_PARAMS, folder: 'INBOX', keywords: ['invoice'] })).rejects.toThrow()
  })
})

describe('[COMP:api/mailbox-imap-client] AliMail false-empty recovery', () => {
  const ALIMAIL_SETTINGS = { ...SETTINGS, imapHost: 'imap.qiye.aliyun.com' }

  it('filters a bounded recent envelope scan when a selective search returns empty', async () => {
    const fake = makeFakeClient({
      INBOX: {
        uids: [1, 2],
        emptyKeywordSearch: true,
        messages: {
          1: msg(1, { from: [{ name: 'Person', address: 'person@example.com' }] }),
          2: msg(2, { from: [{ name: 'Other', address: 'other@example.com' }] }),
        },
      },
    })
    const result = await makeApi(fake.client, { settings: ALIMAIL_SETTINGS })
      .searchMessages({ folder: 'INBOX', from: 'person@example.com', limit: 20 })

    expect(result.hits.map((hit) => hit.id)).toEqual(['INBOX:1'])
    expect(fake.searches).toHaveLength(2)
    expect(fake.searches[1].query).toHaveProperty('since')
    expect(result.note).toMatch(/AliMail returned an empty selective search/i)
  })

  it('falls back to the owner-scoped archive when the bounded live scan is empty', async () => {
    const fake = makeFakeClient({
      INBOX: { uids: [], emptyKeywordSearch: true, messages: {} },
    })
    const archived = vi.fn(async () => [{
      id: 'Client:9',
      folder: 'Client',
      from: 'Person <person@example.com>',
      date: '2026-08-01T00:00:00.000Z',
      subject: 'Hello',
    }])
    const result = await makeApi(fake.client, {
      settings: ALIMAIL_SETTINGS,
      searchArchivedMessages: archived,
    }).searchMessages({ from: 'person@example.com', limit: 20 })

    expect(archived).toHaveBeenCalledWith(expect.objectContaining({ from: 'person@example.com' }))
    expect(result.hits[0].id).toBe('Client:9')
    expect(result.note).toMatch(/synced personal archive/i)
  })

  it('does not distrust an empty selective search from other providers', async () => {
    const fake = makeFakeClient({
      INBOX: { uids: [1], emptyKeywordSearch: true, messages: { 1: msg(1) } },
    })
    const archived = vi.fn(async () => [])
    const result = await makeApi(fake.client, { searchArchivedMessages: archived })
      .searchMessages({ folder: 'INBOX', from: 'person@example.com', limit: 20 })
    expect(result.hits).toEqual([])
    expect(archived).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/mailbox-imap-client] getMessage', () => {
  it('parses the full MIME source: headers, text body, attachment metadata', async () => {
    const source = rfc822('The numbers are up.\r\n', {
      From: 'Ada <ada@acme.com>',
      To: 'me@corp.com',
      Subject: 'Q3 numbers',
      Date: 'Mon, 20 Jul 2026 10:00:00 +0000',
      'Message-ID': '<root@x>',
      'Content-Type': 'text/plain; charset=utf-8',
    })
    const { client } = makeFakeClient({ INBOX: { uids: [7], messages: { 7: msg(7, {}, source) } } })
    const api = makeApi(client)
    const message = await api.getMessage('INBOX:7')
    expect(message.subject).toBe('Q3 numbers')
    expect(message.from).toContain('ada@acme.com')
    expect(message.body).toContain('The numbers are up.')
    expect(message.messageId).toBe('<root@x>')
  })

  it('rejects a malformed ref honestly', async () => {
    const { client } = makeFakeClient({ INBOX: { uids: [], messages: {} } })
    const api = makeApi(client)
    await expect(api.getMessage('not-a-ref')).rejects.toThrow(/folder:uid/)
  })
})

// ── Phase 3: attachment listing + byte fetch (D14 / D16) ─────────────────
//
// The airline shape the feature was built for: multipart/mixed carrying a
// multipart/alternative (text + multipart/related with an inline image) plus a
// real PDF attachment. mailparser numbers these by raw-stream position; only
// BODYSTRUCTURE gives the IMAP part tree the server will honor in a FETCH.
const NESTED_BODY_STRUCTURE: ImapBodyStructureNode = {
  type: 'multipart/mixed',
  childNodes: [
    {
      part: '1',
      type: 'multipart/alternative',
      childNodes: [
        { part: '1.1', type: 'text/plain', size: 400 },
        {
          part: '1.2',
          type: 'multipart/related',
          childNodes: [
            { part: '1.2.1', type: 'text/html', size: 2_000 },
            {
              part: '1.2.2',
              type: 'image/png',
              disposition: 'inline',
              dispositionParameters: { filename: 'logo.png' },
              size: 5_000,
            },
          ],
        },
      ],
    },
    {
      part: '2',
      type: 'application/pdf',
      disposition: 'attachment',
      dispositionParameters: { filename: 'boarding-pass.pdf' },
      encoding: 'base64',
      size: 120_000,
    },
  ],
}

describe('[COMP:tools/imap-attachments] BODYSTRUCTURE attachment listing (D14)', () => {
  it('lists nested-multipart attachments with the IMAP part-tree ids, skipping body parts', async () => {
    const message = msg(7, {}, rfc822('body', { Subject: 'Boarding pass' }))
    message.bodyStructure = NESTED_BODY_STRUCTURE
    const { client } = makeFakeClient({ INBOX: { uids: [7], messages: { 7: message } } })
    const result = await makeApi(client).getMessage('INBOX:7')

    expect(result.attachments).toEqual([
      { filename: 'logo.png', mime: 'image/png', size: 5_000, partId: '1.2.2' },
      { filename: 'boarding-pass.pdf', mime: 'application/pdf', size: 120_000, partId: '2' },
    ])
  })

  it('lists completely for a message larger than the 4 MB source cap (the latent Phase 1 bug)', async () => {
    // The source fetch is capped, so a >4 MB message reaches mailparser
    // truncated — its attachment list would go short. BODYSTRUCTURE is
    // metadata and carries the whole tree regardless of message size.
    const truncatedSource = rfc822('Only the first megabytes arrived…', { Subject: 'Big' })
    const message = msg(9, {}, truncatedSource)
    message.bodyStructure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 100 },
        {
          part: '2',
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'huge-deck.pdf' },
          size: 30 * 1024 * 1024,
        },
      ],
    }
    const { client } = makeFakeClient({ INBOX: { uids: [9], messages: { 9: message } } })
    const result = await makeApi(client).getMessage('INBOX:9')
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]).toMatchObject({ filename: 'huge-deck.pdf', partId: '2' })
  })

  it('asks the server for bodyStructure alongside the capped source', async () => {
    const message = msg(7, {}, rfc822('body', {}))
    message.bodyStructure = NESTED_BODY_STRUCTURE
    const { client, fetchOnes } = makeFakeClient({ INBOX: { uids: [7], messages: { 7: message } } })
    await makeApi(client).getMessage('INBOX:7')
    expect(fetchOnes.at(-1)!.query.bodyStructure).toBe(true)
  })

  it('reports no attachments for a plain single-part message', async () => {
    const message = msg(7, {}, rfc822('just text', {}))
    message.bodyStructure = { type: 'text/plain', size: 9 }
    const { client } = makeFakeClient({ INBOX: { uids: [7], messages: { 7: message } } })
    expect((await makeApi(client).getMessage('INBOX:7')).attachments).toEqual([])
  })

  it('collectAttachmentParts / findPartNode walk the tree directly', () => {
    expect(collectAttachmentParts(NESTED_BODY_STRUCTURE).map((a) => a.partId)).toEqual(['1.2.2', '2'])
    expect(findPartNode(NESTED_BODY_STRUCTURE, '1.2.1')?.type).toBe('text/html')
    expect(findPartNode(NESTED_BODY_STRUCTURE, '9.9')).toBeNull()
  })
})

describe('[COMP:tools/imap-attachments] getAttachment byte fetch (D14 / D16)', () => {
  function mailboxWithPdf(over: { size?: number; chunks?: Buffer[] } = {}) {
    const message = msg(7, {}, rfc822('body', {}))
    message.bodyStructure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 100 },
        {
          part: '2',
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'boarding-pass.pdf' },
          size: over.size ?? 120_000,
        },
      ],
    }
    return makeFakeClient({
      INBOX: {
        uids: [7],
        messages: { 7: message },
        parts: {
          '7:2': {
            chunks: over.chunks ?? [Buffer.from('%PDF-1.4 '), Buffer.from('boarding')],
            meta: { contentType: 'application/pdf', filename: 'boarding-pass.pdf' },
          },
        },
      },
    })
  }

  it('streams the part with download(), never the capped source fetch', async () => {
    const { client, downloads, fetchOnes } = mailboxWithPdf()
    const result = await makeApi(client).getAttachment('INBOX:7', '2')

    expect(downloads).toEqual([{ folder: 'INBOX', range: '7', part: '2' }])
    expect(result.filename).toBe('boarding-pass.pdf')
    expect(result.mime).toBe('application/pdf')
    expect(Buffer.from(result.bytes).toString()).toBe('%PDF-1.4 boarding')
    // The only fetch is the metadata probe — no `source` range is requested,
    // so the 4 MB cap never touches the bytes.
    for (const call of fetchOnes) expect(call.query.source).toBeUndefined()
  })

  it('refuses an over-cap part from BODYSTRUCTURE metadata before any byte streams', async () => {
    const { client, downloads } = mailboxWithPdf({ size: MAILBOX_ATTACHMENT_MAX_BYTES + 1 })
    await expect(makeApi(client).getAttachment('INBOX:7', '2')).rejects.toThrow(/limit/i)
    expect(downloads).toEqual([])
  })

  it('aborts mid-download when the stream itself overruns the cap (metadata is never trusted alone)', async () => {
    // Server under-reports the size, so only the running byte count can stop it.
    const { client, wasDestroyed } = mailboxWithPdf({
      size: 10,
      chunks: [Buffer.alloc(MAILBOX_ATTACHMENT_MAX_BYTES + 1)],
    })
    await expect(makeApi(client).getAttachment('INBOX:7', '2')).rejects.toThrow(/larger than/i)
    expect(wasDestroyed()).toBe(true)
  })

  it('names imapSearchMessages when the message is gone (stale ref)', async () => {
    const { client } = makeFakeClient({ INBOX: { uids: [], messages: {} } })
    await expect(makeApi(client).getAttachment('INBOX:7', '2')).rejects.toThrow(/imapSearchMessages/)
  })

  it('lists the real parts when the requested partId does not exist', async () => {
    const { client } = mailboxWithPdf()
    await expect(makeApi(client).getAttachment('INBOX:7', '4')).rejects.toThrow(
      /boarding-pass\.pdf \(partId 2\)/,
    )
  })

  it('rejects a malformed ref honestly', async () => {
    const { client } = makeFakeClient({ INBOX: { uids: [], messages: {} } })
    await expect(makeApi(client).getAttachment('not-a-ref', '2')).rejects.toThrow(/folder:uid/)
  })
})

describe('[COMP:api/mailbox-imap-client] sendMessage', () => {
  it('composes attachments once and reuses the same MIME bytes for SMTP and Sent APPEND', async () => {
    const { client, appends } = makeFakeClient(
      {
        INBOX: { uids: [], messages: {} },
        Sent: { uids: [], messages: {} },
      },
      { specialUseSent: 'Sent' },
    )
    const sendComposed = vi.fn(async (..._args: unknown[]) => {})
    const api = makeApi(client, { sendComposed })
    await api.sendMessage({
      to: ['ada@acme.com'],
      subject: 'Receipt',
      body: 'Attached.',
      attachments: [{
        filename: 'receipt.pdf',
        mime: 'application/pdf',
        data: new Uint8Array(Buffer.from('%PDF-fake')),
      }],
    })

    const composed = sendComposed.mock.calls[0][1] as { raw: Buffer }
    expect(composed.raw.toString('utf8')).toContain('receipt.pdf')
    expect(appends).toHaveLength(1)
    expect(appends[0].content.equals(composed.raw)).toBe(true)
  })

  it('threads a reply: resolves the target Message-ID + References and appends a Sent copy', async () => {
    const target = msg(7, { messageId: '<root@x>' })
    target.headers = Buffer.from('References: <start@x> <mid@x>\r\n', 'utf8')
    const { client, appends } = makeFakeClient(
      {
        INBOX: { uids: [7], messages: { 7: target } },
        Sent: { uids: [], messages: {} },
      },
      { specialUseSent: 'Sent' },
    )
    const sendComposed = vi.fn(async (..._args: unknown[]) => {})
    const api = makeApi(client, { sendComposed })
    const result = await api.sendMessage({
      to: ['ada@acme.com'],
      subject: 'Re: msg 7',
      body: 'Agreed.',
      inReplyTo: 'INBOX:7',
    })
    expect(result.messageId).toBeTruthy()
    expect(sendComposed).toHaveBeenCalledTimes(1)
    const composed = sendComposed.mock.calls[0][1] as { raw: Buffer }
    const raw = composed.raw.toString('utf8')
    expect(raw).toMatch(/In-Reply-To: <root@x>/)
    expect(raw).toMatch(/References: <start@x> <mid@x> <root@x>/)
    expect(appends).toHaveLength(1)
    expect(appends[0].path).toBe('Sent')
  })

  it('send succeeds even when the Sent APPEND fails (best-effort copy)', async () => {
    const { client } = makeFakeClient({ INBOX: { uids: [], messages: {} } })  // no Sent folder at all
    const sendComposed = vi.fn(async () => {})
    const api = makeApi(client, { sendComposed })
    const result = await api.sendMessage({ to: ['x@y.z'], subject: 's', body: 'b' })
    expect(result.messageId).toBeTruthy()
    expect(sendComposed).toHaveBeenCalledTimes(1)
  })

  it('does not APPEND a duplicate Sent copy when Gmail already auto-saves SMTP submissions', async () => {
    const { client, appends } = makeFakeClient(
      {
        INBOX: { uids: [], messages: {} },
        '[Gmail]/Sent Mail': { uids: [], messages: {} },
      },
      { specialUseSent: '[Gmail]/Sent Mail' },
    )
    const sendComposed = vi.fn(async () => {})
    const api = makeApi(client, {
      sendComposed,
      settings: {
        ...SETTINGS,
        email: 'me@gmail.com',
        imapHost: 'imap.gmail.com',
        smtpHost: 'SMTP.GMAIL.COM.',
      },
    })
    await api.sendMessage({ to: ['x@y.z'], subject: 's', body: 'b' })
    expect(sendComposed).toHaveBeenCalledTimes(1)
    expect(appends).toHaveLength(0)
  })

  it('carries cc as a header and cc + bcc into the delivery envelope', async () => {
    const { client } = makeFakeClient({ INBOX: { uids: [], messages: {} } })
    const sendComposed = vi.fn(async (..._args: unknown[]) => {})
    const api = makeApi(client, { sendComposed })
    await api.sendMessage({
      to: ['ada@acme.com'],
      cc: ['lead@corp.com'],
      bcc: ['audit@corp.com'],
      subject: 's',
      body: 'b',
    })
    const composed = sendComposed.mock.calls[0][1] as { raw: Buffer; envelope: { to: string[] } }
    const raw = composed.raw.toString('utf8')
    expect(raw).toMatch(/^Cc: lead@corp\.com/im)
    expect(raw).not.toMatch(/^Bcc:/im)  // blind: envelope only, never a header
    expect(composed.envelope.to).toEqual(['ada@acme.com', 'lead@corp.com', 'audit@corp.com'])
  })
})

describe('[COMP:api/mailbox-imap-client] send-as aliases (mailbox-imap.md → "Send-as aliases", D4/D5)', () => {
  const ALIASES = ['bd@corp.com', 'ops@corp.com']

  it('resolveSenderAddress: explicit from must be the account or an alias; reply picks the first alias in the envelope; else account', () => {
    expect(resolveSenderAddress({ accountEmail: 'me@corp.com', aliases: ALIASES, from: 'BD@corp.com' }))
      .toEqual({ from: 'bd@corp.com', allowed: ['me@corp.com', 'bd@corp.com', 'ops@corp.com'] })
    expect(resolveSenderAddress({ accountEmail: 'me@corp.com', aliases: ALIASES, from: 'Me <me@corp.com>' }).from)
      .toBe('me@corp.com')
    expect(() => resolveSenderAddress({ accountEmail: 'me@corp.com', aliases: ALIASES, from: 'someone@else.example' }))
      .toThrow(/not an address this email account can send as.*Allowed senders: me@corp\.com, bd@corp\.com, ops@corp\.com/)
    // Reply-from-origin: envelope order decides among aliases; the account itself is not "an alias".
    expect(resolveSenderAddress({ accountEmail: 'me@corp.com', aliases: ALIASES, replyRecipients: ['me@corp.com', 'ops@corp.com', 'bd@corp.com'] }).from)
      .toBe('ops@corp.com')
    expect(resolveSenderAddress({ accountEmail: 'me@corp.com', aliases: ALIASES, replyRecipients: ['x@y.z'] }).from)
      .toBe('me@corp.com')
    expect(resolveSenderAddress({ accountEmail: 'me@corp.com', aliases: [], replyRecipients: ['bd@corp.com'] }).from)
      .toBe('me@corp.com')
  })

  it('a reply to mail addressed to an alias goes out AS that alias - header From and envelope MAIL FROM (row 5)', async () => {
    const target = msg(7, { messageId: '<root@x>', to: [{ address: 'BD@corp.com' }], cc: [{ address: 'ada@acme.com' }] })
    const { client } = makeFakeClient({ INBOX: { uids: [7], messages: { 7: target } } })
    const sendComposed = vi.fn(async (..._args: unknown[]) => {})
    const api = makeApi(client, { sendComposed, sendAsAliases: ALIASES })
    const result = await api.sendMessage({ to: ['ada@acme.com'], subject: 'Re: msg 7', body: 'Sure.', inReplyTo: 'INBOX:7' })
    expect(result.from).toBe('bd@corp.com')
    const composed = sendComposed.mock.calls[0][1] as { raw: Buffer; envelope: { from: string } }
    expect(composed.raw.toString('utf8')).toMatch(/^From: bd@corp\.com/im)
    expect(composed.envelope.from).toBe('bd@corp.com')
    expect(composed.raw.toString('utf8')).toMatch(/In-Reply-To: <root@x>/)
    // The SMTP login is still the account (auth.user) - the settings object is untouched.
    expect((sendComposed.mock.calls[0][0] as MailboxAccountSettings).email).toBe('me@corp.com')
  })

  it('a reply to mail addressed to the account (no alias in To/Cc) and any fresh send go out from the account', async () => {
    const target = msg(7, { messageId: '<root@x>' }) // to: me@corp.com
    const { client } = makeFakeClient({ INBOX: { uids: [7], messages: { 7: target } } })
    const sendComposed = vi.fn(async (..._args: unknown[]) => {})
    const api = makeApi(client, { sendComposed, sendAsAliases: ALIASES })
    const reply = await api.sendMessage({ to: ['ada@acme.com'], subject: 'Re', body: 'b', inReplyTo: 'INBOX:7' })
    expect(reply.from).toBe('me@corp.com')
    const fresh = await api.sendMessage({ to: ['ada@acme.com'], subject: 'Hi', body: 'b' })
    expect(fresh.from).toBe('me@corp.com')
    expect((sendComposed.mock.calls[1][1] as { envelope: { from: string } }).envelope.from).toBe('me@corp.com')
  })

  it('an explicit from outside the allowlist is refused with the list, BEFORE any network work (row 6)', async () => {
    const { client, fetchOnes } = makeFakeClient({ INBOX: { uids: [], messages: {} } })
    const sendComposed = vi.fn(async () => {})
    const api = makeApi(client, { sendComposed, sendAsAliases: ALIASES })
    await expect(api.sendMessage({ to: ['x@y.z'], subject: 's', body: 'b', from: 'someone@else.example', inReplyTo: 'INBOX:7' }))
      .rejects.toThrow(/Allowed senders: me@corp\.com, bd@corp\.com, ops@corp\.com/)
    expect(sendComposed).not.toHaveBeenCalled()
    expect(fetchOnes).toHaveLength(0)
    // Explicit ALLOWED alias needs no reply context.
    const ok = await api.sendMessage({ to: ['x@y.z'], subject: 's', body: 'b', from: 'ops@corp.com' })
    expect(ok.from).toBe('ops@corp.com')
  })

  it('resolveSender previews the same decision the send makes (the From line the approver sees)', async () => {
    const target = msg(7, { messageId: '<root@x>', to: [{ address: 'bd@corp.com' }] })
    const { client, fetchOnes } = makeFakeClient({ INBOX: { uids: [7], messages: { 7: target } } })
    const api = makeApi(client, { sendAsAliases: ALIASES })
    expect(await api.resolveSender!({ inReplyTo: 'INBOX:7' })).toEqual({ from: 'bd@corp.com', allowed: ['me@corp.com', 'bd@corp.com', 'ops@corp.com'] })
    expect((await api.resolveSender!({ from: 'ops@corp.com' })).from).toBe('ops@corp.com')
    await expect(api.resolveSender!({ from: 'nope@else.example' })).rejects.toThrow(/Allowed senders/)
    // With no aliases configured a reply never fetches the envelope just to pick the account.
    const plain = makeApi(client)
    const before = fetchOnes.length
    expect((await plain.resolveSender!({ inReplyTo: 'INBOX:7' })).from).toBe('me@corp.com')
    expect(fetchOnes.length).toBe(before)
  })
})

describe('[COMP:api/mailbox-imap-client] pure helpers', () => {
  it('parseMessageRef handles folders containing colons and rejects garbage', () => {
    expect(parseMessageRef('INBOX:42')).toEqual({ folder: 'INBOX', uid: 42 })
    expect(parseMessageRef('Archive:2024:7')).toEqual({ folder: 'Archive:2024', uid: 7 })
    expect(parseMessageRef('nope')).toBeNull()
    expect(parseMessageRef('INBOX:zero')).toBeNull()
  })

  it('parseReferencesHeader unfolds and extracts message ids', () => {
    const headers = Buffer.from('References: <a@x>\r\n <b@x>\r\n\t<c@x>\r\n', 'utf8')
    expect(parseReferencesHeader(headers)).toEqual(['<a@x>', '<b@x>', '<c@x>'])
    expect(parseReferencesHeader(undefined)).toEqual([])
  })

  it('htmlToText strips tags, scripts, and entities into readable text', () => {
    const text = htmlToText('<style>p{}</style><p>Hello &amp; welcome<br>line two</p><script>x()</script>')
    expect(text).toBe('Hello & welcome\nline two')
  })
})
