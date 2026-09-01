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
  async function* attempt(
    runPrimaryStream: () => AsyncIterable<StreamChunk>,
    runFallbackStream: () => AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk> {
    const result = await runPrimary(runPrimaryStream())
    if (result.kind === 'committed') {
      yield* replay(result.buffered, result.rest)
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

    let fallbackStarted = false
    try {
      for await (const chunk of runFallbackStream()) {
        if (!fallbackStarted) {
          fallbackStarted = true
          opts?.onFallback?.(decision)
        }
        yield chunk
      }
    } catch (fallbackErr) {
      // Both sides failed. Rethrow the ENDPOINT's error: it is the root
      // cause, and the caller's error handling already knows that shape.
      // A fallback that died after emitting is not retried again.
      if (fallbackStarted) throw fallbackErr
      if (result.kind === 'failed') throw result.error
      throw new Error(
        `[endpoint-fallback] endpoint produced no output and the fallback failed: ${errorDetail(fallbackErr)}`,
        { cause: fallbackErr },
      )
    }

    if (!fallbackStarted) {
      // Fallback returned an empty stream too. Report the endpoint failure
      // rather than an empty success, so the engine's empty-response
      // handling is not fed a silently-swapped provider.
      if (result.kind === 'failed') throw result.error
      yield* replay(result.buffered)
    }
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
      let fallbackSession: ProviderSession | null = null
      return {
        send(messages: Message[], sendOpts?: SendOptions): AsyncIterable<StreamChunk> {
          return attempt(
            () => primarySession.send(messages, sendOpts),
            () => {
              fallbackSession ??= fallback.createSession(sessionOpts)
              return fallbackSession.send(messages, sendOpts)
            },
          )
        },
      }
    },
  }
}
