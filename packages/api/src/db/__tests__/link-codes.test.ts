import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { createDbLinkCodeStore } from '../link-codes.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  mockQuery.mockReset()
})

const store = createDbLinkCodeStore()

describe('[COMP:api/link-codes-store] create', () => {
  it('invalidates existing unclaimed codes before inserting', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)  // UPDATE invalidate
      .mockResolvedValueOnce({
        rows: [{ id: 'lc_1', code: 'ABC234', userId: 'u_1', assistantId: 'a_1' }],
        rowCount: 1,
      } as never)

    await store.create({ userId: 'u_1', assistantId: 'a_1' })

    // First call should be the invalidate UPDATE
    expect(mockQuery.mock.calls[0][0]).toContain('SET expires_at = now()')
    expect(mockQuery.mock.calls[0][0]).toContain('claimed_at IS NULL')
    expect(mockQuery.mock.calls[0][1]).toEqual(['u_1', 'a_1'])

    // Second call should be the INSERT
    expect(mockQuery.mock.calls[1][0]).toContain('INSERT INTO telegram_link_codes')
  })

  it('generates a 6-character code from the unambiguous alphabet', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'lc_1' }], rowCount: 1 } as never)

    await store.create({ userId: 'u_1', assistantId: 'a_1' })

    const insertParams = mockQuery.mock.calls[1][1]!
    const code = insertParams[2] as string
    expect(code).toHaveLength(6)
    // Alphabet excludes ambiguous 0/O, 1/I/L
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)
  })

  it('sets a 5-minute TTL on the inserted code', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'lc_1' }], rowCount: 1 } as never)
    await store.create({ userId: 'u_1', assistantId: 'a_1' })
    const sql = mockQuery.mock.calls[1][0] as string
    expect(sql).toContain("interval '5 minutes'")
  })
})

describe('[COMP:api/link-codes-store] findValidCode', () => {
  it('only returns unclaimed, unexpired codes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.findValidCode('ABC234')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('claimed_at IS NULL')
    expect(sql).toContain('expires_at > now()')
    expect(params).toEqual(['ABC234'])
  })

  it('returns null when no matching row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const result = await store.findValidCode('MISSING')
    expect(result).toBeNull()
  })
})

describe('[COMP:api/link-codes-store] claim', () => {
  it('sets claimed_at and claimed_by_provider_id, gated on claimed_at IS NULL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.claim('ABC234', 'telegram_user_12345')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('SET claimed_at = now()')
    expect(sql).toContain('claimed_at IS NULL')  // race condition guard
    expect(params).toEqual(['ABC234', 'telegram_user_12345'])
  })
})

describe('[COMP:api/link-codes-store] getByUserAndAssistant', () => {
  it('returns the most recent code (ORDER BY created_at DESC LIMIT 1)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.getByUserAndAssistant('u_1', 'a_1')
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toContain('ORDER BY created_at DESC')
    expect(sql).toContain('LIMIT 1')
  })
})
