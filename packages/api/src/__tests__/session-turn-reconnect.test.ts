/**
 * [COMP:api/session-turn-reconnect] — the reconnect relay behind
 * `GET /api/sessions/:id/stream` (reconnect mode, every non-room session).
 *
 * 2026-08-24: Cloud Run severed a personal `POST /api/chat` stream at its
 * request cap while the turn kept running. The client took the closed body
 * for a finished turn, the Live card and Stop vanished, and a write-tool
 * confirmation raised after the cut parked on the dead socket for its 24h
 * timeout, locking the session. Every turn now outlives its stream and a
 * dropped client re-attaches over the reconnect stream, which must relay the
 * same feed the direct stream carried. The bus-event -> SSE-frame decision is
 * the pure `reconnectRelayFrames`; these tests pin its contract:
 *
 *   - `turn_stream`    -> `snapshot`  (payload as-is)
 *   - `turn_activity`  -> `activity`  (payload as-is, confirmation cards
 *                                      included)
 *   - `turn_completed` -> `turn_completed` + `done`, and finalize
 *   - every other kind -> nothing
 *   - the 5s DB backstop sends the same terminal pair with an empty
 *     completion
 *
 * Spec: docs/architecture/features/doc-comments.md → "Live turn reconnect".
 */

import { describe, it, expect } from 'vitest'
import { RECONNECT_BACKSTOP_FRAMES, reconnectRelayFrames } from '../routes/sessions.js'
import type { SessionEvent } from '../session-event-port.js'

describe('[COMP:api/session-turn-reconnect] reconnect relay frames', () => {
  it('relays a turn_stream snapshot as-is', () => {
    const payload = { text: 'Drafting the reply so far', activity: null }
    const relay = reconnectRelayFrames({
      kind: 'turn_stream',
      sessionId: 'sess-1',
      payload,
    })

    expect(relay).toEqual({
      frames: [{ event: 'snapshot', data: payload }],
      finalize: false,
    })
    // As-is: the same object, not a reshaped copy.
    expect(relay.frames[0]!.data).toBe(payload)
  })

  it('relays a running-tool snapshot before any reply text lands', () => {
    const payload = { text: '', activity: 'webSearch' }
    expect(reconnectRelayFrames({ kind: 'turn_stream', sessionId: 'sess-1', payload })).toEqual({
      frames: [{ event: 'snapshot', data: payload }],
      finalize: false,
    })
  })

  it('relays turn_activity events as-is, confirmation cards included', () => {
    const toolStart = { event: 'tool_start', senderUserId: 'user-1', id: 'tool-1', name: 'webSearch' }
    const required = {
      event: 'tool_confirmation_required',
      senderUserId: 'user-1',
      toolCallId: 'tool-2',
      toolName: 'gmailSendMessage',
      displayName: 'Send email',
      input: {},
      addresserUserId: 'user-1',
    }
    const resolved = { event: 'tool_confirmation_resolved', toolCallId: 'tool-2', decision: 'approve' }

    for (const payload of [toolStart, required, resolved]) {
      const relay = reconnectRelayFrames({ kind: 'turn_activity', sessionId: 'sess-1', payload })
      expect(relay).toEqual({
        frames: [{ event: 'activity', data: payload }],
        finalize: false,
      })
      expect(relay.frames[0]!.data).toBe(payload)
    }
  })

  it('ends on turn_completed: the payload, then done, and finalizes', () => {
    const payload = { senderUserId: 'user-1' }
    expect(reconnectRelayFrames({ kind: 'turn_completed', sessionId: 'sess-1', payload })).toEqual({
      frames: [
        { event: 'turn_completed', data: payload },
        { event: 'done', data: {} },
      ],
      finalize: true,
    })
  })

  it('carries the end reason through turn_completed (a stop is not an ordinary completion)', () => {
    const payload = {
      senderUserId: 'user-2',
      reason: 'stopped_by_user' as const,
      stoppedByName: 'Alex Example',
    }
    const relay = reconnectRelayFrames({ kind: 'turn_completed', sessionId: 'sess-1', payload })
    expect(relay.finalize).toBe(true)
    expect(relay.frames[0]).toEqual({ event: 'turn_completed', data: payload })
    expect(relay.frames[1]).toEqual({ event: 'done', data: {} })
  })

  it('ignores bus kinds that are not part of a personal turn', () => {
    const unrelated: SessionEvent[] = [
      {
        kind: 'user_message_saved',
        sessionId: 'sess-1',
        payload: { id: 'm1', sequenceNum: 1, senderUserId: 'user-1', content: 'hi' },
      },
      {
        kind: 'assistant_message_saved',
        sessionId: 'sess-1',
        payload: { id: 'm2', sequenceNum: 2, content: 'hello' },
      },
      { kind: 'tool_input', sessionId: 'sess-1', payload: { name: 'webSearch', input: {} } },
      { kind: 'turn_started', sessionId: 'sess-1', payload: { senderUserId: 'user-1' } },
      { kind: 'pins_changed', sessionId: 'sess-1', payload: { byUserId: 'user-1' } },
      {
        kind: 'session_assistant_changed',
        sessionId: 'sess-1',
        payload: { assistantId: 'asst-2', byUserId: 'user-1' },
      },
      { kind: 'presence', sessionId: 'sess-1', payload: { viewers: [] } },
    ]

    for (const event of unrelated) {
      expect(reconnectRelayFrames(event)).toEqual({ frames: [], finalize: false })
    }
  })

  it('backstop: the DB-status poll sends the same terminal pair with an empty completion', () => {
    expect(RECONNECT_BACKSTOP_FRAMES).toEqual([
      { event: 'turn_completed', data: {} },
      { event: 'done', data: {} },
    ])
    // Same terminal shape as the bus path, so a client has one `done` to wait on.
    const viaBus = reconnectRelayFrames({
      kind: 'turn_completed',
      sessionId: 'sess-1',
      payload: { senderUserId: 'user-1' },
    })
    expect(RECONNECT_BACKSTOP_FRAMES.map((f) => f.event)).toEqual(viaBus.frames.map((f) => f.event))
  })
})
