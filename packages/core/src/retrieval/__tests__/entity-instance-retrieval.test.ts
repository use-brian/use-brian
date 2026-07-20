/**
 * Doc v1 — entity-instance retrieval surface.
 *
 * Component tag: [COMP:retrieval/entity-instance]
 *
 * Mock-store unit tests covering the new `primitive: 'entity_instance'`
 * value flowing through the existing 7-tool surface. The store-side SQL
 * lives in `packages/api/src/db/retrieval-store.ts` (search),
 * `aggregate-store.ts` (aggregate), and `provenance-store.ts` (probe);
 * integration coverage rides on the existing `*.integration.test.ts`
 * suites once they're updated.
 *
 * Spec: docs/architecture/brain/retrieval-layer.md +
 *       docs/plans/snuggly-noodling-tiger.md §"Brain-aware reads" +
 *       packages/api/migrations/200_doc_v1.sql (table shape).
 */

import { describe, it, expect } from 'vitest'
import { createRetrievalTools } from '../tools.js'
import type {
  AggregateData,
  EntityInstanceSearchRow,
  MarkUsefulData,
  ProvenanceData,
  RetrievalActor,
  RetrievalEnvelope,
  RetrievalStore,
  SearchData,
  SearchResultRow,
} from '../types.js'
import type { ToolContext } from '../../tools/types.js'

const WORKSPACE_ID = 'ws-1'
const USER_ID = 'user-1'
const ASSISTANT_ID = 'asst-1'
const ENTITY_TYPE_ID = '11111111-1111-4111-8111-111111111111'
const ENTITY_INSTANCE_ID = '22222222-2222-4222-8222-222222222222'

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: USER_ID,
    assistantId: ASSISTANT_ID,
    sessionId: 'sess-1',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'web-1',
    workspaceId: WORKSPACE_ID,
    abortSignal: new AbortController().signal,
    clearance: 'internal',
    ...overrides,
  }
}

function envelope<T>(data: T): RetrievalEnvelope<T> {
  return {
    api_version: 'v1',
    data,
    meta: {
      retrieved_at: '2026-05-28T00:00:00.000Z',
      truncated: false,
      cursor: null,
    },
  }
}

type StoreCalls = {
  search: Array<{ actor: RetrievalActor; input: unknown }>
  aggregate: Array<{ actor: RetrievalActor; input: unknown }>
  provenance: Array<{ actor: RetrievalActor; input: unknown }>
  markUseful: Array<{ actor: RetrievalActor; input: unknown }>
  getEntity: Array<{ actor: RetrievalActor; input: unknown }>
  recentEpisodes: Array<{ actor: RetrievalActor; input: unknown }>
  getRowHistory: Array<{ actor: RetrievalActor; input: unknown }>
}

function entityInstanceRow(overrides: Partial<EntityInstanceSearchRow> = {}): SearchResultRow {
  return {
    primitive: 'entity_instance',
    row_id: ENTITY_INSTANCE_ID,
    entity_type_id: ENTITY_TYPE_ID,
    workspace_id: WORKSPACE_ID,
    title: 'The Matrix',
    created_at: '2026-05-20T00:00:00.000Z',
    source_app: 'doc',
    ...overrides,
  }
}

/**
 * Build a fake store that surfaces entity-instance rows for the
 * `Movies` query and matches one row by id for `provenance`. The
 * `aggregate` arm returns a single grouped row that mirrors what a
 * `(rating, entity_type_id)` measure would emit.
 */
function makeStoreThatKnowsEntityInstances(): { store: RetrievalStore; calls: StoreCalls } {
  const calls: StoreCalls = {
    search: [],
    aggregate: [],
    provenance: [],
    markUseful: [],
    getEntity: [],
    recentEpisodes: [],
    getRowHistory: [],
  }

  const store: RetrievalStore = {
    async getEntity(actor, input) {
      calls.getEntity.push({ actor, input })
      return null
    },
    async search(actor, input) {
      calls.search.push({ actor, input })
      const data: SearchData = [entityInstanceRow()]
      return envelope(data)
    },
    async recentEpisodes(actor, input) {
      calls.recentEpisodes.push({ actor, input })
      return envelope([])
    },
    async provenance(actor, input) {
      calls.provenance.push({ actor, input })
      // Mirror the entity-instance provenance shape: `source` is the
      // source_app (`'doc'`), no source_episode, no derivation,
      // no re-extraction history.
      const data: ProvenanceData = {
        row_id: (input as { row_id: string }).row_id,
        primitive: 'entity_instances',
        source_episode: null,
        authorship: {
          created_by_user_id: USER_ID,
          created_by_assistant_id: null,
          created_at: '2026-05-20T00:00:00.000Z',
        },
        derived_from: [],
        supersession: {
          preceded_by: null,
          superseded_by: null,
          valid_from: '2026-05-20T00:00:00.000Z',
          valid_to: null,
        },
        re_extracted_at: [],
      }
      return envelope(data)
    },
    async markUseful(actor, input) {
      calls.markUseful.push({ actor, input })
      const data: MarkUsefulData = { success: true }
      return envelope(data)
    },
    async aggregate(actor, input) {
      calls.aggregate.push({ actor, input })
      // Mirror an `entity_instances` aggregate keyed by `entity_type_id`
      // with a `sum` measure over `data->>'rating'::numeric`.
      const data: AggregateData = [
        { entity_type_id: ENTITY_TYPE_ID, measure_value: 42 },
      ]
      return envelope(data)
    },
    async getRowHistory(actor, input) {
      calls.getRowHistory.push({ actor, input })
      return envelope({ chain: [], current_id: null })
    },
  }

  return { store, calls }
}

describe('[COMP:retrieval/entity-instance] search', () => {
  it('returns entity_instance rows with the doc-side shape', async () => {
    const { store } = makeStoreThatKnowsEntityInstances()
    const tools = createRetrievalTools(store)

    const result = await tools.search.execute(
      { query: 'Matrix' },
      makeContext(),
    )

    expect(result.isError).toBeUndefined()
    const env = result.data as RetrievalEnvelope<SearchData>
    expect(env.data).toHaveLength(1)
    const row = env.data[0]!
    expect(row.primitive).toBe('entity_instance')
    expect(row.row_id).toBe(ENTITY_INSTANCE_ID)
    expect(row.entity_type_id).toBe(ENTITY_TYPE_ID)
    expect(row.workspace_id).toBe(WORKSPACE_ID)
    expect(row.title).toBe('The Matrix')
    expect(row.source_app).toBe('doc')
  })

  it('propagates scope=entity_instance and entity_type_id filter to the store', async () => {
    const { store, calls } = makeStoreThatKnowsEntityInstances()
    const tools = createRetrievalTools(store)

    await tools.search.execute(
      {
        query: 'Matrix',
        scope: 'entity_instance',
        filters: { entity_type_id: ENTITY_TYPE_ID },
      },
      makeContext(),
    )

    expect(calls.search).toHaveLength(1)
    expect(calls.search[0]!.input).toMatchObject({
      query: 'Matrix',
      scope: 'entity_instance',
      filters: { entity_type_id: ENTITY_TYPE_ID },
    })
  })

  it('mixes entity_instance rows alongside brain primitives in unscoped search', async () => {
    const calls: StoreCalls = {
      search: [],
      aggregate: [],
      provenance: [],
      markUseful: [],
      getEntity: [],
      recentEpisodes: [],
      getRowHistory: [],
    }
    const store: RetrievalStore = {
      async getEntity() { return null },
      async search(actor, input) {
        calls.search.push({ actor, input })
        // Heterogeneous result: a brain memory + a doc entity row.
        const data: SearchData = [
          { primitive: 'memory', row_id: 'mem-1', summary: 'note about Matrix' },
          entityInstanceRow(),
        ]
        return envelope(data)
      },
      async recentEpisodes() { return envelope([]) },
      async provenance() { return null },
      async markUseful() { return envelope({ success: true }) },
      async aggregate() { return envelope([]) },
      async getRowHistory() { return null },
    }
    const tools = createRetrievalTools(store)

    const result = await tools.search.execute({ query: 'Matrix' }, makeContext())
    const env = result.data as RetrievalEnvelope<SearchData>
    expect(env.data.map((r) => r.primitive)).toEqual(['memory', 'entity_instance'])
  })
})

describe('[COMP:retrieval/entity-instance] aggregate', () => {
  it('routes a sum-over-rating aggregate to the entity_instances primitive', async () => {
    const { store, calls } = makeStoreThatKnowsEntityInstances()
    const tools = createRetrievalTools(store)

    const result = await tools.aggregate.execute(
      {
        measure: { fn: 'sum', path: 'rating' },
        dimensions: ['entity_type_id'],
        filters: { primitive: 'entity_instances', entity_type_id: ENTITY_TYPE_ID },
      },
      makeContext(),
    )

    expect(result.isError).toBeUndefined()
    const env = result.data as RetrievalEnvelope<AggregateData>
    expect(env.data).toHaveLength(1)
    expect(env.data[0]!.measure_value).toBe(42)
    expect(env.data[0]!.entity_type_id).toBe(ENTITY_TYPE_ID)
    expect(calls.aggregate).toHaveLength(1)
    expect(calls.aggregate[0]!.input).toMatchObject({
      measure: { fn: 'sum', path: 'rating' },
      filters: { primitive: 'entity_instances', entity_type_id: ENTITY_TYPE_ID },
    })
  })

  it('accepts count-only measures for entity instances', async () => {
    const { store } = makeStoreThatKnowsEntityInstances()
    const tools = createRetrievalTools(store)

    const result = await tools.aggregate.execute(
      {
        measure: { fn: 'count' },
        dimensions: ['entity_type_id'],
        filters: { primitive: 'entity_instances' },
      },
      makeContext(),
    )

    expect(result.isError).toBeUndefined()
  })
})

describe('[COMP:retrieval/entity-instance] provenance', () => {
  it('returns the entity-instance authorship + supersession profile', async () => {
    const { store } = makeStoreThatKnowsEntityInstances()
    const tools = createRetrievalTools(store)

    const result = await tools.provenance.execute(
      { row_id: ENTITY_INSTANCE_ID },
      makeContext(),
    )

    expect(result.isError).toBeUndefined()
    const env = result.data as RetrievalEnvelope<ProvenanceData>
    expect(env.data.row_id).toBe(ENTITY_INSTANCE_ID)
    expect(env.data.primitive).toBe('entity_instances')
    expect(env.data.source_episode).toBeNull()
    expect(env.data.derived_from).toEqual([])
    expect(env.data.supersession.superseded_by).toBeNull()
    expect(env.data.supersession.valid_to).toBeNull()
    expect(env.data.re_extracted_at).toEqual([])
    expect(env.data.authorship.created_by_user_id).toBe(USER_ID)
  })
})

describe('[COMP:retrieval/entity-instance] markUseful', () => {
  it('accepts the existing `entity` primitive enum (markUseful interface stays frozen)', async () => {
    // The tool's primitive enum is locked at `'memory' | 'entity' |
    // 'edge' | 'task' | 'kb_chunk'`. Entity instances ride the `entity`
    // value — the store's markUseful currently silent-accepts that
    // primitive (no `useful_recall_count` column yet on either the
    // brain-anchor entity table or the doc entity-instances table).
    const { store, calls } = makeStoreThatKnowsEntityInstances()
    const tools = createRetrievalTools(store)

    const result = await tools.markUseful.execute(
      { row_id: ENTITY_INSTANCE_ID, primitive: 'entity' },
      makeContext(),
    )

    expect(result.isError).toBeUndefined()
    const env = result.data as RetrievalEnvelope<MarkUsefulData>
    expect(env.data.success).toBe(true)
    expect(calls.markUseful).toHaveLength(1)
  })
})
