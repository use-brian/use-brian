import { describe, it, expect } from 'vitest'
import { SEARCH_PROVIDER_COST_PER_1K, flatSearchCostUsd } from '../search-provider-rates.js'

describe('[COMP:billing/search-rates] SEARCH_PROVIDER_COST_PER_1K', () => {
  it('has entries for the billable providers in the stack', () => {
    expect(SEARCH_PROVIDER_COST_PER_1K.brave).toBe(5.0)
    expect(SEARCH_PROVIDER_COST_PER_1K.serper).toBe(1.0)
    expect(SEARCH_PROVIDER_COST_PER_1K.tavily).toBe(8.0)
    expect(SEARCH_PROVIDER_COST_PER_1K.duckduckgo).toBe(0.0)
  })

  it('has a zero entry for xai (token-billed, not per-call)', () => {
    // xAI bills per-token via the PRICING table, not per-call — but it's
    // listed here so dashboards that iterate the map see it.
    expect(SEARCH_PROVIDER_COST_PER_1K.xai).toBe(0.0)
  })
})

describe('[COMP:billing/search-rates] flatSearchCostUsd', () => {
  it('converts per-1k to per-call', () => {
    expect(flatSearchCostUsd('brave')).toBe(0.005)
    expect(flatSearchCostUsd('serper')).toBe(0.001)
    expect(flatSearchCostUsd('tavily')).toBe(0.008)
    expect(flatSearchCostUsd('duckduckgo')).toBe(0)
  })

  it('returns 0 for unknown providers', () => {
    expect(flatSearchCostUsd('unknown-provider')).toBe(0)
  })
})
