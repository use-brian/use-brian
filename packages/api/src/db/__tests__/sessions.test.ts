import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the pg client before importing the sessions module
vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import {
  findOrCreateSession,
  findSessionById,
  updateSessionStatus,
  updateSessionTitle,
  renameSession,
  countSessionTurns,
  addSessionMessage,
  truncateMessagesFrom,
  getSessionMessages,
  setCompactSummaryAndBoundary,
} from '../sessions.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/sessions-route] findOrCreateSession', () => {
  it('issues an INSERT ... ON CONFLICT on the 5-tuple', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 's_1', assistantId: 'a_1', userId: 'u_1' }],
      rowCount: 1,
    } as never)
    await findOrCreateSession({
      assistantId: 'a_1',
      userId: 'u_1',
      channelType: 'telegram',
      channelId: 'chat_123',
    })
    expect(mockQuery).toHaveBeenCalledOnce()
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('INSERT INTO sessions')
    expect(sql).toContain('ON CONFLICT (assistant_id, user_id, channel_type, channel_id, app_id)')
    // app_origin (migration 187) is the 6th INSERT param; defaults to null
    // when the caller omits it. visibility (migration 223) is the 7th
    // (defaults to 'owner'), workspace_id the 8th (defaults to null), and
    // effective_clearance (migration 224) the 9th (defaults to null).
    // The ON CONFLICT key is still the 5-tuple.
    expect(params).toEqual(['a_1', 'u_1', 'telegram', 'chat_123', 'sidanclaw', null, 'owner', null, null])
  })

  it('defaults appId to sidanclaw when not provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 's_1' }], rowCount: 1 } as never)
    await findOrCreateSession({
      assistantId: 'a_1', userId: 'u_1',
      channelType: 'web', channelId: 'uuid-web',
    })
    expect(mockQuery.mock.calls[0][1]![4]).toBe('sidanclaw')
  })

  it('honors a custom appId when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 's_1' }], rowCount: 1 } as never)
    await findOrCreateSession({
      assistantId: 'a_1', userId: 'u_1',
      channelType: 'app', channelId: 'trip_1',
      appId: 'sidantrip',
    })
    expect(mockQuery.mock.calls[0][1]![4]).toBe('sidantrip')
  })
})

describe('[COMP:api/sessions-route] findSessionById', () => {
  it('returns null when the id is not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const result = await findSessionById('s_missing')
    expect(result).toBeNull()
    // Should not issue the touch UPDATE when no row found
    expect(mockQuery).toHaveBeenCalledOnce()
  })

  it('touches last_active_at on a successful lookup', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 's_1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await findSessionById('s_1')
    expect(mockQuery).toHaveBeenCalledTimes(2)
    expect(mockQuery.mock.calls[1][0]).toContain('UPDATE sessions SET last_active_at')
  })
})

describe('[COMP:api/sessions-route] updateSessionStatus', () => {
  it('issues an UPDATE setting status and last_active_at', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await updateSessionStatus('s_1', 'running')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('UPDATE sessions SET status')
    expect(params).toEqual(['running', 's_1'])
  })
})

describe('[COMP:api/sessions-route] updateSessionTitle (auto-titler)', () => {
  it('gates on title_manually_set = false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await updateSessionTitle('s_1', 'New Title')
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toContain('title_manually_set = false')
  })

  it('returns true when a row was actually written', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const wrote = await updateSessionTitle('s_1', 'New Title')
    expect(wrote).toBe(true)
  })

  it('returns false when no row was touched (manually renamed session)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const wrote = await updateSessionTitle('s_1', 'New Title')
    expect(wrote).toBe(false)
  })
})

describe('[COMP:api/sessions-route] renameSession (user action)', () => {
  it('writes title AND sets title_manually_set = true', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await renameSession('s_1', 'My Trip')
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toContain('title_manually_set = true')
  })
})

describe('[COMP:api/sessions-route] countSessionTurns', () => {
  it('counts user+assistant messages only', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }], rowCount: 1 } as never)
    const n = await countSessionTurns('s_1')
    expect(n).toBe(7)
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toContain("role IN ('user', 'assistant')")
  })
})

describe('[COMP:api/sessions-route] addSessionMessage', () => {
  it('serializes content to JSON and uses MAX(sequence_num)+1', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'm_1', sequenceNum: 1 }],
      rowCount: 1,
    } as never)
    await addSessionMessage({
      sessionId: 's_1',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('MAX(sequence_num)')
    expect(params![0]).toBe('s_1')
    expect(params![1]).toBe('user')
    expect(params![2]).toBe(JSON.stringify([{ type: 'text', text: 'hi' }]))
  })
})

describe('[COMP:api/sessions-route] getSessionMessages with fromSequence', () => {
  it('loads all rows when fromSequence is not provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await getSessionMessages('s_1')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).not.toContain('sequence_num >=')
    expect(sql).not.toContain('sequence_num >')
    expect(params).toEqual(['s_1'])
  })

  it('loads all rows when fromSequence is null (session never compacted)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await getSessionMessages('s_1', { fromSequence: null })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).not.toContain('sequence_num >=')
    expect(params).toEqual(['s_1'])
  })

  it('filters with sequence_num >= N when fromSequence is provided (inclusive)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await getSessionMessages('s_1', { fromSequence: 42 })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('sequence_num >= $2')
    expect(params).toEqual(['s_1', 42])
  })
})

describe('[COMP:api/sessions-route] setCompactSummaryAndBoundary', () => {
  it('writes summary + cursor atomically and returns true on rowCount=1', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const claimed = await setCompactSummaryAndBoundary('s_1', 'compacted text', 510, 499)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('compact_summary = $1')
    expect(sql).toContain('compact_boundary_sequence = $2')
    expect(sql).toContain('compaction_count = compaction_count + 1')
    expect(sql).toContain('last_compacted_at = now()')
    expect(sql).toContain('compact_boundary_sequence IS NOT DISTINCT FROM $4')
    expect(params).toEqual(['compacted text', 510, 's_1', 499])
    expect(claimed).toBe(true)
  })

  it('returns false when the concurrency guard fails (rowCount=0)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const claimed = await setCompactSummaryAndBoundary('s_1', 'text', 510, 499)
    expect(claimed).toBe(false)
  })

  it('passes null as the expected cursor for never-compacted sessions', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await setCompactSummaryAndBoundary('s_1', 'text', 42, null)
    const [, params] = mockQuery.mock.calls[0]
    expect(params).toEqual(['text', 42, 's_1', null])
  })
})

describe('[COMP:api/sessions-route] truncateMessagesFrom', () => {
  it('returns zero-result when the message id is unknown', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const result = await truncateMessagesFrom('m_missing')
    expect(result.deleted).toBe(0)
    expect(result.sessionId).toBeNull()
    expect(result.deletedMessages).toEqual([])
    expect(mockQuery).toHaveBeenCalledOnce()  // only the info lookup
  })

  it('deletes messages at or after the target sequence number', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ sessionId: 's_1', sequenceNum: 5 }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 'm_5' }, { id: 'm_6' }, { id: 'm_7' }],
        rowCount: 3,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 3 } as never)

    const result = await truncateMessagesFrom('m_5')
    expect(result.deleted).toBe(3)
    expect(result.sessionId).toBe('s_1')
    expect(result.deletedMessages).toHaveLength(3)

    // Delete query should use sequence_num >= the target
    const deleteSql = mockQuery.mock.calls[2][0] as string
    expect(deleteSql).toContain('DELETE FROM session_messages')
    expect(deleteSql).toContain('sequence_num >= $2')
    expect(mockQuery.mock.calls[2][1]).toEqual(['s_1', 5])
  })
})
