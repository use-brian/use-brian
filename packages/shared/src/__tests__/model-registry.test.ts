import { describe, it, expect } from 'vitest'
import {
  MODEL_REGISTRY,
  registryRow,
  registryRowForPricing,
  tierModelIds,
  tierForModelId,
  chatTierDefaults,
  tierCaseExpression,
  tierClassifierExpression,
  modelRates,
  modelContextWindow,
  providerAliasMap,
  recordedAliasIds,
  providerModelIds,
  menuForClass,
  bracketFor,
  effectiveRatePerMTok,
  UNKNOWN_MODEL_RATES,
  type ModelRates,
} from '../model-registry.js'

describe('[COMP:providers/model-registry] registry integrity', () => {
  it('every id (alias / idAliases / priceAliases) belongs to exactly one row', () => {
    // The module throws at import time on collision; assert the invariant
    // directly too so the failure reads as a test, not an import crash.
    const seen = new Set<string>()
    for (const row of MODEL_REGISTRY) {
      for (const id of [row.alias, ...(row.idAliases ?? []), ...(row.priceAliases ?? [])]) {
        expect(seen.has(id), `duplicate id '${id}'`).toBe(false)
        seen.add(id)
      }
    }
  })

  it('each chat tier key is claimed by exactly one row', () => {
    const keys = MODEL_REGISTRY.filter((r) => r.chatTierKey).map((r) => r.chatTierKey)
    expect([...keys].sort()).toEqual(['max', 'pro', 'research', 'standard'])
  })

  it('every active row is priced (legacy rows may be classification-only)', () => {
    for (const row of MODEL_REGISTRY) {
      if (row.status === 'active') {
        expect(row.rates, `active row '${row.alias}' has no rates`).toBeDefined()
      }
    }
  })

  it('chat-tier default rows are active and never legacy', () => {
    for (const row of MODEL_REGISTRY) {
      if (row.chatTierKey) expect(row.status).toBe('active')
    }
  })

  it('rate brackets are ascending and end at Infinity', () => {
    for (const row of MODEL_REGISTRY) {
      if (!row.rates) continue
      const bounds = row.rates.brackets.map((b) => b.upToInputTokens)
      expect(bounds[bounds.length - 1]).toBe(Infinity)
      for (let i = 1; i < bounds.length; i++) expect(bounds[i]!).toBeGreaterThan(bounds[i - 1]!)
    }
  })
})

describe('[COMP:providers/model-registry] derivations match the pre-registry literals', () => {
  // These pin the exact pre-refactor contents of MODEL_MAP and the
  // *_TIER_MODELS sets. If a registry edit changes any of them, that is a
  // deliberate product change, not a refactor — update these with the spec.
  it('chatTierDefaults reproduces MODEL_MAP', () => {
    expect(chatTierDefaults()).toEqual({
      standard: 'gemini-3-flash-standard',
      pro: 'gemini-flash-3',
      max: 'gemini-3.5-flash',
      research: 'gemini-3-pro-research',
    })
  })

  it('tierModelIds reproduces the four tier sets exactly', () => {
    expect([...tierModelIds('standard')].sort()).toEqual([
      'gemini-3-flash-standard',
      'gemini-3.1-flash-lite',
      'gemini-3.1-flash-lite-preview',
      // Wave-1 background-lane candidate (plan §5.1): classifies standard
      // like the flash-lite lane it may replace.
      'qwen3.5-flash',
    ].sort())
    expect([...tierModelIds('pro')].sort()).toEqual([
      'pro', 'gemini-flash-3', 'gemini-3-flash-preview', 'gemini-flash',
    ].sort())
    expect([...tierModelIds('max')].sort()).toEqual([
      'max', 'gemini-3.5-flash', 'gemini-3.1-pro-preview',
    ].sort())
    expect([...tierModelIds('research')].sort()).toEqual([
      'research', 'gemini-3-pro-research',
    ].sort())
    expect([...tierModelIds('embedding')].sort()).toEqual([
      'gemini-embedding-001', 'text-embedding-004', 'text-embedding-005',
      'text-embedding-v3', // DashScope/Qwen embeddings (Google-free deploys)
    ].sort())
  })

  it('price-only aliases classify as other, never as their row tier', () => {
    // gemini-pro rows have always classified 'other'; the embedder's
    // namespaced id likewise. Reclassifying them would reprice history.
    expect(tierForModelId('gemini-pro')).toBe('other')
    expect(tierForModelId('gemini:gemini-embedding-001')).toBe('other')
    expect(registryRow('gemini-pro')).toBeUndefined()
    expect(registryRowForPricing('gemini-pro')?.alias).toBe('gemini-3.1-pro-preview')
  })

  it('tierForModelId keeps the historical Max/research split', () => {
    expect(tierForModelId('gemini-3-pro-research')).toBe('research')
    expect(tierForModelId('gemini-3.1-pro-preview')).toBe('max')
    expect(tierForModelId('gemini-3-flash-standard')).toBe('standard')
    expect(tierForModelId('gemini-flash-3')).toBe('pro')
    expect(tierForModelId('totally-unknown')).toBe('other')
  })

  it('tierClassifierExpression trusts recorded model_tier before the id CASE', () => {
    const sql = tierClassifierExpression('model', 'model_tier')
    expect(sql.startsWith('COALESCE(model_tier,')).toBe(true)
    expect(sql).toContain("ELSE 'other'")
    // Custom column names thread through both halves.
    const aliased = tierClassifierExpression('ut.model', 'ut.model_tier')
    expect(aliased).toContain('COALESCE(ut.model_tier,')
    expect(aliased).toContain('ut.model IN (')
  })

  it('tierCaseExpression covers every tier arm with the same ids', () => {
    const sql = tierCaseExpression('model')
    for (const tier of ['standard', 'pro', 'research', 'max', 'embedding'] as const) {
      expect(sql).toContain(`THEN '${tier}'`)
      for (const id of tierModelIds(tier)) expect(sql).toContain(`'${id}'`)
    }
    expect(sql).toContain("ELSE 'other'")
    expect(sql.startsWith('\n  CASE')).toBe(true)
  })
})

describe('[COMP:providers/model-registry] pricing lookups', () => {
  it('synthetic ids price at their underlying model rates', () => {
    expect(modelRates('gemini-3-flash-standard')).toBe(modelRates('gemini-3-flash-preview'))
    expect(modelRates('gemini-3-pro-research')).toBe(modelRates('gemini-3.1-pro-preview'))
  })

  it('resolved snapshot ids price via apiModelId', () => {
    // The anthropic provider records the dated snapshot; it must price at
    // haiku rates, not the unknown-model fallback.
    expect(modelRates('claude-haiku-4-5-20251001')).toBe(modelRates('claude-haiku-4-5'))
  })

  it('unknown and unpriced ids return undefined (fallback is the caller policy)', () => {
    expect(modelRates('mystery-model')).toBeUndefined()
    expect(modelRates('text-embedding-004')).toBeUndefined()
    expect(UNKNOWN_MODEL_RATES.brackets[0]!.inPerMTok).toBe(0.5)
  })

  it('modelContextWindow resolves known ids and stays silent on unknowns', () => {
    expect(modelContextWindow('gemini-flash-3')).toBe(1_048_576)
    expect(modelContextWindow('claude-haiku-4-5')).toBe(200_000)
    expect(modelContextWindow('mystery-model')).toBeUndefined()
  })
})

describe('[COMP:providers/model-registry] provider derivations', () => {
  it('gemini alias map resolves every synthetic + legacy alias to its wire id', () => {
    const map = providerAliasMap('gemini')
    expect(map['gemini-3-flash-standard']).toBe('gemini-3-flash-preview')
    expect(map['gemini-flash-3']).toBe('gemini-3-flash-preview')
    expect(map['gemini-flash']).toBe('gemini-3-flash-preview')
    expect(map['gemini-3-pro-research']).toBe('gemini-3.1-pro-preview')
    expect(map['gemini-pro']).toBe('gemini-3.1-pro-preview')
    expect(map['gemini-flash-25']).toBe('gemini-2.5-flash')
    expect(map['gemini-3.1-flash-lite-preview']).toBe('gemini-3.1-flash-lite')
    // Ids equal to their wire id never appear.
    expect(map['gemini-3-flash-preview']).toBeUndefined()
    expect(map['gemini-3.5-flash']).toBeUndefined()
  })

  it('anthropic alias map pins the dated snapshot', () => {
    expect(providerAliasMap('anthropic')['claude-haiku-4-5']).toBe('claude-haiku-4-5-20251001')
  })

  it('recordedAliasIds returns exactly the synthetic billing ids', () => {
    expect([...recordedAliasIds('gemini')].sort()).toEqual([
      'gemini-3-flash-standard', 'gemini-3-pro-research',
    ].sort())
    expect(recordedAliasIds('anthropic').size).toBe(0)
  })

  it('providerModelIds lists active callable ids without bare tier keys or embeddings', () => {
    const gemini = providerModelIds('gemini')
    expect(gemini).toContain('gemini-3-flash-standard')
    expect(gemini).toContain('gemini-3.1-flash-lite')
    expect(gemini).not.toContain('pro')
    expect(gemini).not.toContain('max')
    expect(gemini).not.toContain('research')
    expect(gemini).not.toContain('gemini-embedding-001')
    expect(gemini).not.toContain('gemini-2.5-flash') // legacy
    expect(providerModelIds('anthropic')).toEqual(['claude-haiku-4-5'])
  })
})

describe('[COMP:providers/model-registry] wave-1 slate + menus (plan §5.1)', () => {
  it('ports the locked wave-1 slate as metered/background rows, all text-only', () => {
    for (const alias of ['qwen3.7-plus', 'deepseek-v4-flash', 'qwen3.7-max', 'deepseek-v4-pro']) {
      const row = registryRow(alias)!
      expect(row.class).toBe('metered')
      expect(row.tier).toBe('other') // never in CREDIT_PER_TIER counts — the metered ledger bills
      expect(row.capabilities.vision).toBe(false)
      expect(row.provider).toBe('openai-compat:dashscope-intl')
    }
    const background = registryRow('qwen3.5-flash')!
    expect(background.class).toBe('background')
    expect(background.menu).not.toBe(true) // internal lane, never a menu
  })

  it('qwen3.7-max is snapshot-pinned at LIST price, not the promo (L6/L13)', () => {
    const row = registryRow('qwen3.7-max')!
    expect(row.apiModelId).toBe('qwen3.7-max-2026-06-08')
    expect(row.rates!.brackets[0]!.inPerMTok).toBe(5.00) // list, not the $2.50 promo
  })

  it('deepseek-v4-pro prices its cache exclusion honestly (full input rate)', () => {
    const rates = registryRow('deepseek-v4-pro')!.rates!
    expect(rates.cacheReadPerMTok).toBe(rates.brackets[0]!.inPerMTok)
  })

  it('menuForClass lists curated defaults and metered ports, never fallback/background/legacy', () => {
    expect(menuForClass('standard-pro').map((r) => r.alias)).toEqual(['gemini-3-flash-standard', 'gemini-flash-3'])
    expect(menuForClass('max').map((r) => r.alias)).toEqual(['gemini-3.5-flash'])
    expect(menuForClass('research').map((r) => r.alias)).toEqual(['gemini-3-pro-research'])
    expect(menuForClass('metered').map((r) => r.alias).sort()).toEqual(
      ['qwen3.7-plus', 'deepseek-v4-flash', 'qwen3.7-max', 'deepseek-v4-pro'].sort(),
    )
    expect(menuForClass('background')).toEqual([])
  })

  it('keyless providers drop their models from every menu (L12)', () => {
    const geminiOnly = new Set(['gemini'])
    expect(menuForClass('metered', geminiOnly)).toEqual([])
    expect(menuForClass('standard-pro', geminiOnly).map((r) => r.alias))
      .toEqual(['gemini-3-flash-standard', 'gemini-flash-3'])
  })
})

describe('[COMP:providers/model-registry] L6 effective rate', () => {
  const bracketed: ModelRates = {
    brackets: [
      { upToInputTokens: 256_000, inPerMTok: 0.40, outPerMTok: 1.60 },
      { upToInputTokens: Infinity, inPerMTok: 1.20, outPerMTok: 4.80 },
    ],
    thinkingOutPerMTok: 3.20,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 0.40,
  }

  it('bracketFor picks by input size, top bracket above every bound', () => {
    expect(bracketFor(bracketed, 10_000).inPerMTok).toBe(0.40)
    expect(bracketFor(bracketed, 256_000).inPerMTok).toBe(0.40)
    expect(bracketFor(bracketed, 300_000).inPerMTok).toBe(1.20)
  })

  it('blends input, cache-read, output and thinking shares at the bracket rates', () => {
    // 50% cache reads, 30% uncached input, 15% output, 5% thinking, short calls.
    const rate = effectiveRatePerMTok(bracketed, {
      inputShare: 0.30,
      cacheReadShare: 0.50,
      outputShare: 0.15,
      thinkingShare: 0.05,
      typicalInputTokens: 50_000,
    })
    // 0.3*0.40 + 0.5*0.08 + 0.15*1.60 + 0.05*3.20 = 0.12+0.04+0.24+0.16 = 0.56
    expect(rate).toBeCloseTo(0.56, 10)
  })

  it('length brackets change the effective rate — the L6 point', () => {
    const mix = { inputShare: 0.6, cacheReadShare: 0.2, outputShare: 0.2, typicalInputTokens: 400_000 }
    const short = effectiveRatePerMTok(bracketed, { ...mix, typicalInputTokens: 50_000 })
    const long = effectiveRatePerMTok(bracketed, mix)
    expect(long).toBeGreaterThan(short)
  })

  it('thinking output falls back to the bracket output rate when unpriced', () => {
    const noThinking: ModelRates = { ...bracketed, thinkingOutPerMTok: undefined }
    const mix = { inputShare: 0, cacheReadShare: 0, outputShare: 0, thinkingShare: 1, typicalInputTokens: 1 }
    expect(effectiveRatePerMTok(noThinking, mix)).toBe(1.60)
  })

  it('a cache-heavy mix can invert a sticker-price ordering (why L6 exists)', () => {
    // The live counterexample from the plan (§5): deepseek-v4-pro's sticker
    // ($2.40/$4.80) undercuts Pro 3.1 ($2.00/$12.00) on output — but it is
    // EXCLUDED from the cache discount, so a deep agentic loop dominated by
    // cache reads prices it far above the incumbent. Sticker classification
    // would have admitted it; the effective rate rejects it.
    const pro31 = modelRates('gemini-3.1-pro-preview')!
    const cacheExcluded: ModelRates = {
      brackets: [{ upToInputTokens: Infinity, inPerMTok: 2.40, outPerMTok: 4.80 }],
      cacheReadPerMTok: 2.40, // no discount: full input rate (registry convention)
      cacheWritePerMTok: 2.40,
    }
    const agenticMix = { inputShare: 0.10, cacheReadShare: 0.85, outputShare: 0.05, typicalInputTokens: 100_000 }
    expect(effectiveRatePerMTok(pro31, agenticMix))
      .toBeLessThan(effectiveRatePerMTok(cacheExcluded, agenticMix))
    // Sticker ordering says the opposite (output rate alone): the inversion.
    expect(cacheExcluded.brackets[0]!.outPerMTok).toBeLessThan(pro31.brackets[0]!.outPerMTok)
  })
})
