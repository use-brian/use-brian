/**
 * Local-fanout + presence tests for the draft-session live bus.
 *
 * The cross-instance NOTIFY/LISTEN path requires a live Postgres and is
 * covered by `*(add — integration test for cross-instance NOTIFY
 * deferred)*` in component-map.md. This file exercises the in-process
 * fan-out, presence transitions, and typing-debounce semantics — the
 * pieces that drive the SSE frame contract from the producing instance.
 *
 * NOTIFY is a fire-and-forget side effect of `publishSessionEvent`. It
 * fails silently when DATABASE_URL isn't a valid Postgres — which is the
 * case in unit tests — so we mock `query()` to a noop to keep the test
 * deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  getPool: vi.fn(),
}))
vi.mock('../../db/sessions.js', () => ({
  getSessionMessages: vi.fn().mockResolvedValue([]),
}))

import {
  subscribeSessionEvents,
  publishSessionEvent,
  setSessionTyping,
  getSessionPresence,
  _shutdownSessionEventBus,
  _getSessionSubscriberCount,
  type SessionEvent,
} from '../session-event-bus.js'

afterEach(async () => {
  await _shutdownSessionEventBus()
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/session-event-bus] subscribe + publish (local fanout)', () => {
  it('delivers events to all subscribers of the same session', () => {
    const sessionId = 'sess_1'
    const seenA: SessionEvent[] = []
    const seenB: SessionEvent[] = []
    const unsubA = subscribeSessionEvents({
      sessionId,
      userId: 'alice',
      name: 'Alice',
      cb: (e) => seenA.push(e),
    })
    const unsubB = subscribeSessionEvents({
      sessionId,
      userId: 'bob',
      name: 'Bob',
      cb: (e) => seenB.push(e),
    })

    publishSessionEvent({
      kind: 'turn_started',
      sessionId,
      payload: { senderUserId: 'alice' },
    })

    // Both subscribers see the turn_started event. They each also saw
    // presence events on join — we only assert the post-publish slice.
    const turnEventsA = seenA.filter((e) => e.kind === 'turn_started')
    const turnEventsB = seenB.filter((e) => e.kind === 'turn_started')
    expect(turnEventsA).toHaveLength(1)
    expect(turnEventsB).toHaveLength(1)

    unsubA()
    unsubB()
  })

  it('delivers turn_stream snapshots to a reconnected comment-thread watcher', () => {
    // The doc comment reconnect (GET /api/sessions/:id/stream) subscribes to
    // this bus to re-attach to a still-running turn after a page refresh; the
    // chat route publishes `turn_stream` snapshots of the in-flight reply.
    const sessionId = 'sess_reconnect'
    const seen: SessionEvent[] = []
    const unsub = subscribeSessionEvents({
      sessionId,
      userId: 'alice',
      name: null,
      cb: (e) => seen.push(e),
    })

    publishSessionEvent({
      kind: 'turn_stream',
      sessionId,
      payload: { text: 'Flattening the two subpages', activity: null },
    })

    const snapshots = seen.filter((e) => e.kind === 'turn_stream')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].payload).toEqual({
      text: 'Flattening the two subpages',
      activity: null,
    })

    unsub()
  })

  it('does NOT deliver to subscribers of a different session', () => {
    const calls: string[] = []
    const unsub = subscribeSessionEvents({
      sessionId: 'sess_focus',
      userId: 'alice',
      name: 'Alice',
      cb: (e) => calls.push(`focus:${e.kind}`),
    })

    publishSessionEvent({
      kind: 'turn_started',
      sessionId: 'sess_other',
      payload: { senderUserId: 'bob' },
    })

    // Only the join-presence event for sess_focus reaches us.
    expect(calls.filter((c) => c === 'focus:turn_started')).toHaveLength(0)
    unsub()
  })

  it('isolates a misbehaving subscriber callback so it does not crash siblings', () => {
    const sessionId = 'sess_isolate'
    const seenB: string[] = []
    subscribeSessionEvents({
      sessionId,
      userId: 'alice',
      name: null,
      cb: () => { throw new Error('explode') },
    })
    subscribeSessionEvents({
      sessionId,
      userId: 'bob',
      name: null,
      cb: (e) => seenB.push(e.kind),
    })

    expect(() =>
      publishSessionEvent({
        kind: 'turn_started',
        sessionId,
        payload: { senderUserId: 'alice' },
      }),
    ).not.toThrow()
    // Bob still received it.
    expect(seenB).toContain('turn_started')
  })
})

describe('[COMP:api/session-event-bus] presence transitions', () => {
  it('emits a presence event on first join + last leave for a user', () => {
    const sessionId = 'sess_pres'
    const presenceEvents: SessionEvent[] = []
    // Subscribe a watcher first so we capture the join event for the
    // second user. The first subscriber's own join is captured *before*
    // it has installed its callback (we register, then emit) — that's
    // OK because we only assert second-user join + leave.
    subscribeSessionEvents({
      sessionId,
      userId: 'watcher',
      name: 'Watcher',
      cb: (e) => { if (e.kind === 'presence') presenceEvents.push(e) },
    })

    const unsubAlice = subscribeSessionEvents({
      sessionId,
      userId: 'alice',
      name: 'Alice',
      cb: () => {},
    })
    expect(presenceEvents.at(-1)?.kind).toBe('presence')
    const afterJoin = getSessionPresence(sessionId)
    expect(afterJoin.map((v) => v.userId).sort()).toEqual(['alice', 'watcher'])

    unsubAlice()
    const afterLeave = getSessionPresence(sessionId)
    expect(afterLeave.map((v) => v.userId)).toEqual(['watcher'])
    // A presence event followed the leave too.
    expect(presenceEvents.length).toBeGreaterThanOrEqual(2)
  })

  it('multi-tab dedupe — second tab for the same user does NOT re-emit join', () => {
    const sessionId = 'sess_multitab'
    const presenceEvents: SessionEvent[] = []
    subscribeSessionEvents({
      sessionId,
      userId: 'watcher',
      name: 'Watcher',
      cb: (e) => { if (e.kind === 'presence') presenceEvents.push(e) },
    })
    const baseline = presenceEvents.length

    const tab1 = subscribeSessionEvents({
      sessionId,
      userId: 'alice',
      name: 'Alice',
      cb: () => {},
    })
    const afterTab1 = presenceEvents.length
    expect(afterTab1).toBeGreaterThan(baseline)

    const tab2 = subscribeSessionEvents({
      sessionId,
      userId: 'alice',
      name: 'Alice',
      cb: () => {},
    })
    // Second tab — same user — does not produce a fresh presence event.
    expect(presenceEvents.length).toBe(afterTab1)

    // First tab close: user is still present (one connection left).
    tab1()
    expect(presenceEvents.length).toBe(afterTab1)

    // Last tab close: now we get the leave.
    tab2()
    expect(presenceEvents.length).toBeGreaterThan(afterTab1)
  })
})

describe('[COMP:api/session-event-bus] typing transitions', () => {
  it('emits a presence event only on the typing transition, not refreshes', () => {
    const sessionId = 'sess_type'
    const presenceEvents: SessionEvent[] = []
    subscribeSessionEvents({
      sessionId,
      userId: 'alice',
      name: 'Alice',
      cb: (e) => { if (e.kind === 'presence') presenceEvents.push(e) },
    })
    const baseline = presenceEvents.length

    setSessionTyping({ sessionId, userId: 'alice', isTyping: true })
    expect(presenceEvents.length).toBe(baseline + 1)

    // Same state again — no new event.
    setSessionTyping({ sessionId, userId: 'alice', isTyping: true })
    expect(presenceEvents.length).toBe(baseline + 1)

    // Off transition — one event.
    setSessionTyping({ sessionId, userId: 'alice', isTyping: false })
    expect(presenceEvents.length).toBe(baseline + 2)
  })

  it('typing beacon for a user who never subscribed is a no-op', () => {
    const sessionId = 'sess_ghost'
    const presenceEvents: SessionEvent[] = []
    subscribeSessionEvents({
      sessionId,
      userId: 'watcher',
      name: 'Watcher',
      cb: (e) => { if (e.kind === 'presence') presenceEvents.push(e) },
    })
    const baseline = presenceEvents.length
    setSessionTyping({ sessionId, userId: 'ghost', isTyping: true })
    expect(presenceEvents.length).toBe(baseline)
  })
})

describe('[COMP:api/session-event-bus] subscriber accounting', () => {
  it('subscriber count tracks subscribe + unsubscribe', () => {
    expect(_getSessionSubscriberCount()).toBe(0)
    const u1 = subscribeSessionEvents({
      sessionId: 's',
      userId: 'a',
      name: null,
      cb: () => {},
    })
    expect(_getSessionSubscriberCount()).toBe(1)
    const u2 = subscribeSessionEvents({
      sessionId: 's',
      userId: 'b',
      name: null,
      cb: () => {},
    })
    expect(_getSessionSubscriberCount()).toBe(2)
    u1()
    expect(_getSessionSubscriberCount()).toBe(1)
    u2()
    expect(_getSessionSubscriberCount()).toBe(0)
  })
})
