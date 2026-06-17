/**
 * DB-store tests for the new `entity_instance` primitive — Doc v1
 * brain-aware reads. Component tag: [COMP:retrieval/entity-instance].
 *
 * Pure mock tests with `queryWithRLS` stubbed. Covers the three
 * stores extended for entity_instances:
 *
 *   - retrieval-store.ts ........ `search` scope='entity_instance'
 *   - aggregate-store.ts ........ `aggregate` over `data->>'rating'`
 *   - provenance-store.ts ....... `provenance` probe for entity_instances
 *
 * Integration coverage (real Postgres) is intentionally out of scope —
 * the SQL shape is exercised here; the real DB lives in the existing
 * `*.integration.test.ts` suites.
 *
 * Spec: docs/architecture/brain/retrieval-layer.md +
 *       packages/api/migrations/200_doc_v1.sql.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RetrievalActor } from '@sidanclaw/core'

vi.mock('../client.js', () => ({
  queryWithRLS: vi.fn(),
}))

import { search as runSearch } from '../retrieval-store.js'
import { createDbAggregateStore } from '../aggregate-store.js'
import { createDbProvenanceStore } from '../provenance-store.js'
import { queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(queryWithRLS)

const ACTOR: RetrievalActor = {
  workspaceId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
  assistantId: '00000000-0000-0000-0000-000000000003',
  assistantKind: 'standard',
  clearance: 'internal',
}

const ENTITY_TYPE_ID = '00000000-0000-0000-0000-0000000000aa'
const ROW_ID = '00000000-0000-0000-0000-0000000000bb'

beforeEach(() => {
  mockQuery.mockReset()
})

// ─────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────

describe('[COMP:retrieval/entity-instance] search', () => {
  it('queries the entity_instances table for scope=entity_instance', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          row_id: ROW_ID,
          entity_type_id: ENTITY_TYPE_ID,
          workspace_id: ACTOR.workspaceId,
          title: 'The Matrix',
          created_at: new Date('2026-05-20T00:00:00Z'),
          source_app: 'doc',
        },
      ],
    } as never)

    const result = await runSearch(ACTOR, {
      query: 'Matrix',
      scope: 'entity_instance',
    })

    // A targeted scope='entity_instance' search runs exactly one SQL
    // statement (no FTS/vector fan-out for this primitive — it has no
    // embedding column, so the vector arm skips it).
    expect(mockQuery).toHaveBeenCalledOnce()
    const [, sql] = mockQuery.mock.calls[0]
    expect(sql).toContain('FROM entity_instances')
    // Title is derived from the entity TYPE's first declared property
    // (the title-column convention) — NOT a fixed `data->>'title'` key.
    // Cells are `{kind,value}` objects, so the displayable string is
    // `data -> (titleProp) ->> 'value'`, resolved via a join to
    // entity_types. (`data->>'title'` would return the JSON object, not
    // the value.)
    expect(sql).toContain('JOIN entity_types')
    expect(sql).toContain("et.properties->0->>'name'")
    expect(sql).toContain("->> 'value'")
    expect(sql).toContain('workspace_id = $1')

    expect(result.data).toHaveLength(1)
    const row = result.data[0]!
    expect(row.primitive).toBe('entity_instance')
    expect(row.row_id).toBe(ROW_ID)
    expect(row.entity_type_id).toBe(ENTITY_TYPE_ID)
    expect(row.title).toBe('The Matrix')
    expect(row.source_app).toBe('doc')
  })

  it('applies entity_type_id filter to the SQL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await runSearch(ACTOR, {
      query: 'foo',
      scope: 'entity_instance',
      filters: { entity_type_id: ENTITY_TYPE_ID },
    })
    const [, sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('entity_type_id = $')
    expect(params).toContain(ENTITY_TYPE_ID)
  })

  it('rejects a non-UUID entity_type_id filter', async () => {
    await expect(
      runSearch(ACTOR, {
        query: 'foo',
        scope: 'entity_instance',
        filters: { entity_type_id: 'not-a-uuid' },
      }),
    ).rejects.toThrow(/UUID/)
  })

  it('rejects unknown filter keys for scope=entity_instance', async () => {
    await expect(
      runSearch(ACTOR, {
        query: 'foo',
        scope: 'entity_instance',
        filters: { sensitivity: 'internal' },
      }),
    ).rejects.toThrow(/unknown filter/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Aggregate
// ─────────────────────────────────────────────────────────────────────

describe('[COMP:retrieval/entity-instance] aggregate', () => {
  it('routes filters.primitive=entity_instances to the entity_instances table', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ dim_0: ENTITY_TYPE_ID, measure_value: '42' }],
    } as never)

    const store = createDbAggregateStore()
    const result = await store.aggregate(ACTOR, {
      measure: { fn: 'sum', path: 'rating' },
      dimensions: ['entity_type_id'],
      filters: { primitive: 'entity_instances' },
    })

    const [, sql] = mockQuery.mock.calls[0]
    expect(sql).toContain('FROM entity_instances')
    // JSONB cast for the rating measure path.
    expect(sql).toContain("data->>'rating'")
    // No bi-temporal clause for the non-bi-temporal primitive.
    expect(sql).not.toContain('retracted_at IS NULL')
    expect(sql).not.toContain('valid_from')

    expect(result.data).toHaveLength(1)
    expect(result.data[0]!.entity_type_id).toBe(ENTITY_TYPE_ID)
    expect(result.data[0]!.measure_value).toBe(42)
  })

  it('supports count over entity_instances grouped by source_app', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { dim_0: 'doc', measure_value: '3' },
        { dim_0: 'chat', measure_value: '1' },
      ],
    } as never)

    const store = createDbAggregateStore()
    const result = await store.aggregate(ACTOR, {
      measure: { fn: 'count' },
      dimensions: ['source_app'],
      filters: { primitive: 'entity_instances' },
    })

    const [, sql] = mockQuery.mock.calls[0]
    expect(sql).toContain('COUNT(*)')
    expect(sql).toContain('FROM entity_instances')
    expect(result.data).toHaveLength(2)
    expect(result.data.map((r) => r.source_app)).toEqual(['doc', 'chat'])
  })

  it('rejects unregistered measure paths for entity_instances', async () => {
    const store = createDbAggregateStore()
    await expect(
      store.aggregate(ACTOR, {
        measure: { fn: 'sum', path: 'arbitrary' },
        dimensions: ['entity_type_id'],
        filters: { primitive: 'entity_instances' },
      }),
    ).rejects.toThrow(/path "arbitrary" is not registered/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────

describe('[COMP:retrieval/entity-instance] provenance', () => {
  it('probes entity_instances after all other primitives miss', async () => {
    // First 9 PRIMITIVE_TABLES (memories, tasks, files, entities,
    // contacts, companies, deals, kb_chunks, entity_links) all miss;
    // the 10th hit is entity_instances and returns the row.
    mockQuery.mockResolvedValue({ rows: [] } as never) // default for all probes
    mockQuery.mockResolvedValueOnce({ rows: [] } as never) // memories
    mockQuery.mockResolvedValueOnce({ rows: [] } as never) // tasks
    mockQuery.mockResolvedValueOnce({ rows: [] } as never) // workspace_files
    mockQuery.mockResolvedValueOnce({ rows: [] } as never) // entities
    mockQuery.mockResolvedValueOnce({ rows: [] } as never) // contacts
    mockQuery.mockResolvedValueOnce({ rows: [] } as never) // companies
    mockQuery.mockResolvedValueOnce({ rows: [] } as never) // deals
    mockQuery.mockResolvedValueOnce({ rows: [] } as never) // kb_chunks
    mockQuery.mockResolvedValueOnce({ rows: [] } as never) // entity_links
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          sourceApp: 'doc',
          createdByUserId: ACTOR.userId,
          createdAt: new Date('2026-05-20T00:00:00Z'),
          lastEditedAt: new Date('2026-05-20T00:00:00Z'),
        },
      ],
    } as never)

    const store = createDbProvenanceStore()
    const result = await store.provenance(ACTOR, { row_id: ROW_ID })

    expect(result).not.toBeNull()
    expect(result!.data.primitive).toBe('entity_instances')
    expect(result!.data.source_episode).toBeNull()
    expect(result!.data.derived_from).toEqual([])
    expect(result!.data.supersession.superseded_by).toBeNull()
    expect(result!.data.supersession.valid_to).toBeNull()
    expect(result!.data.re_extracted_at).toEqual([])
    expect(result!.data.authorship.created_by_user_id).toBe(ACTOR.userId)
  })

  it('returns null when entity_instances also misses', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never)
    const store = createDbProvenanceStore()
    const result = await store.provenance(ACTOR, { row_id: ROW_ID })
    expect(result).toBeNull()
  })
})
