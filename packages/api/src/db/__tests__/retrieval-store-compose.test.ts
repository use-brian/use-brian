/**
 * Unit tests for the retrieval-store composer + getEntity adapter.
 * Component tag: [COMP:retrieval/db-store-compose].
 *
 * Per-method stores already have their own tests
 * (`retrieval-store.integration.test.ts`, `aggregate-store.integration.test.ts`,
 * etc.). This file only verifies (a) the composer dispatches each method
 * to the correct slice and (b) the `getEntity` adapter bridges
 * `EntityRollup` → `RetrievalEnvelope<GetEntityData>` correctly — including
 * the `followedSupersession` → `meta.followed_supersession` shape change.
 *
 * Pure unit tests; no DB.
 */

import { describe, it, expect, vi } from 'vitest'
import type {
  EntityRecord,
  EntityRollup,
  EntityStore,
  GetEntityOpts,
  RetrievalActor,
  RetrievalEnvelope,
  RetrievalStore,
} from '@sidanclaw/core'
import { composeRetrievalStore } from '../retrieval-store.js'

const actor: RetrievalActor = {
  workspaceId: 'ws-1',
  userId: 'u-1',
  assistantId: 'a-1',
  assistantKind: 'standard',
  clearance: 'confidential',
}

const baseEntity: EntityRecord = {
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
  sourceEpisodeId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
} as unknown as EntityRecord

function buildEnvelope<T>(data: T): RetrievalEnvelope<T> {
  return {
    api_version: 'v1',
    data,
    meta: { retrieved_at: new Date().toISOString(), truncated: false },
  }
}

function makeEntityStore(rollup: EntityRollup | null): {
  store: EntityStore
  getEntitySpy: ReturnType<typeof vi.fn>
} {
  const getEntitySpy = vi.fn(async (_ctx: unknown, _idOrName: string, _opts?: GetEntityOpts) => rollup)
  const store = {
    create: vi.fn(),
    getById: vi.fn(),
    findByName: vi.fn(),
    findByNameSystem: vi.fn(),
    findByCanonicalId: vi.fn(),
    findByCanonicalIdSystem: vi.fn(),
    listForWorkspace: vi.fn(),
    update: vi.fn(),
    getEntity: getEntitySpy,
  } as unknown as EntityStore
  return { store, getEntitySpy }
}

function makeSlices(): {
  searchEpisodes: Pick<RetrievalStore, 'search' | 'recentEpisodes'>
  provenance: Pick<RetrievalStore, 'provenance'>
  aggregate: Pick<RetrievalStore, 'aggregate'>
  markUseful: Pick<RetrievalStore, 'markUseful'>
  rowHistory: Pick<RetrievalStore, 'getRowHistory'>
} {
  return {
    searchEpisodes: {
      search: vi.fn(async () => buildEnvelope([] as never)),
      recentEpisodes: vi.fn(async () => buildEnvelope([] as never)),
    },
    provenance: { provenance: vi.fn(async () => null) },
    aggregate: { aggregate: vi.fn(async () => buildEnvelope([] as never)) },
    markUseful: { markUseful: vi.fn(async () => buildEnvelope({ success: true })) },
    rowHistory: { getRowHistory: vi.fn(async () => null) },
  }
}

describe('[COMP:retrieval/db-store-compose] composeRetrievalStore', () => {
  it('wires every slice method onto the unified store', async () => {
    const { store: entityStore } = makeEntityStore(null)
    const slices = makeSlices()
    const composed = composeRetrievalStore({ entityStore, ...slices })

    await composed.search(actor, { query: 'x' })
    await composed.recentEpisodes(actor, {})
    await composed.provenance(actor, { row_id: 'r-1' })
    await composed.aggregate(actor, {
      measure: { fn: 'count' },
      dimensions: ['kind'],
      filters: { primitive: 'memories' },
    })
    await composed.markUseful(actor, { row_id: 'r-1', primitive: 'memory' })
    await composed.getRowHistory(actor, { row_id: 'r-1', primitive: 'memories' })

    expect(slices.searchEpisodes.search).toHaveBeenCalledTimes(1)
    expect(slices.searchEpisodes.recentEpisodes).toHaveBeenCalledTimes(1)
    expect(slices.provenance.provenance).toHaveBeenCalledTimes(1)
    expect(slices.aggregate.aggregate).toHaveBeenCalledTimes(1)
    expect(slices.markUseful.markUseful).toHaveBeenCalledTimes(1)
    expect(slices.rowHistory.getRowHistory).toHaveBeenCalledTimes(1)
  })

  it('getEntity returns null when the entity store returns null', async () => {
    const { store } = makeEntityStore(null)
    const composed = composeRetrievalStore({ entityStore: store, ...makeSlices() })

    const result = await composed.getEntity(actor, { id_or_name: 'ghost' })
    expect(result).toBeNull()
  })

  it('getEntity bridges EntityRollup → RetrievalEnvelope<GetEntityData>', async () => {
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
    const { store, getEntitySpy } = makeEntityStore(rollup)
    const composed = composeRetrievalStore({ entityStore: store, ...makeSlices() })

    const result = await composed.getEntity(actor, {
      id_or_name: 'Ada Lovelace',
      as_of: '2026-03-01T00:00:00Z',
      limits: { edges: 5 },
    })

    expect(result).not.toBeNull()
    expect(result!.api_version).toBe('v1')
    expect(result!.data.entity).toBe(baseEntity)
    expect(result!.data.summary.edge_count).toBe(0)
    expect(result!.meta.followed_supersession).toBeUndefined()

    // Adapter must forward as_of as a Date + map limits.edges → edgeLimit.
    expect(getEntitySpy).toHaveBeenCalledOnce()
    const [, , opts] = getEntitySpy.mock.calls[0] as [unknown, unknown, GetEntityOpts]
    expect(opts.asOf).toBeInstanceOf(Date)
    expect(opts.asOf?.toISOString()).toBe('2026-03-01T00:00:00.000Z')
    expect(opts.edgeLimit).toBe(5)
  })

  it('getEntity threads followedSupersession into envelope meta with snake_case + ISO timestamps', async () => {
    const supersededAt = new Date('2026-04-15T12:00:00Z')
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
      followedSupersession: {
        fromId: 'e-old',
        toId: 'e-1',
        supersededAt,
      },
    }
    const { store } = makeEntityStore(rollup)
    const composed = composeRetrievalStore({ entityStore: store, ...makeSlices() })

    const result = await composed.getEntity(actor, { id_or_name: 'Ada' })
    expect(result!.meta.followed_supersession).toEqual({
      from_id: 'e-old',
      to_id: 'e-1',
      superseded_at: supersededAt.toISOString(),
    })
  })

  it('getEntity throws on invalid as_of', async () => {
    const { store } = makeEntityStore(null)
    const composed = composeRetrievalStore({ entityStore: store, ...makeSlices() })

    await expect(
      composed.getEntity(actor, { id_or_name: 'x', as_of: 'not-a-date' }),
    ).rejects.toThrow(/invalid as_of/)
  })
})
