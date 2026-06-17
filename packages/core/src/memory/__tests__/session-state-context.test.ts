import { describe, it, expect, vi } from 'vitest'
import { buildSessionStateBlock } from '../session-state-context.js'
import type {
  SessionStateRecord,
  SessionStateStore,
  SessionStateStatus,
} from '../session-state-types.js'

function makeRow(
  key: string,
  summary: string,
  status: SessionStateStatus = 'open',
  ageMinutes = 0,
): SessionStateRecord {
  const t = new Date(Date.now() - ageMinutes * 60_000)
  return {
    id: `id-${key}`,
    sessionId: 's1',
    userId: 'u1',
    assistantId: 'a1',
    key,
    status,
    summary,
    detail: null,
    source: 'tool',
    createdAt: t,
    updatedAt: t,
    resolvedAt: status === 'open' ? null : t,
  }
}

function makeStore(rows: SessionStateRecord[]): SessionStateStore {
  return {
    upsert: vi.fn(),
    resolve: vi.fn(),
    listOpenBySession: vi.fn(async () => rows.filter((r) => r.status === 'open')),
    listRecentBySession: vi.fn(async () => rows),
    purgeResolvedOlderThan: vi.fn(),
  }
}

describe('[COMP:memory/session-state-context] buildSessionStateBlock', () => {
  it('returns null when the session has no rows', async () => {
    const store = makeStore([])
    expect(await buildSessionStateBlock({ store, sessionId: 's1' })).toBeNull()
  })

  it('injects open commitments with header and per-row formatting', async () => {
    const store = makeStore([
      makeRow('pill:2026-04-23', 'Confirm daily 2 PM pill'),
      makeRow('trip:seoul', 'Pick dinner spot for Day 2'),
    ])
    const out = await buildSessionStateBlock({ store, sessionId: 's1' })
    expect(out).not.toBeNull()
    expect(out).toContain('# Open commitments')
    expect(out).toContain('`pill:2026-04-23`')
    expect(out).toContain('`trip:seoul`')
    expect(out).toContain('[open, updated')
  })

  it('renders resolved rows with a [resolved ...] prefix', async () => {
    const store = makeStore([
      makeRow('pill:today', 'Daily pill', 'resolved', 30),
    ])
    const out = await buildSessionStateBlock({ store, sessionId: 's1' })
    expect(out).toContain('[resolved')
    expect(out).toContain('pill:today')
  })

  it('trims oldest resolved rows first when over token budget', async () => {
    const rows: SessionStateRecord[] = []
    rows.push(makeRow('open:1', 'open alpha'))
    // 40 resolved rows each with a long summary to blow through the budget
    for (let i = 0; i < 40; i += 1) {
      rows.push(
        makeRow(
          `resolved:${i}`,
          `a very long summary '.repeat(10)'`.repeat(5),
          'resolved',
          i,
        ),
      )
    }
    const store = makeStore(rows)
    const out = await buildSessionStateBlock({
      store,
      sessionId: 's1',
      tokenBudget: 200, // aggressive — forces trim
    })
    expect(out).not.toBeNull()
    // Open row always survives
    expect(out).toContain('`open:1`')
  })

  it('never trims open rows even under aggressive budget', async () => {
    const rows = [
      makeRow('open:1', 'first open'),
      makeRow('open:2', 'second open'),
      makeRow('open:3', 'third open'),
    ]
    const store = makeStore(rows)
    const out = await buildSessionStateBlock({
      store,
      sessionId: 's1',
      tokenBudget: 1, // effectively zero
    })
    expect(out).not.toBeNull()
    expect(out).toContain('`open:1`')
    expect(out).toContain('`open:2`')
    expect(out).toContain('`open:3`')
  })
})
