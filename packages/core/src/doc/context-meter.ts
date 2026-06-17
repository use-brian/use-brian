/**
 * Doc turn-context meter — Phase 0 instrumentation.
 *
 * Pure projection of an assembled doc turn's prompt into a per-component
 * token tally, so the doc token-cost optimization (delta tool returns,
 * tighter elision, and the future hierarchical map + section retrieval) is
 * MEASURED, not guessed, and regressions are visible. The chat route emits one
 * tally per doc `main_response` turn as the `doc_context_composition`
 * analytics event.
 *
 * The single most valuable signal is the doc tool-result ballast carried in
 * history (`docHistoryTokens` / `maxDocResultTokens` /
 * `largeDocResultCount`): before the delta-return change it grew linearly
 * with edit count; after it, it should stay flat. That is computed by walking
 * the post-elision messages array, reusing `DOC_PAGE_STATE_TOOLS` from the
 * elider so the two never disagree about which results count.
 *
 * Token counts use the existing CJK-aware `estimateTokens` /
 * `estimateStringTokens` heuristic — an estimate for observability, NOT a
 * billing figure (billing reads provider usage, echoed here as `inputTokens` /
 * `outputTokens` / `cacheReadTokens` for correlation).
 *
 * Pure — no DB, no clock, no I/O. Safe to import anywhere; unit-tested.
 *
 * Spec: `docs/plans/doc-turn-context-optimization.md` → Phase 0.
 *
 * [COMP:doc/context-meter]
 */

import type { Message } from '../providers/types.js'
import { estimateStringTokens, estimateTokens } from '../compaction/compact.js'
import { DOC_PAGE_STATE_TOOLS } from '../engine/doc-history.js'

/**
 * A doc page-state `tool_result` larger than this (estimated tokens) is a
 * "large snapshot" — a full-page dump (`getCurrentPage` with `fields:'full'`)
 * or a whole-page outline (an `invalid_ops` re-anchor body). These are the
 * ballast the optimization targets; counting them surfaces regressions where a
 * snapshot leaks back into the re-sent history.
 */
export const LARGE_DOC_RESULT_TOKENS = 2_000

export type DocContextComposition = {
  /** The stable system prompt actually sent to the provider (Layer 1 + memory
   *  + skill block). Since the turn-context envelope split (2026-06-10) the
   *  volatile per-turn blocks — clock, topic hint, live outline, preflight —
   *  ride the newest user message instead, so they count under
   *  `messageHistoryTokens`, not here. `skillBlockTokens` /
   *  `memoryContextTokens` remain SUB-SLICES of this total (for attribution),
   *  NOT additive components — do not sum them and expect
   *  `systemPromptTokens`. */
  systemPromptTokens: number
  /** The doc authoring protocol block injected on every doc turn (a
   *  sub-slice of `systemPromptTokens`). */
  skillBlockTokens: number
  /** The full `# Active doc page` block delivered via the turn-context
   *  envelope (heading + title + per-block lines + edit-guidance suffix — a
   *  sub-slice of `messageHistoryTokens` since the envelope split). */
  liveOutlineTokens: number
  /** Number of blocks in that live outline. */
  outlineBlockCount: number
  /** The memory/brain context block (soul + identity + ranked index + team). */
  memoryContextTokens: number
  /** The whole post-elision messages array (conversation history). */
  messageHistoryTokens: number
  /** Sum of all doc page-state tool_result bodies still in history (the
   *  ballast the delta-return + elision changes are meant to keep flat). */
  docHistoryTokens: number
  /** Largest single doc page-state tool_result still verbatim in history. */
  maxDocResultTokens: number
  /** How many doc page-state results exceed `LARGE_DOC_RESULT_TOKENS`. */
  largeDocResultCount: number
  /** Raw block count of the open page (pre-outline). */
  pageBlockCount: number
  /** Open page version (rises with each edit — pairs with edit-turn growth). */
  pageVersion: number
  /** Provider usage for the main response, echoed for 1:1 correlation with the
   *  `usage_tracking` row. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export type MeasureDocContextInput = {
  systemPrompt: string
  skillBlock?: string | null
  liveOutline?: string | null
  outlineBlockCount?: number
  memoryContext?: string | null
  messages: Message[]
  pageBlockCount?: number
  pageVersion?: number
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
}

/**
 * Project an assembled doc turn into a per-component token tally. Tolerant
 * of missing pieces (a chat-without-open-page turn has no live outline) — those
 * components report 0.
 */
export function measureDocContext(
  input: MeasureDocContextInput,
): DocContextComposition {
  let docHistoryTokens = 0
  let maxDocResultTokens = 0
  let largeDocResultCount = 0

  for (const msg of input.messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (
        block.type !== 'tool_result' ||
        !DOC_PAGE_STATE_TOOLS.has(block.name) ||
        typeof block.content !== 'string'
      ) {
        continue
      }
      const t = estimateStringTokens(block.content)
      docHistoryTokens += t
      if (t > maxDocResultTokens) maxDocResultTokens = t
      if (t >= LARGE_DOC_RESULT_TOKENS) largeDocResultCount += 1
    }
  }

  return {
    systemPromptTokens: estimateStringTokens(input.systemPrompt),
    skillBlockTokens: input.skillBlock ? estimateStringTokens(input.skillBlock) : 0,
    liveOutlineTokens: input.liveOutline ? estimateStringTokens(input.liveOutline) : 0,
    outlineBlockCount: input.outlineBlockCount ?? 0,
    memoryContextTokens: input.memoryContext
      ? estimateStringTokens(input.memoryContext)
      : 0,
    messageHistoryTokens: estimateTokens(input.messages),
    docHistoryTokens,
    maxDocResultTokens,
    largeDocResultCount,
    pageBlockCount: input.pageBlockCount ?? 0,
    pageVersion: input.pageVersion ?? 0,
    inputTokens: input.usage?.inputTokens ?? 0,
    outputTokens: input.usage?.outputTokens ?? 0,
    cacheReadTokens: input.usage?.cacheReadTokens ?? 0,
  }
}
