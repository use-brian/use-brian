/**
 * Brain-history version sidecar - capture SQL shape, mutation-event
 * linkage, the as-of resolver (version / current / erased / null), the
 * D7 clearance rule (time-travel applies to data, never permissions),
 * and the destructive-path hooks (deleteMemory captures BEFORE deleting;
 * the consolidation adapter attributes its lane).
 *
 * Pure mock tests at the query boundary; the DB-touching path rides the
 * PGLite/integration harness.
 *
 * Spec: docs/architecture/brain/brain-history.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({
  sql: [] as Array<{ text: string; values: unknown[] }>,
  results: [] as Array<{ rows: unknown[]; rowCount?: number }>,
  events: [] as Array<Record<string, unknown>>,
}))

function nextResult(): { rows: unknown[]; rowCount?: number } {
  return calls.results.shift() ?? { rows: [], rowCount: 0 }
}

vi.mock('../client.js', () => ({
  query: vi.fn(async (text: string, values?: unknown[]) => {
    calls.sql.push({ text, values: values ?? [] })
    return nextResult()
  }),
  getPool: vi.fn(() => ({
    query: async (text: string, values?: unknown[]) => {
      calls.sql.push({ text, values: values ?? [] })
      return nextResult()
    },
  })),
}))

vi.mock('../turn-ledger-store.js', () => ({
  insertTurnEvent: vi.fn(async (e: Record<string, unknown>) => {
    calls.events.push(e)
    return 'event-1'
  }),
}))

import {
  captureMemoryVersions,
  resolveMemoryAsOf,
  resolveMemoryAsOfForClearance,
} from '../brain-row-versions.js'

beforeEach(() => {
  calls.sql.length = 0
  calls.results.length = 0
  calls.events.length = 0
})

describe('[COMP:api/brain-row-versions] captureMemoryVersions', () => {
  it('emits one mutation ledger event and inserts before-images linked to it', async () => {
    calls.results.push({ rows: [], rowCount: 2 })
    const n = await captureMemoryVersions(['m1', 'm2'], {
      actor: 'consolidation_run',
      reason: 'consolidation',
      workspaceId: 'ws1',
    })
    expect(n).toBe(2)
    expect(calls.events).toHaveLength(1)
    expect(calls.events[0].kind).toBe('mutation')
    expect(calls.events[0].actor).toBe('consolidation_run')
    expect((calls.events[0].metadata as Record<string, unknown>).rowIds).toEqual(['m1', 'm2'])
    const capture = calls.sql[0]
    expect(capture.text).toContain('INSERT INTO brain_row_versions')
    expect(capture.text).toContain("to_jsonb(m) - 'embedding'")
    expect(capture.values).toEqual([['m1', 'm2'], 'consolidation_run', 'consolidation', 'event-1'])
  })

  it('no-ops on an empty id list (no event, no SQL)', async () => {
    expect(await captureMemoryVersions([], { actor: 'human_edit', reason: 'x' })).toBe(0)
    expect(calls.events).toHaveLength(0)
    expect(calls.sql).toHaveLength(0)
  })

  it('uses the supplied transaction client and still captures when the event write fails', async () => {
    const { insertTurnEvent } = await import('../turn-ledger-store.js')
    ;(insertTurnEvent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ledger down'))
    const clientCalls: string[] = []
    const client = {
      query: async (text: string, _v?: unknown[]) => {
        clientCalls.push(text)
        return { rows: [], rowCount: 1 }
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const n = await captureMemoryVersions(['m1'], { actor: 'human_edit', reason: 'heal' }, client as never)
      expect(n).toBe(1)
      expect(clientCalls[0]).toContain('INSERT INTO brain_row_versions')
      // event id fell back to null; version capture proceeded
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('[COMP:api/brain-row-versions] resolveMemoryAsOf', () => {
  const at = new Date('2026-08-01T00:00:00Z')

  it('returns the covering version before-image', async () => {
    calls.results.push({ rows: [{ before_image: { summary: 'old' }, erased_at: null, valid_to: new Date('2026-08-02') }] })
    const got = await resolveMemoryAsOf('m1', at)
    expect(got).toMatchObject({ kind: 'version', row: { summary: 'old' } })
  })

  it('returns an explicit erased marker for a wiped version - never silent absence', async () => {
    calls.results.push({ rows: [{ before_image: null, erased_at: new Date('2026-08-10'), valid_to: new Date('2026-08-02') }] })
    const got = await resolveMemoryAsOf('m1', at)
    expect(got?.kind).toBe('erased')
  })

  it('falls back to the live row when no version covers the time', async () => {
    calls.results.push({ rows: [] })
    calls.results.push({ rows: [{ row: { summary: 'live' }, created_at: new Date('2026-07-01') }] })
    const got = await resolveMemoryAsOf('m1', at)
    expect(got).toMatchObject({ kind: 'current', row: { summary: 'live' } })
  })

  it('returns null for a row created after the asked time', async () => {
    calls.results.push({ rows: [] })
    calls.results.push({ rows: [{ row: { summary: 'live' }, created_at: new Date('2026-08-15') }] })
    expect(await resolveMemoryAsOf('m1', at)).toBeNull()
  })

  it('resolves a hard-purged row through the correction_audit tombstone', async () => {
    calls.results.push({ rows: [] })
    calls.results.push({ rows: [] })
    calls.results.push({ rows: [{ created_at: new Date('2026-08-20') }] })
    const got = await resolveMemoryAsOf('m1', at)
    expect(got?.kind).toBe('erased')
  })

  it('returns null when the row never existed', async () => {
    calls.results.push({ rows: [] })
    calls.results.push({ rows: [] })
    calls.results.push({ rows: [] })
    expect(await resolveMemoryAsOf('m1', at)).toBeNull()
  })
})

describe('[COMP:api/brain-row-versions] D7 clearance rule', () => {
  const at = new Date('2026-08-01T00:00:00Z')

  it('gates historical versions by the CURRENT classification', async () => {
    // Live row since reclassified confidential; viewer holds internal.
    calls.results.push({ rows: [{ sensitivity: 'confidential' }] })
    const got = await resolveMemoryAsOfForClearance('m1', at, 'internal')
    expect(got).toEqual({ kind: 'above_clearance' })
    // The resolver never even ran the as-of queries.
    expect(calls.sql).toHaveLength(1)
  })

  it('resolves normally for sufficient clearance', async () => {
    calls.results.push({ rows: [{ sensitivity: 'confidential' }] })
    calls.results.push({ rows: [{ before_image: { summary: 'old' }, erased_at: null, valid_to: new Date('2026-08-02') }] })
    const got = await resolveMemoryAsOfForClearance('m1', at, 'confidential')
    expect(got?.kind).toBe('version')
  })

  it('uses the latest captured sensitivity for a deleted row', async () => {
    calls.results.push({ rows: [] }) // no live row
    calls.results.push({ rows: [{ sensitivity: 'restricted' }] }) // latest version
    const got = await resolveMemoryAsOfForClearance('m1', at, 'confidential')
    expect(got).toEqual({ kind: 'above_clearance' })
  })
})

describe('[COMP:api/brain-row-versions] destructive-path hooks', () => {
  it('deleteMemory captures the before-image BEFORE the DELETE', async () => {
    calls.results.push({ rows: [], rowCount: 1 }) // capture insert
    calls.results.push({ rows: [], rowCount: 1 }) // delete
    const { deleteMemory } = await import('../memories.js')
    await deleteMemory('m1', { actor: 'consolidation_run', reason: 'prune' })
    const order = calls.sql.map((c) => (c.text.includes('brain_row_versions') ? 'capture' : c.text.includes('DELETE FROM memories') ? 'delete' : 'other'))
    expect(order.filter((o) => o !== 'other')).toEqual(['capture', 'delete'])
    expect(calls.events[0].actor).toBe('consolidation_run')
  })
})
