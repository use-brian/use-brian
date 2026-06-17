import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(() => ({
    connect: vi.fn(() => ({
      query: vi.fn(),
      release: vi.fn(),
    })),
  })),
}))

import { createDbLinkedAccountStore } from '../linked-accounts.js'
import { query, queryWithRLS, getPool } from '../client.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockGetPool = vi.mocked(getPool)

beforeEach(() => {
  mockQuery.mockReset()
  mockQueryWithRLS.mockReset()
  mockGetPool.mockReset()
})

const store = createDbLinkedAccountStore()

/**
 * Post-Stage-6 of the team-connector promotion: the store is a shim
 * over `linked_identities` + `channel_routes`. These tests assert the
 * shape of the JOIN queries and the transaction-based upsert/delete.
 * Component tag: [COMP:api/linked-accounts-store].
 */

describe('[COMP:api/linked-accounts-store] findByProvider', () => {
  it('composes the legacy row by JOINing linked_identities + channel_routes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.findByProvider('telegram', '12345')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('FROM linked_identities li')
    expect(sql).toContain('LEFT JOIN channel_routes cr')
    expect(sql).toContain('li.provider = $1 AND li.provider_id = $2')
    expect(sql).toContain('LIMIT 1')
    expect(params).toEqual(['telegram', '12345'])
  })

  it('returns null when no row matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const result = await store.findByProvider('telegram', 'ghost')
    expect(result).toBeNull()
  })

  it('uses bare query (no RLS) because webhooks arrive pre-auth', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.findByProvider('telegram', '1')
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalled()
  })
})

describe('[COMP:api/linked-accounts-store] upsert', () => {
  function makeTxClient() {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return undefined
        // Identity RETURNING yields one row
        if (sql.includes('INSERT INTO linked_identities')) {
          return {
            rows: [{
              id: 'li_1',
              userId: params?.[0],
              assistantId: null,
              provider: params?.[1],
              providerId: params?.[2],
              providerMetadata: params?.[3] ? JSON.parse(params[3] as string) : null,
              linkedAt: new Date(),
            }],
            rowCount: 1,
          }
        }
        // Routing INSERT returns no rows (no RETURNING)
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    mockGetPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never)
    return { client, calls }
  }

  it('upserts both linked_identities + channel_routes in one transaction', async () => {
    const { client, calls } = makeTxClient()

    const result = await store.upsert({
      userId: 'u_1',
      assistantId: 'a_1',
      provider: 'telegram',
      providerId: '12345',
      providerMetadata: { firstName: 'Alice', chatId: '555' },
    })

    expect(result.userId).toBe('u_1')
    expect(result.assistantId).toBe('a_1')
    expect(result.providerMetadata).toEqual({ firstName: 'Alice', chatId: '555' })

    // BEGIN + identity upsert + routing upsert + COMMIT
    expect(calls.map((c) => c.sql.split(' ')[0] + ' ' + (c.sql.split(' ')[1] ?? '')).slice(0, 1)).toEqual(['BEGIN '])
    expect(calls.some((c) => c.sql.includes('INSERT INTO linked_identities'))).toBe(true)
    expect(calls.some((c) => c.sql.includes('INSERT INTO channel_routes'))).toBe(true)
    expect(calls[calls.length - 1].sql).toBe('COMMIT')
    expect(client.release).toHaveBeenCalled()
  })

  it('passes null metadata when not provided', async () => {
    const { calls } = makeTxClient()
    await store.upsert({
      userId: 'u_1',
      assistantId: 'a_1',
      provider: 'telegram',
      providerId: '12345',
    })
    const identityCall = calls.find((c) => c.sql.includes('INSERT INTO linked_identities'))
    expect(identityCall?.params?.[3]).toBeNull()
  })
})

describe('[COMP:api/linked-accounts-store] listForUser', () => {
  it('uses RLS-gated query joining the two new tables', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.listForUser('u_1')
    expect(mockQueryWithRLS).toHaveBeenCalledOnce()
    const [actingUserId, sql] = mockQueryWithRLS.mock.calls[0]
    expect(actingUserId).toBe('u_1')
    expect(sql).toContain('FROM linked_identities li')
    expect(sql).toContain('LEFT JOIN channel_routes cr')
  })
})

describe('[COMP:api/linked-accounts-store] deleteForUser', () => {
  function makeTxClient(identityRows: Array<{ provider: string; provider_id: string }>, deleteRowCount: number) {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return undefined
        if (sql.includes('SELECT provider, provider_id FROM linked_identities')) {
          return { rows: identityRows, rowCount: identityRows.length }
        }
        if (sql.includes('set_config')) return { rows: [], rowCount: 0 }
        if (sql.includes('DELETE FROM linked_identities')) {
          return { rows: [], rowCount: deleteRowCount }
        }
        if (sql.includes('DELETE FROM channel_routes')) {
          return { rows: [], rowCount: 0 }  // whatever — we don't care about routing count
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    mockGetPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never)
    return client
  }

  it('deletes identity + cascades routing cleanup in one transaction', async () => {
    const client = makeTxClient([{ provider: 'telegram', provider_id: '12345' }], 1)

    const result = await store.deleteForUser('u_1', 'li_1')
    expect(result).toBe(true)

    const sqls = client.query.mock.calls.map((c) => c[0] as string)
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls.some((s) => s.includes('SELECT provider, provider_id FROM linked_identities'))).toBe(true)
    expect(sqls.some((s) => s.includes('DELETE FROM linked_identities'))).toBe(true)
    expect(sqls.some((s) => s.includes('DELETE FROM channel_routes'))).toBe(true)
    expect(sqls[sqls.length - 1]).toBe('COMMIT')
  })

  it('returns false when the identity row does not exist', async () => {
    makeTxClient([], 0)
    const result = await store.deleteForUser('u_1', 'li_missing')
    expect(result).toBe(false)
  })

  it('returns false when RLS hides the identity from the caller', async () => {
    makeTxClient([{ provider: 'telegram', provider_id: '12345' }], 0)
    const result = await store.deleteForUser('u_stranger', 'li_1')
    expect(result).toBe(false)
  })
})
