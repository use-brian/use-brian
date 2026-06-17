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
  /** Called once when the stream ends (network closed, body drained). */
  onDone?: () => void
  /** Called on transport errors. Aborted streams do not call this. */
  onError?: (err: unknown) => void
}

export type StartStream = (opts: StreamOptions) => Promise<void>

export type UseMessageStreamResult = {
  /** Begin a stream. Aborts any previous in-flight stream. */
  start: StartStream
  /** Abort the in-flight stream (no-op if none). */
  abort: () => void
  /** Whether a stream is currently in flight. Refs not state — for handlers. */
  inFlight: () => boolean
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

    let res: Response
    try {
      res = await opts.authFetch(opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted) return
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

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (controller.signal.aborted) break
        const chunk = decoder.decode(value, { stream: true })
        for (const event of parseSSEStream(chunk, buffer)) {
          if (controller.signal.aborted) break
          opts.onEvent(event)
        }
      }
      // Drain any trailing event captured but not yet flushed.
      const tail = decoder.decode()
      if (tail) {
        for (const event of parseSSEStream(tail, buffer)) {
          if (controller.signal.aborted) break
          opts.onEvent(event)
        }
      }
      if (!controller.signal.aborted) opts.onDone?.()
    } catch (err) {
      if (controller.signal.aborted) return
      opts.onError?.(err)
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [abort])

  const inFlight = useCallback(() => abortRef.current !== null, [])

  return { start, abort, inFlight }
}
