/**
 * Shared session live publisher — throttle / cap / lane semantics.
 * Component tag: [COMP:api/session-live-publisher].
 *
 * The chat suites (room-mechanics et al.) prove the extraction stayed
 * behavior-identical for the chat route; this file pins the publisher's
 * own contract so the background lanes can rely on it directly.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createTurnStreamPublisher,
  publishRoomTurnActivity,
  publishTurnCompleted,
  STREAM_PUBLISH_THROTTLE_MS,
  STREAM_TEXT_CAP,
  STREAM_REASONING_CAP,
} from '../session-live-publisher.js'
import type { SessionEvent } from '../session-event-port.js'

const SID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function harness(opts?: {
  shouldPublish?: () => boolean
  attribution?: () => { senderUserId: string; assistantId: string } | null
}) {
  const events: SessionEvent[] = []
  // Matches production reality: `now()` is epoch-scale, far past the first
  // throttle window (the publisher seeds lastPublishAt = 0, as chat.ts did).
  let clock = 1_000_000
  const publisher = createTurnStreamPublisher({
    sessionId: SID,
    publishSessionEvent: (e) => events.push(e),
    shouldPublish: opts?.shouldPublish,
    attribution: opts?.attribution,
    now: () => clock,
  })
  return { events, publisher, tick: (ms: number) => (clock += ms) }
}

describe('[COMP:api/session-live-publisher] turn_stream snapshots', () => {
  it('publishes the FULL reply-so-far, never deltas', () => {
    const { events, publisher, tick } = harness()
    publisher.onTextDelta('Hello ')
    tick(STREAM_PUBLISH_THROTTLE_MS + 1)
    publisher.onTextDelta('world')
    expect(events).toHaveLength(2)
    expect((events[1] as { payload: { text: string } }).payload.text).toBe('Hello world')
  })

  it('throttles bursts: leading edge immediate, inside the window dropped', () => {
    const { events, publisher, tick } = harness()
    publisher.onTextDelta('a')
    tick(10)
    publisher.onTextDelta('b')
    tick(10)
    publisher.onTextDelta('c')
    expect(events).toHaveLength(1)
    tick(STREAM_PUBLISH_THROTTLE_MS)
    publisher.publish(false)
    expect(events).toHaveLength(2)
    expect((events[1] as { payload: { text: string } }).payload.text).toBe('abc')
  })

  it('force bypasses the throttle window', () => {
    const { events, publisher } = harness()
    publisher.onTextDelta('a')
    publisher.publish(true)
    expect(events).toHaveLength(2)
  })

  it('caps the text tail at the NOTIFY budget', () => {
    const { events, publisher } = harness()
    publisher.onTextDelta('x'.repeat(STREAM_TEXT_CAP + 500))
    const payload = (events[0] as { payload: { text: string } }).payload
    expect(payload.text).toHaveLength(STREAM_TEXT_CAP)
  })

  it('tool name surfaces as activity only before reply text, published immediately', () => {
    const { events, publisher } = harness()
    publisher.onToolStart('searchBrain')
    expect(events).toHaveLength(1)
    expect((events[0] as { payload: { activity: string | null } }).payload.activity).toBe('searchBrain')
    // Once text flows, activity clears and a later tool start is silent.
    publisher.onTextDelta('answer')
    publisher.onToolStart('editPage')
    publisher.publish(true)
    const last = events[events.length - 1] as { payload: { activity: string | null } }
    expect(last.payload.activity).toBeNull()
  })

  it('bare snapshot carries no reasoning or attribution keys', () => {
    const { events, publisher } = harness()
    publisher.onTextDelta('hi')
    const payload = (events[0] as { payload: Record<string, unknown> }).payload
    expect(Object.keys(payload).sort()).toEqual(['activity', 'text'])
  })

  it('attributed snapshot carries reasoning tail + sender + assistant, reasoning capped', () => {
    const { events, publisher, tick } = harness({
      attribution: () => ({ senderUserId: 'u1', assistantId: 'a1' }),
    })
    publisher.onReasoningDelta('r'.repeat(STREAM_REASONING_CAP + 100))
    tick(STREAM_PUBLISH_THROTTLE_MS + 1)
    publisher.onTextDelta('t')
    const payload = (events[1] as { payload: Record<string, unknown> }).payload
    expect(payload.senderUserId).toBe('u1')
    expect(payload.assistantId).toBe('a1')
    expect((payload.reasoning as string).length).toBe(STREAM_REASONING_CAP)
  })

  it('shouldPublish gates every emit and is re-evaluated per call', () => {
    let open = false
    const { events, publisher, tick } = harness({ shouldPublish: () => open })
    publisher.onTextDelta('hidden')
    expect(events).toHaveLength(0)
    open = true
    tick(STREAM_PUBLISH_THROTTLE_MS + 1)
    publisher.publish(false)
    expect(events).toHaveLength(1)
    expect((events[0] as { payload: { text: string } }).payload.text).toBe('hidden')
  })
})

describe('[COMP:api/session-live-publisher] activity + completion', () => {
  it('mirror=false publishes nothing', () => {
    const publish = vi.fn()
    publishRoomTurnActivity({
      mirror: false,
      sessionId: SID,
      senderUserId: 'u1',
      event: 'tool_start',
      data: { name: 'x' },
      publishSessionEvent: publish,
    })
    expect(publish).not.toHaveBeenCalled()
  })

  it('oversized tool input degrades to {} — the client falls back to its static label', () => {
    const publish = vi.fn()
    publishRoomTurnActivity({
      mirror: true,
      sessionId: SID,
      senderUserId: 'u1',
      event: 'tool_input',
      data: { name: 'x', input: { big: 'y'.repeat(5_000) } },
      publishSessionEvent: publish,
    })
    expect(publish.mock.calls[0][0].payload.input).toEqual({})
  })

  it('non-serializable input degrades to {} instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const publish = vi.fn()
    publishRoomTurnActivity({
      mirror: true,
      sessionId: SID,
      senderUserId: 'u1',
      event: 'tool_input',
      data: { name: 'x', input: circular },
      publishSessionEvent: publish,
    })
    expect(publish.mock.calls[0][0].payload.input).toEqual({})
  })

  it('small inputs and sender attribution pass through verbatim', () => {
    const publish = vi.fn()
    publishRoomTurnActivity({
      mirror: true,
      sessionId: SID,
      senderUserId: 'u1',
      event: 'tool_input',
      data: { name: 'x', input: { q: 'hello' } },
      publishSessionEvent: publish,
    })
    expect(publish.mock.calls[0][0]).toEqual({
      kind: 'turn_activity',
      sessionId: SID,
      payload: { event: 'tool_input', senderUserId: 'u1', name: 'x', input: { q: 'hello' } },
    })
  })

  it('publishTurnCompleted carries the reason only when one exists', () => {
    const publish = vi.fn()
    publishTurnCompleted({ sessionId: SID, senderUserId: 'u1', publishSessionEvent: publish })
    expect(publish.mock.calls[0][0].payload).toEqual({ senderUserId: 'u1' })
    publishTurnCompleted({
      sessionId: SID,
      senderUserId: 'u1',
      publishSessionEvent: publish,
      reason: 'stalled_reclaimed',
    })
    expect(publish.mock.calls[1][0].payload).toEqual({
      senderUserId: 'u1',
      reason: 'stalled_reclaimed',
    })
  })
})
