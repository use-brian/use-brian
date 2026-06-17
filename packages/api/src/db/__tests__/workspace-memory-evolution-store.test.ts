import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import {
  getEvolution,
  upsertEvolution,
} from '../workspace-memory-evolution-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/workspace-memory-evolution-store] getEvolution', () => {
  it('returns null when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)
    const got = await getEvolution('w_1')
    expect(got).toBeNull()
  })

  it('returns the row with coerced numeric rates', async () => {
    // pg returns NUMERIC columns as strings; the store should coerce
    // them to numbers for downstream consumers.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          workspaceId: 'w_1',
          totalSaves30d: 42,
          totalVerifications30d: 17,
          scopeNarrowRate: '0.235',
          scopeWideRate: '0.000',
          sensitivityOverRate: null,
          sensitivityUnderRate: '0.118',
          promptSnippet: '# Workspace memory conventions\n...',
          promptSnippetVersion: 3,
          lastRefreshedAt: new Date('2026-05-23T00:00:00Z'),
          updatedAt: new Date('2026-05-23T00:00:00Z'),
        },
      ],
    } as any)

    const got = await getEvolution('w_1')
    expect(got).not.toBeNull()
    expect(got?.scopeNarrowRate).toBe(0.235)
    expect(got?.scopeWideRate).toBe(0)
    expect(got?.sensitivityOverRate).toBeNull()
    expect(got?.sensitivityUnderRate).toBe(0.118)
    expect(got?.promptSnippet).toContain('Workspace memory conventions')
    expect(got?.promptSnippetVersion).toBe(3)
  })

  it('parameterizes by workspace id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)
    await getEvolution('w_xyz')
    expect(mockQuery.mock.calls[0][1]).toEqual(['w_xyz'])
  })

  it('uses bare query (system bypass), not RLS', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)
    await getEvolution('w_1')
    // The store must call the bare `query`, never `queryWithRLS`,
    // because the prompt builder needs workspace-level data
    // regardless of the per-user request scope.
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:api/workspace-memory-evolution-store] upsertEvolution', () => {
  it('inserts the row when none exists and bumps version=1 with a snippet', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)
    await upsertEvolution({
      workspaceId: 'w_1',
      totalSaves30d: 100,
      totalVerifications30d: 30,
      scopeNarrowRate: 0.2,
      scopeWideRate: 0.05,
      sensitivityOverRate: 0.16,
      sensitivityUnderRate: 0.02,
      promptSnippet: 'snippet body',
    })
    const sql = mockQuery.mock.calls[0][0] as string
    const args = mockQuery.mock.calls[0][1] as unknown[]
    expect(sql).toContain('INSERT INTO workspace_memory_evolution')
    expect(sql).toContain('ON CONFLICT (workspace_id) DO UPDATE')
    expect(args).toEqual([
      'w_1', 100, 30, 0.2, 0.05, 0.16, 0.02, 'snippet body',
    ])
  })

  it('inserts version=0 when snippet is null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)
    await upsertEvolution({
      workspaceId: 'w_2',
      totalSaves30d: 10,
      totalVerifications30d: 5,
      scopeNarrowRate: 0.0,
      scopeWideRate: 0.0,
      sensitivityOverRate: 0.0,
      sensitivityUnderRate: 0.0,
      promptSnippet: null,
    })
    const sql = mockQuery.mock.calls[0][0] as string
    // The INSERT path computes version=0 when snippet is null —
    // exercised via the CASE expression in the INSERT VALUES clause.
    expect(sql).toContain('CASE WHEN $8 IS NULL THEN 0 ELSE 1 END')
    const args = mockQuery.mock.calls[0][1] as unknown[]
    expect(args[7]).toBeNull()
  })

  it('only bumps prompt_snippet_version on actual snippet change in the ON CONFLICT path', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)
    await upsertEvolution({
      workspaceId: 'w_3',
      totalSaves30d: 50,
      totalVerifications30d: 20,
      scopeNarrowRate: 0.3,
      scopeWideRate: 0.0,
      sensitivityOverRate: 0.0,
      sensitivityUnderRate: 0.0,
      promptSnippet: 'updated snippet',
    })
    const sql = mockQuery.mock.calls[0][0] as string
    // The conditional version-bump logic must be present in the
    // ON CONFLICT path — otherwise refreshes with identical snippets
    // would needlessly invalidate prompt caches.
    expect(sql).toContain('IS NOT DISTINCT FROM EXCLUDED.prompt_snippet')
    expect(sql).toContain('prompt_snippet_version  =')
    expect(sql).toContain('prompt_snippet_version + 1')
  })

  it('passes nulls through for rate columns when worker had no signal in a dimension', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)
    await upsertEvolution({
      workspaceId: 'w_4',
      totalSaves30d: 0,
      totalVerifications30d: 11,
      scopeNarrowRate: null,
      scopeWideRate: 0.18,
      sensitivityOverRate: null,
      sensitivityUnderRate: null,
      promptSnippet: null,
    })
    const args = mockQuery.mock.calls[0][1] as unknown[]
    expect(args[3]).toBeNull()
    expect(args[4]).toBe(0.18)
    expect(args[5]).toBeNull()
    expect(args[6]).toBeNull()
  })
})
