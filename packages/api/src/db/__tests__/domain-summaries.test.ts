/**
 * Unit tests for the domain-summaries store.
 * Component tag: [COMP:api/domain-summaries-store].
 *
 * Mocks the `query` helper. Verifies the Deep-consolidation Layer 3
 * domain index: the (assistant,user,app,domain) upsert with a
 * memory_count derived from memoryIds, the stale-bucket prune (NULL-safe
 * app_id match + keep-list), and the listing's appId-omitted vs
 * appId-provided branches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import {
  upsertDomainSummary,
  pruneStaleDomainSummaries,
  listDomainSummaries,
} from '../domain-summaries.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

function summaryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ds-1',
    assistantId: 'a-1',
    userId: 'u-1',
    appId: null,
    domain: 'travel',
    summary: 'User travels to Seoul often.',
    memoryCount: 3,
    memoryIds: ['m-1', 'm-2', 'm-3'],
    updatedAt: new Date('2026-05-15T00:00:00Z'),
    ...over,
  }
}

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/domain-summaries-store] upsertDomainSummary', () => {
  it('upserts on the (assistant,user,app,domain) key, deriving memory_count from memoryIds', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await upsertDomainSummary({
      assistantId: 'a-1',
      userId: 'u-1',
      appId: null,
      domain: 'travel',
      summary: 'Travels to Seoul.',
      memoryIds: ['m-1', 'm-2', 'm-3'],
    })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('INSERT INTO domain_summaries')
    expect(sql).toContain('ON CONFLICT (assistant_id, user_id, app_id, domain)')
    // memory_count is derived from the id list, not passed by the caller.
    expect(params?.[5]).toBe(3)
    expect(params?.[6]).toEqual(['m-1', 'm-2', 'm-3'])
  })
})

describe('[COMP:api/domain-summaries-store] pruneStaleDomainSummaries', () => {
  it('deletes buckets outside the keep-list with a NULL-safe app_id match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 4 } as never)
    const removed = await pruneStaleDomainSummaries('a-1', 'u-1', null, ['travel', 'work'])
    expect(removed).toBe(4)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('DELETE FROM domain_summaries')
    expect(sql).toContain('app_id IS NOT DISTINCT FROM $3')
    expect(sql).toContain('NOT (domain = ANY($4))')
    expect(params).toEqual(['a-1', 'u-1', null, ['travel', 'work']])
  })

  it('returns 0 when the driver reports a null rowCount', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: null } as never)
    expect(await pruneStaleDomainSummaries('a-1', 'u-1', 'app-1', [])).toBe(0)
  })
})

describe('[COMP:api/domain-summaries-store] listDomainSummaries', () => {
  it('omits the app_id filter when appId is undefined', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [summaryRow()], rowCount: 1 } as never)
    const rows = await listDomainSummaries('a-1', 'u-1')
    expect(rows).toHaveLength(1)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).not.toContain('IS NOT DISTINCT FROM')
    expect(params).toEqual(['a-1', 'u-1'])
  })

  it('applies a NULL-safe app_id filter when appId is provided (incl. null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await listDomainSummaries('a-1', 'u-1', null)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('app_id IS NOT DISTINCT FROM $3')
    expect(params).toEqual(['a-1', 'u-1', null])
  })
})
