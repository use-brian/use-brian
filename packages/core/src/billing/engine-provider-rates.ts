/**
 * Per-call rates for the external AI answer engines the observation tools
 * consult (`askOpenAI` / `askGemini` / `askPerplexity` / `askClaude`).
 *
 * These engines charge a vendor search fee per request PLUS tokens, and the
 * ask framework caps output at 2,048 tokens per upstream call — so one call
 * has a bounded, knowable ceiling. Rather than plumb per-token precision
 * through five different response shapes, each engine gets a flat
 * COGS-inclusive rate here, exactly like the search providers next door in
 * `search-provider-rates.ts`. The base tools emit it as `ExternalCost['flat']`
 * so the shared recording seam writes a `usage_tracking` row per call —
 * matching the "External API cost tracking policy" in
 * docs/architecture/platform/cost-and-pricing.md.
 *
 * Rates are deliberately CONSERVATIVE (rounded up from the derivation): an
 * engine call that costs us less than we record is a rounding error, one that
 * costs more is an invisible subsidy that scales with adoption.
 *
 * Keep the keys in sync with `EngineId` in
 * `packages/core/src/engines/ask-engines.ts`.
 *
 * Last verified: 2026-08-07
 * - openai ($0.055/call): `web_search` tool fee ~$30/1k calls + up to 2,048
 *   output tokens on gpt-4o ($10/M = $0.0205) + search-result input tokens.
 * - gemini ($0.045/call): Google Search grounding ~$35/1k requests + 2,048
 *   output tokens on gemini-2.5-flash ($2.50/M = $0.005).
 * - perplexity ($0.005/call): Sonar ~$1/1k requests + request/response and
 *   search-context tokens at ~$1/M.
 * - claude ($0.120/call): the `web_search` server tool at ~$10/1k searches
 *   with `max_uses: 3` ($0.030) + 2,048 output tokens on Sonnet ($15/M =
 *   $0.031) + the search results that land back in input ($3/M).
 * - searchConsoleQuery is FREE (Google Search Console API has no per-call
 *   charge) and is listed as $0 so a dashboard iterating this map does not
 *   drop it.
 *
 * When a rate changes (vendor repricing, a model-default swap, a change to
 * `MAX_ANSWER_TOKENS`), update the value and the `Last verified` date.
 */
export const ENGINE_PROVIDER_COST_PER_1K: Record<string, number> = {
  openai: 55.0,
  gemini: 45.0,
  perplexity: 5.0,
  claude: 120.0,
  gsc: 0.0,
}

/** Per-call USD cost for the given engine. Returns 0 for unknown engines. */
export function flatEngineCostUsd(engine: string): number {
  const per1k = ENGINE_PROVIDER_COST_PER_1K[engine] ?? 0
  return per1k / 1000
}

/**
 * The `usage_tracking.model` value for an engine cost row.
 *
 * Namespaced because an engine id is a vendor, not a model: a bare `openai`
 * or `claude` in that column would sit indistinguishable beside real model
 * ids the tier classifier and the cost dashboards read. The prefix keeps
 * observation spend legible as its own line.
 */
export function engineCostModel(engine: string): string {
  return `engine:${engine}`
}
