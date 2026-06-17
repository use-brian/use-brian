import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import {
  recordRecall,
  recordRecallBatch,
  attachAssistantMessageId,
  listMemoriesByRecentOutcome,
  listRecentRecallsForMemory,
  createMemoryRecallEventsStore,
} from '../memory-recall-events-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/memory-recall-events-store] recordRecall', () => {
  it('inserts a single row with the supplied fields', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'r1',
          memoryId: 'm1',
          sessionId: 's1',
          assistantMessageId: 'msg-1',
          workspaceId: 'w1',
          userId: 'u1',
          recallKind: 'tool_call',
          createdAt: new Date('2026-05-23T00:00:00Z'),
        },
      ],
    } as any)

    const got = await recordRecall({
      memoryId: 'm1',
      sessionId: 's1',
      workspaceId: 'w1',
      userId: 'u1',
      recallKind: 'tool_call',
      assistantMessageId: 'msg-1',
    })

    expect(got.id).toBe('r1')
    expect(got.recallKind).toBe('tool_call')
    expect(got.assistantMessageId).toBe('msg-1')

    const sql = mockQuery.mock.calls[0][0] as string
    const args = mockQuery.mock.calls[0][1] as unknown[]
    expect(sql).toContain('INSERT INTO memory_recall_events')
    expect(args).toEqual(['m1', 's1', 'msg-1', 'w1', 'u1', 'tool_call'])
  })

  it('passes null for assistantMessageId when omitted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{}] } as any)
    await recordRecall({
      memoryId: 'm1',
      sessionId: 's1',
      workspaceId: 'w1',
      userId: 'u1',
      recallKind: 'index_inject',
    })
    const args = mockQuery.mock.calls[0][1] as unknown[]
    expect(args[2]).toBeNull()
  })
})

describe('[COMP:api/memory-recall-events-store] recordRecallBatch', () => {
  it('no-ops on empty batch', async () => {
    await recordRecallBatch({
      memoryIds: [],
      sessionId: 's1',
      workspaceId: 'w1',
      userId: 'u1',
      recallKind: 'index_inject',
    })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('builds a multi-row INSERT with shared positional args', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)

    await recordRecallBatch({
      memoryIds: ['m1', 'm2', 'm3'],
      sessionId: 's1',
      workspaceId: 'w1',
      userId: 'u1',
      recallKind: 'index_inject',
      assistantMessageId: 'msg-1',
    })

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const sql = mockQuery.mock.calls[0][0] as string
    const args = mockQuery.mock.calls[0][1] as unknown[]

    expect(sql).toContain('INSERT INTO memory_recall_events')
    // Three rows: $6, $7, $8 take memory_id positions, $1..$5 are shared.
    expect(sql).toContain('VALUES ($6, $1, $2, $3, $4, $5), ($7, $1, $2, $3, $4, $5), ($8, $1, $2, $3, $4, $5)')

    // Shared args first, then memory ids.
    expect(args).toEqual(['s1', 'msg-1', 'w1', 'u1', 'index_inject', 'm1', 'm2', 'm3'])
  })

  it('de-dupes ids inside a single batch', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)

    await recordRecallBatch({
      memoryIds: ['m1', 'm1', 'm2'],
      sessionId: 's1',
      workspaceId: 'w1',
      userId: 'u1',
      recallKind: 'index_inject',
    })

    const args = mockQuery.mock.calls[0][1] as unknown[]
    // First 5 are shared; remaining are de-duped memory ids
    expect(args.slice(5)).toEqual(['m1', 'm2'])
  })

  it('passes null assistant_message_id when omitted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)

    await recordRecallBatch({
      memoryIds: ['m1'],
      sessionId: 's1',
      workspaceId: 'w1',
      userId: 'u1',
      recallKind: 'tool_call',
    })

    const args = mockQuery.mock.calls[0][1] as unknown[]
    expect(args[1]).toBeNull()
  })
})

describe('[COMP:api/memory-recall-events-store] attachAssistantMessageId', () => {
  it('updates rows for the session whose message id is still null', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 5 } as any)

    const n = await attachAssistantMessageId('s1', 'msg-9')

    expect(n).toBe(5)
    const sql = mockQuery.mock.calls[0][0] as string
    const args = mockQuery.mock.calls[0][1] as unknown[]
    expect(sql).toContain('UPDATE memory_recall_events')
    expect(sql).toContain('SET assistant_message_id = $2')
    expect(sql).toContain('assistant_message_id IS NULL')
    expect(args).toEqual(['s1', 'msg-9'])
  })

  it('returns 0 when no rows were updated', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 } as any)
    const n = await attachAssistantMessageId('s1', 'msg-9')
    expect(n).toBe(0)
  })

  it('handles missing rowCount as 0', async () => {
    mockQuery.mockResolvedValueOnce({} as any)
    const n = await attachAssistantMessageId('s1', 'msg-9')
    expect(n).toBe(0)
  })
})

describe('[COMP:api/memory-recall-events-store] listMemoriesByRecentOutcome — feedback JOIN', () => {
  it('executes the recall ⨝ feedback JOIN and projects positive / negative / correction counts', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          memoryId: 'm-bad-1',
          recallCount: '4',
          positiveCount: '0',
          negativeCount: '3',
          correctionCount: '2',
        },
        {
          memoryId: 'm-bad-2',
          recallCount: '2',
          positiveCount: '0',
          negativeCount: '2',
          correctionCount: '0',
        },
      ],
    } as any)

    const got = await listMemoriesByRecentOutcome({
      workspaceId: 'w1',
      windowDays: 30,
      sentimentFilter: 'negative',
      minBadCount: 2,
    })

    expect(got).toEqual([
      { memoryId: 'm-bad-1', recallCount: 4, positiveCount: 0, negativeCount: 3, correctionCount: 2 },
      { memoryId: 'm-bad-2', recallCount: 2, positiveCount: 0, negativeCount: 2, correctionCount: 0 },
    ])

    const sql = mockQuery.mock.calls[0][0] as string
    const args = mockQuery.mock.calls[0][1] as unknown[]

    // The JOIN walks memory_recall_events ⨝ analytics_events.
    expect(sql).toContain('memory_recall_events')
    expect(sql).toContain('analytics_events')
    expect(sql).toContain("metadata->>'messageId'")
    expect(sql).toContain('feedback_positive')
    expect(sql).toContain('feedback_negative')
    // The correction threshold mirrors feedback.ts:55 — 10-char minimum trim.
    expect(sql).toContain('length(trim(tf.details)) >= 10')

    expect(args).toEqual(['w1', 30, 'negative', 2])
  })

  it('defaults sentimentFilter to "any" and minBadCount to 0', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)

    await listMemoriesByRecentOutcome({
      workspaceId: 'w1',
      windowDays: 7,
    })

    const args = mockQuery.mock.calls[0][1] as unknown[]
    expect(args).toEqual(['w1', 7, 'any', 0])
  })

  it('coerces pg NUMERIC string counts to numbers', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          memoryId: 'm-x',
          recallCount: '17',
          positiveCount: '0',
          negativeCount: '0',
          correctionCount: '0',
        },
      ],
    } as any)

    const got = await listMemoriesByRecentOutcome({
      workspaceId: 'w1',
      windowDays: 30,
    })
    expect(got[0].recallCount).toBe(17)
    expect(typeof got[0].recallCount).toBe('number')
  })
})

describe('[COMP:api/memory-recall-events-store] listRecentRecallsForMemory', () => {
  it('joins recall events with the latest feedback per assistant message', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'r1',
          memoryId: 'm1',
          sessionId: 's1',
          assistantMessageId: 'msg-1',
          recallKind: 'tool_call',
          createdAt: new Date('2026-05-23T00:00:00Z'),
          feedbackKind: 'negative',
          feedbackDetails: 'wrong answer here',
        },
        {
          id: 'r2',
          memoryId: 'm1',
          sessionId: 's1',
          assistantMessageId: 'msg-0',
          recallKind: 'index_inject',
          createdAt: new Date('2026-05-22T00:00:00Z'),
          feedbackKind: null,
          feedbackDetails: null,
        },
      ],
    } as any)

    const got = await listRecentRecallsForMemory('m1', 10)
    expect(got).toHaveLength(2)
    expect(got[0].feedbackKind).toBe('negative')
    expect(got[1].feedbackKind).toBeNull()

    const sql = mockQuery.mock.calls[0][0] as string
    const args = mockQuery.mock.calls[0][1] as unknown[]
    expect(sql).toContain('LEFT JOIN LATERAL')
    expect(sql).toContain("metadata->>'messageId'")
    expect(sql).toContain('ORDER BY mre.created_at DESC')
    expect(args).toEqual(['m1', 10])
  })

  it('defaults limit to 50', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)
    await listRecentRecallsForMemory('m1')
    const args = mockQuery.mock.calls[0][1] as unknown[]
    expect(args).toEqual(['m1', 50])
  })
})

describe('[COMP:api/memory-recall-events-store] createMemoryRecallEventsStore handle', () => {
  it('returns an object that exposes both the MemoryRecallSink shape and the helpers', () => {
    const store = createMemoryRecallEventsStore()
    expect(typeof store.recordRecallBatch).toBe('function')
    expect(typeof store.recordRecall).toBe('function')
    expect(typeof store.attachAssistantMessageId).toBe('function')
    expect(typeof store.listMemoriesByRecentOutcome).toBe('function')
    expect(typeof store.listRecentRecallsForMemory).toBe('function')
  })

  it('store.recordRecallBatch wires through to the module function', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)
    const store = createMemoryRecallEventsStore()
    await store.recordRecallBatch({
      memoryIds: ['m1'],
      sessionId: 's1',
      workspaceId: 'w1',
      userId: 'u1',
      recallKind: 'index_inject',
    })
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('INSERT INTO memory_recall_events')
  })
})
