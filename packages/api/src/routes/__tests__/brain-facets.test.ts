/**
 * Unit tests for the brain facets HTTP route.
 * Component tag: [COMP:brain/list-facets].
 *
 * Mocks the `query()` helper (workspace membership + clearance lookup),
 * the injected `retrievalStore`, and the `knowledgeStore`. Verifies the
 * auth/workspace guards (mirroring `/list`), the per-primitive presence
 * map (one `limit:1` empty-query probe per scope), the hard-coded
 * `sessions: false` v1 deferral, and the per-primitive error isolation
 * (a failing scope defaults to `false`, not a 500).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
}))

import { brainRoutes } from '../brain.js'
import { query } from '../../db/client.js'
import type {
  EntityLinksStore,
  EntityStore,
  RetrievalStore,
  SearchResultRow,
} from '@sidanclaw/core'

const mockQuery = vi.mocked(query)

const memberRow = { rows: [{ role: 'member' }], rowCount: 1 } as never
const noMemberRow = { rows: [], rowCount: 0 } as never
const assistantRow = {
  rows: [{ id: 'a-1', clearance: 'confidential' }],
  rowCount: 1,
} as never

function makeEntityStore(): EntityStore {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    findByName: vi.fn(),
    findByNameSystem: vi.fn(),
    findByCanonicalId: vi.fn(),
    findByCanonicalIdSystem: vi.fn(),
    listForWorkspace: vi.fn(),
    update: vi.fn(),
    getEntity: vi.fn(),
  } as unknown as EntityStore
}

function makeEntityLinksStore(): EntityLinksStore {
  return {
    create: async () => { throw new Error('not used in tests') },
    getById: async () => null,
    walkOutbound: async () => [],
    walkInbound: async () => [],
    countForEntity: async () => 0,
    listForWorkspace: async () => [],
    closeAt: async () => null,
    retract: async () => null,
  }
}

/**
 * Retrieval search stub that returns `data` keyed by the requested
 * `scope` — lets a test mark exactly which primitives are present.
 */
function makeRetrievalStore(
  byScope: Record<string, SearchResultRow[]> = {},
  failScopes: string[] = [],
): Pick<RetrievalStore, 'search'> {
  return {
    search: vi.fn(async (_ctx, input: { scope?: string }) => {
      const scope = input.scope ?? '__all__'
      if (failScopes.includes(scope)) throw new Error(`scope ${scope} blew up`)
      return { api_version: 'v1', data: byScope[scope] ?? [], meta: {} }
    }),
  } as unknown as Pick<RetrievalStore, 'search'>
}

function makeKnowledgeStore(
  rows: { id: string; title: string; path: string; sensitivity: string }[] = [],
  fail = false,
) {
  return {
    listForBrain: vi.fn(async () => {
      if (fail) throw new Error('knowledge probe blew up')
      return rows
    }),
    getById: vi.fn(async () => null),
    listForGraph: vi.fn(async () => []),
  }
}

function makeApp(
  retrievalStore: Pick<RetrievalStore, 'search'> = makeRetrievalStore(),
  knowledgeStore: ReturnType<typeof makeKnowledgeStore> = makeKnowledgeStore(),
) {
  const app = express()
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = 'u-1'
    next()
  })
  app.use(
    '/api/brain',
    brainRoutes({
      entitiesStore: makeEntityStore(),
      entityLinksStore: makeEntityLinksStore(),
      retrievalStore,
      knowledgeStore: knowledgeStore as unknown as Parameters<typeof brainRoutes>[0]['knowledgeStore'],
    }),
  )
  return app
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('[COMP:brain/list-facets] GET /api/brain/facets', () => {
  it('rejects requests without authenticated userId', async () => {
    const app = express()
    app.use(
      '/api/brain',
      brainRoutes({
        entitiesStore: makeEntityStore(),
        entityLinksStore: makeEntityLinksStore(),
        retrievalStore: makeRetrievalStore(),
        knowledgeStore: makeKnowledgeStore() as unknown as Parameters<typeof brainRoutes>[0]['knowledgeStore'],
      }),
    )
    await request(app).get('/api/brain/facets?workspaceId=ws-1').expect(401)
  })

  it('rejects requests missing workspaceId', async () => {
    const res = await request(makeApp()).get('/api/brain/facets').expect(400)
    expect(res.body.error).toMatch(/workspaceId/)
  })

  it('returns 404 when the user is not a workspace member', async () => {
    mockQuery.mockResolvedValueOnce(noMemberRow)
    await request(makeApp()).get('/api/brain/facets?workspaceId=ws-1').expect(404)
  })

  it('reports presence per primitive from limit:1 empty-query probes', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore({
      contact: [{ primitive: 'contact', row_id: 'c-1', name: 'Ada', sensitivity: 'internal' }],
      deal: [{ primitive: 'deal', row_id: 'd-1', sensitivity: 'internal' }],
      // company / memory / file / task scopes return empty → not present.
    })
    const knowledge = makeKnowledgeStore([
      { id: 'k-1', title: 'A doc', path: 'a.md', sensitivity: 'public' },
    ])
    const res = await request(makeApp(retrieval, knowledge))
      .get('/api/brain/facets?workspaceId=ws-1')
      .expect(200)

    expect(res.body).toEqual({
      present: {
        people: true,
        companies: false,
        deals: true,
        tasks: false,
        knowledge: true,
        memories: false,
        files: false,
        sessions: false,
      },
    })

    // Each search-scoped primitive is probed with an empty query, limit 1,
    // and a concrete scope (never an all-scopes call).
    const search = retrieval.search as ReturnType<typeof vi.fn>
    expect(search).toHaveBeenCalledTimes(6)
    for (const call of search.mock.calls) {
      expect(call[1]).toMatchObject({ query: '', limit: 1 })
      expect(typeof call[1].scope).toBe('string')
    }
    const probedScopes = search.mock.calls.map((c) => c[1].scope).sort()
    expect(probedScopes).toEqual(['company', 'contact', 'deal', 'file', 'memory', 'task'])
  })

  it('hard-codes sessions:false even when every other primitive is present', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore({
      contact: [{ primitive: 'contact', row_id: 'c', name: 'x', sensitivity: 'internal' }],
      company: [{ primitive: 'company', row_id: 'co', name: 'x', sensitivity: 'internal' }],
      deal: [{ primitive: 'deal', row_id: 'd', sensitivity: 'internal' }],
      memory: [{ primitive: 'memory', row_id: 'm', summary: 'x', sensitivity: 'internal' }],
      file: [{ primitive: 'file', row_id: 'f', title: 'x', sensitivity: 'internal' }],
      task: [{ primitive: 'task', row_id: 't', title: 'x', sensitivity: 'internal' }],
    })
    const knowledge = makeKnowledgeStore([
      { id: 'k-1', title: 'A doc', path: 'a.md', sensitivity: 'public' },
    ])
    const res = await request(makeApp(retrieval, knowledge))
      .get('/api/brain/facets?workspaceId=ws-1')
      .expect(200)
    expect(res.body.present.sessions).toBe(false)
    // Every other primitive resolves true.
    const { sessions, ...rest } = res.body.present as Record<string, boolean>
    expect(Object.values(rest).every((v) => v === true)).toBe(true)
  })

  it('defaults a primitive to false when its probe throws (no 500)', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore(
      { contact: [{ primitive: 'contact', row_id: 'c', name: 'x', sensitivity: 'internal' }] },
      ['file'], // the file-scope probe throws
    )
    const knowledge = makeKnowledgeStore([], true) // knowledge probe throws
    const res = await request(makeApp(retrieval, knowledge))
      .get('/api/brain/facets?workspaceId=ws-1')
      .expect(200)
    expect(res.body.present.people).toBe(true)
    expect(res.body.present.files).toBe(false)
    expect(res.body.present.knowledge).toBe(false)
  })
})
