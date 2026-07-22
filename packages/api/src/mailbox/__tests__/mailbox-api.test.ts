import { describe, it, expect, vi } from 'vitest'
import { createMailboxApi, parseMessageRef, parseReferencesHeader, htmlToText } from '../mailbox-api.js'
import { createMailboxSessionCache, type ImapClientLike, type ImapFetchedMessage } from '../imap-session.js'
import type { MailboxAccountSettings } from '../types.js'

const SETTINGS: MailboxAccountSettings = {
  email: 'me@corp.com',
  appPassword: 'p',
  imapHost: 'imap.corp.com',
  imapPort: 993,
  smtpHost: 'smtp.corp.com',
  smtpPort: 465,
}

type FakeFolder = {
  /** UIDs the server search returns for this folder (any criteria). */
  uids: number[]
  messages: Record<number, ImapFetchedMessage>
  /** When set, the FIRST search with keyword criteria throws (BADCHARSET). */
  rejectKeywordSearch?: boolean
}

function rfc822(body: string, headers: Record<string, string>): Buffer {
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
  return Buffer.from(`${head}\r\n\r\n${body}`, 'utf8')
}

function makeFakeClient(folders: Record<string, FakeFolder>, opts?: { specialUseSent?: string }) {
  const searches: Array<{ folder: string; query: Record<string, unknown> }> = []
  const appends: Array<{ path: string; content: Buffer }> = []
  let openFolder = ''
  const client = {
    usable: true,
    async connect() {},
    async logout() {},
    close() {},
    async list() {
      return Object.keys(folders).map((path) => ({
        path,
        ...(opts?.specialUseSent === path ? { specialUse: '\\Sent' } : {}),
      }))
    },
    async getMailboxLock(path: string) {
      if (!folders[path]) throw new Error(`no such folder ${path}`)
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
    async fetchOne(id: string) {
      const folder = folders[openFolder]
      return folder.messages[Number(id)] ?? false
    },
    async status() {
      return { path: openFolder }
    },
    async append(path: string, content: Buffer) {
      appends.push({ path, content })
      return {}
    },
  } as unknown as ImapClientLike
  return { client, searches, appends }
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

function makeApi(client: ImapClientLike, over: { sendComposed?: ReturnType<typeof vi.fn>; saveSentCopy?: boolean } = {}) {
  const sessions = createMailboxSessionCache({ createClient: () => client })
  return createMailboxApi({
    cacheKey: 'inst-1',
    getSettings: async () => SETTINGS,
    sessions,
    sendComposed: (over.sendComposed ?? vi.fn(async () => {})) as never,
    ...(over.saveSentCopy !== undefined ? { saveSentCopy: over.saveSentCopy } : {}),
  })
}

const BASE_PARAMS = { since: '2026-01-01', limit: 20 }

describe('[COMP:api/mailbox-imap-client] searchMessages folder scope', () => {
  it('searches INBOX and the SPECIAL-USE \\Sent folder by default (D12 #3)', async () => {
    const { client, searches } = makeFakeClient(
      {
        INBOX: { uids: [1], messages: { 1: msg(1) } },
        'Sent Messages': { uids: [2], messages: { 2: msg(2, { subject: 'my reply' }) } },
      },
      { specialUseSent: 'Sent Messages' },
    )
    const api = makeApi(client)
    const { hits } = await api.searchMessages({ ...BASE_PARAMS, keywords: ['reply'] })
    const searchedFolders = [...new Set(searches.map((s) => s.folder))]
    expect(searchedFolders).toEqual(expect.arrayContaining(['INBOX', 'Sent Messages']))
    expect(hits.map((h) => h.folder)).toEqual(expect.arrayContaining(['INBOX', 'Sent Messages']))
  })

  it('falls back to well-known Sent folder names when no SPECIAL-USE flag exists', async () => {
    const { client, searches } = makeFakeClient({
      INBOX: { uids: [1], messages: { 1: msg(1) } },
      '已发送': { uids: [], messages: {} },
    })
    const api = makeApi(client)
    await api.searchMessages({ ...BASE_PARAMS })
    expect(searches.map((s) => s.folder)).toEqual(expect.arrayContaining(['INBOX', '已发送']))
  })

  it('searches only the explicit folder when one is given, and only INBOX when no Sent exists', async () => {
    const explicit = makeFakeClient({ INBOX: { uids: [], messages: {} }, Archive: { uids: [3], messages: { 3: msg(3) } } })
    await makeApi(explicit.client).searchMessages({ ...BASE_PARAMS, folder: 'Archive' })
    expect([...new Set(explicit.searches.map((s) => s.folder))]).toEqual(['Archive'])

    const inboxOnly = makeFakeClient({ INBOX: { uids: [1], messages: { 1: msg(1) } } })
    const result = await makeApi(inboxOnly.client).searchMessages({ ...BASE_PARAMS })
    expect(result.note).toMatch(/only INBOX/i)
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

describe('[COMP:api/mailbox-imap-client] sendMessage', () => {
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
      to: 'ada@acme.com',
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
    const result = await api.sendMessage({ to: 'x@y.z', subject: 's', body: 'b' })
    expect(result.messageId).toBeTruthy()
    expect(sendComposed).toHaveBeenCalledTimes(1)
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
