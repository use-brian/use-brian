/**
 * `provenance(row_id)` derivation chain — WS-5 / WU-5.5.
 * Component tag: [COMP:retrieval/provenance].
 *
 * Pure unit tests. `queryWithRLS` is mocked with a SQL-dispatching fake
 * so the derivation-assembly logic runs in plain `pnpm test` (no DB):
 * the `derived_from` source-episode link + its `relationship` typing,
 * the P1-8 silent omission of an inaccessible source Episode, and the
 * `re_extracted_at` supersession-chain backward walk + oldest→newest
 * sort. The DB-backed query SQL itself is covered by
 * `provenance-store.integration.test.ts`.
 *
 * Spec: docs/architecture/brain/retrieval-layer.md §provenance; data-model.md
 * §"Provenance pattern".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RetrievalActor, Sensitivity } from '@use-brian/core'

vi.mock('../client.js', () => ({
  queryWithRLS: vi.fn(),
}))

import { createDbProvenanceStore } from '../provenance-store.js'
import { queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(queryWithRLS)

const actor: RetrievalActor = {
  workspaceId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
  assistantId: '00000000-0000-0000-0000-000000000003',
  assistantKind: 'standard',
  clearance: 'internal',
}

// Memory row ids must be valid UUIDs (provenance UUID-gates `row_id`);
// episode ids are never gated, so plain strings keep the fixtures legible.
const M0 = '00000000-0000-0000-0000-0000000000a0'
const M1 = '00000000-0000-0000-0000-0000000000a1'
const M2 = '00000000-0000-0000-0000-0000000000a2'
const DAY1 = new Date('2026-01-01T00:00:00Z')
const DAY2 = new Date('2026-01-02T00:00:00Z')
const DAY3 = new Date('2026-01-03T00:00:00Z')

type FixtureRow = {
  id: string
  table: string
  source: string
  sourceEpisodeId: string | null
  createdByUserId: string | null
  createdByAssistantId: string | null
  createdAt: Date
  validFrom: Date
  validTo: Date | null
  supersededBy: string | null
}

type FixtureEpisode = {
  id: string
  sourceKind: string
  occurredAt: Date
  sensitivity: Sensitivity
  contentRef: unknown
}

function memRow(p: Partial<FixtureRow> & { id: string }): FixtureRow {
  return {
    table: 'memories',
    source: 'extracted',
    sourceEpisodeId: null,
    createdByUserId: 'user-1',
    createdByAssistantId: null,
    createdAt: DAY1,
    validFrom: DAY1,
    validTo: null,
    supersededBy: null,
    ...p,
  }
}

function episode(id: string, sensitivity: Sensitivity = 'internal'): FixtureEpisode {
  return { id, sourceKind: 'web_chat', occurredAt: DAY1, sensitivity, contentRef: {} }
}

/**
 * Install a `queryWithRLS` fake that answers from the fixture by
 * recognising each of provenance's five query shapes.
 */
function setup(rows: FixtureRow[], episodes: FixtureEpisode[]): void {
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const epById = new Map(episodes.map((e) => [e.id, e]))

  function dispatch(sql: string, params: readonly unknown[]): { rows: unknown[] } {
    const key = String(params[0])
    if (sql.includes('FROM episodes')) {
      const ep = epById.get(key)
      if (!ep) return { rows: [] }
      // `fetchEpisode` selects source_kind; `isEpisodeAccessible` does not.
      if (sql.includes('source_kind')) {
        return {
          rows: [
            {
              id: ep.id,
              sourceKind: ep.sourceKind,
              occurredAt: ep.occurredAt,
              sensitivity: ep.sensitivity,
              contentRef: ep.contentRef,
            },
          ],
        }
      }
      return { rows: [{ sensitivity: ep.sensitivity }] }
    }
    if (sql.includes('WHERE superseded_by')) {
      const prior = rows.find((r) => r.supersededBy === key)
      if (!prior) return { rows: [] }
      // re-extraction walk selects source_episode_id; precededBy selects only id.
      if (sql.includes('source_episode_id')) {
        return {
          rows: [
            { id: prior.id, sourceEpisodeId: prior.sourceEpisodeId, validFrom: prior.validFrom },
          ],
        }
      }
      return { rows: [{ id: prior.id }] }
    }
    // probePrimitive — `WHERE id = $1`, one query per primitive table.
    const row = rowById.get(key)
    if (!row || !sql.includes(`FROM ${row.table}`)) return { rows: [] }
    return {
      rows: [
        {
          source: row.source,
          sourceEpisodeId: row.sourceEpisodeId,
          createdByUserId: row.createdByUserId,
          createdByAssistantId: row.createdByAssistantId,
          createdAt: row.createdAt,
          validFrom: row.validFrom,
          validTo: row.validTo,
          supersededBy: row.supersededBy,
        },
      ],
    }
  }

  mockQuery.mockImplementation(((
    _userId: string,
    sql: string,
    params?: unknown[],
  ) => Promise.resolve(dispatch(sql, params ?? []))) as unknown as typeof queryWithRLS)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:retrieval/provenance] createDbProvenanceStore', () => {
  it('exposes the provenance method matching the RetrievalStore contract', () => {
    const store = createDbProvenanceStore()
    expect(typeof store.provenance).toBe('function')
  })

  it('returns null for an obviously invalid row_id (UUID gate)', async () => {
    const store = createDbProvenanceStore()
    const result = await store.provenance(actor, { row_id: 'not-a-uuid' })
    expect(result).toBeNull()
  })

  it('returns null for an empty string row_id', async () => {
    const store = createDbProvenanceStore()
    const result = await store.provenance(actor, { row_id: '' })
    expect(result).toBeNull()
  })
})

describe('[COMP:retrieval/provenance] derivation chain assembly', () => {
  it('builds derived_from + supersession + authorship for an extracted row', async () => {
    setup(
      [
        memRow({ id: M1, source: 'extracted', sourceEpisodeId: 'ep-1', validFrom: DAY2 }),
        memRow({ id: M0, sourceEpisodeId: 'ep-0', validFrom: DAY1, validTo: DAY2, supersededBy: M1 }),
      ],
      [episode('ep-1'), episode('ep-0')],
    )
    const result = await createDbProvenanceStore().provenance(actor, { row_id: M1 })
    expect(result).not.toBeNull()
    const data = result!.data
    expect(data.source_episode?.id).toBe('ep-1')
    expect(data.derived_from).toEqual([
      { primitive: 'episode', row_id: 'ep-1', relationship: 'extracted_from' },
    ])
    expect(data.supersession.preceded_by).toBe(M0)
    expect(data.supersession.superseded_by).toBeNull()
    expect(data.authorship.created_by_user_id).toBe('user-1')
    expect(data.re_extracted_at).toEqual([
      { from_episode: 'ep-0', at: DAY1.toISOString() },
    ])
  })

  it('types a rem_connection row\'s episode link as inferred_from', async () => {
    setup(
      [memRow({ id: M1, source: 'rem_connection', sourceEpisodeId: 'ep-1' })],
      [episode('ep-1')],
    )
    const result = await createDbProvenanceStore().provenance(actor, { row_id: M1 })
    expect(result!.data.derived_from[0].relationship).toBe('inferred_from')
  })

  it('omits an inaccessible source Episode from derived_from (P1-8)', async () => {
    setup(
      [memRow({ id: M1, source: 'extracted', sourceEpisodeId: 'ep-1' })],
      [episode('ep-1', 'confidential')], // above the actor's `internal` clearance
    )
    const result = await createDbProvenanceStore().provenance(actor, { row_id: M1 })
    expect(result!.data.source_episode).toBeNull()
    expect(result!.data.derived_from).toEqual([])
  })

  it('walks the supersession chain and sorts re_extracted_at oldest→newest', async () => {
    setup(
      [
        memRow({ id: M2, sourceEpisodeId: 'ep-2', validFrom: DAY3 }),
        memRow({ id: M1, sourceEpisodeId: 'ep-1', validFrom: DAY2, validTo: DAY3, supersededBy: M2 }),
        memRow({ id: M0, sourceEpisodeId: 'ep-0', validFrom: DAY1, validTo: DAY2, supersededBy: M1 }),
      ],
      [episode('ep-2'), episode('ep-1'), episode('ep-0')],
    )
    const result = await createDbProvenanceStore().provenance(actor, { row_id: M2 })
    expect(result!.data.re_extracted_at).toEqual([
      { from_episode: 'ep-0', at: DAY1.toISOString() },
      { from_episode: 'ep-1', at: DAY2.toISOString() },
    ])
  })

  it('skips an inaccessible prior Episode in the re_extracted_at walk', async () => {
    setup(
      [
        memRow({ id: M2, sourceEpisodeId: 'ep-2', validFrom: DAY3 }),
        memRow({ id: M1, sourceEpisodeId: 'ep-1', validFrom: DAY2, validTo: DAY3, supersededBy: M2 }),
        memRow({ id: M0, sourceEpisodeId: 'ep-0', validFrom: DAY1, validTo: DAY2, supersededBy: M1 }),
      ],
      [episode('ep-2'), episode('ep-1', 'confidential'), episode('ep-0')],
    )
    const result = await createDbProvenanceStore().provenance(actor, { row_id: M2 })
    expect(result!.data.re_extracted_at).toEqual([
      { from_episode: 'ep-0', at: DAY1.toISOString() },
    ])
  })

  it('returns null when the row is not found in any primitive', async () => {
    setup([], [])
    const result = await createDbProvenanceStore().provenance(actor, { row_id: M1 })
    expect(result).toBeNull()
  })
})
