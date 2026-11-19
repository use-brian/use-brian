/** [COMP:api/session-turn-reconnect] A follow opened when a question is answered.
 *
 * The answer route only enqueues the durable resume; the resumed turn exists
 * only once the lease-holding owner starts it and publishes `turn_started`. A
 * personal session is idle until then, so the reconnect stream used to send
 * `status`, then `done`, and close before the resumed turn existed. It now
 * waits for that owner (relayed as `status running`) and then follows the
 * resumed turn to its completion, bounded by RESUME_FOLLOW_LIMIT_MS.
 * Spec: docs/architecture/engine/askquestion-suspend-resume.md "Resume attach
 * and poll retirement". */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RESUME_FOLLOW_LIMIT_MS, resumeStartFrames, sessionRoutes } from '../sessions.js'
import * as sessions from '../../db/sessions.js'
import * as authority from '../../session-read-authority.js'
import type { SessionEvent } from '../../session-event-port.js'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

const previousTurn = 'a'.repeat(64), resumedTurn = 'b'.repeat(64)
const idle = { id: 'session-fixture', userId: 'viewer', channelType: 'web', visibility: 'personal', anchorKind: 'none',
  status: 'idle', turnStartedAt: null, turnId: previousTurn, turnEndReason: 'completed' }

async function open(pendingSessionResume?: () => Promise<boolean>, current: () => object = () => idle) {
  vi.spyOn(sessions, 'findSessionById').mockImplementation(async () => current() as sessions.Session)
  vi.spyOn(authority, 'gateSessionRead').mockResolvedValue(null)
  let deliver: ((event: SessionEvent) => void) | null = null
  const unsubscribe = vi.fn()
  const route = sessionRoutes({ pendingSessionResume,
    subscribeSessionEvents: ({ cb }) => { deliver = cb; return unsubscribe } }).stack.find(layer => layer.route?.path === '/:id/stream')!.route!
  const req = Object.assign(new EventEmitter(), { userId: 'viewer', params: { id: idle.id } })
  const res = Object.assign(new EventEmitter(), { setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(),
    end: vi.fn(() => { res.writableEnded = true }), writableEnded: false, destroyed: false })
  await route.stack[0].handle(req as never, res as never, vi.fn())
  const frames = () => res.write.mock.calls.map(([chunk]) => String(chunk)).filter(chunk => chunk.startsWith('event:'))
    .map(chunk => { const [event, data] = chunk.trim().split('\n'); return { event: event!.slice(7), data: JSON.parse(data!.slice(6)) } })
  // Every relay passes the stream's current-authority guard asynchronously.
  const emit = async (event: SessionEvent) => { deliver?.(event); await vi.advanceTimersByTimeAsync(0) }
  return { res, frames, unsubscribe, emit }
}

describe('[COMP:api/session-turn-reconnect] follow across an enqueued resume', () => {
  it('still closes an idle session with nothing enqueued', async () => {
    vi.useFakeTimers()
    for (const pending of [undefined, async () => false, async () => { throw new Error('Fictional lookup failure') }]) {
      const stream = await open(pending)
      expect(stream.frames().map(frame => frame.event)).toEqual(['status', 'done'])
      expect(stream.res.end).toHaveBeenCalled()
    }
  })

  it('waits for the resumed owner, relays its start as status running and follows it to completion', async () => {
    vi.useFakeTimers()
    let current: object = idle
    const stream = await open(async () => true, () => current)
    expect(stream.frames().map(frame => frame.event)).toEqual(['status'])
    expect(stream.res.end).not.toHaveBeenCalled()
    // A completion of some other turn while waiting is not the resumed turn.
    await stream.emit({ kind: 'turn_completed', sessionId: idle.id, payload: { senderUserId: null, turnId: previousTurn } })
    expect(stream.res.end).not.toHaveBeenCalled()
    // The owner holds the lease before it publishes its start.
    current = { ...idle, status: 'running', turnId: resumedTurn, turnStartedAt: new Date(), turnEndReason: null }
    await stream.emit({ kind: 'turn_started', sessionId: idle.id, payload: { senderUserId: 'viewer', assistantId: 'fixture-assistant', turnId: resumedTurn } })
    expect(stream.frames().at(-1)).toEqual({ event: 'status', data: { status: 'running', turnId: resumedTurn, turnEndReason: null, startedAt: expect.any(Number) } })
    await stream.emit({ kind: 'turn_stream', sessionId: idle.id, payload: { text: 'Fictional resumed reply', activity: null } })
    await vi.advanceTimersByTimeAsync(RESUME_FOLLOW_LIMIT_MS + 1)
    expect(stream.res.end).not.toHaveBeenCalled()
    await stream.emit({ kind: 'turn_completed', sessionId: idle.id, payload: { senderUserId: 'viewer', turnId: resumedTurn } })
    expect(stream.frames().slice(1).map(frame => frame.event)).toEqual(['status', 'snapshot', 'turn_completed', 'done'])
    expect(stream.frames().at(-1)).toEqual({ event: 'done', data: { turnId: resumedTurn } })
    expect(stream.res.end).toHaveBeenCalledOnce()
    expect(stream.unsubscribe).toHaveBeenCalled()
  })

  it('closes at the bound when the owner never starts', async () => {
    vi.useFakeTimers()
    const stream = await open(async () => true)
    await vi.advanceTimersByTimeAsync(RESUME_FOLLOW_LIMIT_MS - 1)
    expect(stream.res.end).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(stream.frames().map(frame => frame.event)).toEqual(['status', 'done'])
    expect(stream.res.end).toHaveBeenCalledOnce()
  })

  it('finishes from the database backstop when the resumed turn ran unseen', async () => {
    vi.useFakeTimers()
    let pending = true, current: object = idle
    const stream = await open(async () => pending, () => current)
    pending = false
    current = { ...idle, turnId: resumedTurn, turnEndReason: 'completed' }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stream.frames().slice(1)).toEqual([{ event: 'turn_completed', data: { turnId: resumedTurn } }, { event: 'done', data: { turnId: resumedTurn } }])
    expect(stream.res.end).toHaveBeenCalledOnce()
  })

  it('maps only a turn start to the running status frame', () => {
    expect(resumeStartFrames({ kind: 'turn_stream', sessionId: idle.id, payload: { text: '', activity: null } } as SessionEvent)).toEqual([])
    expect(resumeStartFrames({ kind: 'turn_started', sessionId: idle.id, payload: { senderUserId: null, turnId: resumedTurn } }, 7))
      .toEqual([{ event: 'status', data: { status: 'running', turnId: resumedTurn, turnEndReason: null, startedAt: 7 } }])
  })
})
