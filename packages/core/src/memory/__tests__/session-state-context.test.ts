import { describe, it, expect, vi } from 'vitest'
import {
  buildSessionStateBlock,
  buildDeliveryConversationStateBlock,
} from '../session-state-context.js'
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

/**
 * Read-only bridge for scheduled runs: the block a workflow step / scheduled
 * job sees for the conversation it DELIVERS into. Same row format as the
 * per-turn block; a distinct header + contract preamble; per-session labels
 * only when more than one session contributes.
 */
describe('[COMP:memory/session-state-context] buildDeliveryConversationStateBlock', () => {
  function makeStoreBySession(bySession: Record<string, SessionStateRecord[]>): SessionStateStore {
    return {
      upsert: vi.fn(),
      resolve: vi.fn(),
      listOpenBySession: vi.fn(async (id: string) =>
        (bySession[id] ?? []).filter((r) => r.status === 'open'),
      ),
      listRecentBySession: vi.fn(async (id: string) => bySession[id] ?? []),
      purgeResolvedOlderThan: vi.fn(),
    }
  }

  it('returns null when no delivery-conversation session has rows', async () => {
    const store = makeStoreBySession({ s1: [], s2: [] })
    expect(
      await buildDeliveryConversationStateBlock({
        store,
        sessions: [{ sessionId: 's1' }, { sessionId: 's2', assistantName: 'Trainer' }],
      }),
    ).toBeNull()
  })

  it('returns null for an empty session list without touching the store', async () => {
    const store = makeStoreBySession({})
    expect(await buildDeliveryConversationStateBlock({ store, sessions: [] })).toBeNull()
    expect(store.listRecentBySession).not.toHaveBeenCalled()
  })

  it('renders the delivery-conversation header, contract, and row bodies (detail is data)', async () => {
    const diet = makeRow('diet:2026-08-17', 'Yesterday meals + workout log')
    diet.detail = 'Breakfast: oats 60g, 2 eggs. Gym: squat 5x5 @ 80kg.'
    const store = makeStoreBySession({ s1: [diet, makeRow('session:health', 'Health tracking session')] })
    const out = await buildDeliveryConversationStateBlock({
      store,
      sessions: [{ sessionId: 's1', assistantName: 'Trainer' }],
    })
    expect(out).not.toBeNull()
    expect(out).toContain('# Open commitments (delivery conversation)')
    expect(out).toContain('cannot resolve or edit these rows from here')
    expect(out).toContain('`diet:2026-08-17`')
    expect(out).toContain('squat 5x5 @ 80kg')
    expect(out).toContain('`session:health`')
    // Single contributing session: no "Tracked by" label.
    expect(out).not.toContain('Tracked by')
    // The header must not collide with the per-turn block's exact heading
    // line (the interactive block is `# Open commitments\n`).
    expect(out?.startsWith('# Open commitments (delivery conversation)')).toBe(true)
  })

  it('labels each session when more than one contributes (multi-bot chat)', async () => {
    const store = makeStoreBySession({
      s1: [makeRow('diet:2026-08-17', 'Meals')],
      s2: [makeRow('followup:invoice', 'Chase the invoice')],
    })
    const out = await buildDeliveryConversationStateBlock({
      store,
      sessions: [
        { sessionId: 's1', assistantName: 'Trainer' },
        { sessionId: 's2', assistantName: 'Secretary' },
      ],
    })
    expect(out).toContain('Tracked by Trainer:')
    expect(out).toContain('Tracked by Secretary:')
    expect(out).toContain('`diet:2026-08-17`')
    expect(out).toContain('`followup:invoice`')
  })

  it('skips sessions with no rows and drops the label when only one remains', async () => {
    const store = makeStoreBySession({
      s1: [makeRow('diet:2026-08-17', 'Meals')],
      s2: [],
    })
    const out = await buildDeliveryConversationStateBlock({
      store,
      sessions: [
        { sessionId: 's1', assistantName: 'Trainer' },
        { sessionId: 's2', assistantName: 'Secretary' },
      ],
    })
    expect(out).toContain('`diet:2026-08-17`')
    expect(out).not.toContain('Tracked by')
  })

  it('never trims open rows; trims resolved rows oldest-first under budget pressure', async () => {
    const rows = [
      makeRow('open:1', 'O'.repeat(200)),
      makeRow('open:2', 'O'.repeat(200)),
      makeRow('res:new', 'R'.repeat(200), 'resolved', 1),
      makeRow('res:old', 'R'.repeat(200), 'resolved', 60),
    ]
    const store = makeStoreBySession({ s1: rows })
    const out = await buildDeliveryConversationStateBlock({
      store,
      sessions: [{ sessionId: 's1' }],
      tokenBudget: 200,
    })
    expect(out).toContain('`open:1`')
    expect(out).toContain('`open:2`')
    expect(out).not.toContain('`res:old`')
  })
})
