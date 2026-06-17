/**
 * Shared shape for external-API cost attribution attached to tool results.
 *
 * Tools that call paid external APIs (xAI, Brave, Serper, Tavily, etc.)
 * emit cost data on `ToolResult.meta` using the flat key scheme below.
 * The chat route reads it off the `tool_result` QueryEvent and writes a
 * `usage_tracking` row per external call.
 *
 * The meta channel is constrained to `Record<string, string | number | boolean>`
 * (see `tools/types.ts`), so we flatten rather than nest. This also keeps
 * the fields visible in the `tool_executed` analytics event metadata
 * without special-casing the iterator in `chat.ts`.
 *
 * See docs/architecture/platform/cost-and-pricing.md → "External API cost
 * tracking policy" for the binding rule.
 */

import type { ToolResultMeta } from '../tools/types.js'

/** Per-token (LLM-like) external cost. The chat route computes USD via `calculateCost`. */
export type PerTokenExternalCost = {
  kind: 'per-token'
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

/** Flat per-call external cost. The chat route writes `flatCostUsd` directly. */
export type FlatExternalCost = {
  kind: 'flat'
  /** Typically a provider name (`brave`, `serper`, `tavily`, `duckduckgo`). Stored in `usage_tracking.model`. */
  model: string
  flatCostUsd: number
}

export type ExternalCost = PerTokenExternalCost | FlatExternalCost

// ── Flat key scheme ─────────────────────────────────────────────

const PREFIX = 'externalCost_'
const KEY_KIND = `${PREFIX}kind`
const KEY_MODEL = `${PREFIX}model`
const KEY_INPUT_TOKENS = `${PREFIX}inputTokens`
const KEY_OUTPUT_TOKENS = `${PREFIX}outputTokens`
const KEY_CACHE_READ_TOKENS = `${PREFIX}cacheReadTokens`
const KEY_FLAT_COST_USD = `${PREFIX}flatCostUsd`

/** Encode an ExternalCost into `ToolResult.meta` fields. */
export function encodeExternalCostMeta(cost: ExternalCost): ToolResultMeta {
  if (cost.kind === 'per-token') {
    return {
      [KEY_KIND]: 'per-token',
      [KEY_MODEL]: cost.model,
      [KEY_INPUT_TOKENS]: cost.inputTokens,
      [KEY_OUTPUT_TOKENS]: cost.outputTokens,
      [KEY_CACHE_READ_TOKENS]: cost.cacheReadTokens ?? 0,
    }
  }
  return {
    [KEY_KIND]: 'flat',
    [KEY_MODEL]: cost.model,
    [KEY_FLAT_COST_USD]: cost.flatCostUsd,
  }
}

/** Decode an ExternalCost from `ToolResult.meta`, or undefined if not present / malformed. */
export function decodeExternalCostMeta(meta: ToolResultMeta | undefined): ExternalCost | undefined {
  if (!meta) return undefined
  const kind = meta[KEY_KIND]
  const model = meta[KEY_MODEL]
  if (typeof model !== 'string' || !model) return undefined
  if (kind === 'per-token') {
    const inputTokens = meta[KEY_INPUT_TOKENS]
    const outputTokens = meta[KEY_OUTPUT_TOKENS]
    if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined
    const cacheReadTokens = meta[KEY_CACHE_READ_TOKENS]
    return {
      kind: 'per-token',
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens: typeof cacheReadTokens === 'number' ? cacheReadTokens : 0,
    }
  }
  if (kind === 'flat') {
    const flatCostUsd = meta[KEY_FLAT_COST_USD]
    if (typeof flatCostUsd !== 'number') return undefined
    return { kind: 'flat', model, flatCostUsd }
  }
  return undefined
}
