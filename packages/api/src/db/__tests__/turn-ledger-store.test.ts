/**
 * turn-ledger store - SQL shapes at the query boundary: append-only
 * insert with conflict-tolerant RETURNING, per-workspace payload
 * scoping, trace re-keying, and the erasure tombstone returning storage
 * refs for object deletion.
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({
  sql: [] as Array<{ text: string; values: unknown[] }>,
  results: [] as Array<{ rows: unknown[]; rowCount?: number }>,
}))

vi.mock('../client.js', () => ({
  query: vi.fn(async (text: string, values?: unknown[]) => {
    calls.sql.push({ text, values: values ?? [] })
    return calls.results.shift() ?? { rows: [], rowCount: 0 }
  }),
  getPool: vi.fn(),
}))

import {
  insertTurnEvent,
  markPayloadsErased,
  payloadScope,
  rebindTraceId,
} from '../turn-ledger-store.js'

beforeEach(() => {
  calls.sql.length = 0
  calls.results.length = 0
})

describe('[COMP:api/turn-ledger-store] turn_events + turn_payloads access', () => {
  it('insertTurnEvent is conflict-tolerant and returns the row id', async () => {
    calls.results.push({ rows: [{ id: 'evt-1' }] })
    const id = await insertTurnEvent({
      workspaceId: 'ws1',
      assistantMessageId: 'msg-1',
      stepOrdinal: 0,
      actor: 'assistant_turn',
      kind: 'provider_call',
      metadata: { turn: 0 },
      payloadRefs: ['h1'],
    })
    expect(id).toBe('evt-1')
    const sql = calls.sql[0].text
    expect(sql).toContain('INSERT INTO turn_events')
    expect(sql).toContain('ON CONFLICT (assistant_message_id, step_ordinal) DO NOTHING')
    expect(sql).toContain('RETURNING id')
  })

  it('returns null when the ordinal already exists (idempotent replayed write)', async () => {
    calls.results.push({ rows: [] })
    const id = await insertTurnEvent({
      assistantMessageId: 'msg-1',
      stepOrdinal: 0,
      actor: 'assistant_turn',
      kind: 'tool_call',
      metadata: {},
      payloadRefs: [],
    })
    expect(id).toBeNull()
  })

  it('payloadScope isolates workspaces and names the global lane', () => {
    expect(payloadScope('ws1')).toBe('ws1')
    expect(payloadScope(null)).toBe('global')
    expect(payloadScope(undefined)).toBe('global')
  })

  it('rebindTraceId re-keys and no-ops on identical ids', async () => {
    await rebindTraceId('minted', 'real')
    expect(calls.sql[0].text).toContain('UPDATE turn_events SET assistant_message_id')
    expect(calls.sql[0].values).toEqual(['minted', 'real'])
    calls.sql.length = 0
    await rebindTraceId('same', 'same')
    expect(calls.sql).toHaveLength(0)
  })

  it('markPayloadsErased tombstones once and returns the storage refs', async () => {
    calls.results.push({ rows: [{ storage_ref: 'ledger/ws1/h1' }] })
    const refs = await markPayloadsErased('ws1', ['h1'])
    expect(refs).toEqual(['ledger/ws1/h1'])
    expect(calls.sql[0].text).toContain('erased_at IS NULL')
    expect(await markPayloadsErased('ws1', [])).toEqual([])
  })
})
