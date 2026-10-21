import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AccessContext } from '@use-brian/core'

const { resourceQuery } = vi.hoisted(() => ({ resourceQuery: vi.fn() }))
vi.mock('../client.js', () => {
  const transactionQuery = async (sql: string, values?: unknown[]) => {
    if (sql.includes("current_setting('app.system_bypass'")) return { rows: [{ value: 'false' }] }
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('set_config') || sql.includes('FROM workspaces WHERE id=')) return { rows: [] }
    if (sql.trimStart().startsWith('SELECT') && sql.includes('FROM workspace_access_policies')) return { rows: [] }
    return resourceQuery(sql, values)
  }
  const pool = { connect: async () => ({ query: transactionQuery, release: vi.fn() }) }
  return {
    query: (sql: string, values?: unknown[]) => sql.includes("SELECT setup_state='ready'") ? Promise.resolve({ rows: [] }) : resourceQuery(sql, values),
    queryWithRLS: vi.fn(), getPool: () => pool, getAppPool: () => pool,
    applyRLSGucs: vi.fn(), rollbackAndRelease: vi.fn(),
  }
})

// Capture the `knowledge` workflow-event-source emissions the store publishes.
const { published } = vi.hoisted(() => ({ published: [] as Array<Record<string, unknown>> }))
vi.mock('../../knowledge-event-fanout.js', () => ({
  publishKnowledgeLifecycle: (event: Record<string, unknown>) => {
    published.push(event)
  },
}))

import { createDbKnowledgeStore } from '../knowledge-store.js'

const mockQuery = resourceQuery
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

// Viewer query-construction cases now execute against real non-owner SQL in
// application-platform/__tests__/knowledge-query-shape.integration.test.ts.
// No mocked canonical domain or current admission is introduced here.
beforeEach(() => {
  vi.clearAllMocks()
  published.length = 0
})

describe('[COMP:api/knowledge-store] entries', () => {


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
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'github', 'org/repo', 'main', '', null, null, null, null, null])
    })

    it('binds the picked connector_instance_id when supplied', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 's1', workspaceId: 't1', sourceType: 'github', repo: 'org/repo', connectorInstanceId: 'ci_1' }],
        rowCount: 1,
      } as never)

      await store.createSource({ workspaceId: 't1', sourceType: 'github', repo: 'org/repo', connectorInstanceId: 'ci_1' })
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'github', 'org/repo', 'main', '', 'ci_1', null, null, null, null])
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
    expect(mockQuery.mock.calls[0][1]).toEqual(['New body', 'e1', 't1', [], []])
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
      content: 'body', sensitivity: 'internal',
    })
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('(xmax = 0) AS "__inserted"')
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ entryId: 'e1', action: 'created', workspaceId: 't1' })

    published.length = 0
    mockQuery.mockResolvedValueOnce({ rows: [{ ...entryRow, __inserted: false }], rowCount: 1 } as never)
    await store.upsertByPath({
      workspaceId: 't1', path: 'products/vault', title: 'Vault',
      content: 'body2', sensitivity: 'internal',
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

  it.each(['products/vault', 'missing'])('rejects an unfenced sync deletion (%s) without SQL or events', async path => {
    await expect(store.deleteByTeamAndPath('t1', path)).rejects.toThrow('knowledge_sync_authority_required')
    expect(mockQuery).not.toHaveBeenCalled()
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
