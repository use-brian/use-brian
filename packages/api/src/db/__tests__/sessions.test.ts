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
  listSessionsForWorkspaceSystem,
  getSessionTranscriptForWorkspaceSystem,
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
    expect(params).toEqual(['a_1', 'u_1', 'telegram', 'chat_123', 'Use Brian', null, 'owner', null, null])
  })

  it('defaults appId to Use Brian when not provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 's_1' }], rowCount: 1 } as never)
    await findOrCreateSession({
      assistantId: 'a_1', userId: 'u_1',
      channelType: 'web', channelId: 'uuid-web',
    })
    expect(mockQuery.mock.calls[0][1]![4]).toBe('Use Brian')
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

  // WS3 cross-session chat-deletion regression: the primitive resolves the
  // session from the message id, so a caller must be able to pin the session
  // it believes it is truncating. A message that lives in a DIFFERENT session
  // than expectedSessionId is refused (treated as not-found) — no DELETE runs.
  it('refuses a message whose session differs from expectedSessionId', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ sessionId: 's_victim', sequenceNum: 2 }],
      rowCount: 1,
    } as never)

    const result = await truncateMessagesFrom('m_leaked', 's_caller')
    expect(result.deleted).toBe(0)
    expect(result.sessionId).toBeNull()
    expect(result.deletedMessages).toEqual([])
    // Only the info lookup ran — no capture SELECT, no DELETE.
    expect(mockQuery).toHaveBeenCalledOnce()
  })

  it('proceeds when expectedSessionId matches the message session', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ sessionId: 's_1', sequenceNum: 5 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'm_5' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const result = await truncateMessagesFrom('m_5', 's_1')
    expect(result.deleted).toBe(1)
    expect(result.sessionId).toBe('s_1')
  })
})

// Introspection session-history reads (audit §6-a). Both scope via the
// assistants.workspace_id join, which excludes other members' personal
// assistants. See docs/architecture/engine/introspection-tools.md.

describe('[COMP:api/sessions-route] listSessionsForWorkspaceSystem', () => {
  it('joins assistants and scopes on assistants.workspace_id = $1, newest-active first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await listSessionsForWorkspaceSystem('ws_1', { limit: 20 })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('JOIN assistants a ON a.id = s.assistant_id')
    expect(sql).toContain('a.workspace_id = $1')
    expect(sql).toContain('ORDER BY s.last_active_at DESC')
    // No channel filter → workspace + limit only.
    expect(params).toEqual(['ws_1', 20])
  })

  it('adds the channel_type predicate when channelType is supplied', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await listSessionsForWorkspaceSystem('ws_1', { limit: 10, channelType: 'telegram' })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('s.channel_type = $2')
    expect(params).toEqual(['ws_1', 'telegram', 10])
  })

  it('clamps an over-cap limit to 50 defensively', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await listSessionsForWorkspaceSystem('ws_1', { limit: 999 })
    expect(mockQuery.mock.calls[0][1]).toEqual(['ws_1', 50])
  })
})

describe('[COMP:api/sessions-route] getSessionTranscriptForWorkspaceSystem', () => {
  it('returns null when the scope guard finds no in-workspace session (no message fetch)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // scope guard: miss
    const result = await getSessionTranscriptForWorkspaceSystem('s_x', 'ws_1', { limit: 30 })
    expect(result).toBeNull()
    // Only the guard ran — no second (message) query.
    expect(mockQuery).toHaveBeenCalledOnce()
    const [guardSql, guardParams] = mockQuery.mock.calls[0]
    expect(guardSql).toContain('JOIN assistants a ON a.id = s.assistant_id')
    expect(guardSql).toContain('s.id = $1 AND a.workspace_id = $2')
    expect(guardParams).toEqual(['s_x', 'ws_1'])
  })

  it('fetches the most-recent N (DESC LIMIT) and returns them reversed to chronological', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 's_1' }], rowCount: 1 } as never) // scope guard: hit
      .mockResolvedValueOnce({
        // DB returns newest-first (sequence DESC).
        rows: [
          { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
          { role: 'user', content: [{ type: 'text', text: 'first' }] },
        ],
        rowCount: 2,
      } as never)

    const result = await getSessionTranscriptForWorkspaceSystem('s_1', 'ws_1', { limit: 30 })
    const [msgSql, msgParams] = mockQuery.mock.calls[1]
    expect(msgSql).toContain('ORDER BY sequence_num DESC')
    expect(msgSql).toContain('LIMIT $2')
    expect(msgParams).toEqual(['s_1', 30])
    // Reversed to chronological: user 'first' then assistant 'second'.
    expect(result).toEqual([
      { role: 'user', gist: 'first' },
      { role: 'assistant', gist: 'second' },
    ])
  })

  it('collapses tool_use / tool_result blocks to one-line markers, never the payload', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 's_1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Sending it.' },
              { type: 'tool_use', name: 'gmailSendMessage', input: { to: 'secret@vendor.com' } },
              { type: 'tool_result', content: 'ok' },
            ],
          },
        ],
        rowCount: 1,
      } as never)

    const result = await getSessionTranscriptForWorkspaceSystem('s_1', 'ws_1', { limit: 30 })
    expect(result).toEqual([
      { role: 'assistant', gist: 'Sending it. [tool: gmailSendMessage] [tool result]' },
    ])
    // The frozen tool input must never leak into the gist.
    expect(result![0].gist).not.toContain('secret@vendor.com')
  })

  it('passes a bare string content through and marks empty/opaque content', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 's_1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        // DB order is newest-first (sequence DESC); the method reverses to
        // chronological, so the assistant row (newer) is listed first here.
        rows: [
          { role: 'assistant', content: [{ type: 'image', source: {} }] },
          { role: 'user', content: 'plain string body' },
        ],
        rowCount: 2,
      } as never)

    const result = await getSessionTranscriptForWorkspaceSystem('s_1', 'ws_1', { limit: 30 })
    expect(result).toEqual([
      { role: 'user', gist: 'plain string body' },
      { role: 'assistant', gist: '(non-text content)' },
    ])
  })

  it('clamps an over-cap message limit to 100 defensively', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 's_1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await getSessionTranscriptForWorkspaceSystem('s_1', 'ws_1', { limit: 999 })
    expect(mockQuery.mock.calls[1][1]).toEqual(['s_1', 100])
  })
})
