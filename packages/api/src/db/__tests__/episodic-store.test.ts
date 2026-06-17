/**
 * Unit tests for the episodic-memory DB store.
 * Component tag: [COMP:memory/episodic-store].
 *
 * Mocks the `query` helper and exercises the `EpisodicStore` adapter
 * (`episodic-store.ts`) together with the underlying query functions
 * (`episodic-memories.ts`): insert param marshalling (message_span /
 * entity_refs JSON), the default row limits, the fetchByTopic newest-
 * accessed re-sort after `UPDATE ... RETURNING`, the row→record mapping,
 * and the empty-id no-op on the survival-count bump.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { createDbEpisodicStore } from '../episodic-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)
const store = createDbEpisodicStore()

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ep-1',
    userId: 'u-1',
    assistantId: 'a-1',
    sessionId: 's-1',
    topicLabel: 'trip-seoul',
    summary: 'Planned the Seoul itinerary.',
    messageSpan: { fromSequence: 1, toSequence: 8, turnCount: 4 },
    entityRefs: null,
    createdAt: new Date('2026-05-15T00:00:00Z'),
    lastAccessedAt: new Date('2026-05-15T00:00:00Z'),
    accessCount: 0,
    survivalCount: 0,
    ...over,
  }
}

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:memory/episodic-store] create', () => {
  it('inserts with message_span + entity_refs JSON-encoded and maps the row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [row({ entityRefs: ['e-1'] })],
      rowCount: 1,
    } as never)
    const rec = await store.create({
      userId: 'u-1',
      assistantId: 'a-1',
      sessionId: 's-1',
      topicLabel: 'trip-seoul',
      summary: 'Planned the Seoul itinerary.',
      messageSpan: { fromSequence: 1, toSequence: 8, turnCount: 4 },
      entityRefs: ['e-1'],
    })
    // toRecord mapping
    expect(rec.id).toBe('ep-1')
    expect(rec.messageSpan).toEqual({ fromSequence: 1, toSequence: 8, turnCount: 4 })
    expect(rec.entityRefs).toEqual(['e-1'])
    expect(rec.survivalCount).toBe(0)

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('INSERT INTO episodic_memories')
    expect(params?.[5]).toBe(JSON.stringify({ fromSequence: 1, toSequence: 8, turnCount: 4 }))
    expect(params?.[6]).toBe(JSON.stringify(['e-1']))
  })

  it('passes null entity_refs when none supplied', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()], rowCount: 1 } as never)
    await store.create({
      userId: 'u-1',
      assistantId: 'a-1',
      sessionId: 's-1',
      topicLabel: 't',
      summary: 's',
      messageSpan: { fromSequence: 0, toSequence: 0, turnCount: 1 },
    })
    expect(mockQuery.mock.calls[0][1]?.[6]).toBeNull()
  })
})

describe('[COMP:memory/episodic-store] fetchByTopic', () => {
  it('defaults to limit 3 and re-sorts newest-accessed first', async () => {
    const older = row({ id: 'ep-old', lastAccessedAt: new Date('2026-05-10T00:00:00Z') })
    const newer = row({ id: 'ep-new', lastAccessedAt: new Date('2026-05-14T00:00:00Z') })
    // UPDATE ... RETURNING does not preserve the inner SELECT order — the
    // store re-sorts. Hand back the rows oldest-first to prove the sort.
    mockQuery.mockResolvedValueOnce({ rows: [older, newer], rowCount: 2 } as never)
    const recs = await store.fetchByTopic({ sessionId: 's-1', topicLabel: 'trip-seoul' })
    expect(recs.map((r) => r.id)).toEqual(['ep-new', 'ep-old'])

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('UPDATE episodic_memories')
    expect(sql).toContain('access_count = access_count + 1')
    expect(params).toEqual(['s-1', 'trip-seoul', 3])
  })

  it('honors an explicit limit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.fetchByTopic({ sessionId: 's-1', topicLabel: 't', limit: 10 })
    expect(mockQuery.mock.calls[0][1]).toEqual(['s-1', 't', 10])
  })
})

describe('[COMP:memory/episodic-store] fetchBySession', () => {
  it('selects by session newest-first with a default limit of 50', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()], rowCount: 1 } as never)
    const recs = await store.fetchBySession({ sessionId: 's-1' })
    expect(recs).toHaveLength(1)

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('FROM episodic_memories')
    expect(sql).toContain('ORDER BY created_at DESC')
    expect(params).toEqual(['s-1', 50])
  })
})

describe('[COMP:memory/episodic-store] listTopicsBySession', () => {
  it('returns distinct topic labels with a default limit of 20', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ topicLabel: 'trip-seoul' }, { topicLabel: 'api-quota' }],
      rowCount: 2,
    } as never)
    const topics = await store.listTopicsBySession({ sessionId: 's-1' })
    expect(topics).toEqual(['trip-seoul', 'api-quota'])
    expect(mockQuery.mock.calls[0][1]).toEqual(['s-1', 20])
  })
})

describe('[COMP:memory/episodic-store] listBySession', () => {
  it('fetches all session rows ascending, without bumping access counters', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [row(), row({ id: 'ep-2' })],
      rowCount: 2,
    } as never)
    const recs = await store.listBySession('s-1')
    expect(recs.map((r) => r.id)).toEqual(['ep-1', 'ep-2'])

    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('ORDER BY created_at ASC')
    // No access-counter bump — that is fetchByTopic's job, not this read.
    expect(sql).not.toContain('access_count = access_count + 1')
    expect(params).toEqual(['s-1'])
  })
})

describe('[COMP:memory/episodic-store] deleteById', () => {
  it('hard-deletes by id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.deleteById('ep-1')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('DELETE FROM episodic_memories')
    expect(params).toEqual(['ep-1'])
  })
})

describe('[COMP:memory/episodic-store] incrementSurvivalCount', () => {
  it('is a no-op for an empty id list — issues no query', async () => {
    await store.incrementSurvivalCount([])
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('bulk-increments survival_count for the given ids', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 } as never)
    await store.incrementSurvivalCount(['ep-1', 'ep-2'])
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('survival_count = survival_count + 1')
    expect(sql).toContain('ANY($1::uuid[])')
    expect(params).toEqual([['ep-1', 'ep-2']])
  })
})
