import type { LLMProvider, ProviderSession, SessionOptions, SendOptions, Message, StreamChunk, StreamFn, TokenUsage } from './types.js'
import { fitMessagesToBudget, resolveInputTokenLimit, isContextOverflowError, MODEL_CONTEXT_FIT_RATIO } from './context-budget.js'

/**
 * Composable stream wrappers.
 *
 * Each wrapper takes a StreamFn and returns a StreamFn.
 * Applied innermost → outermost:
 *   stream = wrapTimeout(wrapLog(wrapSanitize(baseStream)))
 */

export type StreamWrapper = (inner: StreamFn) => StreamFn

// ── Context budget ─────────────────────────────────────────────

/**
 * Guarantees the request fits the model's input-token window before it
 * reaches the provider — the deterministic, LLM-independent half of the
 * shrink/summarize split (see `context-budget.ts`). Pre-flight: trim the
 * request's messages to fit (`fitMessagesToBudget` — clamp over-sized
 * tool_results, then evict oldest). Backstop: if the provider still 400s on
 * an over-limit input (estimator drift), trim to half the budget and retry
 * once. The overflow 400 is thrown before any chunk streams, so the retry
 * can't double-emit; we only retry while nothing has been yielded.
 *
 * Innermost wrapper (first in `defaultWrappers`) so it sees the final request
 * and re-invokes the real provider directly on retry. Covers both `stream()`
 * and `createSession().send()` — the latter relies on the session adapter
 * forwarding `req.messages` (see `wrapProvider`).
 */
export function wrapContextBudget(): StreamWrapper {
  return (inner) => async function* (request) {
    const budget = Math.floor(resolveInputTokenLimit(request.model) * MODEL_CONTEXT_FIT_RATIO)
    const fitted = fitMessagesToBudget(request.messages, budget)
    const primaryReq = fitted.trimmed ? { ...request, messages: fitted.messages } : request

    let emitted = false
    try {
      for await (const chunk of inner(primaryReq)) {
        emitted = true
        yield chunk
      }
    } catch (err) {
      if (!emitted && isContextOverflowError(err)) {
        const harder = fitMessagesToBudget(request.messages, Math.floor(budget / 2))
        for await (const chunk of inner({ ...request, messages: harder.messages })) {
          yield chunk
        }
        return
      }
      throw err
    }
  }
}

// ── Idle timeout ───────────────────────────────────────────────

/**
 * Aborts the stream if no chunks arrive within the idle window.
 * Guards against hung LLM connections that SDK timeout won't catch.
 *
 * Two windows (2026-06-10): `firstChunkTimeoutMs` covers the wait for the
 * FIRST chunk, which is dominated by server-side prompt prefill — on a large
 * cold context (post-compaction, cache-evicted, long doc session) that
 * legitimately runs past 30s on the pro tier. `timeoutMs` covers every later
 * inter-chunk gap, where silence really does mean a hung connection. One
 * window for both (the pre-split behaviour) turned slow-but-healthy prefills
 * into abort → cold-retry → abort death spirals: the abort threw away a
 * prefill that was about to complete and the retry re-paid it from zero
 * (prod 2026-06-10 15:24 + 15:43 — "Stream idle for 30000ms" on turn 0, the
 * retry stalled the same way, and the turn died with no reply). Omitting
 * `firstChunkTimeoutMs` keeps the single-window behaviour.
 *
 * The error message keeps the `Stream idle for <n>ms` prefix in both phases —
 * `isTransientStreamError` (query-loop.ts) matches on it.
 */
export function wrapIdleTimeout(timeoutMs: number, firstChunkTimeoutMs?: number): StreamWrapper {
  return (inner) => async function* (request) {
    const stream = inner(request)
    const iterator = stream[Symbol.asyncIterator]()
    let timer: ReturnType<typeof setTimeout> | undefined
    let sawFirstChunk = false

    const timeoutPromise = () => {
      const windowMs = sawFirstChunk ? timeoutMs : (firstChunkTimeoutMs ?? timeoutMs)
      return new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Stream idle for ${windowMs}ms${sawFirstChunk ? '' : ' (no first chunk — prefill window)'}`,
              ),
            ),
          windowMs,
        )
      })
    }

    try {
      while (true) {
        const result = await Promise.race([
          iterator.next(),
          timeoutPromise(),
        ])
        if (timer) clearTimeout(timer)

        if (result.done) break
        sawFirstChunk = true
        yield result.value
      }
    } finally {
      if (timer) clearTimeout(timer)
      iterator.return?.()
    }
  }
}

// ── Logging ────────────────────────────────────────────────────

/**
 * Logs stream events for debugging. Emits start/end markers and
 * optionally logs each chunk type (not content — never log content).
 */
export function wrapLog(options?: { verbose?: boolean }): StreamWrapper {
  return (inner) => async function* (request) {
    const start = Date.now()
    let chunkCount = 0

    for await (const chunk of inner(request)) {
      chunkCount++
      if (options?.verbose) {
        console.debug(`[stream] chunk #${chunkCount}: ${chunk.type}`)
      }
      yield chunk
    }

    console.debug(`[stream] complete: ${chunkCount} chunks in ${Date.now() - start}ms`)
  }
}

// ── Sanitize tool call names ───────────────────────────────────

/**
 * Trims whitespace from tool call names (some providers add trailing spaces).
 */
export function wrapSanitizeToolNames(): StreamWrapper {
  return (inner) => async function* (request) {
    for await (const chunk of inner(request)) {
      if (chunk.type === 'tool_use_start') {
        yield { ...chunk, name: chunk.name.trim() }
      } else {
        yield chunk
      }
    }
  }
}

// ── Repair malformed tool call JSON ────────────────────────────

/**
 * Attempts to repair incomplete JSON in tool_use_delta chunks.
 * Accumulates deltas per tool call and validates on tool_use_end.
 */
export function wrapRepairToolCallArgs(): StreamWrapper {
  return (inner) => async function* (request) {
    const buffers = new Map<string, string>()

    for await (const chunk of inner(request)) {
      if (chunk.type === 'tool_use_delta') {
        const prev = buffers.get(chunk.id) ?? ''
        buffers.set(chunk.id, prev + chunk.input)
        yield chunk
      } else if (chunk.type === 'tool_use_end') {
        const accumulated = buffers.get(chunk.id)
        if (accumulated) {
          try {
            JSON.parse(accumulated)
          } catch {
            // Try simple repairs: trailing comma, missing closing brace
            const repaired = tryRepairJson(accumulated)
            if (repaired !== null) {
              yield { type: 'tool_use_delta' as const, id: chunk.id, input: repaired }
            }
          }
          buffers.delete(chunk.id)
        }
        yield chunk
      } else {
        yield chunk
      }
    }
  }
}

function tryRepairJson(json: string): string | null {
  // Remove trailing comma before closing brace
  let attempt = json.replace(/,\s*$/, '')
  // Add missing closing brace
  const opens = (attempt.match(/{/g) ?? []).length
  const closes = (attempt.match(/}/g) ?? []).length
  if (opens > closes) {
    attempt += '}'.repeat(opens - closes)
  }
  try {
    JSON.parse(attempt)
    return attempt
  } catch {
    return null
  }
}

// ── Degenerate token detector ──────────────────────────────────

/**
 * Detects control character spam (\b, zero-width chars) and single-token
 * infinite repetition. Aborts immediately on detection.
 *
 * Returns the clean text accumulated before the loop, or null if no loop.
 */
const DEGENERATE_PATTERN = /[\x08\u200B\u200C\u200D\uFEFF]{3,}/

function detectDegenerateTokens(buffer: string): boolean {
  return DEGENERATE_PATTERN.test(buffer)
}

function detectSingleTokenRepeat(buffer: string, minRepeat = 10): boolean {
  // Check if the last N characters are the same character repeated
  if (buffer.length < minRepeat) return false
  const tail = buffer.slice(-minRepeat)
  return tail.split('').every((c) => c === tail[0])
}

// ── N-gram repetition detector ─────────────────────────────────

/**
 * Sliding window of ~100 words, tracks 4-gram frequencies.
 * If any 4-gram appears 3+ times, the model is looping.
 * Returns the index in the text where the loop started (for trimming).
 */
const NGRAM_SIZE = 4
const NGRAM_REPEAT_THRESHOLD = 3
const WINDOW_SIZE = 100 // words

function detectNgramRepetition(text: string): { looping: boolean; cleanEnd: number } {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < WINDOW_SIZE) {
    // Check full text if shorter than window
    return checkNgrams(words, text)
  }

  // Use sliding window of last WINDOW_SIZE words
  const windowWords = words.slice(-WINDOW_SIZE)
  const result = checkNgrams(windowWords, text)
  return result
}

function checkNgrams(words: string[], fullText: string): { looping: boolean; cleanEnd: number } {
  if (words.length < NGRAM_SIZE) return { looping: false, cleanEnd: fullText.length }

  const counts = new Map<string, { count: number; firstEnd: number }>()

  for (let i = 0; i <= words.length - NGRAM_SIZE; i++) {
    const ngram = words.slice(i, i + NGRAM_SIZE).join(' ')
    const entry = counts.get(ngram)
    if (entry) {
      entry.count++
      if (entry.count >= NGRAM_REPEAT_THRESHOLD) {
        // Find where in the full text this ngram first ended — trim to there
        return { looping: true, cleanEnd: entry.firstEnd }
      }
    } else {
      // Approximate position of this ngram's end in the full text
      const approxPos = fullText.indexOf(words[i + NGRAM_SIZE - 1], i > 0 ? fullText.indexOf(words[i]) : 0)
      counts.set(ngram, {
        count: 1,
        firstEnd: approxPos !== -1 ? approxPos + words[i + NGRAM_SIZE - 1].length : fullText.length,
      })
    }
  }

  return { looping: false, cleanEnd: fullText.length }
}

// ── Block-restart detector (long-range loops) ──────────────────

/**
 * Catches the loop class the n-gram detector is structurally blind to: the
 * model restarting its ENTIRE answer. Those evade `detectNgramRepetition`
 * because each restart is longer than its 100-word window, so the three
 * identical openings never co-occur in one window, and minor wording drift
 * between restarts ("is broken" vs "was broken") dilutes exact-4-gram counts
 * below the 3× threshold. Window-independent by construction.
 *
 * Observed in prod 2026-06-05 (session abab9918): a Pro-research turn restarted
 * its answer 3× and ran to the output-token cap, ending mid-sentence — the
 * n-gram guard never fired.
 *
 * Signal: the response's opening fingerprint reappearing verbatim later in the
 * same stream. An assistant essentially never re-emits its first full clause,
 * so false positives are negligible. Anchored on the opening only, so it is a
 * single `indexOf` per check, not an O(n²) all-pairs scan.
 */
const RESTART_ANCHOR_CHARS = 48 // opening fingerprint length
const RESTART_MIN_BUFFER = 200 // don't fingerprint a tiny prefix

export function detectBlockRestart(buffer: string): { looping: boolean; cleanEnd: number } {
  if (buffer.length < RESTART_MIN_BUFFER) return { looping: false, cleanEnd: buffer.length }
  // Skip leading whitespace so the fingerprint is dense text, not indentation.
  let start = 0
  while (start < buffer.length && (buffer.charCodeAt(start) === 32
    || buffer.charCodeAt(start) === 9 || buffer.charCodeAt(start) === 10
    || buffer.charCodeAt(start) === 13)) start++
  const anchor = buffer.slice(start, start + RESTART_ANCHOR_CHARS)
  if (anchor.length < RESTART_ANCHOR_CHARS) return { looping: false, cleanEnd: buffer.length }
  // A verbatim reappearance of the opening fingerprint, searched past its own
  // span, means the model restarted its answer. Trim to the first clean copy.
  const second = buffer.indexOf(anchor, start + RESTART_ANCHOR_CHARS)
  if (second === -1) return { looping: false, cleanEnd: buffer.length }
  return { looping: true, cleanEnd: second }
}

// ── Text loop prevention wrapper ───────────────────────────────

type RepetitionDetected = {
  type: 'degenerate' | 'ngram' | 'restart'
  cleanText: string
  /** Last usage seen before the stream was aborted. */
  lastUsage?: TokenUsage
}

/**
 * Detects text repetition loops in the LLM stream.
 *
 * On detection: aborts stream, retries once with temperature +0.2 and
 * anti-repetition instruction. If second attempt also loops, returns
 * truncated clean output.
 */
export function wrapTextLoopPrevention(): StreamWrapper {
  return (inner) => async function* (request) {
    const result = yield* streamWithDetection(inner, request)

    if (!result) return // stream completed normally

    // First detection — retry with higher temperature + anti-repetition instruction
    const retryRequest = {
      ...request,
      temperature: (request.temperature ?? 0.7) + 0.2,
      systemPrompt: request.systemPrompt +
        '\n\nIMPORTANT: Vary your language. Do not repeat phrases or sentences. ' +
        'If you find yourself repeating, stop and move to the next point.',
    }

    const retryResult = yield* streamWithDetection(inner, retryRequest)

    if (!retryResult) return // retry succeeded

    // Second detection — yield the clean portion from whichever attempt had more clean text
    const useRetry = retryResult.cleanText.length >= result.cleanText.length
    const cleanText = useRetry ? retryResult.cleanText : result.cleanText

    if (cleanText.length > 0) {
      yield { type: 'text_delta' as const, text: cleanText }
    }
    // Synthesize a message_end with combined usage from both attempts.
    // Both consumed real tokens even though only one attempt's text is emitted.
    const u1 = result.lastUsage
    const u2 = retryResult.lastUsage
    const bestUsage: TokenUsage = u1 && u2
      ? {
          inputTokens: u1.inputTokens + u2.inputTokens,
          outputTokens: u1.outputTokens + u2.outputTokens,
          ...((u1.cacheReadTokens ?? 0) + (u2.cacheReadTokens ?? 0) > 0
            ? { cacheReadTokens: (u1.cacheReadTokens ?? 0) + (u2.cacheReadTokens ?? 0) }
            : {}),
        }
      : (u1 ?? u2 ?? { inputTokens: 0, outputTokens: 0 })
    yield {
      type: 'message_end' as const,
      stopReason: 'end_turn' as const,
      usage: bestUsage,
    }
  }
}

/**
 * After detecting a loop, drain remaining chunks from the inner stream
 * to capture the message_end usage. Gemini sends usageMetadata in the
 * final chunk, so we must consume through end-of-stream to get it.
 * Discards all content — only captures the TokenUsage.
 */
async function drainForUsage(
  stream: AsyncIterable<StreamChunk>,
): Promise<TokenUsage | undefined> {
  for await (const chunk of stream) {
    if (chunk.type === 'message_end' && chunk.usage) {
      return chunk.usage
    }
  }
  return undefined
}

/**
 * Sliding-window cap on textBuffer (bytes). Without this, every text_delta
 * chunk forced an O(n) split + O(n) detection scan over the unbounded-
 * growing buffer; total allocation work across a stream is O(M²) for M
 * chunks. Production 5/27 4GB OOM traces were consistent with this pattern
 * (heap 80MB → 4GB during a stream, no chunk-level guard fired because
 * each individual allocation was reasonable but the cumulative churn drove
 * V8 off a cliff). 64 KB is enough for the n-gram detector to catch
 * repetition; older text is trimmed from the left.
 */
const TEXT_BUFFER_WINDOW = 64 * 1024

/**
 * Allocation-free word counter. Replaces `textBuffer.split(/\s+/).length`
 * which allocated an array of ALL words just to read .length. For a 64 KB
 * buffer that's ~10K throwaway string allocations per chunk; cheap if it
 * fires once but the per-chunk cost compounds across thousands of chunks.
 */
function approxWordCount(s: string): number {
  let n = 0
  let inWord = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const isWs = c === 32 || c === 9 || c === 10 || c === 13
    if (!isWs) {
      if (!inWord) { n++; inWord = true }
    } else {
      inWord = false
    }
  }
  return n
}

/**
 * Streams from the inner function with repetition detection.
 * Yields chunks normally. If repetition detected, stops yielding
 * and returns the detection info. Returns null if stream completes cleanly.
 */
async function* streamWithDetection(
  inner: StreamFn,
  request: Parameters<StreamFn>[0],
): AsyncGenerator<StreamChunk, RepetitionDetected | null> {
  let textBuffer = ''
  let inTextMode = false

  const stream = inner(request)

  for await (const chunk of stream) {
    // Only check text_delta chunks for repetition
    if (chunk.type === 'text_delta') {
      inTextMode = true
      textBuffer += chunk.text
      // Sliding window cap to prevent O(n²) allocation churn (5/27 OOM).
      if (textBuffer.length > TEXT_BUFFER_WINDOW) {
        textBuffer = textBuffer.slice(-TEXT_BUFFER_WINDOW)
      }

      // Check for degenerate tokens (control char spam, single-char repeat)
      if (detectDegenerateTokens(textBuffer) || detectSingleTokenRepeat(textBuffer)) {
        const clean = textBuffer.replace(/[\x08\u200B\u200C\u200D\uFEFF]+$/, '').trimEnd()
        const lastUsage = await drainForUsage(stream)
        return { type: 'degenerate', cleanText: clean, lastUsage }
      }

      // Check for n-gram repetition (only after enough text). The word-count
      // gate is allocation-free; detection runs on the bounded window above.
      if (approxWordCount(textBuffer) >= 20) {
        const { looping, cleanEnd } = detectNgramRepetition(textBuffer)
        if (looping) {
          const lastUsage = await drainForUsage(stream)
          return { type: 'ngram', cleanText: textBuffer.slice(0, cleanEnd), lastUsage }
        }
      }

      // Check for whole-answer restarts (loops longer than the n-gram window).
      if (textBuffer.length >= RESTART_MIN_BUFFER) {
        const restart = detectBlockRestart(textBuffer)
        if (restart.looping) {
          const lastUsage = await drainForUsage(stream)
          return { type: 'restart', cleanText: textBuffer.slice(0, restart.cleanEnd), lastUsage }
        }
      }

      yield chunk
    } else {
      if (chunk.type !== 'message_start' && chunk.type !== 'message_end') {
        // Non-text chunk (tool use) — reset text detection
        inTextMode = false
        textBuffer = ''
      }
      yield chunk
    }
  }

  return null
}

// ── Compose wrappers ───────────────────────────────────────────

/**
 * Composes multiple wrappers into a single StreamFn.
 * Applied left-to-right (first wrapper is innermost).
 */
export function composeWrappers(base: StreamFn, ...wrappers: StreamWrapper[]): StreamFn {
  return wrappers.reduce((fn, wrapper) => wrapper(fn), base)
}

// ── Default wrapper pipeline ───────────────────────────────────

/**
 * Returns the standard wrapper pipeline for production use.
 */
export function defaultWrappers(options?: {
  idleTimeoutMs?: number
  /** First-chunk (prefill) window — see `wrapIdleTimeout`. Default 90s. */
  firstChunkTimeoutMs?: number
  verbose?: boolean
}): StreamWrapper[] {
  return [
    wrapContextBudget(),
    wrapSanitizeToolNames(),
    wrapRepairToolCallArgs(),
    wrapTextLoopPrevention(),
    wrapLog({ verbose: options?.verbose }),
    wrapIdleTimeout(options?.idleTimeoutMs ?? 30_000, options?.firstChunkTimeoutMs ?? 90_000),
  ]
}

// ── Provider wrapping ──────────────────────────────────────────

/**
 * Returns a new `LLMProvider` whose `stream()` and `createSession().send()`
 * both pass through the supplied wrapper pipeline (default: `defaultWrappers`).
 *
 * Why this exists: the chat route uses the stateful `createSession` API, not
 * the legacy single-shot `stream`. Wrapping only `stream` (the obvious thing)
 * leaves session-driven calls unprotected — `wrapIdleTimeout` etc. never
 * fires. Without this, a hung Gemini fetch ran for the full Cloud Run 300s
 * cap with no abort, the chat-route catch block never executed, and the
 * draft session was left stuck in `status='running'`.
 *
 * Each `send()` call gets a fresh wrapper instance so per-call state
 * (idle-timer, n-gram detector, etc.) is reset between turns.
 */
export function wrapProvider(
  base: LLMProvider,
  options?: { idleTimeoutMs?: number; firstChunkTimeoutMs?: number; verbose?: boolean },
): LLMProvider {
  const wrappers = defaultWrappers(options)
  const wrappedStream: StreamFn = composeWrappers(base.stream, ...wrappers)

  return {
    name: base.name,
    models: base.models,
    stream: wrappedStream,
    createSession(sessionOpts: SessionOptions): ProviderSession {
      const inner = base.createSession(sessionOpts)
      return {
        send(messages: Message[], sendOpts?: SendOptions): AsyncIterable<StreamChunk> {
          // Adapt session.send (closure over sendOpts) into the StreamFn shape
          // the wrappers expect. The request's `messages` ARE forwarded to
          // `inner.send` — `wrapContextBudget` may have trimmed them to fit the
          // model window, and that trim must reach the provider. A failed first
          // send leaves the session's rawHistory empty (it only pushes on a
          // successful stream — see gemini.ts), so re-sending trimmed messages
          // on the budget wrapper's retry is safe. The other wrappers don't
          // touch `req.messages`, so this is a no-op for them.
          const adaptedFn: StreamFn = (req) => inner.send(req.messages, sendOpts)
          const wrapped = composeWrappers(adaptedFn, ...wrappers)
          return wrapped({
            model: sessionOpts.model,
            systemPrompt: sessionOpts.systemPrompt,
            messages,
            tools: sessionOpts.tools,
            maxTokens: sessionOpts.maxTokens,
            temperature: sessionOpts.temperature,
            thinkingLevel: sendOpts?.thinkingLevel ?? sessionOpts.thinkingLevel,
            signal: sessionOpts.signal,
          })
        },
      }
    },
  }
}
