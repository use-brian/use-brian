import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import {
  createMemory,
  countMemories,
  getMemoryById,
  searchMemories,
  getIdentityMemories,
  getMemoryIndex,
  listMemoriesWithMetrics,
  updateMemory,
} from '../memories.js'
import { query, getPool } from '../client.js'

const mockQuery = vi.mocked(query)
const mockGetPool = vi.mocked(getPool)

beforeEach(() => {
  mockQuery.mockReset()
  mockGetPool.mockReset()
})

describe('[COMP:api/memory-store] createMemory', () => {
  it('applies default values (scope=shared, confidence=0.8, source=model)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm_1' }], rowCount: 1 } as never)
    await createMemory({
      assistantId: 'a_1',
      userId: 'u_1',
      summary: 'Likes ramen',
      sensitivity: 'internal',
      createdByUserId: 'u_1',
    })
    const params = mockQuery.mock.calls[0][1]!
    expect(params[0]).toBe('a_1')        // assistantId
    expect(params[1]).toBe('u_1')        // userId
    expect(params[2]).toBeNull()         // appId default
    expect(params[3]).toBeNull()         // workspaceId default
    // Post-Phase-4 (migration 177) dropped the `type` and `category`
    // columns, so the INSERT no longer carries them — scope is now the
    // first field after workspaceId. The scope default flipped from
    // 'app' to 'shared' in migration 053: it matches the model's intent
    // for scope-less writes (a personal fact about the user) and aligns
    // with the post-053 DB column DEFAULT.
    expect(params[4]).toBe('shared')     // scope default
    expect(params[5]).toEqual([])        // tags default
    expect(params[8]).toBe(0.8)          // confidence default
    expect(params[9]).toBe('internal')   // sensitivity
    expect(params[10]).toBe('model')     // source default
  })

  it('resolves a primary writer to workspace_shared (assistant_id → NULL) via SQL CASE', async () => {
    // The visibility-double resolution lives in the INSERT (so EVERY
    // writer — chat / Pipeline B / consolidation — is covered at the one
    // chokepoint). The `assistant_id` param ($1) is unchanged; the SQL
    // decides whether to persist it or NULL based on the writer's kind.
    // See sensitivity.md → "saveMemory resolution" + migration 240. The
    // behavioural (real-DB) assertion lives in
    // memories-primary-workspace-shared.integration.test.ts.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm_1' }], rowCount: 1 } as never)
    await createMemory({
      assistantId: 'a_1',
      userId: 'u_1',
      summary: 'Likes ramen',
      sensitivity: 'internal',
      createdByUserId: 'u_1',
    })
    const sql = mockQuery.mock.calls[0][0] as string
    const params = mockQuery.mock.calls[0][1]!
    expect(sql).toContain("(SELECT kind FROM assistants WHERE id = $1::uuid) = 'primary'")
    expect(sql).toContain('THEN NULL')
    // $1 still carries the writer id — the DB nulls it only for a primary
    // writer, and only when $2 (user_id) is set (CHECK guard).
    expect(params[0]).toBe('a_1')
    expect(params[1]).toBe('u_1')
  })

  it('honors explicit tags and confidence', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm_1' }], rowCount: 1 } as never)
    await createMemory({
      assistantId: 'a_1',
      userId: 'u_1',
      summary: 'Software engineer',
      tags: ['work', 'tech'],
      confidence: 0.95,
      sensitivity: 'internal',
      createdByUserId: 'u_1',
    })
    const params = mockQuery.mock.calls[0][1]!
    expect(params[5]).toEqual(['work', 'tech'])
    expect(params[8]).toBe(0.95)
  })
})

describe('[COMP:memory/authorship-stamp] createMemory writes universal-column authorship', () => {
  it('writes createdByUserId / createdByAssistantId / sourceEpisodeId when supplied', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm_1' }], rowCount: 1 } as never)
    await createMemory({
      assistantId: 'a_1',
      userId: 'u_1',
      summary: 's',
      sensitivity: 'internal',
      createdByUserId: 'u_1',
      createdByAssistantId: 'a_1',
      sourceEpisodeId: 'ep_1',
    })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('created_by_user_id')
    expect(sql).toContain('created_by_assistant_id')
    expect(sql).toContain('source_episode_id')
    expect(params![12]).toBe('u_1')   // created_by_user_id
    expect(params![13]).toBe('a_1')   // created_by_assistant_id
    expect(params![14]).toBe('ep_1')  // source_episode_id
  })

  it('rejects inserts missing createdByUserId (WU-4.5 authorship NOT NULL enforcement)', async () => {
    await expect(
      createMemory({
        assistantId: 'a_1', userId: 'u_1',
        summary: 's', sensitivity: 'internal',
        // createdByUserId deliberately omitted; the guard fires before
        // any SQL so no mockQuery setup is needed.
        createdByUserId: '',
      }),
    ).rejects.toThrowError(/createMemory.*createdByUserId.*WU-4\.5/)
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('[COMP:memory/bi-temporal-reads] reads filter valid_to IS NULL (SQL shape)', () => {
  beforeEach(() => {
    // Two slots — some readers fall through to a second query on empty.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
  })

  const CTX = { workspaceId: 'w', userId: 'u', assistantId: 'a', assistantKind: 'standard' as const, clearance: 'confidential' as const }

  it('getMemoryById', async () => {
    await getMemoryById(CTX, '00000000-0000-0000-0000-000000000000')
    expect(mockQuery.mock.calls[0][0]).toContain('valid_to IS NULL')
  })

  it('searchMemories (FTS path + ILIKE fallback both filter)', async () => {
    await searchMemories(CTX, { searchQuery: 'hello' })
    expect(mockQuery.mock.calls[0][0]).toContain('valid_to IS NULL') // FTS query
    expect(mockQuery.mock.calls[1][0]).toContain('valid_to IS NULL') // ILIKE fallback
  })

  it('getIdentityMemories', async () => {
    await getIdentityMemories(CTX)
    expect(mockQuery.mock.calls[0][0]).toContain('valid_to IS NULL')
  })

  it('getMemoryIndex', async () => {
    await getMemoryIndex(CTX)
    expect(mockQuery.mock.calls[0][0]).toContain('valid_to IS NULL')
  })

  it('listMemoriesWithMetrics', async () => {
    await listMemoriesWithMetrics('a', 'u')
    expect(mockQuery.mock.calls[0][0]).toContain('valid_to IS NULL')
  })
})

describe('[COMP:api/memory-store] updateMemory access scoping', () => {
  // WS3 read/write-asymmetry regression: getMemoryById scopes reads with
  // buildAccessPredicate, but updateMemory superseded by id on the owner pool
  // (RLS-bypassing) with no scope — so a full-UUID edit from the model tool or
  // the Memory-tab PATCH route could overwrite another user's/workspace's
  // memory. When a viewer ctx is passed the lock SELECT must carry the
  // predicate; workers omit it and stay system-wide.
  function makeClient(lockRows: unknown[]) {
    const calls: Array<[string, unknown[]?]> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return undefined
        if (sql.includes('FOR UPDATE')) return { rows: lockRows, rowCount: lockRows.length }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    mockGetPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never)
    return calls
  }

  const ctx = {
    workspaceId: 'w_1',
    userId: 'u_1',
    assistantId: 'a_1',
    assistantKind: 'standard' as const,
    clearance: 'confidential' as const,
  }

  it('scopes the lock SELECT with the access predicate when a viewer ctx is passed', async () => {
    const calls = makeClient([]) // no row visible to the viewer → returns null
    const result = await updateMemory('11111111-1111-1111-1111-111111111111', { summary: 'x' }, ctx)
    expect(result).toBeNull()
    const lock = calls.find((c) => (c[0] as string).includes('FOR UPDATE'))!
    // The bare form is `WHERE id = $1 AND valid_to IS NULL FOR UPDATE`; the
    // scoped form inserts the projection between valid_to and FOR UPDATE and
    // appends the ctx params after the id.
    expect(lock[0]).not.toMatch(/valid_to IS NULL\s+FOR UPDATE/)
    expect(lock[1]).toContain('w_1')
    expect((lock[1] as unknown[]).length).toBeGreaterThan(1)
  })

  it('runs unscoped (system path) when no access is passed', async () => {
    const calls = makeClient([])
    await updateMemory('11111111-1111-1111-1111-111111111111', { summary: 'x' })
    const lock = calls.find((c) => (c[0] as string).includes('FOR UPDATE'))!
    expect(lock[0]).toContain('WHERE id = $1 AND valid_to IS NULL')
    expect(lock[0]).toMatch(/valid_to IS NULL\s+FOR UPDATE/)
    expect(lock[1]).toEqual(['11111111-1111-1111-1111-111111111111'])
  })
})

describe('[COMP:api/memory-store] countMemories', () => {
  it('counts active memories visible to the viewer', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '12' }], rowCount: 1 } as never)
    const n = await countMemories({
      workspaceId: 'w_1',
      userId: 'u_1',
      assistantId: 'a_1',
      assistantKind: 'standard',
      clearance: 'confidential',
    })
    expect(n).toBe(12)
    const [sql, params] = mockQuery.mock.calls[0]
    expect((sql as string).toLowerCase()).toContain('count(*)')
    expect(sql).toContain('valid_to IS NULL')
    // params now lead with the AccessContext projection: workspace,
    // user, assistant, clearance.
    expect(params).toEqual(['w_1', 'u_1', 'a_1', 'confidential'])
  })
})
