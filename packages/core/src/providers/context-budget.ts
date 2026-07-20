/**
 * Context-budget fitting — the deterministic, LLM-independent shrink path.
 *
 * The invariant this module enforces: an assembled provider request always
 * fits the model's input-token window. Compaction (the quality-preserving
 * shrink) calls the LLM and can therefore fail for the very reason it's
 * needed — an over-limit session 400s, and so does the compaction that's
 * meant to rescue it, wedging the session permanently. The fix is to
 * separate *shrink* (lossy, deterministic, cannot fail) from *summarize*
 * (LLM-dependent, can fail): `fitMessagesToBudget` guarantees the request
 * fits before any provider call, and `wrapContextBudget` (in `wrappers.ts`)
 * applies it at the single provider seam every call passes through.
 *
 * Provenance: 2026-05-31 Gemini 400 "input token count exceeds 1048576" on
 * a Telegram session whose history (incl. two 2.29 MB historical tool_results)
 * blew past the 1M window; both the turn and compaction 400'd. See
 * `docs/architecture/engine/provider-abstraction.md` → "Context-budget wrapper".
 */

import { modelContextWindow } from '@use-brian/shared/model-registry'
import type { Message, ContentBlock } from './types.js'
import { estimateTokens, estimateStringTokens } from '../compaction/index.js'

// ── Per-tool_result cap (shared with the tool executor) ─────────

/**
 * Largest a single `tool_result` block may be, in tokens. The tool executor
 * applies this at *write* time (`engine/tool-executor.ts`); `fitMessagesToBudget`
 * applies the same cap at *read* time so an over-sized result already
 * persisted in history (written before the write-time cap shipped, or by a
 * future tool that forgets to opt in) is clamped on every assembly.
 */
export const MAX_TOOL_RESULT_TOKENS = 25_000

export const TOOL_RESULT_TRUNCATION_MARKER =
  '\n\n[Response truncated at 25k tokens — narrow your query or paginate.]'

/**
 * Appended when stage 2.5 shrinks a lone oversized newest message (a giant
 * paste or attachment that alone blows the budget). Deliberately DISTINCT
 * from `TOOL_RESULT_TRUNCATION_MARKER` so a clamped user turn and a clamped
 * tool_result stay legible when a transcript is inspected.
 */
export const MESSAGE_TRUNCATION_MARKER =
  '\n\n…[truncated: message exceeded the context budget]'

// ── Per-model input window ──────────────────────────────────────

/**
 * Substring → input-token limit fallback for ids the registry doesn't know,
 * matched in order (first hit wins), mirroring `modelToCompactionTier`'s
 * substring strategy so an unregistered vendor variant still gets a sane
 * window. Registered models resolve their exact `contextWindow` from the
 * model registry first.
 */
const MODEL_INPUT_LIMITS: ReadonlyArray<{ match: string; limit: number }> = [
  { match: 'claude', limit: 200_000 },
  { match: 'gemini', limit: 1_048_576 },
]

const DEFAULT_INPUT_LIMIT = 1_048_576

/** Target fraction of the hard limit to fit under — headroom for estimator drift. */
export const MODEL_CONTEXT_FIT_RATIO = 0.9

export function resolveInputTokenLimit(model: string): number {
  const known = modelContextWindow(model)
  if (known) return known
  const m = model.toLowerCase()
  for (const { match, limit } of MODEL_INPUT_LIMITS) {
    if (m.includes(match)) return limit
  }
  return DEFAULT_INPUT_LIMIT
}

// ── Context-overflow detection ──────────────────────────────────

/**
 * True when an error from a provider call is a context-window overflow
 * (the provider rejected the request because the input exceeded its
 * token limit). Matched on the error message across providers — Gemini
 * surfaces "exceeds the maximum number of tokens", others vary.
 *
 * Used by the query loop's reactive-compact path and by `wrapContextBudget`'s
 * trim-and-retry backstop. Lives here (not in the query loop) so the provider
 * wrapper can reuse it without an engine→… import.
 */
export function isContextOverflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /prompt.too.long|context.length.exceeded|token.limit|exceeds.*maximum|too many tokens/i.test(msg)
}

// ── Deterministic shrink ────────────────────────────────────────

export type FitResult = {
  messages: Message[]
  /** True when any clamp or eviction changed the message array. */
  trimmed: boolean
  tokensBefore: number
  tokensAfter: number
  /** Number of whole messages evicted (0 if only tool_result clamping ran). */
  dropped: number
}

/**
 * CJK-aware truncation to a token budget. Walks code points accumulating
 * `estimateStringTokens` (1 token/CJK char, ~4 chars/token otherwise) and
 * cuts at the index that first exceeds the budget — a naive `slice(0, n*4)`
 * would leak past the budget on CJK content.
 */
function truncateToTokenBudget(s: string, maxTokens: number): string {
  let cumulative = 0
  for (let i = 0; i < s.length; i++) {
    cumulative += estimateStringTokens(s[i]!)
    if (cumulative > maxTokens) return s.slice(0, i)
  }
  return s
}

/**
 * The single canonical write-time tool_result cap. Returns `content`
 * unchanged (same reference) when it already fits `MAX_TOOL_RESULT_TOKENS` —
 * the hot path — otherwise CJK-aware-truncates and appends the marker.
 *
 * Every site that finalizes tool-produced content routes through this:
 *   - the tool executor's success path (capping `result.data`),
 *   - the tool executor's catch path (capping a thrown error message — the
 *     one path that historically bypassed the cap, letting a recursive
 *     `ZodError` dump ~60k tokens into context; 2026-06-01 "AI Trading"),
 *   - `clampToolResults` below (read time), so a result persisted before the
 *     write-time cap shipped is clamped on every history assembly.
 * Keeping it one function means no path can finalize content uncapped.
 */
export function capToolResultTokens(content: string): string {
  if (estimateStringTokens(content) <= MAX_TOOL_RESULT_TOKENS) return content
  return truncateToTokenBudget(content, MAX_TOOL_RESULT_TOKENS) + TOOL_RESULT_TRUNCATION_MARKER
}

/** Clamp any over-sized `tool_result` block in one message. Returns the same
 * message reference when nothing changed (so callers can detect a no-op). */
function clampToolResults(msg: Message): Message {
  if (typeof msg.content === 'string') return msg
  let changed = false
  const content = msg.content.map((block): ContentBlock => {
    if (block.type === 'tool_result') {
      const capped = capToolResultTokens(block.content)
      if (capped !== block.content) {
        changed = true
        return { ...block, content: capped }
      }
    }
    return block
  })
  return changed ? { ...msg, content } : msg
}

/**
 * Clamp one text payload to `maxTokens`, CJK-aware, appending the
 * message-truncation marker. Returns `text` unchanged (same reference) when
 * it already fits — the twin of `capToolResultTokens`, but with a DISTINCT
 * marker so a clamped user turn and a clamped tool_result stay legible.
 */
function capMessageText(text: string, maxTokens: number): string {
  if (estimateStringTokens(text) <= maxTokens) return text
  return truncateToTokenBudget(text, maxTokens) + MESSAGE_TRUNCATION_MARKER
}

/**
 * Clamp the text payload of a single message to `maxTokens`. Targets a
 * plain-string `content` and the `text` blocks of a multi-block message;
 * image / tool_use / tool_result blocks are left untouched (a tool_result
 * already carries its own stage-1 cap). Returns the same message reference
 * when nothing changed.
 */
function clampMessageText(msg: Message, maxTokens: number): Message {
  if (typeof msg.content === 'string') {
    const capped = capMessageText(msg.content, maxTokens)
    return capped === msg.content ? msg : { ...msg, content: capped }
  }
  let changed = false
  const content = msg.content.map((block): ContentBlock => {
    if (block.type === 'text') {
      const capped = capMessageText(block.text, maxTokens)
      if (capped !== block.text) {
        changed = true
        return { ...block, text: capped }
      }
    }
    return block
  })
  return changed ? { ...msg, content } : msg
}

/**
 * After evicting an oldest prefix, the new first message may be a `user`
 * turn carrying `tool_result` blocks whose `tool_use` (in the dropped
 * preceding assistant turn) is gone. Gemini 400s on a `functionResponse`
 * with no preceding `functionCall`, so strip those orphans; if that empties
 * the message, drop it entirely.
 */
function stripLeadingOrphanToolResults(msgs: Message[]): Message[] {
  const first = msgs[0]
  if (!first || first.role !== 'user' || typeof first.content === 'string') return msgs
  const kept = first.content.filter((b) => b.type !== 'tool_result')
  if (kept.length === first.content.length) return msgs
  if (kept.length === 0) return msgs.slice(1)
  return [{ ...first, content: kept }, ...msgs.slice(1)]
}

/**
 * Shrink `messages` to fit `budgetTokens`, deterministically and without an
 * LLM call. Stages:
 *   1. Clamp every over-sized `tool_result` block to `MAX_TOOL_RESULT_TOKENS`.
 *   2. If still over budget, evict oldest messages — preserving the leading
 *      `system` prefix and the most-recent suffix (the current turn is never
 *      dropped) — then repair tool_use/tool_result pairing at the new head and
 *      prepend a one-line breadcrumb noting how many messages were omitted.
 *   2.5. If eviction left only the newest message and it STILL exceeds the
 *      budget, no eviction can help (the current turn is never dropped) — so
 *      clamp that message's own text payload via `clampMessageText`. Handles a
 *      single giant paste/attachment that alone blows the window.
 *
 * `trimmed` is false (and `messages` is returned untouched) when the input
 * already fits — the common case, so this is cheap on the hot path.
 */
export function fitMessagesToBudget(messages: Message[], budgetTokens: number): FitResult {
  const tokensBefore = estimateTokens(messages)
  if (tokensBefore <= budgetTokens) {
    return { messages, trimmed: false, tokensBefore, tokensAfter: tokensBefore, dropped: 0 }
  }

  // Stage 1 — clamp over-sized tool_results.
  let clampedAny = false
  const clamped = messages.map((m) => {
    const c = clampToolResults(m)
    if (c !== m) clampedAny = true
    return c
  })
  const tokensAfterClamp = estimateTokens(clamped)
  if (tokensAfterClamp <= budgetTokens) {
    return { messages: clamped, trimmed: clampedAny, tokensBefore, tokensAfter: tokensAfterClamp, dropped: 0 }
  }

  // Stage 2 — evict oldest non-system messages, newest-first accumulation.
  let prefixEnd = 0
  while (prefixEnd < clamped.length && clamped[prefixEnd]!.role === 'system') prefixEnd++
  const systemPrefix = clamped.slice(0, prefixEnd)
  const body = clamped.slice(prefixEnd)
  const systemTokens = estimateTokens(systemPrefix)

  const keptReversed: Message[] = []
  let running = 0
  let dropped = 0
  for (let j = body.length - 1; j >= 0; j--) {
    const t = estimateTokens([body[j]!])
    // Always keep the most recent message (the current turn); only the
    // overflow check gates older ones.
    if (keptReversed.length > 0 && systemTokens + running + t > budgetTokens) {
      dropped = j + 1
      break
    }
    keptReversed.push(body[j]!)
    running += t
  }

  // Stage 2.5 — clamp a lone oversized newest message. When the only survivor
  // of eviction is the current turn itself and it still blows the budget,
  // further eviction can't help (the turn is never dropped). Shrink its text
  // payload deterministically, capped at half the budget (never above the
  // tool_result cap) so a runaway paste can't reclaim the whole window.
  if (keptReversed.length === 1 && systemTokens + running > budgetTokens) {
    const cap = Math.min(MAX_TOOL_RESULT_TOKENS, Math.floor(budgetTokens / 2))
    keptReversed[0] = clampMessageText(keptReversed[0]!, cap)
  }

  const kept = stripLeadingOrphanToolResults(keptReversed.reverse())

  const breadcrumb: Message[] =
    dropped > 0
      ? [{ role: 'system', content: `[${dropped} earlier message(s) omitted to fit the context window.]` }]
      : []
  const result = [...systemPrefix, ...breadcrumb, ...kept]
  return { messages: result, trimmed: true, tokensBefore, tokensAfter: estimateTokens(result), dropped }
}
