/**
 * Per-call rates for web-search providers that don't return token counts.
 *
 * These providers charge flat per-call (Brave, Serper, Tavily) or per-1k,
 * not per-token. For billing, the `webSearch` tool emits these rates as
 * `ExternalCost['flat']` so the chat route can write a `usage_tracking`
 * row at the true cost — matching the "External API cost tracking policy"
 * in docs/architecture/platform/cost-and-pricing.md.
 *
 * Keep the keys in sync with `SearchProvider.name` strings in
 * `packages/core/src/tools/base/search-stack.ts`.
 *
 * Last verified: 2026-04-22
 * - brave: $5.00 per 1k (AI-tier billing; user-confirmed rate).
 * - serper: $50 / 50k queries = $1.00 per 1k.
 * - tavily: $0.008 / request = $8.00 per 1k.
 * - duckduckgo: free HTML scrape fallback, $0.
 *
 * When a rate changes (new tier, vendor switch, volume discount), update
 * the value and the `Last verified` date.
 */
export const SEARCH_PROVIDER_COST_PER_1K: Record<string, number> = {
  brave: 5.0,
  serper: 1.0,
  tavily: 8.0,
  duckduckgo: 0.0,
  // xAI's x_search is not served via this path — Grok returns token counts,
  // so it bills per-token via the PRICING table in cost-tracker.ts. Listed
  // here with $0 so dashboards that iterate this map don't drop it.
  xai: 0.0,
}

/** Per-call USD cost for the given provider. Returns 0 for unknown providers. */
export function flatSearchCostUsd(provider: string): number {
  const per1k = SEARCH_PROVIDER_COST_PER_1K[provider] ?? 0
  return per1k / 1000
}
