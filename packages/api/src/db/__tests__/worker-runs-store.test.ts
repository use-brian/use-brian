/**
 * Unit tests for the worker_runs store.
 * Component tag: [COMP:api/worker-runs-store].
 *
 * Phase 3 of askQuestion suspend-resume. See
 * docs/architecture/engine/askquestion-suspend-resume.md.
 *
 * Mocks the `query` helper from db/client.js. Covers each method's SQL
 * shape and the loadForSession deserialization (history_json JSONB →
 * Message[] array).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { createDbWorkerRunsStore } from '../worker-runs-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)
const store = createDbWorkerRunsStore()

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/worker-runs-store] recordSpawn', () => {
  it('INSERTs a fresh row keyed by runId (no ON CONFLICT clause)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.recordSpawn({
      runId: '11111111-1111-1111-1111-111111111111',
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      workerId: 'worker_1',
      description: 'check pricing',
      prompt: 'what is the pricing?',
      researchMode: true,
      model: 'gemini-3.1-pro-preview',
    })
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO worker_runs')
    expect(sql).toContain("'running'")
    // Migration 194 dropped UNIQUE(session_id, worker_id); the INSERT
    // no longer needs an ON CONFLICT clause — every spawn is a fresh
    // row keyed by the caller-supplied UUID.
    expect(sql).not.toContain('ON CONFLICT')
    expect(values).toEqual([
      '11111111-1111-1111-1111-111111111111',
      'sess-1', 'ws-1', 'worker_1', 'check pricing',
      'what is the pricing?', true, 'gemini-3.1-pro-preview',
    ])
  })
})

describe('[COMP:api/worker-runs-store] recordTurn', () => {
  it('UPDATEs turn_count + history_json + updated_at by runId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    const history = [
      { role: 'user' as const, content: 'original prompt' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: '1', name: 'webSearch', input: {} }] },
    ]
    await store.recordTurn({
      runId: '22222222-2222-2222-2222-222222222222',
      sessionId: 'sess-1',
      workerId: 'worker_1',
      turnCount: 3,
      history,
    })
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('UPDATE worker_runs')
    expect(sql).toContain('WHERE id = $1')
    expect(sql).toContain('turn_count   = $2')
    expect(sql).toContain('history_json = $3')
    expect(values).toEqual([
      '22222222-2222-2222-2222-222222222222',
      3,
      JSON.stringify(history),
    ])
  })
})

describe('[COMP:api/worker-runs-store] recordCompletion', () => {
  it('UPDATEs status + result + turn_count by runId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.recordCompletion({
      runId: '33333333-3333-3333-3333-333333333333',
      sessionId: 'sess-1',
      workerId: 'worker_1',
      status: 'completed',
      result: 'found the answer',
      turnCount: 4,
    })
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('UPDATE worker_runs')
    expect(sql).toContain('WHERE id = $1')
    expect(sql).toContain('status     = $2')
    expect(sql).toContain('result     = $3')
    expect(values).toEqual([
      '33333333-3333-3333-3333-333333333333',
      'completed',
      'found the answer',
      4,
    ])
  })

  it('handles failed status the same shape (caller decides status)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.recordCompletion({
      runId: '44444444-4444-4444-4444-444444444444',
      sessionId: 'sess-1',
      workerId: 'worker_2',
      status: 'failed',
      result: 'protocol violation',
      turnCount: 1,
    })
    const [, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(values[1]).toBe('failed')
  })
})

describe('[COMP:api/worker-runs-store] deleteTerminalOlderThan', () => {
  it('only deletes terminal-state rows older than the cutoff', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 7 } as never)
    const cutoff = new Date('2026-05-01T00:00:00Z')
    const n = await store.deleteTerminalOlderThan(cutoff)
    expect(n).toBe(7)
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('DELETE FROM worker_runs')
    expect(sql).toContain("status IN ('completed', 'failed', 'stopped')")
    expect(sql).toContain('updated_at < $1')
    expect(values).toEqual([cutoff])
  })

  it('returns 0 when rowCount is null (defensive)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: null } as never)
    const n = await store.deleteTerminalOlderThan(new Date())
    expect(n).toBe(0)
  })
})

describe('[COMP:api/worker-runs-store] loadForSession', () => {
  it('returns rows with history parsed from the JSONB column', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          runId: '55555555-5555-5555-5555-555555555555',
          workerId: 'worker_1',
          status: 'completed',
          description: 'd1',
          prompt: 'p1',
          researchMode: false,
          model: 'gemini-flash',
          turnCount: 2,
          result: 'r1',
          historyJson: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
          ],
        },
        {
          runId: '66666666-6666-6666-6666-666666666666',
          workerId: 'worker_2',
          status: 'running',
          description: 'd2',
          prompt: 'p2',
          researchMode: true,
          model: 'gemini-pro',
          turnCount: 1,
          result: null,
          historyJson: null,
        },
      ],
      rowCount: 2,
    } as never)
    const rows = await store.loadForSession('sess-1')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      runId: '55555555-5555-5555-5555-555555555555',
      workerId: 'worker_1',
      status: 'completed',
      researchMode: false,
      turnCount: 2,
    })
    expect(Array.isArray(rows[0].history)).toBe(true)
    expect(rows[0].history).toHaveLength(2)
    expect(rows[1].runId).toBe('66666666-6666-6666-6666-666666666666')
    // Null history_json (running worker that never recorded a turn)
    // deserializes to []. Caller treats this as "no checkpoint".
    expect(rows[1].history).toEqual([])
  })

  it('queries ordered by created_at ASC for stable rehydration', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.loadForSession('sess-1')
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('FROM worker_runs')
    expect(sql).toContain('ORDER BY created_at ASC')
    expect(values).toEqual(['sess-1'])
  })
})
