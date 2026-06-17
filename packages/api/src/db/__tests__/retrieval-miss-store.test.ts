/**
 * Unit tests for the retrieval-miss store.
 * Component tag: [COMP:api/retrieval-miss-store].
 *
 * Mocks `query` / `queryWithRLS`. Verifies record, the per-session cap
 * counter (countForSession), the aggregation window read, and the
 * RLS-gated session listing helper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import {
  createDbRetrievalMissStore,
  listMissesForSession,
} from '../retrieval-miss-store.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)

beforeEach(() => {
  mockQuery.mockReset()
  mockRls.mockReset()
})

const store = createDbRetrievalMissStore()

function missRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    sessionId: 's-1',
    workspaceId: 'ws-1',
    userId: 'u-1',
    priorQueryHash: 'h-prior',
    newQueryHash: 'h-new',
    priorQueryText: 'who handles refunds?',
    newQueryText: 'refund policy contact',
    topKOverlap: 0.2,
    cosineSimilarity: 0.91,
    at: new Date('2026-05-24T10:00:00Z'),
    ...over,
  }
}

describe('[COMP:api/retrieval-miss-store] record', () => {
  it('inserts with the full miss shape', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [missRow()], rowCount: 1 } as never)
    const out = await store.record({
      sessionId: 's-1',
      workspaceId: 'ws-1',
      userId: 'u-1',
      priorQueryHash: 'h-prior',
      newQueryHash: 'h-new',
      priorQueryText: 'who handles refunds?',
      newQueryText: 'refund policy contact',
      topKOverlap: 0.2,
      cosineSimilarity: 0.91,
    })
    expect(out.id).toBe('m-1')
    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[0]).toBe('s-1')
    expect(params[7]).toBe(0.2) // topKOverlap
    expect(params[8]).toBe(0.91) // cosineSimilarity
  })
})

describe('[COMP:api/retrieval-miss-store] countForSession — per-session cap enforcement', () => {
  it('returns the row count as a number', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '4' }], rowCount: 1 } as never)
    expect(await store.countForSession('s-1')).toBe(4)
    expect(mockQuery.mock.calls[0][0]).toContain('SELECT COUNT(*)')
  })

  it('returns 0 when the session has no misses yet', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never)
    expect(await store.countForSession('s-1')).toBe(0)
  })

  it('returns 0 when the count row is missing (defensive)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.countForSession('s-1')).toBe(0)
  })
})

describe('[COMP:api/retrieval-miss-store] listForAggregation', () => {
  it('filters by workspace_id and an inclusive/exclusive window', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [missRow()], rowCount: 1 } as never)
    const since = new Date('2026-05-17T00:00:00Z')
    const until = new Date('2026-05-24T00:00:00Z')
    await store.listForAggregation('ws-1', since, until)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('workspace_id = $1')
    expect(sql).toContain('at >= $2')
    expect(sql).toContain('at < $3')
    expect(mockQuery.mock.calls[0][1]).toEqual(['ws-1', since, until])
  })
})

describe('[COMP:api/retrieval-miss-store] listMissesForSession (RLS helper)', () => {
  it('routes through queryWithRLS', async () => {
    mockRls.mockResolvedValueOnce({ rows: [missRow()], rowCount: 1 } as never)
    const out = await listMissesForSession('u-1', 's-1')
    expect(out[0].id).toBe('m-1')
    expect(mockRls.mock.calls[0][0]).toBe('u-1')
    expect(mockRls.mock.calls[0][2]).toEqual(['s-1'])
  })
})
