/**
 * Provider fallback wrapper — single-vendor outage de-risk.
 *
 * Wraps a primary `LLMProvider` such that 429 (rate limited) or 5xx
 * (server-side) errors trigger a retry against a fallback provider.
 * Normal traffic NEVER touches the fallback — error-condition only.
 *
 * Why this exists: the chat stack is Gemini-primary. A Gemini outage or
 * sustained rate-limit storm would otherwise return errors to every user.
 * `wrapFallback(geminiProvider, anthropicProvider)` keeps the product
 * answering during the outage window at the cost of a follow-up bill on
 * Anthropic.
 *
 * Spec: docs/architecture/engine/provider-abstraction.md → "Fallback wrapper".
 * COMP tag: `providers/fallback`.
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

// ── Error classification ───────────────────────────────────────

const DEFAULT_RETRYABLE_STATUS = [429, 500, 502, 503, 504]

export type ErrorKind = 'rate_limited' | 'server_error' | 'unknown'

/**
 * Extract an HTTP-like status from a thrown error. Works for:
 *   - SDK errors with `.status: number` (Anthropic SDK, OpenAI SDK shape)
 *   - The Gemini provider's manually-thrown `Error: Gemini API error 429: ...`
 *     (we parse the leading "API error <status>" out of the message)
 *   - Anything else → null (not classified as retryable)
 */
export function extractStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  // SDK-style error
  if ('status' in err) {
    const s = (err as { status: unknown }).status
    if (typeof s === 'number') return s
  }
  // String-formatted error (the Gemini REST provider does this)
  if ('message' in err) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') {
      const match = m.match(/\b(?:API error|HTTP|status)\s+(\d{3})\b/i)
      if (match) return Number(match[1])
    }
  }
  return null
}

function classifyError(err: unknown): ErrorKind {
  const status = extractStatus(err)
  if (status === null) return 'unknown'
  if (status === 429) return 'rate_limited'
  if (status >= 500 && status < 600) return 'server_error'
  return 'unknown'
}

// ── Analytics hook ─────────────────────────────────────────────

export type FallbackAnalytics = {
  /**
   * Fired when a fallback is invoked. Implementations should log an
   * `llm_provider_fallback` analytics event with `primary_model`,
   * `fallback_model`, `error_kind`, and `error_status` metadata so the
   * admin dashboard can measure outage rate.
   */
  onFallback(event: {
    primaryModel: string
    fallbackModel: string
    errorKind: ErrorKind
    errorStatus: number | null
  }): void
}

// ── Wrapper options ────────────────────────────────────────────

export type WrapFallbackOptions = {
  /**
   * HTTP statuses that should trigger a fallback. Default: 429 + 5xx.
   * `null` status (unclassifiable error) is NEVER retried — fallback is
   * only safe for transient remote failures.
   */
  retryableStatus?: number[]
  /**
   * Analytics hook fired on every successful fallback. The wrapper itself
   * does no logging; pass in your AnalyticsLogger-backed adapter here.
   */
  analytics?: FallbackAnalytics
  /**
   * Default model name used when resolving the fallback model id for
   * analytics / billing. The fallback provider's `models[0]` is used when
   * unset. Optional — analytics is the only consumer.
   */
  fallbackModel?: string
}

// ── Helpers ────────────────────────────────────────────────────

function shouldFallback(err: unknown, retryable: number[]): { eligible: boolean; status: number | null; kind: ErrorKind } {
  const status = extractStatus(err)
  const kind = classifyError(err)
  if (status === null) return { eligible: false, status, kind }
  return { eligible: retryable.includes(status), status, kind }
}

/**
 * Adapt an `AsyncIterable<StreamChunk>` so we can detect a thrown error
 * BEFORE yielding any chunks downstream. The async-iterator protocol
 * surfaces synchronous throws on the first `.next()`, but errors that
 * happen between chunks (e.g. mid-stream 5xx) only fire after some text
 * has already been yielded — at that point we've committed to the primary
 * and cannot transparently swap providers.
 *
 * This helper materializes the first chunk synchronously: if the inner
 * stream throws before producing one, we've not committed yet and can
 * fall back cleanly.
 */
async function peekFirstChunk(
  stream: AsyncIterable<StreamChunk>,
): Promise<{ kind: 'chunk'; first: StreamChunk; rest: AsyncIterator<StreamChunk> } | { kind: 'error'; error: unknown }> {
  const iter = stream[Symbol.asyncIterator]()
  try {
    const result = await iter.next()
    if (result.done) {
      return { kind: 'chunk', first: { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }, rest: emptyIterator() }
    }
    return { kind: 'chunk', first: result.value, rest: iter }
  } catch (err) {
    return { kind: 'error', error: err }
  }
}

function emptyIterator(): AsyncIterator<StreamChunk> {
  return {
    async next() { return { done: true, value: undefined } },
  } as AsyncIterator<StreamChunk>
}

async function* streamFromPeeked(
  first: StreamChunk,
  rest: AsyncIterator<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  yield first
  while (true) {
    const r = await rest.next()
    if (r.done) return
    yield r.value
  }
}

// ── Wrapper ────────────────────────────────────────────────────

/**
 * Wrap `primary` so that requests failing with a retryable HTTP status
 * are retried against `fallback`. Returns a new `LLMProvider` that is a
 * drop-in replacement for the primary.
 *
 * Both `stream` and `createSession.send` are wrapped. Each call gets a
 * fresh fallback session when needed — we do not share session state
 * between providers (their internal state models differ).
 *
 * If both providers fail, the original primary error is rethrown — the
 * caller sees the same shape they would have seen without the wrapper.
 */
export function wrapFallback(
  primary: LLMProvider,
  fallback: LLMProvider,
  opts?: WrapFallbackOptions,
): LLMProvider {
  const retryable = opts?.retryableStatus ?? DEFAULT_RETRYABLE_STATUS
  const fallbackModelName = opts?.fallbackModel ?? fallback.models[0] ?? fallback.name

  async function* runStream(request: ProviderRequest): AsyncIterable<StreamChunk> {
    // Phase 1 — try the primary. We must peek the first chunk to detect
    // whether the primary failed BEFORE emitting anything; mid-stream
    // errors fall through to the caller without a swap (we've already
    // started yielding partial text).
    const primaryStream = primary.stream(request)
    const peeked = await peekFirstChunk(primaryStream)
    if (peeked.kind === 'chunk') {
      yield* streamFromPeeked(peeked.first, peeked.rest)
      return
    }

    const decision = shouldFallback(peeked.error, retryable)
    if (!decision.eligible) {
      throw peeked.error
    }

    // Phase 2 — try the fallback. Use the fallback provider's resolved
    // model (the request's `model` field is primary-specific).
    const fallbackRequest: ProviderRequest = {
      ...request,
      model: fallbackModelName,
    }
    try {
      const fallbackStream = fallback.stream(fallbackRequest)
      const fbPeeked = await peekFirstChunk(fallbackStream)
      if (fbPeeked.kind === 'error') {
        // Both failed → surface the primary error (the operator cares about
        // the root cause, not the recovery cascade).
        throw peeked.error
      }
      opts?.analytics?.onFallback({
        primaryModel: request.model,
        fallbackModel: fallbackModelName,
        errorKind: decision.kind,
        errorStatus: decision.status,
      })
      yield* streamFromPeeked(fbPeeked.first, fbPeeked.rest)
    } catch (fallbackErr) {
      // Re-throw the ORIGINAL primary error so caller error handling
      // (chat route catch, analytics) keeps a stable shape.
      if (fallbackErr === peeked.error) throw peeked.error
      throw peeked.error
    }
  }

  function makeSession(sessionOpts: SessionOptions): ProviderSession {
    const primarySession = primary.createSession(sessionOpts)
    // Lazily construct the fallback session — we don't want to allocate
    // until we actually need to fall back. Sessions may hold resources
    // (HTTP clients, signature buffers); avoiding the eager construction
    // is the correct default.
    let fallbackSession: ProviderSession | null = null
    const fallbackSessionOpts: SessionOptions = {
      ...sessionOpts,
      model: fallbackModelName,
    }

    return {
      async *send(messages: Message[], opts2?: SendOptions): AsyncIterable<StreamChunk> {
        const primaryStream = primarySession.send(messages, opts2)
        const peeked = await peekFirstChunk(primaryStream)
        if (peeked.kind === 'chunk') {
          yield* streamFromPeeked(peeked.first, peeked.rest)
          return
        }

        const decision = shouldFallback(peeked.error, retryable)
        if (!decision.eligible) {
          throw peeked.error
        }

        if (!fallbackSession) {
          fallbackSession = fallback.createSession(fallbackSessionOpts)
        }
        try {
          const fbStream = fallbackSession.send(messages, opts2)
          const fbPeeked = await peekFirstChunk(fbStream)
          if (fbPeeked.kind === 'error') {
            throw peeked.error
          }
          opts?.analytics?.onFallback({
            primaryModel: sessionOpts.model,
            fallbackModel: fallbackModelName,
            errorKind: decision.kind,
            errorStatus: decision.status,
          })
          yield* streamFromPeeked(fbPeeked.first, fbPeeked.rest)
        } catch (fallbackErr) {
          if (fallbackErr === peeked.error) throw peeked.error
          throw peeked.error
        }
      },
    }
  }

  return {
    name: primary.name,
    models: [...new Set([...primary.models, ...fallback.models])],
    stream: runStream,
    createSession: makeSession,
  }
}
