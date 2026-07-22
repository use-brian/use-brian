/**
 * [COMP:brain/entity-links] Entity-links store — idempotent create (migration 354).
 *
 * Mocks the pg client and verifies the assert-exists contract: `create` inserts
 * with ON CONFLICT DO NOTHING against the active-identity index, and on
 * conflict reads the existing active row back instead of duplicating it.
 * Regression for the 2026-07-22 incident: the chat-retrieval local-match
 * re-minted the same `mentioned` edge on every recall (one edge 946x; 85% of
 * the table was duplicates) because edge writers are fire-and-forget and no
 * seam enforced uniqueness.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbEntityLinksStore } from '../entity-links-store.js'
import { queryWithRLS } from '../client.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)

const WS = '00000000-0000-0000-0000-000000000001'
const USER = '00000000-0000-0000-0000-000000000002'
const MEMORY = '00000000-0000-0000-0000-000000000003'
const ENTITY = '00000000-0000-0000-0000-000000000004'

const ROW = {
  id: '00000000-0000-0000-0000-00000000000e',
  sourceKind: 'memory',
  sourceId: MEMORY,
  targetKind: 'entity',
  targetId: ENTITY,
  edgeType: 'mentioned',
  attributes: {},
  source: 'extracted',
  verifiedByUserId: null,
  verifiedAt: null,
  validFrom: new Date(),
  validTo: null,
  retractedAt: null,
  retractedReason: null,
  sourceEpisodeId: null,
  sensitivity: 'internal',
  workspaceId: WS,
  userId: USER,
  assistantId: null,
  createdAt: new Date(),
}

const PARAMS = {
  sourceKind: 'memory',
  sourceId: MEMORY,
  targetKind: 'entity',
  targetId: ENTITY,
  edgeType: 'mentioned',
  workspaceId: WS,
  source: 'extracted',
  userId: USER,
} as never

beforeEach(() => {
  vi.clearAllMocks()
})

const store = createDbEntityLinksStore()

describe('[COMP:brain/entity-links] idempotent create (mig 354)', () => {
  it('fresh edge: single INSERT carrying the active-identity ON CONFLICT clause', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 } as never)
    const link = await store.create(PARAMS)
    expect(link.id).toBe(ROW.id)
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(1)
    const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string]
    expect(sql).toContain('ON CONFLICT (workspace_id, source_kind, source_id, target_kind, target_id, edge_type)')
    expect(sql).toContain('WHERE valid_to IS NULL AND retracted_at IS NULL')
    expect(sql).toContain('DO NOTHING')
  })

  it('duplicate edge: conflict yields no row → the EXISTING active row is read back', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // insert: conflict, no row
      .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 } as never) // read-back
    const link = await store.create(PARAMS)
    expect(link.id).toBe(ROW.id)
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(2)
    const [, selectSql, selectParams] = mockQueryWithRLS.mock.calls[1] as [string, string, unknown[]]
    expect(selectSql).toContain('valid_to IS NULL AND retracted_at IS NULL')
    expect(selectParams).toEqual([WS, 'memory', MEMORY, 'entity', ENTITY, 'mentioned'])
  })

  it('conflict + vanished row (concurrent retract): retries the insert once, then succeeds', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // insert: conflict
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // read-back: retracted meanwhile
      .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 } as never) // re-insert lands
    const link = await store.create(PARAMS)
    expect(link.id).toBe(ROW.id)
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(3)
  })

  it('gives up with a clear error when the race never settles', async () => {
    mockQueryWithRLS.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    await expect(store.create(PARAMS)).rejects.toThrow(/raced a concurrent retract/)
  })
})
