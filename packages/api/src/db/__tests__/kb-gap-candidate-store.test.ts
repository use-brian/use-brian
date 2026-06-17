/**
 * Unit tests for the KB gap candidate store.
 * Component tag: [COMP:api/kb-gap-candidate-store].
 *
 * Mocks `query` / `queryWithRLS`. Verifies create with the UUID[] evidence
 * cast, the open-queue listing (not dismissed, not drafted), and the
 * dismiss / markDrafted lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbKbGapCandidateStore } from '../kb-gap-candidate-store.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)

beforeEach(() => {
  mockQuery.mockReset()
  mockRls.mockReset()
})

const store = createDbKbGapCandidateStore()

function candidateRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c-1',
    workspaceId: 'ws-1',
    patternSummary: 'Users repeatedly ask about refund policy',
    evidenceMissIds: ['m-1', 'm-2'],
    occurrences: 4,
    distinctSessions: 3,
    dismissedAt: null,
    dismissedByUserId: null,
    draftedAt: null,
    draftedByUserId: null,
    createdAt: new Date('2026-05-24'),
    ...over,
  }
}

describe('[COMP:api/kb-gap-candidate-store] create', () => {
  it('inserts with the UUID[] evidence cast', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidateRow()], rowCount: 1 } as never)
    await store.create({
      workspaceId: 'ws-1',
      patternSummary: 'Users repeatedly ask about refund policy',
      evidenceMissIds: ['m-1', 'm-2'],
      occurrences: 4,
      distinctSessions: 3,
    })
    expect(mockQuery.mock.calls[0][0]).toContain('uuid[]')
    expect(mockQuery.mock.calls[0][1]).toEqual([
      'ws-1',
      'Users repeatedly ask about refund policy',
      ['m-1', 'm-2'],
      4,
      3,
    ])
  })
})

describe('[COMP:api/kb-gap-candidate-store] listOpen', () => {
  it('filters to not-dismissed + not-drafted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidateRow()], rowCount: 1 } as never)
    await store.listOpen('ws-1')
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('dismissed_at IS NULL')
    expect(sql).toContain('drafted_at IS NULL')
  })

  it('routes through RLS with actingUserId', async () => {
    mockRls.mockResolvedValueOnce({ rows: [candidateRow()], rowCount: 1 } as never)
    await store.listOpen('ws-1', { actingUserId: 'u-1' })
    expect(mockRls.mock.calls[0][0]).toBe('u-1')
  })
})

describe('[COMP:api/kb-gap-candidate-store] dismiss + markDrafted', () => {
  it('dismiss stamps dismissed_at + dismissed_by_user_id (idempotent guard)', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await store.dismiss('u-1', 'c-1')).toBe(true)
    const sql = mockRls.mock.calls[0][1] as string
    expect(sql).toContain('dismissed_at = now()')
    expect(sql).toContain('dismissed_at IS NULL')

    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.dismiss('u-1', 'c-1')).toBe(false)
  })

  it('markDrafted stamps drafted_at + drafted_by_user_id (idempotent guard)', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await store.markDrafted('u-1', 'c-1')).toBe(true)
    const sql = mockRls.mock.calls[0][1] as string
    expect(sql).toContain('drafted_at = now()')
    expect(sql).toContain('drafted_at IS NULL')
  })
})
