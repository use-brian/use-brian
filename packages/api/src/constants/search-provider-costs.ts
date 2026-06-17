/**
 * Cost-per-call rates for the web search provider stack.
 *
 * Moved to `@sidanclaw/core` (`packages/core/src/billing/search-provider-rates.ts`)
 * so the `webSearch` tool can attach per-call USD to its result meta for
 * the billing pipeline. This file re-exports for existing dashboard callers.
 *
 * See docs/architecture/platform/cost-and-pricing.md → "External API cost
 * tracking policy".
 */

export { SEARCH_PROVIDER_COST_PER_1K } from '@sidanclaw/core'
import { SEARCH_PROVIDER_COST_PER_1K } from '@sidanclaw/core'

/** Cost in USD for `calls` successful searches against `provider`. */
export function estimateSearchCostUsd(provider: string, calls: number): number {
  const rate = SEARCH_PROVIDER_COST_PER_1K[provider] ?? 0
  return (rate * calls) / 1000
}
