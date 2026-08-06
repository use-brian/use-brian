import { describe, it, expect, beforeEach, vi } from 'vitest'

// The registry only reaches the DB to fan a message out to ANOTHER instance.
// Every assertion below is about the local path, so both seams are stubbed —
// keeping this suite DB-free (see docs/workflow/testing.md).
vi.mock('../db/client.js', () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }))
vi.mock('../db/notify-listener.js', () => ({
  registerNotifyChannel: vi.fn(),
  startNotifyListener: vi.fn(),
  unregisterNotifyChannel: vi.fn(async () => {}),
}))

import {
  registerTurnInbox,
  deliverTurnInput,
  hasTurnInbox,
  _resetTurnInboxes,
} from '../turn-inbox.js'
import type { PendingTurnInput } from '@use-brian/core'

const input = (over: Partial<PendingTurnInput> & { text: string }): PendingTurnInput => ({
  id: over.id ?? 'i1',
  mode: over.mode ?? 'queued',
  receivedAt: over.receivedAt ?? 1,
  text: over.text,
})

describe('[COMP:api/turn-inbox] Mid-turn input registry', () => {
  beforeEach(() => {
    _resetTurnInboxes()
  })

  it('holds a message for a running turn and hands it over on drain', () => {
    const handle = registerTurnInbox('s1')
    expect(handle.port.peek()).toEqual({ pending: false, steer: false })

    expect(deliverTurnInput({ sessionId: 's1', input: input({ text: 'and Jack?' }) })).toBe(true)
    expect(handle.port.peek()).toEqual({ pending: true, steer: false })

    const drained = handle.port.drain()
    expect(drained.map((i) => i.text)).toEqual(['and Jack?'])
    // Draining clears — a second drain point must not re-inject.
    expect(handle.port.peek().pending).toBe(false)
    expect(handle.port.drain()).toEqual([])
  })

  it('reports not-delivered when no turn is holding an inbox', () => {
    // What the client's "the turn already ended, send it normally" fallback
    // keys off.
    expect(deliverTurnInput({ sessionId: 'nobody', input: input({ text: 'hi' }) })).toBe(false)
    expect(hasTurnInbox('nobody')).toBe(false)
  })

  it('drains oldest-first regardless of arrival order into the map', () => {
    const handle = registerTurnInbox('s1')
    deliverTurnInput({ sessionId: 's1', input: input({ id: 'b', text: 'second', receivedAt: 20 }) })
    deliverTurnInput({ sessionId: 's1', input: input({ id: 'a', text: 'first', receivedAt: 10 }) })
    expect(handle.port.drain().map((i) => i.text)).toEqual(['first', 'second'])
  })

  it('upgrades a queued message in place when it is steered afterwards', () => {
    // The Steer button re-posts the SAME inputId — it must not enqueue a
    // duplicate of the message the user already sent.
    const handle = registerTurnInbox('s1')
    deliverTurnInput({ sessionId: 's1', input: input({ id: 'x', text: 'use Friday' }) })
    deliverTurnInput({ sessionId: 's1', input: input({ id: 'x', text: 'use Friday', mode: 'steer' }) })

    expect(handle.port.peek()).toEqual({ pending: true, steer: true })
    const drained = handle.port.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0].mode).toBe('steer')
  })

  it('never demotes a pending steer back to queued', () => {
    const handle = registerTurnInbox('s1')
    deliverTurnInput({ sessionId: 's1', input: input({ id: 'x', text: 'stop', mode: 'steer' }) })
    deliverTurnInput({ sessionId: 's1', input: input({ id: 'x', text: 'stop', mode: 'queued' }) })
    expect(handle.port.drain()[0].mode).toBe('steer')
  })

  it('close() stops holding messages for that session', () => {
    const handle = registerTurnInbox('s1')
    handle.close()
    expect(hasTurnInbox('s1')).toBe(false)
    expect(deliverTurnInput({ sessionId: 's1', input: input({ text: 'late' }) })).toBe(false)
  })

  it('close() from a superseded turn does not evict the live one', () => {
    // The route closes in a `finally`, so a crashed turn's close can land
    // after its successor has already registered.
    const stale = registerTurnInbox('s1')
    const live = registerTurnInbox('s1')
    stale.close()

    expect(hasTurnInbox('s1')).toBe(true)
    deliverTurnInput({ sessionId: 's1', input: input({ text: 'for the live turn' }) })
    expect(live.port.drain().map((i) => i.text)).toEqual(['for the live turn'])
  })

  it('keeps sessions isolated', () => {
    const a = registerTurnInbox('s1')
    const b = registerTurnInbox('s2')
    deliverTurnInput({ sessionId: 's1', input: input({ text: 'mine' }) })
    expect(b.port.peek().pending).toBe(false)
    expect(a.port.drain()).toHaveLength(1)
  })
})
