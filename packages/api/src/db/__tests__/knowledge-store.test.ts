import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AccessContext } from '@use-brian/core'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

// Capture the `knowledge` workflow-event-source emissions the store publishes.
const { published } = vi.hoisted(() => ({ published: [] as Array<Record<string, unknown>> }))
vi.mock('../../knowledge-event-fanout.js', () => ({
  publishKnowledgeLifecycle: (event: Record<string, unknown>) => {
    published.push(event)
  },
}))

import { createDbKnowledgeStore } from '../knowledge-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)
const store = createDbKnowledgeStore()

// Default viewer with passthrough clearance — matches DEFAULT_CLEARANCE
// behaviour used by every existing assertion.
const ctxFor = (workspaceId: string, clearance?: 'public' | 'internal' | 'confidential'): AccessContext => ({
  workspaceId,
  userId: 'u1',
  assistantId: 'a1',
  assistantKind: 'standard',
  clearance,
})

beforeEach(() => {
  vi.clearAllMocks()
  published.length = 0
})

describe('[COMP:api/knowledge-store] entries', () => {
  describe('search', () => {
    it('uses FTS with plainto_tsquery and ranks by ts_rank_cd, scoped by team', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'e1', path: 'products/vault', title: 'Vault', summary: 'Vault product' }],
        rowCount: 1,
      } as never)

      const results = await store.search(ctxFor('t1'), 'vault fees')
      expect(results).toHaveLength(1)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('plainto_tsquery')
      expect(sql).toContain('ts_rank_cd')
      expect(sql).toContain('ke.workspace_id = $1')
      // Per-assistant source denylist applied on the consumption path.
      expect(sql).toContain('assistant_disabled_knowledge_sources')
      expect(sql).toContain('adks.assistant_id = $5')
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'vault fees', 10, 'confidential', 'a1'])
    })
  })

  describe('listByPath', () => {
    it('lists top-level entries when pathPrefix is empty', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ path: 'index' }], rowCount: 1 } as never)

      await store.listByPath(ctxFor('t1'), '')
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain("NOT LIKE '%/%'")
      expect(sql).toContain('ke.workspace_id = $1')
    })

    it('lists direct children and index entry for a nested path', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ path: 'products/vault/fees' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ path: 'products/vault' }], rowCount: 1 } as never)

      const results = await store.listByPath(ctxFor('t1'), 'products/vault')
      expect(results).toHaveLength(2)
    })
  })

  describe('getById', () => {
    it('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      const entry = await store.getById(ctxFor('t1'), 'missing')
      expect(entry).toBeNull()
    })

    it('scopes lookup by workspace_id so cross-workspace IDs are not readable', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      await store.getById(ctxFor('t1'), 'someid')
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('ke.workspace_id = $2')
      expect(sql).toContain('adks.assistant_id = $4')
      expect(mockQuery.mock.calls[0][1]).toEqual(['someid', 't1', 'confidential', 'a1'])
    })
  })

  describe('upsertByPath', () => {
    it('uses INSERT ON CONFLICT (workspace_id, path) DO UPDATE', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'e1', path: 'test', title: 'Test' }],
        rowCount: 1,
      } as never)

      await store.upsertByPath({
        workspaceId: 't1',
        path: 'test',
        title: 'Test',
        content: 'body',
        tags: ['tag1'],
        sensitivity: 'internal',
      })

      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('ON CONFLICT (workspace_id, path) DO UPDATE')
    })
  })

  describe('delete', () => {
    it('returns true when deleted', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never)
      expect(await store.delete('e1')).toBe(true)
    })

    it('returns false when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 } as never)
      expect(await store.delete('missing')).toBe(false)
    })
  })

  describe('deleteBySource', () => {
    it('deletes all entries for a source and returns count', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 5 } as never)
      const count = await store.deleteBySource('src1')
      expect(count).toBe(5)
    })
  })

  describe('listSummaries', () => {
    it('returns id, path, summary, sensitivity scoped by team and clearance', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'e1', path: 'a', summary: 'Summary A', sensitivity: 'internal' },
          { id: 'e2', path: 'b', summary: null, sensitivity: 'public' },
        ],
        rowCount: 2,
      } as never)

      const summaries = await store.listSummaries(ctxFor('t1'))
      expect(summaries).toHaveLength(2)
      expect(summaries[1].summary).toBeNull()
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('workspace_id = $1')
      expect(sql).toContain('sensitivity_rank')
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'confidential'])
    })
  })

  describe('listForBrain', () => {
    it('returns recent rows ordered by updated_at when query is empty', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'e1', title: 'A', path: 'a.md', sensitivity: 'public' },
          { id: 'e2', title: 'B', path: 'b.md', sensitivity: 'internal' },
        ],
        rowCount: 2,
      } as never)

      const rows = await store.listForBrain(ctxFor('t1'), '', 50)
      expect(rows).toHaveLength(2)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('workspace_id = $1')
      // `, id` is a PAGINATION tiebreaker, not decoration: this is the
      // knowledge arm of the Brain list's composite cursor, and rows tied on
      // `updated_at` (a bulk KB import writes many at once) would otherwise
      // reshuffle between pages, showing duplicates and skipping others.
      expect(sql).toContain('ORDER BY updated_at DESC, id')
      expect(sql).not.toContain('plainto_tsquery')
      // Offset defaults to 0 when the caller does not page.
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'confidential', 50, 0])
    })

    it('offsets by the caller\'s cursor position', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      await store.listForBrain(ctxFor('t1'), '', 50, 120)
      expect(mockQuery.mock.calls[0][0] as string).toContain('OFFSET')
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'confidential', 50, 120])
    })

    it('floors a negative or fractional offset to zero-or-whole rows', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
      await store.listForBrain(ctxFor('t1'), '', 50, -5)
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'confidential', 50, 0])
      await store.listForBrain(ctxFor('t1'), '', 50, 10.7)
      expect(mockQuery.mock.calls[1][1]).toEqual(['t1', 'confidential', 50, 10])
    })

    it('runs FTS ranked by ts_rank_cd when query is non-empty', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'e1', title: 'Pricing', path: 'platform/pricing.md', sensitivity: 'internal' }],
        rowCount: 1,
      } as never)

      await store.listForBrain(ctxFor('t1'), 'pricing model', 20)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('plainto_tsquery')
      expect(sql).toContain('ts_rank_cd')
      // Same tiebreaker reasoning as the empty-query branch — `ts_rank_cd`
      // ties are common, so paging without it would repeat and skip rows.
      expect(sql).toContain('DESC, id')
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'pricing model', 'confidential', 20, 0])
    })
  })

  describe('listForGraph', () => {
    it('returns ranked rows with clearance-scoped relatedIds', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'e1', title: 'Identity', path: 'features/identity.md', sensitivity: 'confidential', relatedIds: ['e2'] },
          { id: 'e2', title: 'Memory', path: 'features/memory.md', sensitivity: 'internal', relatedIds: ['e1'] },
        ],
        rowCount: 2,
      } as never)

      const rows = await store.listForGraph(ctxFor('t1'), 500)
      expect(rows).toHaveLength(2)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('workspace_id = $1')
      expect(sql).toContain('sensitivity_rank(ke.sensitivity) <= sensitivity_rank($2)')
      expect(sql).toContain('sensitivity_rank(ke2.sensitivity) <= sensitivity_rank($2)')
      expect(sql).toContain('ORDER BY ke.updated_at DESC')
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'confidential', 500])
    })
  })

  describe('hasEntries', () => {
    it('returns true when entries exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 } as never)
      expect(await store.hasEntries(ctxFor('t1'))).toBe(true)
    })

    it('returns false when no entries', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 } as never)
      expect(await store.hasEntries(ctxFor('t1'))).toBe(false)
    })
  })

  describe('listPathsSystem', () => {
    it('lists all paths without clearance filter for sync worker', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ path: 'a' }, { path: 'b/c' }],
        rowCount: 2,
      } as never)

      const paths = await store.listPathsSystem('t1')
      expect(paths).toEqual(['a', 'b/c'])
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).not.toContain('sensitivity_rank')
      expect(sql).toContain('workspace_id = $1')
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1'])
    })
  })

  describe('getByPathSystem', () => {
    it('returns entry by path without clearance filter', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'e1', path: 'a/b', workspaceId: 't1' }],
        rowCount: 1,
      } as never)

      const entry = await store.getByPathSystem('t1', 'a/b')
      expect(entry?.id).toBe('e1')
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).not.toContain('sensitivity_rank')
      expect(sql).toContain('workspace_id = $1')
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'a/b'])
    })
  })

  describe('hasEntriesForAssistant', () => {
    it('joins assistants to find the team and checks entries', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 } as never)
      expect(await store.hasEntriesForAssistant('a1')).toBe(true)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('JOIN assistants')
      expect(sql).toContain('a.workspace_id = ke.workspace_id')
    })
  })
})

describe('[COMP:api/knowledge-store] sources', () => {
  describe('createSource', () => {
    it('inserts with defaults for branch and rootPath', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 's1', workspaceId: 't1', sourceType: 'github', repo: 'org/repo', branch: 'main', rootPath: '' }],
        rowCount: 1,
      } as never)

      const source = await store.createSource({ workspaceId: 't1', sourceType: 'github', repo: 'org/repo' })
      expect(source.repo).toBe('org/repo')
      // 6th param is the bound connector_instance_id — null when not supplied.
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'github', 'org/repo', 'main', '', null])
    })

    it('binds the picked connector_instance_id when supplied', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 's1', workspaceId: 't1', sourceType: 'github', repo: 'org/repo', connectorInstanceId: 'ci_1' }],
        rowCount: 1,
      } as never)

      await store.createSource({ workspaceId: 't1', sourceType: 'github', repo: 'org/repo', connectorInstanceId: 'ci_1' })
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'github', 'org/repo', 'main', '', 'ci_1'])
    })
  })

  describe('updateSourceSync', () => {
    it('updates sha and clears error on success', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never)
      await store.updateSourceSync('s1', 'abc123')
      expect(mockQuery.mock.calls[0][1]).toEqual(['abc123', null, 's1'])
    })

    it('stores error message on failure', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never)
      await store.updateSourceSync('s1', 'abc123', 'rate limit exceeded')
      expect(mockQuery.mock.calls[0][1]).toEqual(['abc123', 'rate limit exceeded', 's1'])
    })
  })

  describe('getSourcesDueForSync', () => {
    it('returns sources without the per-assistant fan-out array', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 's1', workspaceId: 't1', repo: 'org/kb' }],
        rowCount: 1,
      } as never)

      const sources = await store.getSourcesDueForSync()
      expect(sources[0]).not.toHaveProperty('assistantIds')
      expect(sources[0].workspaceId).toBe('t1')
    })
  })
})

describe('[COMP:api/knowledge-store] per-assistant source scoping', () => {
  describe('listDisabledSourceIds', () => {
    it('returns the source ids on the assistant denylist', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ source_id: 's1' }, { source_id: 's2' }],
        rowCount: 2,
      } as never)

      const ids = await store.listDisabledSourceIds('a1')
      expect(ids).toEqual(['s1', 's2'])
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('FROM assistant_disabled_knowledge_sources')
      expect(sql).toContain('assistant_id = $1')
      expect(mockQuery.mock.calls[0][1]).toEqual(['a1'])
    })

    it('returns an empty array when nothing is disabled', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      expect(await store.listDisabledSourceIds('a1')).toEqual([])
    })
  })

  describe('setSourceDisabled', () => {
    it('inserts a denylist row (ON CONFLICT DO NOTHING) when disabling', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never)
      await store.setSourceDisabled({ assistantId: 'a1', sourceId: 's1', disabled: true, userId: 'u1' })
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('INSERT INTO assistant_disabled_knowledge_sources')
      expect(sql).toContain('ON CONFLICT (assistant_id, source_id) DO NOTHING')
      expect(mockQuery.mock.calls[0][1]).toEqual(['a1', 's1', 'u1'])
    })

    it('deletes the denylist row when (re-)enabling', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never)
      await store.setSourceDisabled({ assistantId: 'a1', sourceId: 's1', disabled: false, userId: 'u1' })
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('DELETE FROM assistant_disabled_knowledge_sources')
      expect(mockQuery.mock.calls[0][1]).toEqual(['a1', 's1'])
    })
  })

  describe('read-path filter', () => {
    it('listByPath top-level excludes disabled sources and passes assistantId', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ path: 'index' }], rowCount: 1 } as never)
      await store.listByPath(ctxFor('t1'), '')
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('assistant_disabled_knowledge_sources')
      // Applied to both the row filter and the child-count subquery.
      expect(sql).toContain('adks.source_id = ke.source_id')
      expect(sql).toContain('adks.source_id = ke2.source_id')
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'confidential', 'a1'])
    })

    it('getByPath excludes disabled sources', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      await store.getByPath(ctxFor('t1'), 'products/vault')
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('adks.assistant_id = $4')
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'products/vault', 'confidential', 'a1'])
    })

    it('does NOT apply the denylist for a primary reflector context', async () => {
      // The brain explorer + workspace coordinator set assistantKind='primary'
      // and span every source — no denylist clause, no assistantId param.
      const primaryCtx: AccessContext = {
        workspaceId: 't1', userId: 'u1', assistantId: 'p1', assistantKind: 'primary', clearance: 'confidential',
      }
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      await store.search(primaryCtx, 'vault')
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).not.toContain('assistant_disabled_knowledge_sources')
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'vault', 10, 'confidential'])
    })
  })
})

describe('[COMP:api/kb-write-capability] source write-access cache', () => {
  it('updateSourceWriteAccess persists the probe result with a checked-at stamp', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.updateSourceWriteAccess('src1', true)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('SET write_access = $1')
    expect(sql).toContain('write_access_checked_at = now()')
    expect(mockQuery.mock.calls[0][1]).toEqual([true, 'src1'])
  })

  it('source reads carry the cached probe columns', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.listSourcesForAssistant('a1')
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('write_access AS "writeAccess"')
    expect(sql).toContain('write_access_checked_at AS "writeAccessCheckedAt"')
  })

  it('updateManualEntryContent is body-only and refuses repo-synced rows in the predicate', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'e1', path: 'notes/x' }], rowCount: 1 } as never)
    const updated = await store.updateManualEntryContent('t1', 'e1', 'New body')
    expect(updated).toEqual({ id: 'e1', path: 'notes/x' })
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('SET content = $1')
    expect(sql).toContain('source_id IS NULL')
    expect(sql).toContain('workspace_id = $3')
    // Body-only: no other column assignments besides updated_at.
    expect(sql).not.toContain('tags =')
    expect(sql).not.toContain('sensitivity =')
    expect(mockQuery.mock.calls[0][1]).toEqual(['New body', 'e1', 't1'])
  })

  it('updateManualEntryContent returns null when the id is not a manual entry in the workspace', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const updated = await store.updateManualEntryContent('t1', 'repo-entry', 'x')
    expect(updated).toBeNull()
  })
})

// ── Knowledge lifecycle events (the `knowledge` workflow event source) ──
//
// The store is the KB's write chokepoint — the sync worker, the assistant
// repo-writer's write-through, and manual writes all land here — so this is
// where lifecycle events are published. Spec:
// docs/architecture/features/workflow.md → "Knowledge event source".
describe('[COMP:api/knowledge-event-fanout] lifecycle emission', () => {
  const entryRow = {
    id: 'e1',
    workspaceId: 't1',
    path: 'products/vault',
    title: 'Vault',
    tags: ['pricing'],
    sensitivity: 'internal',
    sourceId: 'src1',
  }

  it('upsertByPath discriminates create from update with xmax and emits the matching action', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...entryRow, __inserted: true }], rowCount: 1 } as never)
    await store.upsertByPath({
      workspaceId: 't1', path: 'products/vault', title: 'Vault',
      content: 'body', sensitivity: 'internal', sourceId: 'src1',
    })
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('(xmax = 0) AS "__inserted"')
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ entryId: 'e1', action: 'created', workspaceId: 't1' })

    published.length = 0
    mockQuery.mockResolvedValueOnce({ rows: [{ ...entryRow, __inserted: false }], rowCount: 1 } as never)
    await store.upsertByPath({
      workspaceId: 't1', path: 'products/vault', title: 'Vault',
      content: 'body2', sensitivity: 'internal', sourceId: 'src1',
    })
    expect(published[0]).toMatchObject({ action: 'updated' })
  })

  it('strips the xmax discriminator from the returned entry', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...entryRow, __inserted: true }], rowCount: 1 } as never)
    const row = await store.upsertByPath({
      workspaceId: 't1', path: 'products/vault', title: 'Vault',
      content: 'body', sensitivity: 'internal',
    })
    expect(row).not.toHaveProperty('__inserted')
  })

  it('defaults to a user write, and relays writtenBy: system from the repo writer', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...entryRow, __inserted: false }], rowCount: 1 } as never)
    await store.upsertByPath({
      workspaceId: 't1', path: 'products/vault', title: 'Vault',
      content: 'b', sensitivity: 'internal',
    })
    // The sync worker mirroring a human push must NOT look bot-authored.
    expect(published[0].writtenBy).toBeUndefined()

    published.length = 0
    mockQuery.mockResolvedValueOnce({ rows: [{ ...entryRow, __inserted: false }], rowCount: 1 } as never)
    await store.upsertByPath({
      workspaceId: 't1', path: 'products/vault', title: 'Vault',
      content: 'b', sensitivity: 'internal', writtenBy: 'system', actorId: 'u9',
    })
    expect(published[0]).toMatchObject({ writtenBy: 'system', actorId: 'u9' })
  })

  it('updateManualEntryContent emits an assistant-authored update', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'm1', path: 'notes/x', title: 'X', tags: [], sensitivity: 'internal', sourceId: null }],
      rowCount: 1,
    } as never)
    await store.updateManualEntryContent('t1', 'm1', 'New body')
    expect(published[0]).toMatchObject({
      entryId: 'm1', action: 'updated', writtenBy: 'system', sourceId: null,
    })
  })

  it('deleteByTeamAndPath emits a delete carrying the removed row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [entryRow], rowCount: 1 } as never)
    await store.deleteByTeamAndPath('t1', 'products/vault')
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('RETURNING')
    expect(published[0]).toMatchObject({ entryId: 'e1', action: 'deleted', writtenBy: 'user' })
  })

  it('emits nothing when the delete matched no row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.deleteByTeamAndPath('t1', 'missing')
    expect(published).toHaveLength(0)
  })

  it('bulk teardown paths stay silent — a source disconnect is not N entry events', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 12 } as never)
    await store.deleteBySource('src1')
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 5 } as never)
    await store.deleteByTeamAndPathPrefix('t1', 'products/')
    expect(published).toHaveLength(0)
  })

  it('never puts the entry body on the event', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...entryRow, __inserted: true }], rowCount: 1 } as never)
    await store.upsertByPath({
      workspaceId: 't1', path: 'products/vault', title: 'Vault',
      content: 'SECRET BODY', sensitivity: 'confidential',
    })
    expect(JSON.stringify(published[0])).not.toContain('SECRET BODY')
  })
})
