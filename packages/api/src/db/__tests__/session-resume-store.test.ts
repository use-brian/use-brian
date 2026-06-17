import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { createDbSessionResumeStore } from '../session-resume-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)
const store = createDbSessionResumeStore()

beforeEach(() => {
  mockQuery.mockReset()
})

const SAMPLE_ROW = {
  sessionId: 'sess-1',
  approvalId: 'app-1',
  suspendedToolName: 'gmailSendMessage',
  suspendedToolInput: { to: 'user@example.com', subject: 'hi' },
  loopStepIndex: 3,
  createdAt: new Date('2026-05-14T00:00:00Z'),
}

describe('[COMP:api/session-resume-store] create', () => {
  it('inserts and returns the row when no prior row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [SAMPLE_ROW], rowCount: 1 } as never)

    const row = await store.create({
      sessionId: 'sess-1',
      approvalId: 'app-1',
      suspendedToolName: 'gmailSendMessage',
      suspendedToolInput: { to: 'user@example.com', subject: 'hi' },
      loopStepIndex: 3,
    })

    expect(row).toEqual(SAMPLE_ROW)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('INSERT INTO session_resume_points')
    expect(sql).toContain('ON CONFLICT (session_id) DO NOTHING')
    expect(params).toEqual([
      'sess-1',
      'app-1',
      'gmailSendMessage',
      JSON.stringify({ to: 'user@example.com', subject: 'hi' }),
      3,
    ])
  })

  it('on PK conflict, re-reads the existing row and returns it', async () => {
    // First call: INSERT ... ON CONFLICT DO NOTHING → empty RETURNING.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    // Second call: SELECT for the existing row.
    mockQuery.mockResolvedValueOnce({ rows: [SAMPLE_ROW], rowCount: 1 } as never)

    const row = await store.create({
      sessionId: 'sess-1',
      approvalId: 'app-1',
      suspendedToolName: 'gmailSendMessage',
      suspendedToolInput: { to: 'user@example.com', subject: 'hi' },
      loopStepIndex: 3,
    })

    expect(row).toEqual(SAMPLE_ROW)
    expect(mockQuery).toHaveBeenCalledTimes(2)
    const [reselect] = mockQuery.mock.calls[1]
    expect(reselect).toContain('SELECT')
    expect(reselect).toContain('WHERE session_id = $1')
  })
})

describe('[COMP:api/session-resume-store] getBySessionId / getByApprovalId', () => {
  it('returns the row when found by session id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [SAMPLE_ROW], rowCount: 1 } as never)
    const row = await store.getBySessionId('sess-1')
    expect(row).toEqual(SAMPLE_ROW)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('WHERE session_id = $1')
    expect(params).toEqual(['sess-1'])
  })

  it('returns null when no row matches the session id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getBySessionId('sess-missing')).toBeNull()
  })

  it('returns the row when found by approval id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [SAMPLE_ROW], rowCount: 1 } as never)
    const row = await store.getByApprovalId('app-1')
    expect(row).toEqual(SAMPLE_ROW)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('WHERE approval_id = $1')
    expect(params).toEqual(['app-1'])
  })

  it('returns null when no row matches the approval id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getByApprovalId('app-missing')).toBeNull()
  })
})

describe('[COMP:api/session-resume-store] deleteBySessionId / deleteByApprovalId', () => {
  it('deleteBySessionId returns true when a row was removed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await store.deleteBySessionId('sess-1')).toBe(true)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('DELETE FROM session_resume_points')
    expect(sql).toContain('WHERE session_id = $1')
    expect(params).toEqual(['sess-1'])
  })

  it('deleteBySessionId returns false when no row matched', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.deleteBySessionId('sess-missing')).toBe(false)
  })

  it('deleteByApprovalId returns true when a row was removed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await store.deleteByApprovalId('app-1')).toBe(true)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('WHERE approval_id = $1')
    expect(params).toEqual(['app-1'])
  })

  it('deleteByApprovalId returns false when no row matched', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.deleteByApprovalId('app-missing')).toBe(false)
  })
})
