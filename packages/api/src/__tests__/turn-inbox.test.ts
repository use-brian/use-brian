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
  localTurnInboxAssistant,
  acknowledgeTurnInputs,
  awaitTurnInputOutcome,
  roomInputAdmission,
  _resetTurnInboxes,
} from '../turn-inbox.js'
import { registerNotifyChannel } from '../db/notify-listener.js'
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

describe('[COMP:api/turn-inbox] Room steer (chat-parity D3, section 6)', () => {
  beforeEach(() => {
    _resetTurnInboxes()
  })

  const running = {
    status: 'running',
    waiterArmed: false,
    clientMidTurn: true,
    queue: true,
    runningAssistantId: 'a1' as string | null | undefined,
    addressedAssistantId: 'a1',
  }
  const roomInput = (over: Partial<PendingTurnInput> = {}): PendingTurnInput => ({
    id: 'r1', text: 'use last Friday', mode: 'steer', receivedAt: 1,
    persistedMessageId: 'm1', assistantId: 'a1', ...over,
  })

  it('a room steer for the running assistant goes into the inbox and never arms a follow-up', () => {
    expect(roomInputAdmission(running)).toBe('inbox')
    // Even with a follow-up already armed, it is the running turn's to take.
    expect(roomInputAdmission({ ...running, waiterArmed: true })).toBe('inbox')
    // A turn running on another instance: the inbox there decides.
    expect(roomInputAdmission({ ...running, runningAssistantId: undefined })).toBe('inbox')
  })

  it('a message for a different assistant arms or folds, the T5 path unchanged', () => {
    expect(roomInputAdmission({ ...running, addressedAssistantId: 'a2' })).toBe('wait')
    expect(roomInputAdmission({ ...running, addressedAssistantId: 'a2', waiterArmed: true })).toBe('fold')
  })

  it('without a mid-turn send, or where the composer may not queue, it is T5; an idle room runs', () => {
    expect(roomInputAdmission({ ...running, clientMidTurn: false })).toBe('wait')
    expect(roomInputAdmission({ ...running, queue: false, waiterArmed: true })).toBe('fold')
    expect(roomInputAdmission({ ...running, status: 'idle' })).toBe('run')
  })

  it("another assistant's turn refuses a room input; the running assistant's turn takes it with its saved row", () => {
    const handle = registerTurnInbox('s1', { assistantId: 'a1' })
    expect(localTurnInboxAssistant('s1')).toBe('a1')
    expect(localTurnInboxAssistant('elsewhere')).toBeUndefined()
    expect(deliverTurnInput({ sessionId: 's1', input: roomInput({ id: 'x', assistantId: 'a2' }) })).toBe(false)
    expect(handle.port.peek().pending).toBe(false)
    expect(deliverTurnInput({ sessionId: 's1', input: roomInput() })).toBe(true)
    expect(handle.port.peek()).toEqual({ pending: true, steer: true })
    expect(handle.port.drain()).toEqual([expect.objectContaining({ id: 'r1', persistedMessageId: 'm1', assistantId: 'a1' })])
    // A personal mid-turn message names no assistant and is still taken.
    expect(deliverTurnInput({ sessionId: 's1', input: { id: 'p', text: 'and Jack?', mode: 'queued', receivedAt: 2 } })).toBe(true)
  })

  it('the waiter learns the turn took it: applied, so it arms nothing', async () => {
    const outcome = awaitTurnInputOutcome({
      sessionId: 's1', inputId: 'r1', isRunning: async () => true, timeoutMs: 5_000, pollMs: 5, graceMs: 5,
    })
    acknowledgeTurnInputs('s1', ['r1'])
    await expect(outcome).resolves.toBe('applied')
  })

  it('an acknowledgement that lands before its waiter still counts', async () => {
    acknowledgeTurnInputs('s1', ['early'])
    await expect(awaitTurnInputOutcome({
      sessionId: 's1', inputId: 'early', isRunning: async () => false, timeoutMs: 1_000,
    })).resolves.toBe('applied')
  })

  it('the turn ending first hands it back to the follow-up path', async () => {
    let calls = 0
    await expect(awaitTurnInputOutcome({
      sessionId: 's1', inputId: 'late', isRunning: async () => (++calls) < 3, timeoutMs: 5_000, pollMs: 2, graceMs: 2,
    })).resolves.toBe('turn_ended')
  })

  it('a cross-instance acknowledgement wakes the waiter through the NOTIFY channel', async () => {
    registerTurnInbox('s2', { assistantId: 'a1' })
    const handler = vi.mocked(registerNotifyChannel).mock.calls[0]?.[1] as (payload: string) => void
    expect(handler).toBeTypeOf('function')
    const outcome = awaitTurnInputOutcome({
      sessionId: 's2', inputId: 'remote', isRunning: async () => true, timeoutMs: 5_000, pollMs: 5,
    })
    handler(JSON.stringify({ sessionId: 's2', applied: ['remote'] }))
    await expect(outcome).resolves.toBe('applied')
  })

  it('gives up past the queue budget while the turn still runs', async () => {
    await expect(awaitTurnInputOutcome({
      sessionId: 's1', inputId: 'slow', isRunning: async () => true, timeoutMs: 10, pollMs: 2,
    })).resolves.toBe('timeout')
  })
})
