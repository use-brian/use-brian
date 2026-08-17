import { describe, it, expect } from 'vitest'
import {
  ENGINE_PROVIDER_COST_PER_1K,
  flatEngineCostUsd,
  engineCostModel,
} from '../engine-provider-rates.js'
import { createEngineAskers } from '../../engines/ask-engines.js'

describe('[COMP:billing/engine-rates] ENGINE_PROVIDER_COST_PER_1K', () => {
  it('carries a rate for every engine the ask framework can build', () => {
    const engines = createEngineAskers({
      ENGINES_OPENAI_API_KEY: 'k',
      ENGINES_GEMINI_API_KEY: 'k',
      ENGINES_PERPLEXITY_API_KEY: 'k',
      ENGINES_ANTHROPIC_API_KEY: 'k',
    }).map((a) => a.engine)

    expect(engines).toHaveLength(4)
    for (const engine of engines) {
      expect(ENGINE_PROVIDER_COST_PER_1K[engine]).toBeGreaterThan(0)
    }
  })

  it('converts a per-1k rate to a per-call cost', () => {
    expect(flatEngineCostUsd('openai')).toBeCloseTo(ENGINE_PROVIDER_COST_PER_1K.openai / 1000)
    expect(flatEngineCostUsd('perplexity')).toBeCloseTo(0.005)
  })

  it('returns 0 for an unknown engine rather than throwing', () => {
    expect(flatEngineCostUsd('not-an-engine')).toBe(0)
  })

  it('namespaces the usage_tracking model so an engine id cannot pass for a model id', () => {
    expect(engineCostModel('openai')).toBe('engine:openai')
  })
})
