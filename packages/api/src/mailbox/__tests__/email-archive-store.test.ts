/**
 * Email archive store — segmentation, idempotent insert shape, and the
 * person-compartment chain (§10 "Compartments"): every segment row stamps
 * `user_id = owner` / `assistant_id = NULL`, and the search runs BOTH
 * owner-gated in the predicate AND under the owner's RLS context — another
 * member's search cannot read this archive (the owner-scoped RLS policy in
 * migration 359 is the DB-level backstop).
 *
 * [COMP:api/email-archive-store]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import {
  segmentEmailBody,
  insertEmailArchiveMessage,
  searchEmailArchive,
  countEmailArchiveMessages,
  findArchivedEmailUids,
  searchExactEmailArchiveMessages,
} from '../../db/email-archive-store.js'
import { query, queryWithRLS, getPool } from '../../db/client.js'
import { MAX_CHARS } from '../../db/text-chunking.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockGetPool = vi.mocked(getPool)

beforeEach(() => {
  mockQuery.mockReset()
  mockQueryWithRLS.mockReset()
  mockGetPool.mockReset()
})

describe('[COMP:api/email-archive-store] segmentEmailBody', () => {
  it('prefixes segment 0 with the Subject/From header line', () => {
    const segments = segmentEmailBody({ subject: 'Q3', from: 'Ada <ada@acme.com>', bodyText: 'Numbers are up.' })
    expect(segments).toHaveLength(1)
    expect(segments[0]).toContain('Subject: Q3 / From: Ada <ada@acme.com>')
    expect(segments[0]).toContain('Numbers are up.')
  })

  it('a subject-only message still embeds the header line; a fully empty one embeds nothing', () => {
    expect(segmentEmailBody({ subject: 'Ping', from: 'a@b.c', bodyText: '' })).toHaveLength(1)
    expect(segmentEmailBody({ subject: '', from: '', bodyText: '  ' })).toHaveLength(0)
  })

  it('splits a long body into bounded segments, header on the first only', () => {
    const body = 'A sentence here. '.repeat(400) // far over MAX_CHARS
    const segments = segmentEmailBody({ subject: 'Long', from: 'a@b.c', bodyText: body })
    expect(segments.length).toBeGreaterThan(1)
    expect(segments[0]).toContain('Subject: Long')
    expect(segments[1]).not.toContain('Subject: Long')
    for (const s of segments.slice(1)) expect(s.length).toBeLessThanOrEqual(MAX_CHARS)
  })
})

function makeTxClient(returningId: string | null) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (sql.includes('INSERT INTO email_archive_messages')) {
        return { rows: returningId ? [{ id: returningId }] : [], rowCount: returningId ? 1 : 0 }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  mockGetPool.mockReturnValue({ connect: vi.fn(async () => client) } as never)
  return { client, calls }
}

const INPUT = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  ownerUserId: 'owner-1',
  folder: 'INBOX',
  providerMessageId: 'INBOX:42',
  rfcMessageId: '<m42@acme.com>',
  subject: 'Deal terms',
  from: 'Ken <ken@client.hk>',
  to: ['maya@harborlane.example'],
  sentAt: new Date('2026-07-20T10:00:00Z'),
  bodyText: 'Can we revise clause 4?',
}

describe('[COMP:api/email-archive-store] insertEmailArchiveMessage', () => {
  it('stamps user_id = owner / assistant_id = NULL on every segment (the person compartment, D7)', async () => {
    const { calls } = makeTxClient('am-1')
    const result = await insertEmailArchiveMessage(INPUT)
    expect(result).toMatchObject({ inserted: true, messageId: 'am-1', segmentCount: 1 })
    const segInsert = calls.find((c) => c.sql.includes('INSERT INTO email_archive_segments'))
    expect(segInsert).toBeDefined()
    expect(segInsert!.sql).toContain('ON CONFLICT (message_id, segment_index) DO NOTHING')
    // Columns: workspace_id, message_id, instance_id, segment_index,
    // segment_text, user_id, assistant_id(NULL literal), sensitivity, created_by
    expect(segInsert!.sql).toMatch(/user_id, assistant_id/)
    expect(segInsert!.sql).toContain('NULL')
    expect(segInsert!.params?.[5]).toBe('owner-1') // user_id = owner
  })

  it('stamps segment valid_from with the message SENT time, not the sync clock', async () => {
    // D6 / B5. `created_at` is when the sync wrote the row, so a backfill
    // stamps a decade of history with `now()`; the embedding drain keys its
    // priority tier and its 12-month window on `valid_from` for this corpus.
    const { calls } = makeTxClient('am-1')
    await insertEmailArchiveMessage(INPUT)
    const segInsert = calls.find((c) => c.sql.includes('INSERT INTO email_archive_segments'))
    expect(segInsert!.sql).toContain('created_by_user_id, valid_from')
    expect(segInsert!.params?.[8]).toEqual(INPUT.sentAt)
  })

  it('clamps a future-dated sent time to now — a skewed Date: header cannot hide the row', async () => {
    const { calls } = makeTxClient('am-1')
    const before = Date.now()
    await insertEmailArchiveMessage({
      ...INPUT,
      sentAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    })
    const segInsert = calls.find((c) => c.sql.includes('INSERT INTO email_archive_segments'))
    const validFrom = segInsert!.params?.[8] as Date
    expect(validFrom.getTime()).toBeGreaterThanOrEqual(before)
    expect(validFrom.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('falls back to now when the message carries no sent time', async () => {
    const { calls } = makeTxClient('am-1')
    const before = Date.now()
    await insertEmailArchiveMessage({ ...INPUT, sentAt: null })
    const segInsert = calls.find((c) => c.sql.includes('INSERT INTO email_archive_segments'))
    const validFrom = segInsert!.params?.[8] as Date
    expect(validFrom.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('is idempotent on (instance_id, provider_message_id) — a re-synced UID writes nothing', async () => {
    const { calls } = makeTxClient(null) // ON CONFLICT DO NOTHING → no RETURNING row
    const result = await insertEmailArchiveMessage(INPUT)
    expect(result).toEqual({ inserted: false, messageId: null, segmentCount: 0 })
    expect(calls.some((c) => c.sql.includes('email_archive_segments'))).toBe(false)
    const msgInsert = calls.find((c) => c.sql.includes('INSERT INTO email_archive_messages'))
    expect(msgInsert!.sql).toContain('ON CONFLICT (instance_id, provider_message_id) DO NOTHING')
  })
})

describe('[COMP:api/email-archive-store] searchEmailArchive (person compartment)', () => {
  it('owner-gates in the predicate AND runs under the owner RLS context; instance is caller-bound', async () => {
    mockQueryWithRLS.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    await searchEmailArchive({ ownerUserId: 'owner-1', instanceId: 'inst-1', query: 'deposit' })
    // No embedder → lexical arm + the coverage probe.
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(2)
    for (const call of mockQueryWithRLS.mock.calls) {
      const [rlsUser, sql, params] = call as unknown as [string, string, unknown[]]
      expect(rlsUser).toBe('owner-1') // RLS braces: the owner policy applies
      expect(sql).toContain('es.user_id = $1') // predicate belt
      expect(sql).toContain('es.instance_id = $2')
      expect(params[0]).toBe('owner-1')
      expect(params[1]).toBe('inst-1')
      expect(sql).toContain('es.retracted_at IS NULL')
    }
  })

  it('fuses the vector and lexical arms by reciprocal rank, deduped by message#segment', async () => {
    const vecRow = {
      provider_message_id: 'INBOX:1', folder: 'INBOX', subject: 'a', from_addr: 'x@y.z',
      sent_at: '2026-07-20T10:00:00Z', segment_index: 0, segment_text: 'vector hit', distance: 0.1,
    }
    const likeRow = { ...vecRow, provider_message_id: 'INBOX:2', segment_text: 'lexical hit' }
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [vecRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [vecRow, likeRow], rowCount: 2 } as never)
      .mockResolvedValueOnce({ rows: [{ n: '0' }], rowCount: 1 } as never)
    const { hits } = await searchEmailArchive(
      { ownerUserId: 'owner-1', instanceId: 'inst-1', query: 'deposit refund' },
      { embedder: { embed: async () => [[0.1, 0.2]] } },
    )
    expect(hits).toHaveLength(2)
    // Found by BOTH arms, so it outranks the passage only one arm found.
    expect(hits[0].segment_text).toBe('vector hit')
    expect(hits[1].segment_text).toBe('lexical hit')
  })

  it('ranks a multi-term natural-language query with the vector arm disabled', async () => {
    // B6: the lexical arm used to bind `%<whole query>%`, so a sentence like
    // this matched only if all 52 characters appeared verbatim — i.e. never,
    // which left the vector arm doing all the work.
    const row = {
      provider_message_id: 'INBOX:7', folder: 'INBOX', subject: 'Shipment', from_addr: 's@x.example',
      sent_at: '2026-07-20T10:00:00Z', segment_index: 0, segment_text: 'the shipment is delayed',
    }
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ n: '0' }], rowCount: 1 } as never)
    const { hits } = await searchEmailArchive({
      ownerUserId: 'owner-1',
      instanceId: 'inst-1',
      query: 'what did the supplier say about the delayed shipment',
    })
    expect(hits).toHaveLength(1)
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as unknown as [string, string, unknown[]]
    // Individual terms, ranked by how many of them hit — never the raw query.
    expect(params).toContain('%supplier%')
    expect(params).toContain('%delayed%')
    expect(params).toContain('%shipment%')
    expect(params).not.toContain('%what did the supplier say about the delayed shipment%')
    expect(sql).toContain('ORDER BY term_hits DESC')
    // Stopwords carry no signal and would match every passage equally.
    expect(params).not.toContain('%the%')
    expect(params).not.toContain('%what%')
  })

  it('reports partial coverage when unembedded rows fall inside the filter scope', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ n: '42' }], rowCount: 1 } as never)
    const { coverage } = await searchEmailArchive({
      ownerUserId: 'owner-1',
      instanceId: 'inst-1',
      query: 'deposit',
    })
    expect(coverage.partial).toBe(true)
    expect(coverage.unembeddedInScope).toBe(42)
    expect(coverage.note).toContain('42 passages')
    expect(coverage.note).toContain('inconclusive')
    // Scoped to THIS query's filters, not to the corpus at large.
    const [, probeSql] = mockQueryWithRLS.mock.calls[1] as unknown as [string, string, unknown[]]
    expect(probeSql).toContain('es.embedding IS NULL')
    expect(probeSql).toContain('es.user_id = $1')
    expect(probeSql).toContain('LIMIT')
  })

  it('says nothing when the whole filter scope is embedded', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ n: '0' }], rowCount: 1 } as never)
    const { coverage } = await searchEmailArchive({
      ownerUserId: 'owner-1',
      instanceId: 'inst-1',
      query: 'deposit',
    })
    expect(coverage).toEqual({ partial: false, unembeddedInScope: 0, capped: false, note: null })
  })

  it('vector arm soft-fails to lexical-only on embed error', async () => {
    mockQueryWithRLS.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { hits } = await searchEmailArchive(
      { ownerUserId: 'owner-1', instanceId: 'inst-1', query: 'quarterly report' },
      { embedder: { embed: async () => { throw new Error('embed down') } } },
    )
    expect(hits).toEqual([])
    // Lexical arm + coverage probe; the vector arm never issued a query.
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('[COMP:api/email-archive-store] exact provider fallback', () => {
  it('preserves structured filters and owner-scoped RLS without embeddings', async () => {
    mockQueryWithRLS.mockResolvedValue({
      rows: [{
        provider_message_id: 'Client:7', folder: 'Client', from_addr: 'Person <person@example.com>',
        to_addrs: ['me@example.com'], sent_at: '2026-08-01T00:00:00Z', subject: 'Hello',
        body_text: 'Recent note', rfc_message_id: '<m7@example.com>', in_reply_to: null,
        references_ids: [],
      }],
      rowCount: 1,
    } as never)

    const hits = await searchExactEmailArchiveMessages({
      ownerUserId: 'owner-1',
      instanceId: 'inst-1',
      params: { from: 'person@example.com', since: '2026-07-01', limit: 20 },
    })

    const [rlsUser, sql, params] = mockQueryWithRLS.mock.calls[0] as unknown as [string, string, unknown[]]
    expect(rlsUser).toBe('owner-1')
    expect(sql).toContain('owner_user_id = $1')
    expect(sql).toContain('instance_id = $2')
    expect(sql).toContain('from_addr ILIKE')
    expect(params).toEqual(expect.arrayContaining(['owner-1', 'inst-1', '%person@example.com%', '2026-07-01']))
    expect(hits[0]).toMatchObject({ id: 'Client:7', from: 'Person <person@example.com>' })
  })
})

describe('[COMP:api/email-archive-store] counts', () => {
  it('reconciles per-folder totals for the completeness check', async () => {
    mockQuery.mockResolvedValue({ rows: [{ folder: 'INBOX', n: '3' }, { folder: 'Sent', n: '2' }], rowCount: 2 } as never)
    const counts = await countEmailArchiveMessages('inst-1')
    expect(counts).toEqual({ total: 5, byFolder: { INBOX: 3, Sent: 2 } })
  })

  it('finds only archived UIDs in the requested folder window', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { provider_message_id: 'Archive:2024:9' },
        { provider_message_id: 'Archive:2024:7' },
      ],
      rowCount: 2,
    } as never)

    await expect(findArchivedEmailUids('inst-1', 'Archive:2024', [10, 9, 8, 7])).resolves.toEqual(
      new Set([9, 7]),
    )
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('provider_message_id = ANY'),
      ['inst-1', 'Archive:2024', ['Archive:2024:10', 'Archive:2024:9', 'Archive:2024:8', 'Archive:2024:7']],
    )
  })

  it('does not query for an empty reconciliation window', async () => {
    await expect(findArchivedEmailUids('inst-1', 'INBOX', [])).resolves.toEqual(new Set())
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
