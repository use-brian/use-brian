/**
 * Cursor pagination for the Brain list route.
 * Component tag: [COMP:brain/list-http].
 *
 * `/list` reads from two independent arms - the retrieval fan-out (which has
 * its own opaque cursor over the Layer-3 ranked axis) and the knowledge table
 * (a plain offset) - so "where am I" is a composite. These tests pin the parts
 * that go wrong silently:
 *
 *  - an exhausted arm must DROP OUT, not restart at page 1 under every
 *    subsequent request (which would replay the same knowledge rows forever
 *    while retrieval paged onward);
 *  - `nextCursor` must come from the ARMS, not from `results.length`, because
 *    the `taskStatus` partition filters after the merge and can shrink a page
 *    while the underlying data continues - keying on page size would strand a
 *    user mid-dataset;
 *  - a page must be LOSSLESS: every row an arm returned is handed back, since
 *    the arm cursor has already advanced past it and no rewind is possible.
 *
 * Before this, the route hard-capped at 100 rows and always returned
 * `nextCursor: null`, so a workspace with thousands of entries showed 100 with
 * no way to reach the rest and no signal that anything was missing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../db/workspace-viewpoint.js', () => ({
  resolveWorkspaceViewpoint: vi.fn(),
}))
vi.mock('../../db/crm.js', () => ({
  listCompanies: vi.fn(),
  listContacts: vi.fn(),
  listDeals: vi.fn(),
}))

import { brainRoutes } from '../brain.js'
import { resolveWorkspaceViewpoint } from '../../db/workspace-viewpoint.js'

const mockResolve = vi.mocked(resolveWorkspaceViewpoint)
const CTX = { workspaceId: 'w1', userId: 'u1' } as any

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A retrieval row shaped so `projectSearchRow` keeps it: it dispatches on
 * `primitive` and reads `row_id`, so a row missing those is silently dropped
 * (which is exactly how the first draft of this file produced a passing-looking
 * but empty page).
 */
function searchRow(id: string) {
  return {
    row_id: id,
    primitive: 'memory',
    summary: `Memory ${id}`,
    sensitivity: 'internal',
  }
}

function knowledgeRow(id: string) {
  return { id, title: `Entry ${id}`, path: `kb/${id}.md`, sensitivity: 'internal' as const }
}

function makeApp(opts: {
  search: any
  listForBrain: any
}) {
  const router = brainRoutes({
    entitiesStore: {} as any,
    entityLinksStore: {} as any,
    retrievalStore: { search: opts.search } as any,
    knowledgeStore: {
      listForBrain: opts.listForBrain,
      getById: vi.fn(),
      listForGraph: vi.fn(),
      listByIds: vi.fn(),
      getSource: vi.fn(),
    } as any,
  })
  return createTestApp('/api/brain', router, { userId: 'u1' })
}

/** `search()` envelope with an optional next-cursor. */
function envelope(rows: unknown[], cursor: string | null) {
  return {
    api_version: 'v1',
    data: rows,
    meta: { retrieved_at: '2026-07-29T00:00:00.000Z', truncated: cursor !== null, cursor },
  }
}

describe('[COMP:brain/list-http] GET /api/brain/list cursor pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolve.mockResolvedValue(CTX)
  })

  it('returns a nextCursor while either arm has more', async () => {
    const search = vi.fn().mockResolvedValue(envelope([searchRow('a')], 'RETRIEVAL_P2'))
    const listForBrain = vi.fn().mockResolvedValue([])
    const res = await request(makeApp({ search, listForBrain })).get(
      '/api/brain/list?workspaceId=w1&limit=1',
    )
    expect(res.status).toBe(200)
    expect(res.body.nextCursor).toBeTruthy()
  })

  it('returns nextCursor null once every arm is exhausted', async () => {
    const search = vi.fn().mockResolvedValue(envelope([searchRow('a')], null))
    const listForBrain = vi.fn().mockResolvedValue([])
    const res = await request(makeApp({ search, listForBrain })).get(
      '/api/brain/list?workspaceId=w1&limit=10',
    )
    expect(res.body.nextCursor).toBeNull()
  })

  it('passes the arm cursor back into search() on the next page', async () => {
    const search = vi.fn().mockResolvedValue(envelope([searchRow('a')], 'RETRIEVAL_P2'))
    const listForBrain = vi.fn().mockResolvedValue([])
    const app = makeApp({ search, listForBrain })

    const first = await request(app).get('/api/brain/list?workspaceId=w1&limit=1')
    const cursor = first.body.nextCursor as string

    search.mockClear()
    await request(app).get(
      `/api/brain/list?workspaceId=w1&limit=1&cursor=${encodeURIComponent(cursor)}`,
    )
    // The route carries the arm's opaque cursor through without decoding it.
    expect(search.mock.calls[0][1]).toMatchObject({ cursor: 'RETRIEVAL_P2' })
  })

  it('advances the knowledge offset by the rows it consumed', async () => {
    const search = vi.fn().mockResolvedValue(envelope([], null))
    const listForBrain = vi.fn().mockResolvedValue([knowledgeRow('k1'), knowledgeRow('k2')])
    const app = makeApp({ search, listForBrain })

    const first = await request(app).get('/api/brain/list?workspaceId=w1&limit=2')
    expect(listForBrain.mock.calls[0][3]).toBe(0)

    const cursor = first.body.nextCursor as string
    expect(cursor).toBeTruthy()
    await request(app).get(
      `/api/brain/list?workspaceId=w1&limit=2&cursor=${encodeURIComponent(cursor)}`,
    )
    expect(listForBrain.mock.calls[1][3]).toBe(2)
  })

  it('drops an exhausted arm instead of restarting it every page', async () => {
    // Knowledge runs dry on page 1 (short page); retrieval keeps going.
    const search = vi.fn().mockResolvedValue(envelope([searchRow('a')], 'RETRIEVAL_P2'))
    const listForBrain = vi.fn().mockResolvedValue([knowledgeRow('k1')])
    const app = makeApp({ search, listForBrain })

    const first = await request(app).get('/api/brain/list?workspaceId=w1&limit=10')
    const cursor = first.body.nextCursor as string

    listForBrain.mockClear()
    const second = await request(app).get(
      `/api/brain/list?workspaceId=w1&limit=10&cursor=${encodeURIComponent(cursor)}`,
    )
    // Without the drop-out rule this would re-query knowledge at offset 0 and
    // replay `k1` on every subsequent page.
    expect(listForBrain).not.toHaveBeenCalled()
    expect(second.body.results.some((r: any) => r.id === 'k1')).toBe(false)
  })

  it('keeps every row both arms returned (no truncating slice)', async () => {
    // Both arms return a full page. The old `slice(0, limit)` would bin half of
    // them — unreachable forever, because the arm cursors moved past them.
    const search = vi
      .fn()
      .mockResolvedValue(envelope([searchRow('a'), searchRow('b')], 'RETRIEVAL_P2'))
    const listForBrain = vi.fn().mockResolvedValue([knowledgeRow('k1'), knowledgeRow('k2')])
    const res = await request(makeApp({ search, listForBrain })).get(
      '/api/brain/list?workspaceId=w1&limit=2',
    )
    expect(res.body.results).toHaveLength(4)
  })

  it('restarts from page one on a malformed cursor rather than erroring', async () => {
    const search = vi.fn().mockResolvedValue(envelope([searchRow('a')], null))
    const listForBrain = vi.fn().mockResolvedValue([])
    const res = await request(makeApp({ search, listForBrain })).get(
      '/api/brain/list?workspaceId=w1&limit=10&cursor=not-a-real-cursor',
    )
    // The token is opaque and only ever echoed by the client, so a bad one
    // means our encoding moved under a stale tab. Page 1 beats a 400.
    expect(res.status).toBe(200)
    expect(search.mock.calls[0][1].cursor).toBeUndefined()
  })
})
