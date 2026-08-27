import { useCallback, useRef } from 'react'
import { createSSEBuffer, parseSSEStream, type SSEEvent } from './sse.js'

/**
 * Caller-supplied fetch implementation. Distinguished from the global
 * `fetch` so consumers can inject `authFetch` (transparent JWT refresh) or
 * any equivalent wrapper. Same signature as `fetch`.
 */
export type AuthFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export type StreamOptions = {
  /** POST URL for the chat endpoint, e.g. `${API_URL}/api/chat`. */
  url: string
  /** JSON body to POST. */
  body: unknown
  /** Caller-supplied fetch — typically `authFetch`. */
  authFetch: AuthFetch
  /** Per-event callback. Caller dispatches reducer actions from here. */
  onEvent: (event: SSEEvent) => void
  /**
   * Called once when the stream ends AFTER the server said it was over — a
   * terminal event (`done` or `error`) was seen before the body closed.
   *
   * Compatibility: when `onDisconnect` is not supplied, a body that closes
   * WITHOUT a terminal event also lands here, exactly as it always did.
   */
  onDone?: () => void
  /**
   * Called when the transport closed with NO terminal event: a request or
   * proxy timeout, a deploy, a network blip. The turn is very likely still
   * running on the server — Cloud Run cut every chat stream at its request
   * cap on 2026-08-24 while the turn kept working, and treating that close
   * as `onDone` painted a finished turn over a live one. A caller that can
   * re-attach (the chat surface's session follow stream) does so here.
   * `lastEvent` is the last event name received, for diagnostics.
   */
  onDisconnect?: (info: { lastEvent: string | null }) => void
  /** Called on transport errors. Aborted streams do not call this. */
  onError?: (err: unknown) => void
}

/**
 * Event names that mean "the server has finished with this stream". A body
 * that closes after one of these is a completed turn; a body that closes
 * before any of them is a disconnect. `error` is terminal because the route
 * always `res.end()`s right after it (`turn_in_flight`, `pending_question_exists`,
 * the generic crash banner) — the caller's `onEvent` has already reacted.
 */
export const TERMINAL_STREAM_EVENTS: ReadonlySet<string> = new Set(['done', 'error'])

export type StartStream = (opts: StreamOptions) => Promise<void>

export type UseMessageStreamResult = {
  /** Begin a stream. Aborts any previous in-flight stream. */
  start: StartStream
  /**
   * POST on a SECOND connection, leaving the in-flight stream untouched.
   *
   * `start()` aborts the previous stream before opening its own, which is
   * exactly wrong for a message handed to a RUNNING turn: the reply comes
   * back on that very stream, so aborting it would kill the thing we are
   * waiting on. This call is short — the server answers `session`,
   * `input_queued`, `done` and closes — and it is deliberately invisible to
   * `abort()` / `inFlight()`, which continue to describe the main stream.
   *
   * See docs/architecture/engine/mid-turn-input.md.
   */
  sideStream: (opts: StreamOptions) => Promise<void>
  /** Abort the in-flight stream (no-op if none). */
  abort: () => void
  /** Whether a stream is currently in flight. Refs not state — for handlers. */
  inFlight: () => boolean
}

/**
 * Run one POST + SSE-parse loop against `signal`. Shared by `start` (which
 * owns the abort registration) and `sideStream` (which has none). Exported
 * for the hook's tests, which drive it with a fake `authFetch` — the
 * close-without-`done` distinction is the whole contract and needs no React.
 */
export async function runStream(opts: StreamOptions, signal: AbortSignal): Promise<void> {
  let res: Response
  try {
    res = await opts.authFetch(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body),
      signal,
    })
  } catch (err) {
    if (signal.aborted) return
    opts.onError?.(err)
    return
  }

  if (!res.body) {
    opts.onError?.(new Error('Response has no body'))
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const buffer = createSSEBuffer()
  let lastEvent: string | null = null
  let sawTerminal = false
  const deliver = (event: SSEEvent) => {
    lastEvent = event.event
    if (TERMINAL_STREAM_EVENTS.has(event.event)) sawTerminal = true
    opts.onEvent(event)
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (signal.aborted) break
      const chunk = decoder.decode(value, { stream: true })
      for (const event of parseSSEStream(chunk, buffer)) {
        if (signal.aborted) break
        deliver(event)
      }
    }
    // Drain any trailing event captured but not yet flushed.
    const tail = decoder.decode()
    if (tail) {
      for (const event of parseSSEStream(tail, buffer)) {
        if (signal.aborted) break
        deliver(event)
      }
    }
    if (signal.aborted) return
    // The body closed. Only the server's own terminal event makes that a
    // completed turn; a bare close is the transport giving up on a stream
    // the server may still be writing to (request-timeout cut, deploy,
    // network). Hand that to `onDisconnect` when the caller can re-attach;
    // otherwise keep the historical `onDone` so existing hosts behave as
    // before.
    if (sawTerminal || !opts.onDisconnect) opts.onDone?.()
    else opts.onDisconnect({ lastEvent })
  } catch (err) {
    if (signal.aborted) return
    opts.onError?.(err)
  }
}

/**
 * Owns the fetch + ReadableStream + SSE-parse loop. The hook is a thin
 * orchestrator over `parseSSEStream` and an injected `fetch` — it knows how
 * to close the previous stream when a new one starts and how to bail on abort.
 *
 * The hook deliberately doesn't know about message types or reducer actions —
 * the caller's `onEvent` is where the bridge into chat state happens.
 */
export function useMessageStream(): UseMessageStreamResult {
  const abortRef = useRef<AbortController | null>(null)

  const abort = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const start = useCallback<StartStream>(async (opts) => {
    abort()

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await runStream(opts, controller.signal)
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [abort])

  const sideStream = useCallback(async (opts: StreamOptions) => {
    // No abort registration on purpose: `abort()` is the user's Stop button
    // and must keep meaning "stop the turn", not "cancel the message I just
    // queued". This request is short enough to need no cancellation of its own.
    await runStream(opts, new AbortController().signal)
  }, [])

  const inFlight = useCallback(() => abortRef.current !== null, [])

  return { start, sideStream, abort, inFlight }
}
