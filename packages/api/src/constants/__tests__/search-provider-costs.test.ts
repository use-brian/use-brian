/**
 * Unit tests for the search-provider cost helper.
 * Component tag: [COMP:api/search-provider-costs].
 *
 * Verifies estimateSearchCostUsd — the per-1k rate scaled by call
 * count — and the re-exported SEARCH_PROVIDER_COST_PER_1K table that
 * the admin search-cost dashboard reads.
 */

import { describe, it, expect } from 'vitest'
import {
  estimateSearchCostUsd,
  SEARCH_PROVIDER_COST_PER_1K,
} from '../search-provider-costs.js'

describe('[COMP:api/search-provider-costs] estimateSearchCostUsd', () => {
  it('scales the per-1k rate by the call count', () => {
    expect(estimateSearchCostUsd('brave', 1000)).toBeCloseTo(SEARCH_PROVIDER_COST_PER_1K.brave)
    expect(estimateSearchCostUsd('serper', 500)).toBeCloseTo(SEARCH_PROVIDER_COST_PER_1K.serper / 2)
  })

  it('returns 0 for a zero-rate or unknown provider', () => {
    expect(estimateSearchCostUsd('duckduckgo', 9999)).toBe(0)
    expect(estimateSearchCostUsd('nonexistent-provider', 1000)).toBe(0)
  })

  it('returns 0 for a zero call count', () => {
    expect(estimateSearchCostUsd('brave', 0)).toBe(0)
  })

  it('exposes the provider rate table for the cost dashboard', () => {
    expect(SEARCH_PROVIDER_COST_PER_1K.brave).toBeGreaterThan(0)
    expect(SEARCH_PROVIDER_COST_PER_1K.duckduckgo).toBe(0)
  })
})
