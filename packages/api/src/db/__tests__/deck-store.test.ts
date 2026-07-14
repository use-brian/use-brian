import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilesContext } from '@sidanclaw/core'

// Unit-level store test: `query` and the SSE notify are mocked so no pg /
// LISTEN infra is needed — what's under test is the store's row mapping,
// the version-guarded UPDATE conflict discrimination, and that create/update
// emit the `deck` workspace event (the live preview's refresh signal).
vi.mock('../client.js', () => ({ query: vi.fn() }))
vi.mock('../../brain-stream/notify.js', () => ({ notifyWorkspaceChange: vi.fn() }))

const { query } = await import('../client.js')
const { notifyWorkspaceChange } = await import('../../brain-stream/notify.js')
const { createDeckStore } = await import('../deck-store.js')

const queryMock = vi.mocked(query)
const notifyMock = vi.mocked(notifyWorkspaceChange)

const ctx = { workspaceId: 'ws-1', userId: 'user-1' } as FilesContext

const ROW = {
  id: 'deck-1',
  workspace_id: 'ws-1',
  title: 'Deck',
  spec: { title: 'Deck', slides: [{ title: 'S', bullets: ['b'] }] },
  style: null,
  style_source: null,
  file_path: 'decks/deck-1.pptx',
  version: 4,
  created_by: 'user-1',
  created_at: new Date('2026-07-14T00:00:00Z'),
  updated_at: new Date('2026-07-14T01:00:00Z'),
}

describe('[COMP:api/deck-store] Deck store', () => {
  beforeEach(() => {
    queryMock.mockReset()
    notifyMock.mockReset()
  })

  it('create inserts with ctx-derived workspace/user scoping and emits deck:create', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...ROW, version: 1 }] } as never)
    const record = await createDeckStore().create(ctx, {
      id: 'deck-1',
      title: 'Deck',
      spec: ROW.spec,
      style: null,
      styleSource: null,
      filePath: 'decks/deck-1.pptx',
    })
    expect(record.version).toBe(1)
    expect(record.workspaceId).toBe('ws-1')
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('INSERT INTO workspace_decks')
    expect(params?.[1]).toBe('ws-1') // workspace from ctx, never tool input
    expect(params?.[7]).toBe('user-1')
    expect(notifyMock).toHaveBeenCalledWith('ws-1', 'deck', 'create', 'deck-1')
  })

  it('update returns the bumped record and emits deck:update on version match', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...ROW, version: 5 }] } as never)
    const result = await createDeckStore().update(ctx, 'deck-1', {
      title: 'Deck',
      spec: ROW.spec,
      style: null,
      styleSource: null,
      expectedVersion: 4,
    })
    expect(result).toMatchObject({ id: 'deck-1', version: 5 })
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('version = version + 1')
    expect(sql).toContain('AND version = $7')
    expect(params?.[6]).toBe(4)
    expect(notifyMock).toHaveBeenCalledWith('ws-1', 'deck', 'update', 'deck-1')
  })

  it('update discriminates version_conflict (row exists) from null (row gone), emitting nothing', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] } as never) // guarded UPDATE missed
      .mockResolvedValueOnce({ rows: [{ id: 'deck-1' }] } as never) // …but the row exists
    const conflict = await createDeckStore().update(ctx, 'deck-1', {
      title: 'Deck',
      spec: ROW.spec,
      style: null,
      styleSource: null,
      expectedVersion: 3,
    })
    expect(conflict).toBe('version_conflict')

    queryMock
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
    const gone = await createDeckStore().update(ctx, 'deck-1', {
      title: 'Deck',
      spec: ROW.spec,
      style: null,
      styleSource: null,
      expectedVersion: 3,
    })
    expect(gone).toBeNull()
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('get scopes by ctx workspace; listSystem derives slideCount incl. the auto title slide', async () => {
    queryMock.mockResolvedValueOnce({ rows: [ROW] } as never)
    const record = await createDeckStore().get(ctx, 'deck-1')
    expect(record?.styleSource).toBeNull()
    expect(queryMock.mock.calls[0][1]).toEqual(['deck-1', 'ws-1'])

    queryMock.mockResolvedValueOnce({ rows: [ROW] } as never)
    const list = await createDeckStore().listSystem('ws-1')
    expect(list[0]).toMatchObject({ id: 'deck-1', slideCount: 2, version: 4 })
    expect(list[0].updatedAt).toBe('2026-07-14T01:00:00.000Z')
  })
})
