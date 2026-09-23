/**
 * Endpoint fallback wrapper — BYO custom endpoint outage de-risk.
 *
 * `wrapFallback` (wrap-fallback.ts) exists for the platform's own vendors and
 * is deliberately conservative: 429 + a fixed 5xx list, and a status-less
 * throw is NEVER retried. Those defaults are wrong for a workspace-operated
 * OpenAI-compatible endpoint, which fails in three shapes the platform
 * vendors do not:
 *
 *   1. `http_status` — any 5xx, including the ones absent from
 *      `DEFAULT_RETRYABLE_STATUS`. A Cloudflare-tunnelled endpoint whose
 *      tunnel is down answers **530** (`error code: 1033`), which the
 *      platform list does not contain. Whitelisting statuses one incident at
 *      a time is how that gets missed again; the whole 5xx range is the
 *      honest predicate for "the far side broke".
 *   2. `network` — the fetch itself rejects, with no status at all: DNS
 *      failure, refused connection, TLS error, socket timeout. For a vendor
 *      SDK a status-less throw usually means a client-side bug, which is why
 *      `wrapFallback` refuses to retry it. For an endpoint someone runs on
 *      their own hardware it is the single most likely outage shape.
 *   3. `stream_error` — HTTP 200, SSE opens, and an `error` frame arrives
 *      instead of content (`openai-compat.ts` throws on one, provided no
 *      content has been emitted yet). Nothing about this is visible as a
 *      status.
 *   4. `empty_stream` — the stream completes having emitted no text, no
 *      thinking, and no tool call. The engine's own retry plan already treats
 *      that as a failure and ends with "I could not produce a reply"; a
 *      wrapped endpoint can do better than a second and third dead attempt.
 *
 * ## Where the commit point is, and why it is not the first chunk
 *
 * `wrapFallback` peeks exactly ONE chunk to decide whether it may still swap
 * providers. That is unsound here, because `streamCompat` yields
 * `message_start` BEFORE it reads a single SSE frame — so the one-chunk peek
 * always succeeds, the wrapper commits to the primary, and every shape 3 and
 * 4 failure escapes it. Of the six Oulu-expert failures on 2026-08-30, a
 * one-chunk peek would have caught one.
 *
 * This wrapper buffers instead, and commits only at the first chunk a person
 * could actually have seen: `text_delta`, `thinking_delta`, or
 * `tool_use_start`. `message_start` is bookkeeping and is held back — which
 * is also what lets the fallback announce its OWN model id on the
 * `message_start` that eventually ships, rather than the dead endpoint's.
 *
 * `thinking_delta` counts as committed on purpose. It streams to the web UI,
 * so swapping after it would show a user one model's reasoning followed by
 * another model's answer. Nothing is lost by that choice today: the
 * openai-compat error frame only throws while `sawContent` is false, i.e.
 * before any reasoning has been emitted.
 *
 * ## What it does not do
 *
 * A failure AFTER the commit point is not recoverable and is not made to
 * look recoverable — partial output has already reached the caller, and
 * re-answering would duplicate it. Those turns keep failing exactly as they
 * do today.
 *
 * Spec: docs/architecture/platform/byo-llm-key.md -> "Endpoint failure
 * fallback".
 * COMP tag: `providers/endpoint-fallback`.
 */
import type {
  LLMProvider,
  Message,
  ProviderRequest,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
} from './types.js'
import { createAccumulator } from './accumulator.js'
import { extractStatus } from './wrap-fallback.js'

export type EndpointFallbackReason = 'http_status' | 'network' | 'stream_error' | 'empty_stream'

export type EndpointFallbackEvent = {
  reason: EndpointFallbackReason
  /** HTTP status when the endpoint answered with one, else null. */
  status: number | null
  /** Operator-facing detail. Never rendered to a user verbatim. */
  detail: string
}

export type WrapEndpointFallbackOptions = {
  /**
   * Fired once per provider call that actually fell back and SUCCEEDED.
   * A fallback that also fails rethrows the primary error and reports
   * nothing — the operator's root cause is the endpoint, not the recovery.
   */
  onFallback?: (event: EndpointFallbackEvent) => void
}

/** Chunks a person can see. Anything else is protocol bookkeeping. */
function isUserVisible(chunk: StreamChunk): boolean {
  return chunk.type === 'text_delta'
    || chunk.type === 'thinking_delta'
    || chunk.type === 'tool_use_start'
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

/**
 * Classify a throw from the primary endpoint.
 *
 * Everything that is not an explicit non-5xx status is eligible. A 4xx is
 * the endpoint answering correctly that the REQUEST is wrong (bad key, bad
 * model id, oversized payload); replaying it elsewhere hides a
 * configuration error the admin needs to see, and would keep hiding it.
 */
function classify(err: unknown): EndpointFallbackEvent | null {
  const detail = errorDetail(err)
  const status = extractStatus(err)
  if (status !== null) {
    if (status >= 500 && status < 600) return { reason: 'http_status', status, detail }
    return null
  }
  // An `error` frame mid-stream throws with no status. openai-compat marks it
  // with a stable phrase; anything else status-less is a transport failure.
  const reason: EndpointFallbackReason = /returned an error mid-stream/.test(detail)
    ? 'stream_error'
    : 'network'
  return { reason, status: null, detail }
}

type PrimaryAttempt =
  | { kind: 'committed'; buffered: StreamChunk[]; rest: AsyncIterator<StreamChunk> }
  | { kind: 'exhausted'; buffered: StreamChunk[] }
  | { kind: 'failed'; error: unknown }

/**
 * Drain the primary until it produces something a user could see, ends, or
 * throws. Buffered non-visible chunks are replayed verbatim when we commit,
 * so a committed stream is byte-identical to the unwrapped one.
 */
async function runPrimary(stream: AsyncIterable<StreamChunk>): Promise<PrimaryAttempt> {
  const iter = stream[Symbol.asyncIterator]()
  const buffered: StreamChunk[] = []
  try {
    while (true) {
      const result = await iter.next()
      if (result.done) return { kind: 'exhausted', buffered }
      buffered.push(result.value)
      if (isUserVisible(result.value)) return { kind: 'committed', buffered, rest: iter }
    }
  } catch (err) {
    return { kind: 'failed', error: err }
  }
}

async function* replay(buffered: StreamChunk[], rest?: AsyncIterator<StreamChunk>): AsyncGenerator<StreamChunk> {
  for (const chunk of buffered) yield chunk
  if (!rest) return
  while (true) {
    const r = await rest.next()
    if (r.done) return
    yield r.value
  }
}

/**
 * Wrap `primary` (a workspace custom endpoint) so that an endpoint-side
 * failure before any user-visible output is re-answered by `fallback` (the
 * platform routing provider), using the request unchanged.
 *
 * The request is passed to the fallback AS GIVEN, including its `model`:
 * the custom lane already receives the resolved Brian serving alias as its
 * policy model (byo-llm-key.md -> "Runtime resolution") and pins its own wire
 * model internally, so the same request routes correctly on the platform side
 * with no model chosen by hand here.
 */
export function wrapEndpointFallback(
  primary: LLMProvider,
  fallback: LLMProvider,
  opts?: WrapEndpointFallbackOptions,
): LLMProvider {
  /**
   * `onServed` fires once the attempt finished cleanly, naming the side whose
   * chunks were yielded. The session lane uses it to keep its transcript.
   */
  async function* attempt(
    runPrimaryStream: () => AsyncIterable<StreamChunk>,
    runFallbackStream: () => AsyncIterable<StreamChunk>,
    onServed?: (side: 'primary' | 'fallback', chunks: StreamChunk[]) => void,
  ): AsyncGenerator<StreamChunk> {
    const result = await runPrimary(runPrimaryStream())
    if (result.kind === 'committed') {
      const served: StreamChunk[] = []
      for await (const chunk of replay(result.buffered, result.rest)) {
        served.push(chunk)
        yield chunk
      }
      onServed?.('primary', served)
      return
    }

    const decision: EndpointFallbackEvent | null = result.kind === 'failed'
      ? classify(result.error)
      : { reason: 'empty_stream', status: null, detail: 'endpoint stream produced no text, thinking, or tool call' }

    if (!decision) {
      // Not an endpoint failure we may paper over (4xx, or a deliberate
      // abort). Surface it unchanged.
      if (result.kind === 'failed') throw result.error
      yield* replay(result.buffered)
      return
    }

    // The fallback is held to the same commit point as the endpoint: its
    // `message_start` is bookkeeping, not an answer. Announcing on the first
    // chunk of ANY kind is how a fallback that answered nothing (2026-09-23:
    // `message_start` + `message_end` in 15ms) got reported as having served
    // the turn, flipping its billing to platform and telling the user a
    // built-in model had answered.
    const fallbackResult = await runPrimary(runFallbackStream())
    if (fallbackResult.kind === 'committed') {
      opts?.onFallback?.(decision)
      const served: StreamChunk[] = []
      for await (const chunk of replay(fallbackResult.buffered, fallbackResult.rest)) {
        served.push(chunk)
        yield chunk
      }
      onServed?.('fallback', served)
      return
    }

    // Both sides failed, or the fallback produced nothing either. Report the
    // ENDPOINT's failure: it is the root cause, and the caller's error
    // handling already knows that shape. An empty fallback is not fed to the
    // engine as a silently-swapped empty success.
    if (result.kind === 'failed') throw result.error
    if (fallbackResult.kind === 'failed') {
      throw new Error(
        `[endpoint-fallback] endpoint produced no output and the fallback failed: ${errorDetail(fallbackResult.error)}`,
        { cause: fallbackResult.error },
      )
    }
    yield* replay(result.buffered)
  }

  return {
    name: primary.name,
    models: primary.models,

    stream(request: ProviderRequest): AsyncIterable<StreamChunk> {
      return attempt(
        () => primary.stream(request),
        () => fallback.stream(request),
      )
    },

    createSession(sessionOpts: SessionOptions): ProviderSession {
      const primarySession = primary.createSession(sessionOpts)
      // A provider session is incremental: after its first send it receives
      // only the new messages (usually tool results) and holds the rest of
      // the conversation privately. A fallback session created on a LATER
      // send therefore knew nothing but that delta. On 2026-09-23 an endpoint
      // reset its socket on the 12th send of a calendar turn; Gemini was
      // handed a lone tool result, dropped it as an orphan, and answered
      // nothing. So the wrapper keeps the transcript itself and seeds a new
      // fallback session with all of it.
      const transcript: Message[] = []
      let fallbackSession: ProviderSession | null = null
      // Once the fallback has served a send, it keeps the session. The
      // endpoint's own history never saw the fallback's reply, so the next
      // delta (results for the FALLBACK's tool calls) would be a tool result
      // with no matching call there.
      let stickToFallback = false

      function record(sent: Message[], chunks: StreamChunk[]): void {
        const acc = createAccumulator()
        for (const chunk of chunks) acc.push(chunk)
        const response = acc.finish()
        transcript.push(...sent)
        if (response.content.length > 0) transcript.push({ role: 'assistant', content: response.content })
      }

      return {
        send(messages: Message[], sendOpts?: SendOptions): AsyncIterable<StreamChunk> {
          if (stickToFallback && fallbackSession) {
            const session = fallbackSession
            return (async function* () {
              const served: StreamChunk[] = []
              for await (const chunk of session.send(messages, sendOpts)) {
                served.push(chunk)
                yield chunk
              }
              record(messages, served)
            })()
          }
          return attempt(
            () => primarySession.send(messages, sendOpts),
            () => {
              // Always a fresh session here: a previous fallback that failed
              // may have left partial state, and only a session that has
              // SERVED (sticky, above) is known to hold the transcript.
              fallbackSession = fallback.createSession(sessionOpts)
              return fallbackSession.send([...transcript, ...messages], sendOpts)
            },
            (side, chunks) => {
              record(messages, chunks)
              if (side === 'fallback') stickToFallback = true
            },
          )
        },
      }
    },
  }
}
