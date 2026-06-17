/**
 * Unit tests for the skill curator digest store.
 * Component tag: [COMP:api/skill-curator-digest-store].
 *
 * Mocks `query` / `queryWithRLS`. Verifies append, list paging, and the
 * getLatest convenience wrapper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbSkillCuratorDigestStore } from '../skill-curator-digest-store.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)

beforeEach(() => {
  mockQuery.mockReset()
  mockRls.mockReset()
})

const store = createDbSkillCuratorDigestStore()

function digestRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd-1',
    workspaceId: 'ws-1',
    weekOf: new Date('2026-05-18'),
    actions: { archived: 2, merged: 1 },
    createdAt: new Date('2026-05-24'),
    ...over,
  }
}

describe('[COMP:api/skill-curator-digest-store] append', () => {
  it('inserts a row with the actions JSONB payload', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [digestRow()], rowCount: 1 } as never)
    const out = await store.append('ws-1', new Date('2026-05-18'), { archived: 2, merged: 1 })
    expect(out.workspaceId).toBe('ws-1')
    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[0]).toBe('ws-1')
    // JSON-encoded payload is the third parameter.
    expect(JSON.parse(params[2] as string)).toEqual({ archived: 2, merged: 1 })
  })
})

describe('[COMP:api/skill-curator-digest-store] listForWorkspace + getLatest', () => {
  it('listForWorkspace defaults to 12 weeks of history', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [digestRow(), digestRow({ id: 'd-2' })],
      rowCount: 2,
    } as never)
    const out = await store.listForWorkspace('ws-1')
    expect(out.length).toBe(2)
    expect(mockQuery.mock.calls[0][1]).toEqual(['ws-1', 12])
  })

  it('routes through RLS with actingUserId', async () => {
    mockRls.mockResolvedValueOnce({ rows: [digestRow()], rowCount: 1 } as never)
    await store.listForWorkspace('ws-1', 5, { actingUserId: 'u-1' })
    expect(mockRls.mock.calls[0][0]).toBe('u-1')
    expect(mockRls.mock.calls[0][2]).toEqual(['ws-1', 5])
  })

  it('getLatest returns the most recent row or null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [digestRow()], rowCount: 1 } as never)
    expect((await store.getLatest('ws-1'))?.id).toBe('d-1')

    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getLatest('ws-empty')).toBeNull()
  })
})
