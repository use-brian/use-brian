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
    // No embedder → single (ILIKE) arm.
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(1)
    const [rlsUser, sql, params] = mockQueryWithRLS.mock.calls[0] as unknown as [string, string, unknown[]]
    expect(rlsUser).toBe('owner-1') // RLS braces: the owner policy applies
    expect(sql).toContain('es.user_id = $1') // predicate belt
    expect(sql).toContain('es.instance_id = $2')
    expect(params[0]).toBe('owner-1')
    expect(params[1]).toBe('inst-1')
    expect(sql).toContain('es.retracted_at IS NULL')
  })

  it('fuses vector + ILIKE arms, vector rank first, deduped by message#segment', async () => {
    const vecRow = {
      provider_message_id: 'INBOX:1', folder: 'INBOX', subject: 'a', from_addr: 'x@y.z',
      sent_at: '2026-07-20T10:00:00Z', segment_index: 0, segment_text: 'vector hit', distance: 0.1,
    }
    const likeRow = { ...vecRow, provider_message_id: 'INBOX:2', segment_text: 'ilike hit' }
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [vecRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [vecRow, likeRow], rowCount: 2 } as never)
    const hits = await searchEmailArchive(
      { ownerUserId: 'owner-1', instanceId: 'inst-1', query: 'deposit' },
      { embedder: { embed: async () => [[0.1, 0.2]] } },
    )
    expect(hits).toHaveLength(2)
    expect(hits[0].segment_text).toBe('vector hit')
    expect(hits[1].segment_text).toBe('ilike hit')
  })

  it('vector arm soft-fails to ILIKE-only on embed error', async () => {
    mockQueryWithRLS.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hits = await searchEmailArchive(
      { ownerUserId: 'owner-1', instanceId: 'inst-1', query: 'q' },
      { embedder: { embed: async () => { throw new Error('embed down') } } },
    )
    expect(hits).toEqual([])
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('[COMP:api/email-archive-store] counts', () => {
  it('reconciles per-folder totals for the completeness check', async () => {
    mockQuery.mockResolvedValue({ rows: [{ folder: 'INBOX', n: '3' }, { folder: 'Sent', n: '2' }], rowCount: 2 } as never)
    const counts = await countEmailArchiveMessages('inst-1')
    expect(counts).toEqual({ total: 5, byFolder: { INBOX: 3, Sent: 2 } })
  })
})
