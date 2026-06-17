/**
 * Unit tests for the markUseful store.
 * Component tag: [COMP:retrieval/mark-useful-store].
 *
 * Pure mock tests — verifies the SQL routing per primitive, RLS user
 * threading, idempotency, and silent acceptance for primitives that
 * don't yet carry a `useful_recall_count` column.
 *
 * Integration coverage of the actual UPDATE rides on the existing
 * `memories` table tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  queryWithRLS: vi.fn(),
}))

import { createDbMarkUsefulStore } from '../mark-useful-store.js'
import { queryWithRLS } from '../client.js'
import type { RetrievalActor } from '@sidanclaw/core'

const mockQuery = vi.mocked(queryWithRLS)
const store = createDbMarkUsefulStore()

const actor: RetrievalActor = {
  workspaceId: 'ws-1',
  userId: 'u-1',
  assistantId: 'a-1',
  assistantKind: 'standard',
  clearance: 'confidential',
}

const ROW = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:retrieval/mark-useful-store] markUseful', () => {
  it('bumps memories.useful_recall_count when primitive=memory', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const result = await store.markUseful(actor, { row_id: ROW, primitive: 'memory' })

    expect(result.data.success).toBe(true)
    expect(mockQuery).toHaveBeenCalledOnce()
    const [userId, sql, params] = mockQuery.mock.calls[0]
    expect(userId).toBe('u-1')
    expect(sql).toContain('UPDATE memories')
    expect(sql).toContain('useful_recall_count = useful_recall_count + 1')
    expect(sql).toContain('workspace_id = $2')
    expect(params).toEqual([ROW, 'ws-1'])
  })

  it('bumps kb_chunks.useful_recall_count when primitive=kb_chunk', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const result = await store.markUseful(actor, { row_id: ROW, primitive: 'kb_chunk' })

    expect(result.data.success).toBe(true)
    const [, sql] = mockQuery.mock.calls[0]
    expect(sql).toContain('UPDATE kb_chunks')
  })

  it('returns success=false when the row is invisible (RLS hides it / wrong workspace)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const result = await store.markUseful(actor, { row_id: ROW, primitive: 'memory' })

    expect(result.data.success).toBe(false)
  })

  it('returns success=false for malformed row_id without hitting the DB', async () => {
    const result = await store.markUseful(actor, { row_id: 'not-a-uuid', primitive: 'memory' })

    expect(result.data.success).toBe(false)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('accepts the signal silently for primitives without a counter column', async () => {
    for (const primitive of ['entity', 'edge', 'task'] as const) {
      const result = await store.markUseful(actor, { row_id: ROW, primitive })
      expect(result.data.success).toBe(true)
    }
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('emits the canonical envelope shape', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const result = await store.markUseful(actor, { row_id: ROW, primitive: 'memory' })

    expect(result.api_version).toBe('v1')
    expect(result.meta.truncated).toBe(false)
    expect(typeof result.meta.retrieved_at).toBe('string')
  })
})
