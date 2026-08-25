/**
 * [COMP:chat-ui/use-message-stream] `runStream` close semantics.
 *
 * The load-bearing contract: a body that closes AFTER a terminal event
 * (`done` / `error`) is a finished turn and lands in `onDone`; a body that
 * closes with NO terminal event is a transport disconnect — the turn is very
 * likely still running server-side — and lands in `onDisconnect`. Before
 * 2026-08-24 both cases landed in `onDone`, so Cloud Run's request-timeout
 * cut painted a finished turn over a live one and the user's re-send was
 * refused with `turn_in_flight`. Hosts that do not pass `onDisconnect` keep
 * the historical `onDone` fallback.
 *
 * chat-ui's vitest is node-only; `runStream` is driven with a fake
 * `authFetch` that returns a `Response` over a hand-built `ReadableStream`.
 */

import { describe, expect, it } from 'vitest'
import { runStream, TERMINAL_STREAM_EVENTS, type StreamOptions } from '../useMessageStream'

function sseResponse(frames: string[], opts: { fail?: boolean } = {}): Response {
  const encoder = new TextEncoder()
  // Pull-based so a `fail` stream delivers its frames BEFORE erroring —
  // `controller.error()` discards anything still queued.
  const pending = [...frames]
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pending.shift()
      if (next !== undefined) controller.enqueue(encoder.encode(next))
      else if (opts.fail) controller.error(new Error('socket reset'))
      else controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

type Calls = { events: string[]; done: number; disconnect: Array<{ lastEvent: string | null }>; errors: unknown[] }

function drive(
  response: Response,
  extra: Partial<Pick<StreamOptions, 'onDisconnect'>> & { signal?: AbortSignal } = {},
): { calls: Calls; run: Promise<void> } {
  const calls: Calls = { events: [], done: 0, disconnect: [], errors: [] }
  const run = runStream(
    {
      url: 'http://api.example/api/chat',
      body: { message: 'hi' },
      authFetch: async () => response,
      onEvent: (e) => calls.events.push(e.event),
      onDone: () => { calls.done += 1 },
      onError: (err) => calls.errors.push(err),
      ...(extra.onDisconnect ? { onDisconnect: extra.onDisconnect } : {}),
    },
    extra.signal ?? new AbortController().signal,
  )
  return { calls, run }
}

describe('[COMP:chat-ui/use-message-stream] runStream close semantics', () => {
  it('names done and error as the terminal events', () => {
    expect([...TERMINAL_STREAM_EVENTS].sort()).toEqual(['done', 'error'])
  })

  it('a close after `done` is a completed turn: onDone, never onDisconnect', async () => {
    const disconnects: Array<{ lastEvent: string | null }> = []
    const { calls, run } = drive(
      sseResponse([frame('text_delta', { text: 'hel' }), frame('text_delta', { text: 'lo' }), frame('done', {})]),
      { onDisconnect: (i) => disconnects.push(i) },
    )
    await run
    expect(calls.events).toEqual(['text_delta', 'text_delta', 'done'])
    expect(calls.done).toBe(1)
    expect(disconnects).toEqual([])
    expect(calls.errors).toEqual([])
  })

  it('a close after an `error` event is terminal too (the route ends the response right after it)', async () => {
    const disconnects: Array<{ lastEvent: string | null }> = []
    const { calls, run } = drive(
      sseResponse([frame('error', { code: 'turn_in_flight', error: 'busy' })]),
      { onDisconnect: (i) => disconnects.push(i) },
    )
    await run
    expect(calls.events).toEqual(['error'])
    expect(calls.done).toBe(1)
    expect(disconnects).toEqual([])
  })

  it('a close with NO terminal event is a disconnect: onDisconnect with the last event, no onDone', async () => {
    const disconnects: Array<{ lastEvent: string | null }> = []
    const { calls, run } = drive(
      sseResponse([frame('session', { id: 's1' }), frame('text_delta', { text: 'working' })]),
      { onDisconnect: (i) => disconnects.push(i) },
    )
    await run
    expect(calls.events).toEqual(['session', 'text_delta'])
    expect(calls.done).toBe(0)
    expect(disconnects).toEqual([{ lastEvent: 'text_delta' }])
    expect(calls.errors).toEqual([])
  })

  it('a bare close with no events at all reports lastEvent null', async () => {
    const disconnects: Array<{ lastEvent: string | null }> = []
    const { calls, run } = drive(sseResponse([]), { onDisconnect: (i) => disconnects.push(i) })
    await run
    expect(calls.done).toBe(0)
    expect(disconnects).toEqual([{ lastEvent: null }])
  })

  it('without onDisconnect a bare close falls back to onDone (host compatibility)', async () => {
    const { calls, run } = drive(sseResponse([frame('text_delta', { text: 'x' })]))
    await run
    expect(calls.done).toBe(1)
    expect(calls.errors).toEqual([])
  })

  it('a transport error mid-body goes to onError, not onDisconnect or onDone', async () => {
    const disconnects: Array<{ lastEvent: string | null }> = []
    const { calls, run } = drive(
      sseResponse([frame('text_delta', { text: 'x' })], { fail: true }),
      { onDisconnect: (i) => disconnects.push(i) },
    )
    await run
    expect(calls.events).toEqual(['text_delta'])
    expect(calls.done).toBe(0)
    expect(disconnects).toEqual([])
    expect(calls.errors).toHaveLength(1)
  })

  it('an aborted stream fires none of the completion callbacks', async () => {
    const controller = new AbortController()
    const disconnects: Array<{ lastEvent: string | null }> = []
    let firstEventSeen = false
    const calls: Calls = { events: [], done: 0, disconnect: [], errors: [] }
    const run = runStream(
      {
        url: 'http://api.example/api/chat',
        body: {},
        authFetch: async () => sseResponse([frame('text_delta', { text: 'a' }), frame('text_delta', { text: 'b' })]),
        onEvent: (e) => {
          calls.events.push(e.event)
          if (!firstEventSeen) { firstEventSeen = true; controller.abort() }
        },
        onDone: () => { calls.done += 1 },
        onDisconnect: (i) => disconnects.push(i),
        onError: (err) => calls.errors.push(err),
      },
      controller.signal,
    )
    await run
    expect(calls.events).toEqual(['text_delta'])
    expect(calls.done).toBe(0)
    expect(disconnects).toEqual([])
    expect(calls.errors).toEqual([])
  })
})
