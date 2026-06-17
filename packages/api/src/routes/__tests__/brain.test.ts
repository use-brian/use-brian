/**
 * Unit tests for the brain page HTTP route.
 * Component tag: [COMP:brain/entity-rollup-http].
 *
 * Mocks the `query()` helper (workspace membership + clearance lookup)
 * and the injected `entitiesStore`. Verifies the auth gate, the
 * web-shape projection, and the workspace-membership 404 response.
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
  EntityRecord,
  EntityRollup,
  EntityStore,
  RetrievalStore,
  SearchResultRow,
} from '@sidanclaw/core'

const mockQuery = vi.mocked(query)

// Confidential member so the read-side member bound (min(member, assistant))
// is a no-op in the assistant-resolution tests below — they assert the
// assistant-derived ceiling. The member-bound cap has its own test.
const memberRow = { rows: [{ role: 'member', clearance: 'confidential' }], rowCount: 1 } as never
const noMemberRow = { rows: [], rowCount: 0 } as never
// A low-clearance member, for the read-side clearance cap test.
const internalMemberRow = { rows: [{ role: 'member', clearance: 'internal' }], rowCount: 1 } as never
const assistantRow = {
  rows: [{ id: 'a-1', clearance: 'confidential' }],
  rowCount: 1,
} as never

const baseEntity = {
  id: 'e-1',
  workspaceId: 'ws-1',
  kind: 'person',
  source: 'user',
  canonicalId: null,
  displayName: 'Ada Lovelace',
  attributes: {},
  sensitivity: 'internal',
  userId: null,
  assistantId: null,
  validFrom: new Date('2026-01-01T00:00:00Z'),
  validTo: null,
  supersededBy: null,
  retractedAt: null,
  retractedReason: null,
  retractedBy: null,
  createdByUserId: 'u-1',
  createdByAssistantId: 'a-1',
  verifiedByUserId: null,
  verifiedAt: null,
  sourceEpisodeId: 'ep-1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
} as unknown as EntityRecord

function makeEntityStore(getEntityResult: EntityRollup | null): EntityStore {
  return {
    create: vi.fn(),
    getById: vi.fn(async (_ctx, _id) => baseEntity),
    findByName: vi.fn(),
    findByNameSystem: vi.fn(),
    findByCanonicalId: vi.fn(),
    findByCanonicalIdSystem: vi.fn(),
    listForWorkspace: vi.fn(),
    update: vi.fn(),
    getEntity: vi.fn(async () => getEntityResult),
  } as unknown as EntityStore
}

function makeRetrievalStore(rows: SearchResultRow[] = []): Pick<RetrievalStore, 'search'> {
  return {
    search: vi.fn(async () => ({ api_version: 'v1', data: rows, meta: {} })),
  } as unknown as Pick<RetrievalStore, 'search'>
}

type BrainKnowledgeRow = { id: string; title: string; path: string; sensitivity: 'public' | 'internal' | 'confidential' | 'restricted' }

type BrainKnowledgeGraphRow = BrainKnowledgeRow & { relatedIds: string[] }

function makeKnowledgeStore(
  rows: BrainKnowledgeRow[] = [],
  entry: Record<string, unknown> | null = null,
  graphRows: BrainKnowledgeGraphRow[] = [],
): {
  listForBrain: ReturnType<typeof vi.fn>
  getById: ReturnType<typeof vi.fn>
  listForGraph: ReturnType<typeof vi.fn>
  listByIds: ReturnType<typeof vi.fn>
  getSource: ReturnType<typeof vi.fn>
} {
  return {
    listForBrain: vi.fn(async () => rows),
    getById: vi.fn(async () => entry),
    listForGraph: vi.fn(async () => graphRows),
    // Entry-reader enrichment (related refs + source provenance) — empty
    // by default; the detail route degrades to `related: []` / `source: null`.
    listByIds: vi.fn(async () => []),
    getSource: vi.fn(async () => null),
  }
}

/**
 * Stub edge store — every method returns the empty / null path. The two
 * non-graph route tests never exercise edge IO, and the graph route
 * isn't covered by this suite yet; this just satisfies the type
 * contract so the routes mount.
 */
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

function makeApp(
  store: EntityStore,
  retrievalStore: Pick<RetrievalStore, 'search'> = makeRetrievalStore(),
  entityLinksStore: EntityLinksStore = makeEntityLinksStore(),
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
      entitiesStore: store,
      entityLinksStore,
      retrievalStore,
      knowledgeStore: knowledgeStore as unknown as Parameters<typeof brainRoutes>[0]['knowledgeStore'],
    }),
  )
  return app
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('[COMP:brain/entity-rollup-http] GET /api/brain/entities/:id', () => {
  it('rejects requests without authenticated userId', async () => {
    const app = express()
    app.use(
      '/api/brain',
      brainRoutes({ entitiesStore: makeEntityStore(null), entityLinksStore: makeEntityLinksStore(), retrievalStore: makeRetrievalStore(), knowledgeStore: makeKnowledgeStore() as unknown as Parameters<typeof brainRoutes>[0]['knowledgeStore'] }),
    )
    await request(app).get('/api/brain/entities/e-1?workspaceId=ws-1').expect(401)
  })

  it('rejects requests missing workspaceId', async () => {
    const app = makeApp(makeEntityStore(null))
    const res = await request(app).get('/api/brain/entities/e-1').expect(400)
    expect(res.body.error).toMatch(/workspaceId/)
  })

  it('returns 404 when the user is not a workspace member', async () => {
    mockQuery.mockResolvedValueOnce(noMemberRow)
    const app = makeApp(makeEntityStore(null))
    await request(app).get('/api/brain/entities/e-1?workspaceId=ws-1').expect(404)
  })

  it('returns 404 when getEntity returns null', async () => {
    mockQuery
      .mockResolvedValueOnce(memberRow)
      .mockResolvedValueOnce(assistantRow)
    const app = makeApp(makeEntityStore(null))
    await request(app).get('/api/brain/entities/missing?workspaceId=ws-1').expect(404)
  })

  it('projects the rollup to the web EntityRollup shape', async () => {
    mockQuery
      .mockResolvedValueOnce(memberRow)
      .mockResolvedValueOnce(assistantRow)

    const rollup: EntityRollup = {
      entity: baseEntity,
      summary: {
        edge_count: 1,
        memory_count: 3,
        episode_count: 5,
        open_task_count: 2,
        file_count: 1,
        kb_chunk_count: 4,
      },
      embedded: {
        edges: [
          {
            id: 'l-1',
            sourceKind: 'entity',
            sourceId: 'e-1',
            targetKind: 'entity',
            targetId: 'e-2',
            edgeType: 'mentioned',
          } as never,
        ],
        recent_episodes: [
          { id: 'ep-1', sourceKind: 'gmail', summaryText: 'hello', sensitivity: 'internal' },
        ],
        recent_memory: [
          {
            id: 'm-1',
            summary: 'Ada prefers Tuesday standups',
            sensitivity: 'internal',
            createdByUserId: 'u-1',
            createdByAssistantId: 'a-1',
          },
        ],
        open_tasks: [{ id: 't-1', title: 'Send proposal', status: 'open' }],
        files: [
          {
            id: 'f-1',
            name: 'deck.pdf',
            title: 'Pitch Deck',
            sensitivity: 'confidential',
          },
        ],
      },
    }
    const store = makeEntityStore(rollup)
    const app = makeApp(store)

    const res = await request(app)
      .get('/api/brain/entities/e-1?workspaceId=ws-1')
      .expect(200)

    expect(res.body.id).toBe('e-1')
    expect(res.body.kind).toBe('person')
    expect(res.body.name).toBe('Ada Lovelace')
    expect(res.body.sensitivity).toBe('internal')
    expect(res.body.authorship).toEqual({
      createdByUserId: 'u-1',
      createdByAssistantId: 'a-1',
      sourceEpisodeId: 'ep-1',
    })
    expect(res.body.summary).toEqual({
      memoriesCount: 3,
      tasksCount: 2,
      filesCount: 1,
      knowledgeCount: 4,
      episodesCount: 5,
    })

    expect(res.body.embedded.recentMemories).toEqual([
      {
        id: 'm-1',
        kind: 'memories',
        name: 'Ada prefers Tuesday standups',
        sensitivity: 'internal',
        createdByUserId: 'u-1',
        createdByAssistantId: 'a-1',
      },
    ])
    expect(res.body.embedded.openTasks).toEqual([
      { id: 't-1', kind: 'tasks', name: 'Send proposal' },
    ])
    expect(res.body.embedded.files).toEqual([
      { id: 'f-1', kind: 'files', name: 'Pitch Deck', sensitivity: 'confidential' },
    ])
    expect(res.body.embedded.recentEpisodes).toEqual([
      { id: 'ep-1', kind: 'sessions', name: 'hello', sensitivity: 'internal' },
    ])
    expect(res.body.embedded.edges).toEqual([
      { kind: 'mentioned', targetEntityId: 'e-2', targetName: 'Ada Lovelace' },
    ])
    expect(res.body.embedded.knowledge).toEqual([])
    expect(res.body.pendingChanges).toEqual([])
    // Empty `attributes` projects as `{}` — never undefined. The web
    // entity panel iterates this map; absence would break the render.
    expect(res.body.attributes).toEqual({})
  })

  it('projects self-entity attributes so the entity panel can render mig-176 identity data', async () => {
    // Regression guard for the gap that hid jackal.leung@deltadefi.io's
    // post-mig-176 identity from the UI. Mig 176 lifts identity-flavored
    // memory into `entities.attributes` on a `self=true` person entity;
    // without `attributes` in the rollup response there is no UI surface
    // that renders post-migration identity data.
    mockQuery
      .mockResolvedValueOnce(memberRow)
      .mockResolvedValueOnce(assistantRow)

    const selfEntity = {
      ...baseEntity,
      displayName: 'You',
      attributes: { self: true, name: 'Hinson', role: 'Founder' },
    } as unknown as EntityRecord

    const rollup: EntityRollup = {
      entity: selfEntity,
      summary: {
        edge_count: 0,
        memory_count: 0,
        episode_count: 0,
        open_task_count: 0,
        file_count: 0,
        kb_chunk_count: 0,
      },
      embedded: {
        edges: [],
        recent_episodes: [],
        recent_memory: [],
        open_tasks: [],
        files: [],
      },
    }

    const res = await request(makeApp(makeEntityStore(rollup)))
      .get('/api/brain/entities/e-1?workspaceId=ws-1')
      .expect(200)

    expect(res.body.attributes).toEqual({
      self: true,
      name: 'Hinson',
      role: 'Founder',
    })
  })

  it('falls back to internal clearance when the user has no assistant in the workspace', async () => {
    mockQuery
      .mockResolvedValueOnce(memberRow)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    const rollup: EntityRollup = {
      entity: baseEntity,
      summary: {
        edge_count: 0,
        memory_count: 0,
        episode_count: 0,
        open_task_count: 0,
        file_count: 0,
        kb_chunk_count: 0,
      },
      embedded: {
        edges: [],
        recent_episodes: [],
        recent_memory: [],
        open_tasks: [],
        files: [],
      },
    }
    const store = makeEntityStore(rollup)
    const getEntitySpy = store.getEntity as ReturnType<typeof vi.fn>

    await request(makeApp(store))
      .get('/api/brain/entities/e-1?workspaceId=ws-1')
      .expect(200)

    const [ctx] = getEntitySpy.mock.calls[0] as [{ clearance: string; assistantId: string }]
    expect(ctx.clearance).toBe('internal')
    expect(ctx.assistantId).toBe('00000000-0000-0000-0000-000000000000')
  })
})

describe('[COMP:brain/list-http] GET /api/brain/list', () => {
  it('rejects requests without authenticated userId', async () => {
    const app = express()
    app.use(
      '/api/brain',
      brainRoutes({ entitiesStore: makeEntityStore(null), entityLinksStore: makeEntityLinksStore(), retrievalStore: makeRetrievalStore(), knowledgeStore: makeKnowledgeStore() as unknown as Parameters<typeof brainRoutes>[0]['knowledgeStore'] }),
    )
    await request(app).get('/api/brain/list?workspaceId=ws-1').expect(401)
  })

  it('rejects requests missing workspaceId', async () => {
    const res = await request(makeApp(makeEntityStore(null)))
      .get('/api/brain/list')
      .expect(400)
    expect(res.body.error).toMatch(/workspaceId/)
  })

  it('returns 404 when the user is not a workspace member', async () => {
    mockQuery.mockResolvedValueOnce(noMemberRow)
    await request(makeApp(makeEntityStore(null)))
      .get('/api/brain/list?workspaceId=ws-1')
      .expect(404)
  })

  it('projects search rows into the web BrainRow shape', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore([
      { primitive: 'memory', row_id: 'm-1', summary: 'Likes Tuesday standups', sensitivity: 'internal' },
      { primitive: 'company', row_id: 'c-1', name: 'Acme', sensitivity: 'confidential' },
    ])
    const res = await request(makeApp(makeEntityStore(null), retrieval))
      .get('/api/brain/list?workspaceId=ws-1')
      .expect(200)
    expect(res.body).toEqual({
      results: [
        { id: 'm-1', kind: 'memories', name: 'Likes Tuesday standups', sensitivity: 'internal' },
        { id: 'c-1', kind: 'companies', name: 'Acme', sensitivity: 'confidential' },
      ],
      nextCursor: null,
    })
  })

  it('maps a kinds filter to a single retrieval scope', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore([])
    await request(makeApp(makeEntityStore(null), retrieval))
      .get('/api/brain/list?workspaceId=ws-1&kinds=memories')
      .expect(200)
    const search = retrieval.search as ReturnType<typeof vi.fn>
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][1]).toMatchObject({ scope: 'memory' })
  })

  it('always searches with semantic:false — the Brain search box is a literal filter', async () => {
    // Regression: with the vector arm on, an unscoped query that embeds near
    // the workspace's own topic (e.g. the workspace name) surfaced rows that
    // don't contain the text at all — "All + search" looked broken.
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore([])
    await request(makeApp(makeEntityStore(null), retrieval))
      .get('/api/brain/list?workspaceId=ws-1&q=sidan')
      .expect(200)
    const search = retrieval.search as ReturnType<typeof vi.fn>
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][1]).toMatchObject({ query: 'sidan', semantic: false })

    // Scoped variant carries it too.
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const scoped = makeRetrievalStore([])
    await request(makeApp(makeEntityStore(null), scoped))
      .get('/api/brain/list?workspaceId=ws-1&kinds=memories&q=sidan')
      .expect(200)
    expect((scoped.search as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      scope: 'memory',
      semantic: false,
    })
  })

  it('runs a single all-scopes search when kinds is absent', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore([])
    await request(makeApp(makeEntityStore(null), retrieval))
      .get('/api/brain/list?workspaceId=ws-1')
      .expect(200)
    const search = retrieval.search as ReturnType<typeof vi.fn>
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][1].scope).toBeUndefined()
  })

  // Bug A — browse "Files" (no search query) showed nothing. The route must
  // still issue a `scope='file'` search with an empty query and project the
  // returned rows as `kind:'files'` (the document-icon path). The empty-query
  // ILIKE fallback that actually returns files lives in `searchFilesScope`
  // (store-level; integration-tested) — here we assert the route wiring.
  it('Bug A: browse kinds=files (no q) issues a scope=file search and returns file rows', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore([
      {
        primitive: 'file',
        row_id: 'f1',
        title: 'Bug Report: Google Sheet Integration Issue',
        sensitivity: 'internal',
      } as SearchResultRow,
    ])
    const res = await request(makeApp(makeEntityStore(null), retrieval))
      .get('/api/brain/list?workspaceId=ws-1&kinds=files')
      .expect(200)
    const search = retrieval.search as ReturnType<typeof vi.fn>
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][1].scope).toBe('file')
    expect(search.mock.calls[0][1].query).toBe('')
    expect(res.body.results).toEqual([
      {
        id: 'f1',
        kind: 'files',
        name: 'Bug Report: Google Sheet Integration Issue',
        sensitivity: 'internal',
      },
    ])
  })

  // Bug B — search + a single primitive filter leaked all entry types. The
  // route must run ONLY the file scope (`scope='file'`), so every returned
  // row is a file. (The store-level vector-arm scope gate that fixes the
  // actual leak is covered by [COMP:retrieval/vector-scope-gate].)
  it('Bug B: search kinds=files runs only the file scope and returns only files', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore([
      {
        primitive: 'file',
        row_id: 'f1',
        title: 'Bug Report: Google Sheet Integration Issue',
        sensitivity: 'internal',
      } as SearchResultRow,
    ])
    const res = await request(makeApp(makeEntityStore(null), retrieval))
      .get('/api/brain/list?workspaceId=ws-1&kinds=files&q=bug')
      .expect(200)
    const search = retrieval.search as ReturnType<typeof vi.fn>
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][1].scope).toBe('file')
    expect(search.mock.calls[0][1].query).toBe('bug')
    expect(res.body.results.every((r: { kind: string }) => r.kind === 'files')).toBe(true)
  })

  it('returns empty for a sessions-only filter (no retrieval scope)', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore([])
    const res = await request(makeApp(makeEntityStore(null), retrieval))
      .get('/api/brain/list?workspaceId=ws-1&kinds=sessions')
      .expect(200)
    expect(res.body.results).toEqual([])
    expect(retrieval.search as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('returns empty for pending=true (v1 deferral)', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const res = await request(makeApp(makeEntityStore(null)))
      .get('/api/brain/list?workspaceId=ws-1&pending=true')
      .expect(200)
    expect(res.body.results).toEqual([])
  })

  it('caps clearance at the selected assistant when ?assistantId= is provided', async () => {
    // Floating-pill picker writes the selected assistant id; the brain
    // page forwards it. The route should look that assistant up by
    // (id, workspaceId) and use ITS clearance — picking a `public`
    // assistant must hide internal/confidential rows.
    mockQuery
      .mockResolvedValueOnce(memberRow)
      .mockResolvedValueOnce({
        rows: [{ id: 'a-public', clearance: 'public' }],
        rowCount: 1,
      } as never)
    const retrieval = makeRetrievalStore([
      { primitive: 'memory', row_id: 'm-1', summary: 'public-only', sensitivity: 'public' },
    ])
    await request(makeApp(makeEntityStore(null), retrieval))
      .get('/api/brain/list?workspaceId=ws-1&assistantId=a-public')
      .expect(200)
    // The selected-assistant query filters by both id AND workspace_id —
    // a cross-workspace id can't escape the workspace fence.
    const selectedCall = mockQuery.mock.calls[1]
    expect(selectedCall[0]).toMatch(/WHERE id = \$1 AND workspace_id = \$2/)
    expect(selectedCall[1]).toEqual(['a-public', 'ws-1'])
    // Only two queries: membership + selected assistant. No fallback
    // "highest-clearance" query when the selection resolved cleanly.
    expect(mockQuery.mock.calls).toHaveLength(2)
    // The retrieval store sees the selected assistant's clearance.
    const searchCtx = (retrieval.search as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { clearance: string }
    expect(searchCtx.clearance).toBe('public')
  })

  it('caps reads at the MEMBER clearance when it is below the assistant (incident 2026-06-01)', async () => {
    // A plain `internal` member selecting a `confidential` assistant must read
    // at min(member, assistant) = 'internal' — not the assistant's confidential.
    // Closes the read-side leak (the member would otherwise see confidential
    // brain rows through a higher-clearance assistant).
    mockQuery
      .mockResolvedValueOnce(internalMemberRow)
      .mockResolvedValueOnce({
        rows: [{ id: 'a-conf', clearance: 'confidential' }],
        rowCount: 1,
      } as never)
    const retrieval = makeRetrievalStore([])
    await request(makeApp(makeEntityStore(null), retrieval))
      .get('/api/brain/list?workspaceId=ws-1&assistantId=a-conf')
      .expect(200)
    const searchCtx = (retrieval.search as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { clearance: string }
    expect(searchCtx.clearance).toBe('internal')
  })

  it('falls back to the workspace-wide ceiling when the selected assistant is not in this workspace', async () => {
    // Workspace-switch race: the localStorage `active-assistant-id` may
    // still point at an assistant from the previous workspace. The
    // server should fall back to the workspace's highest-clearance
    // assistant rather than 500'ing or silently failing closed.
    mockQuery
      .mockResolvedValueOnce(memberRow)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 'a-high', clearance: 'confidential' }],
        rowCount: 1,
      } as never)
    const retrieval = makeRetrievalStore([])
    await request(makeApp(makeEntityStore(null), retrieval))
      .get('/api/brain/list?workspaceId=ws-1&assistantId=stale-from-other-ws')
      .expect(200)
    expect(mockQuery.mock.calls).toHaveLength(3)
    const searchCtx = (retrieval.search as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { clearance: string }
    expect(searchCtx.clearance).toBe('confidential')
  })

  it('resolves the viewpoint assistant by workspace, not owner_user_id', async () => {
    // A workspace whose only assistant is a migration-110 §8g
    // kind='primary' row has owner_user_id NULL. Keying the viewpoint
    // lookup on owner_user_id silently excludes it and the brain view
    // degrades to empty; the lookup must be workspace-scoped.
    mockQuery
      .mockResolvedValueOnce(memberRow)
      .mockResolvedValueOnce({
        rows: [{ id: 'primary-1', clearance: 'internal' }],
        rowCount: 1,
      } as never)
    const retrieval = makeRetrievalStore([
      { primitive: 'memory', row_id: 'm-1', summary: 'ported memory', sensitivity: 'internal' },
    ])
    const res = await request(makeApp(makeEntityStore(null), retrieval))
      .get('/api/brain/list?workspaceId=ws-1')
      .expect(200)
    expect(res.body.results).toEqual([
      { id: 'm-1', kind: 'memories', name: 'ported memory', sensitivity: 'internal' },
    ])
    // The assistant lookup carries no owner filter and is parameterized
    // on workspaceId alone.
    const assistantCall = mockQuery.mock.calls[1]
    expect(assistantCall[0]).not.toMatch(/owner_user_id/)
    expect(assistantCall[1]).toEqual(['ws-1'])
  })

  it('returns knowledge entries from knowledge_entries (not kb_chunks) when kinds=knowledge', async () => {
    // Regression: Brain previously mapped `knowledge` → `kb_chunks`
    // retrieval scope. github_sync only writes to `knowledge_entries`, so
    // every workspace with a synced KB saw an empty Brain. Read the doc-
    // level table directly. kb_chunks stays the substrate for the chat
    // `searchKnowledge` tool's chunk-granular RAG.
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore([])
    const knowledge = makeKnowledgeStore([
      { id: 'k-1', title: 'Pricing model', path: 'platform/pricing.md', sensitivity: 'internal' },
      { id: 'k-2', title: '', path: 'features/doc.md', sensitivity: 'public' },
    ])
    const res = await request(makeApp(makeEntityStore(null), retrieval, undefined, knowledge))
      .get('/api/brain/list?workspaceId=ws-1&kinds=knowledge')
      .expect(200)
    expect(res.body.results).toEqual([
      { id: 'k-1', kind: 'knowledge', name: 'Pricing model', sensitivity: 'internal' },
      { id: 'k-2', kind: 'knowledge', name: 'features/doc.md', sensitivity: 'public' },
    ])
    // Retrieval store is not consulted for knowledge — that path is for
    // chunk-granular semantic search, not the doc list view.
    expect(retrieval.search as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(knowledge.listForBrain).toHaveBeenCalledTimes(1)
  })

  it('includes knowledge entries alongside retrieval rows when kinds is absent', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore([
      { primitive: 'memory', row_id: 'm-1', summary: 'a memory', sensitivity: 'internal' },
    ])
    const knowledge = makeKnowledgeStore([
      { id: 'k-1', title: 'A doc', path: 'docs/a.md', sensitivity: 'public' },
    ])
    const res = await request(makeApp(makeEntityStore(null), retrieval, undefined, knowledge))
      .get('/api/brain/list?workspaceId=ws-1')
      .expect(200)
    expect(res.body.results).toEqual(
      expect.arrayContaining([
        { id: 'm-1', kind: 'memories', name: 'a memory', sensitivity: 'internal' },
        { id: 'k-1', kind: 'knowledge', name: 'A doc', sensitivity: 'public' },
      ]),
    )
    expect(knowledge.listForBrain).toHaveBeenCalledTimes(1)
  })

  it('skips the knowledge store when kinds does not include knowledge', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const retrieval = makeRetrievalStore([])
    const knowledge = makeKnowledgeStore([])
    await request(makeApp(makeEntityStore(null), retrieval, undefined, knowledge))
      .get('/api/brain/list?workspaceId=ws-1&kinds=memories')
      .expect(200)
    expect(knowledge.listForBrain).not.toHaveBeenCalled()
  })
})

describe('[COMP:brain/knowledge-detail-http] GET /api/brain/knowledge/:id', () => {
  it('returns the knowledge entry body when the viewer is a workspace member', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const entry = {
      id: 'k-1',
      workspaceId: 'ws-1',
      path: 'features/identity.md',
      title: 'Identity healing',
      summary: 'How identity merges work',
      content: '# Identity healing\n\nLong-form body…',
      tags: ['identity', 'merge'],
      sensitivity: 'confidential',
      sourceId: 's-1',
      sourceSha: 'abc123',
      createdAt: new Date('2026-05-01T00:00:00Z'),
      updatedAt: new Date('2026-05-20T00:00:00Z'),
    }
    const knowledge = makeKnowledgeStore([], entry)
    const res = await request(
      makeApp(makeEntityStore(null), makeRetrievalStore(), undefined, knowledge),
    )
      .get('/api/brain/knowledge/k-1?workspaceId=ws-1')
      .expect(200)
    expect(res.body).toMatchObject({
      id: 'k-1',
      path: 'features/identity.md',
      title: 'Identity healing',
      summary: 'How identity merges work',
      content: '# Identity healing\n\nLong-form body…',
      tags: ['identity', 'merge'],
      sensitivity: 'confidential',
    })
    expect(knowledge.getById).toHaveBeenCalledTimes(1)
  })

  it('404s when the entry belongs to a different workspace', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const knowledge = makeKnowledgeStore([], {
      id: 'k-1',
      workspaceId: 'other-ws',
      path: 'p.md',
      title: 't',
      summary: null,
      content: '',
      tags: [],
      sensitivity: 'public',
      sourceId: null,
      sourceSha: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await request(
      makeApp(makeEntityStore(null), makeRetrievalStore(), undefined, knowledge),
    )
      .get('/api/brain/knowledge/k-1?workspaceId=ws-1')
      .expect(404)
  })

  it('404s when the caller is not a workspace member', async () => {
    mockQuery.mockResolvedValueOnce(noMemberRow)
    const knowledge = makeKnowledgeStore([])
    await request(
      makeApp(makeEntityStore(null), makeRetrievalStore(), undefined, knowledge),
    )
      .get('/api/brain/knowledge/k-1?workspaceId=ws-1')
      .expect(404)
    expect(knowledge.getById).not.toHaveBeenCalled()
  })
})

describe('[COMP:brain/graph-http] GET /api/brain/graph — knowledge nodes + edges', () => {
  function makeEntityStoreWithList(entityRows: { id: string; kind: string; displayName: string; sensitivity: string }[]): EntityStore {
    return {
      create: vi.fn(),
      getById: vi.fn(async () => null),
      findByName: vi.fn(),
      findByNameSystem: vi.fn(),
      findByCanonicalId: vi.fn(),
      findByCanonicalIdSystem: vi.fn(),
      listForWorkspace: vi.fn(async () => entityRows as unknown as EntityRecord[]),
      update: vi.fn(),
      getEntity: vi.fn(),
    } as unknown as EntityStore
  }

  it('emits knowledge nodes + related_ids edges even when the workspace has no entities', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    const knowledge = makeKnowledgeStore([], null, [
      { id: 'k-1', title: 'Identity healing', path: 'features/identity.md', sensitivity: 'confidential', relatedIds: ['k-2'] },
      { id: 'k-2', title: 'Memory model', path: 'features/memory.md', sensitivity: 'internal', relatedIds: ['k-1'] },
      { id: 'k-3', title: '', path: 'docs/orphan.md', sensitivity: 'public', relatedIds: [] },
    ])
    const res = await request(makeApp(makeEntityStoreWithList([]), makeRetrievalStore(), undefined, knowledge))
      .get('/api/brain/graph?workspaceId=ws-1')
      .expect(200)
    expect(res.body.nodes).toEqual(
      expect.arrayContaining([
        { id: 'k-1', kind: 'knowledge', name: 'Identity healing', sensitivity: 'confidential', degree: 1 },
        { id: 'k-2', kind: 'knowledge', name: 'Memory model', sensitivity: 'internal', degree: 1 },
        { id: 'k-3', kind: 'knowledge', name: 'docs/orphan.md', sensitivity: 'public', degree: 0 },
      ]),
    )
    expect(res.body.edges).toHaveLength(1)
    expect(res.body.edges[0]).toMatchObject({
      type: 'related',
      sensitivity: 'confidential',
    })
    // Edge sensitivity should be the max of both endpoints (k-1 confidential, k-2 internal).
    expect([res.body.edges[0].source, res.body.edges[0].target].sort()).toEqual(['k-1', 'k-2'])
  })

  it('drops dangling related_ids pointing at filtered-out entries', async () => {
    mockQuery.mockResolvedValueOnce(memberRow).mockResolvedValueOnce(assistantRow)
    // k-1 points at k-2 which is NOT returned (clearance-filtered).
    const knowledge = makeKnowledgeStore([], null, [
      { id: 'k-1', title: 'a', path: 'a.md', sensitivity: 'public', relatedIds: ['k-2'] },
    ])
    const res = await request(makeApp(makeEntityStoreWithList([]), makeRetrievalStore(), undefined, knowledge))
      .get('/api/brain/graph?workspaceId=ws-1')
      .expect(200)
    expect(res.body.edges).toEqual([])
    expect(res.body.nodes).toHaveLength(1)
  })
})
