import { describe, it, expect } from 'vitest'
import { createRetrievalTools } from '../tools.js'
import type {
  AggregateData,
  GetEntityData,
  MarkUsefulData,
  ProvenanceData,
  RecentEpisodesData,
  RetrievalActor,
  RetrievalEnvelope,
  RetrievalStore,
  RetrievalToolEvent,
  SearchData,
} from '../types.js'
import type { ToolContext } from '../../tools/types.js'

const WORKSPACE_ID = 'ws-1'
const USER_ID = 'user-1'
const ASSISTANT_ID = 'asst-1'

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: USER_ID,
    assistantId: ASSISTANT_ID,
    sessionId: 'sess-1',
    appId: 'sidanclaw',
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
      retrieved_at: '2026-05-14T00:00:00.000Z',
      truncated: false,
      cursor: null,
    },
  }
}

type StoreCalls = {
  getEntity: Array<{ actor: RetrievalActor; input: unknown }>
  search: Array<{ actor: RetrievalActor; input: unknown }>
  recentEpisodes: Array<{ actor: RetrievalActor; input: unknown }>
  provenance: Array<{ actor: RetrievalActor; input: unknown }>
  markUseful: Array<{ actor: RetrievalActor; input: unknown }>
  aggregate: Array<{ actor: RetrievalActor; input: unknown }>
  getRowHistory: Array<{ actor: RetrievalActor; input: unknown }>
}

function makeFakeStore(): { store: RetrievalStore; calls: StoreCalls } {
  const calls: StoreCalls = {
    getEntity: [],
    search: [],
    recentEpisodes: [],
    provenance: [],
    markUseful: [],
    aggregate: [],
    getRowHistory: [],
  }

  const sampleEntity: GetEntityData = {
    entity: {
      id: 'e-1',
      kind: 'company',
      displayName: 'Acme',
      canonicalId: null,
      aliases: [],
      attributes: {},
      sensitivity: 'internal',
      workspaceId: WORKSPACE_ID,
      userId: null,
      assistantId: null,
      createdByUserId: USER_ID,
      createdByAssistantId: null,
      sourceEpisodeId: null,
      source: 'user',
      verifiedByUserId: null,
      verifiedAt: null,
      validFrom: new Date('2026-05-01T00:00:00.000Z'),
      validTo: null,
      supersededBy: null,
      retractedAt: null,
      retractedReason: null,
      retractedBy: null,
      centrality: 0,
      centralityComputedAt: null,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    },
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

  const store: RetrievalStore = {
    async getEntity(actor, input) {
      calls.getEntity.push({ actor, input })
      return envelope(sampleEntity)
    },
    async search(actor, input) {
      calls.search.push({ actor, input })
      const data: SearchData = [
        { primitive: 'memory', row_id: 'mem-1' },
        { primitive: 'entity', row_id: 'ent-1' },
      ]
      return {
        api_version: 'v1',
        data,
        meta: {
          retrieved_at: '2026-05-14T00:00:00.000Z',
          truncated: false,
          cursor: 'next-cursor',
        },
      }
    },
    async recentEpisodes(actor, input) {
      calls.recentEpisodes.push({ actor, input })
      const data: RecentEpisodesData = [
        {
          id: 'ep-1',
          source_kind: 'web_chat',
          occurred_at: '2026-05-13T00:00:00.000Z',
          sensitivity: 'internal',
        },
      ]
      return envelope(data)
    },
    async provenance(actor, input) {
      calls.provenance.push({ actor, input })
      const data: ProvenanceData = {
        row_id: (input as { row_id: string }).row_id,
        primitive: 'memory',
        source_episode: null,
        authorship: {
          created_by_user_id: USER_ID,
          created_by_assistant_id: null,
          created_at: '2026-05-01T00:00:00.000Z',
        },
        derived_from: [],
        supersession: {
          preceded_by: null,
          superseded_by: null,
          valid_from: '2026-05-01T00:00:00.000Z',
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
      const data: AggregateData = [
        { entity_id: 'e-1', quarter: '2026-Q2', measure_value: 42 },
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

describe('[COMP:retrieval/tool-surface] createRetrievalTools', () => {
  describe('factory shape + safety flags', () => {
    const { store } = makeFakeStore()
    const tools = createRetrievalTools(store)

    it('returns the 7 named tools', () => {
      expect(tools.getEntity.name).toBe('getEntity')
      expect(tools.search.name).toBe('search')
      expect(tools.recentEpisodes.name).toBe('recentEpisodes')
      expect(tools.provenance.name).toBe('provenance')
      expect(tools.markUseful.name).toBe('markUseful')
      expect(tools.aggregate.name).toBe('aggregate')
      expect(tools.getRowHistory.name).toBe('getRowHistory')
    })

    it('flags reads as concurrency-safe + read-only', () => {
      for (const t of [tools.getEntity, tools.search, tools.recentEpisodes, tools.provenance, tools.aggregate, tools.getRowHistory]) {
        expect(t.isReadOnly).toBe(true)
        expect(t.isConcurrencySafe).toBe(true)
        expect(t.requiresConfirmation).toBe(false)
      }
    })

    it('flags markUseful as idempotent write', () => {
      expect(tools.markUseful.isReadOnly).toBe(false)
      expect(tools.markUseful.isConcurrencySafe).toBe(true)
      expect(tools.markUseful.requiresConfirmation).toBe(false)
    })
  })

  describe('getEntity', () => {
    it('delegates to store with actor + input and returns the envelope', async () => {
      const { store, calls } = makeFakeStore()
      const events: RetrievalToolEvent[] = []
      const tools = createRetrievalTools(store, { onEvent: (e) => events.push(e) })

      const result = await tools.getEntity.execute({ id_or_name: 'Acme' }, makeContext())

      expect(calls.getEntity).toHaveLength(1)
      expect(calls.getEntity[0]!.actor).toEqual({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        assistantId: ASSISTANT_ID,
        assistantKind: 'standard',
        clearance: 'internal',
      })
      expect(calls.getEntity[0]!.input).toEqual({ id_or_name: 'Acme' })
      expect(result.isError).toBeUndefined()
      const envelopeOut = result.data as RetrievalEnvelope<GetEntityData>
      expect(envelopeOut.api_version).toBe('v1')
      expect(envelopeOut.data.entity.id).toBe('e-1')
      expect(typeof envelopeOut.meta.retrieved_at).toBe('string')
      expect(events).toEqual([{ type: 'entity_retrieved', idOrName: 'Acme', found: true }])
    })

    it('returns an error body when the store returns null', async () => {
      const store: RetrievalStore = {
        ...makeFakeStore().store,
        async getEntity() {
          return null
        },
      }
      const tools = createRetrievalTools(store)
      const result = await tools.getEntity.execute({ id_or_name: 'missing' }, makeContext())
      expect(result.isError).toBe(true)
      expect((result.data as { error: string }).error).toContain('missing')
    })

    it('rejects input missing id_or_name', () => {
      const { store } = makeFakeStore()
      const tools = createRetrievalTools(store)
      const parsed = tools.getEntity.inputSchema.safeParse({})
      expect(parsed.success).toBe(false)
    })
  })

  describe('search', () => {
    it('passes cursor through to the store and surfaces the store cursor in meta', async () => {
      const { store, calls } = makeFakeStore()
      const events: RetrievalToolEvent[] = []
      const tools = createRetrievalTools(store, { onEvent: (e) => events.push(e) })

      const result = await tools.search.execute(
        { query: 'pricing', cursor: 'incoming-cursor', limit: 5 },
        makeContext(),
      )

      expect(calls.search).toHaveLength(1)
      expect(calls.search[0]!.input).toEqual({ query: 'pricing', cursor: 'incoming-cursor', limit: 5 })
      const envelopeOut = result.data as RetrievalEnvelope<SearchData>
      expect(envelopeOut.meta.cursor).toBe('next-cursor')
      expect(envelopeOut.data).toHaveLength(2)
      expect(events).toEqual([{ type: 'search_executed', query: 'pricing', resultCount: 2 }])
    })

    it('rejects input missing query', () => {
      const { store } = makeFakeStore()
      const tools = createRetrievalTools(store)
      const parsed = tools.search.inputSchema.safeParse({})
      expect(parsed.success).toBe(false)
    })
  })

  describe('recentEpisodes', () => {
    it('delegates to store and emits event', async () => {
      const { store, calls } = makeFakeStore()
      const events: RetrievalToolEvent[] = []
      const tools = createRetrievalTools(store, { onEvent: (e) => events.push(e) })

      const result = await tools.recentEpisodes.execute({ entity: 'e-1', limit: 3 }, makeContext())

      expect(calls.recentEpisodes).toHaveLength(1)
      expect(result.isError).toBeUndefined()
      const envelopeOut = result.data as RetrievalEnvelope<RecentEpisodesData>
      expect(envelopeOut.data).toHaveLength(1)
      expect(envelopeOut.data[0]!.id).toBe('ep-1')
      expect(events).toEqual([{ type: 'recent_episodes_listed', resultCount: 1, entity: 'e-1' }])
    })
  })

  describe('provenance', () => {
    it('delegates and surfaces the envelope', async () => {
      const { store, calls } = makeFakeStore()
      const tools = createRetrievalTools(store)
      const result = await tools.provenance.execute({ row_id: 'mem-1' }, makeContext())

      expect(calls.provenance).toHaveLength(1)
      expect(calls.provenance[0]!.input).toEqual({ row_id: 'mem-1' })
      const envelopeOut = result.data as RetrievalEnvelope<ProvenanceData>
      expect(envelopeOut.data.row_id).toBe('mem-1')
    })

    it('rejects input missing row_id', () => {
      const { store } = makeFakeStore()
      const tools = createRetrievalTools(store)
      const parsed = tools.provenance.inputSchema.safeParse({})
      expect(parsed.success).toBe(false)
    })
  })

  describe('markUseful', () => {
    it('delegates to store and emits event', async () => {
      const { store, calls } = makeFakeStore()
      const events: RetrievalToolEvent[] = []
      const tools = createRetrievalTools(store, { onEvent: (e) => events.push(e) })

      const result = await tools.markUseful.execute(
        { row_id: 'mem-1', primitive: 'memory' },
        makeContext(),
      )

      expect(calls.markUseful).toHaveLength(1)
      const envelopeOut = result.data as RetrievalEnvelope<MarkUsefulData>
      expect(envelopeOut.data.success).toBe(true)
      expect(events).toEqual([
        { type: 'mark_useful_recorded', rowId: 'mem-1', primitive: 'memory' },
      ])
    })

    it('rejects unknown primitive', () => {
      const { store } = makeFakeStore()
      const tools = createRetrievalTools(store)
      const parsed = tools.markUseful.inputSchema.safeParse({ row_id: 'r', primitive: 'session' })
      expect(parsed.success).toBe(false)
    })
  })

  describe('aggregate', () => {
    it('accepts count measure with no path', () => {
      const { store } = makeFakeStore()
      const tools = createRetrievalTools(store)
      const parsed = tools.aggregate.inputSchema.safeParse({
        measure: { fn: 'count' },
        dimensions: ['entity_id'],
      })
      expect(parsed.success).toBe(true)
    })

    it('rejects sum measure missing path', () => {
      const { store } = makeFakeStore()
      const tools = createRetrievalTools(store)
      const parsed = tools.aggregate.inputSchema.safeParse({
        measure: { fn: 'sum' },
        dimensions: ['entity_id'],
      })
      expect(parsed.success).toBe(false)
    })

    it('rejects empty dimensions array', () => {
      const { store } = makeFakeStore()
      const tools = createRetrievalTools(store)
      const parsed = tools.aggregate.inputSchema.safeParse({
        measure: { fn: 'count' },
        dimensions: [],
      })
      expect(parsed.success).toBe(false)
    })

    it('delegates to store and emits event', async () => {
      const { store, calls } = makeFakeStore()
      const events: RetrievalToolEvent[] = []
      const tools = createRetrievalTools(store, { onEvent: (e) => events.push(e) })

      const result = await tools.aggregate.execute(
        {
          measure: { fn: 'sum', path: 'attributes.amount_cents' },
          dimensions: ['entity_id', 'quarter'],
        },
        makeContext(),
      )

      expect(calls.aggregate).toHaveLength(1)
      const envelopeOut = result.data as RetrievalEnvelope<AggregateData>
      expect(envelopeOut.data).toHaveLength(1)
      expect(envelopeOut.data[0]!.measure_value).toBe(42)
      expect(events).toEqual([{ type: 'aggregate_computed', resultCount: 1, fn: 'sum' }])
    })
  })

  describe('getRowHistory', () => {
    it('delegates to store with actor + input and emits event', async () => {
      const { store, calls } = makeFakeStore()
      const events: RetrievalToolEvent[] = []
      const tools = createRetrievalTools(store, { onEvent: (e) => events.push(e) })

      const result = await tools.getRowHistory.execute(
        { primitive: 'memories', row_id: '11111111-1111-4111-8111-111111111111' },
        makeContext(),
      )

      expect(calls.getRowHistory).toHaveLength(1)
      expect(calls.getRowHistory[0]!.input).toEqual({
        primitive: 'memories',
        row_id: '11111111-1111-4111-8111-111111111111',
      })
      expect(result.isError).toBeUndefined()
      expect(events).toEqual([
        {
          type: 'row_history_walked',
          primitive: 'memories',
          rowId: '11111111-1111-4111-8111-111111111111',
          chainLength: 0,
        },
      ])
    })

    it('returns an error body when the store returns null', async () => {
      const store: RetrievalStore = {
        ...makeFakeStore().store,
        async getRowHistory() {
          return null
        },
      }
      const tools = createRetrievalTools(store)
      const result = await tools.getRowHistory.execute(
        { primitive: 'tasks', row_id: '22222222-2222-4222-8222-222222222222' },
        makeContext(),
      )
      expect(result.isError).toBe(true)
      expect((result.data as { error: string }).error).toContain('22222222')
    })

    it('rejects an unknown primitive', () => {
      const { store } = makeFakeStore()
      const tools = createRetrievalTools(store)
      const parsed = tools.getRowHistory.inputSchema.safeParse({
        primitive: 'sessions',
        row_id: '33333333-3333-4333-8333-333333333333',
      })
      expect(parsed.success).toBe(false)
    })

    it('rejects input missing row_id', () => {
      const { store } = makeFakeStore()
      const tools = createRetrievalTools(store)
      const parsed = tools.getRowHistory.inputSchema.safeParse({ primitive: 'memories' })
      expect(parsed.success).toBe(false)
    })
  })

  describe('error and context handling', () => {
    it('returns a plain error body when the store throws', async () => {
      const fake = makeFakeStore()
      const store: RetrievalStore = {
        ...fake.store,
        async search() {
          throw new Error('db down')
        },
      }
      const tools = createRetrievalTools(store)
      const result = await tools.search.execute({ query: 'x' }, makeContext())
      expect(result.isError).toBe(true)
      expect((result.data as { error: string }).error).toBe('db down')
    })

    it('refuses retrieval without a workspace-scoped context', async () => {
      const { store } = makeFakeStore()
      const tools = createRetrievalTools(store)
      const result = await tools.search.execute(
        { query: 'x' },
        makeContext({ workspaceId: null }),
      )
      expect(result.isError).toBe(true)
      expect((result.data as { error: string }).error).toMatch(/workspace/i)
    })
  })
})
