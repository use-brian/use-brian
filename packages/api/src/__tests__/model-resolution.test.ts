import { describe, it, expect } from 'vitest'
import {
  MODEL_MAP,
  STANDARD_TIER_MODELS,
  RESEARCH_TIER_MODELS,
  isStandardTier,
  isResearchTier,
  isMaxTier,
  tierForModel,
  defaultTierForPlan,
  resolveModel,
  wouldBudgetDowngradeAffectModel,
  chatTierBudget,
  ensureServableModel,
  backgroundModelFor,
  BACKGROUND_MODEL,
  backgroundLatencyBudgetMs,
} from '../model-resolution.js'

// Research became its own billing tier on 2026-06-02 (10 credits, above Max's
// 6). It runs Gemini Pro 3.1 but records the synthetic `gemini-3-pro-research`
// id so it stays distinct from Max — and from historical Pro-3.1-as-Max rows,
// which keep the bare `gemini-3.1-pro-preview` id and stay Max.
const RESEARCH = 'gemini-3-pro-research'

// Standard chat tier moved from Flash Lite to Flash 3 on 2026-06-02. It runs
// the same model as Pro but on a tighter tool-round budget, and carries the
// synthetic id `gemini-3-flash-standard` so it stays billable-distinct from
// Pro. Flash Lite stays the background/extraction workhorse and is still
// classified as Standard tier for analytics.
const STANDARD = 'gemini-3-flash-standard'

describe('[COMP:api/model-resolution] MODEL_MAP', () => {
  it('points the Standard chat tier at the synthetic Flash 3 id', () => {
    expect(MODEL_MAP.standard).toBe(STANDARD)
  })

  it('points Pro at the explicit Gemini Flash 3 alias', () => {
    expect(MODEL_MAP.pro).toBe('gemini-flash-3')
  })

  it('points Max at the Gemini 3.5 Flash provider id (default Max model)', () => {
    expect(MODEL_MAP.max).toBe('gemini-3.5-flash')
  })

  it('points the research alias at the synthetic Pro 3.1 research id', () => {
    // Research mode bypasses the session tier and forces Pro 3.1 (deep web
    // synthesis is reasoning-bound, where Pro 3.1 leads). The synthetic id
    // keeps research billable-distinct from Max + historical rows.
    expect(MODEL_MAP.research).toBe(RESEARCH)
  })
})

describe('[COMP:api/model-resolution] isResearchTier / tierForModel', () => {
  it('classifies the synthetic research id as the research tier', () => {
    expect(isResearchTier(RESEARCH)).toBe(true)
    expect(tierForModel(RESEARCH)).toBe('research')
    expect(RESEARCH_TIER_MODELS.has(RESEARCH)).toBe(true)
  })

  it('keeps bare gemini-3.1-pro-preview as Max (historical rows do not reprice)', () => {
    // Pre-2026-06-02 research + the prior Max default both recorded this id and
    // billed as Max — they must stay Max, not retroactively become research.
    expect(isResearchTier('gemini-3.1-pro-preview')).toBe(false)
    expect(isMaxTier('gemini-3.1-pro-preview')).toBe(true)
    expect(tierForModel('gemini-3.1-pro-preview')).toBe('max')
  })

  it('classifies the standard / pro / max ids to their tiers', () => {
    expect(tierForModel('gemini-3-flash-standard')).toBe('standard')
    expect(tierForModel('gemini-flash-3')).toBe('pro')
    expect(tierForModel('gemini-3.5-flash')).toBe('max')
  })
})

describe('[COMP:api/model-resolution] isStandardTier', () => {
  it('recognises the synthetic Flash 3 chat-tier id', () => {
    expect(isStandardTier(STANDARD)).toBe(true)
  })

  it('still recognises Flash Lite (background workhorse) + its retired preview SKU', () => {
    expect(isStandardTier('gemini-3.1-flash-lite')).toBe(true)
    expect(isStandardTier('gemini-3.1-flash-lite-preview')).toBe(true)
  })

  it('does not classify the Pro Flash 3 aliases as Standard', () => {
    // Pro shares the underlying model but records its own resolved id, so the
    // billing/tier split survives.
    expect(isStandardTier('gemini-flash')).toBe(false)
    expect(isStandardTier('gemini-flash-3')).toBe(false)
    expect(isStandardTier('gemini-3-flash-preview')).toBe(false)
  })

  it('does not classify Pro or Max as Standard', () => {
    expect(isStandardTier('gemini-pro')).toBe(false)
    expect(isStandardTier('gemini-3.1-pro-preview')).toBe(false)
  })

  it('STANDARD_TIER_MODELS exposes the same set', () => {
    expect(STANDARD_TIER_MODELS.has(STANDARD)).toBe(true)
    expect(STANDARD_TIER_MODELS.has('gemini-3.1-flash-lite')).toBe(true)
    expect(STANDARD_TIER_MODELS.has('gemini-3.1-flash-lite-preview')).toBe(true)
    expect(STANDARD_TIER_MODELS.has('gemini-flash')).toBe(false)
    expect(STANDARD_TIER_MODELS.has('gemini-3-flash-preview')).toBe(false)
    expect(STANDARD_TIER_MODELS.has('gemini-pro')).toBe(false)
  })
})

describe('[COMP:api/model-resolution] defaultTierForPlan', () => {
  it('defaults free / unknown plans to Standard', () => {
    expect(defaultTierForPlan('free')).toBe('standard')
    expect(defaultTierForPlan('mystery-plan')).toBe('standard')
  })

  it('defaults every paid plan to Pro', () => {
    // "Default chat is Pro, not Max" — even Max plans start on Pro until the
    // user opts up per session. See cost-and-pricing.md → "Model routing".
    expect(defaultTierForPlan('pro')).toBe('pro')
    expect(defaultTierForPlan('max_5x')).toBe('pro')
    expect(defaultTierForPlan('max_10x')).toBe('pro')
    expect(defaultTierForPlan('enterprise')).toBe('pro')
  })
})

describe('[COMP:api/model-resolution] resolveModel', () => {
  it('falls back to the plan default tier when no alias is requested', () => {
    // Free → Standard; paid → Pro (the spec default). A Max plan with no
    // explicit request still resolves to Pro, not Max.
    expect(resolveModel(undefined, 'free')).toBe(STANDARD)
    expect(resolveModel(undefined, 'pro')).toBe('gemini-flash-3')
    expect(resolveModel(undefined, 'max_5x')).toBe('gemini-flash-3')
    expect(resolveModel(undefined, 'enterprise')).toBe('gemini-flash-3')
  })

  it('honours an explicit Standard request on a paid plan', () => {
    // The plan default is Pro, but a user who deliberately picks Standard
    // (e.g. to conserve credits) keeps it — the cheaper, tighter-budget tier.
    expect(resolveModel('standard', 'pro')).toBe(STANDARD)
  })

  it('downgrades unauthorized aliases to Standard', () => {
    // Free plan can only use 'standard'
    expect(resolveModel('pro', 'free')).toBe(STANDARD)
    expect(resolveModel('max', 'free')).toBe(STANDARD)
  })

  it('forces Standard when the budget is downgraded, regardless of alias', () => {
    expect(resolveModel('pro', 'pro', 'downgraded')).toBe(STANDARD)
    expect(resolveModel('max', 'max_5x', 'downgraded')).toBe(STANDARD)
  })

  it('routes Pro plans to the Gemini Flash 3 alias', () => {
    expect(resolveModel('pro', 'pro', 'ok')).toBe('gemini-flash-3')
  })

  it('routes Max requests to the Gemini 3.5 Flash provider id', () => {
    expect(resolveModel('max', 'max_5x', 'ok')).toBe('gemini-3.5-flash')
    expect(resolveModel('max', 'max_10x', 'ok')).toBe('gemini-3.5-flash')
    expect(resolveModel('max', 'enterprise', 'ok')).toBe('gemini-3.5-flash')
  })

  it('routes research-alias requests to the synthetic Pro 3.1 research id', () => {
    // The chat route hands the resolver `('research', 'max_5x', ...)` when
    // the request carries `mode: 'research'`, bypassing the session tier.
    expect(resolveModel('research', 'max_5x', 'ok')).toBe(RESEARCH)
    expect(resolveModel('research', 'max_10x', 'ok')).toBe(RESEARCH)
    expect(resolveModel('research', 'enterprise', 'ok')).toBe(RESEARCH)
  })

  it('forces Standard when budget is downgraded, even for research-alias requests', () => {
    expect(resolveModel('research', 'max_5x', 'downgraded')).toBe(STANDARD)
  })

  it('downgrades Max requests on plans that cannot use it to Standard', () => {
    // resolveModel returns 'standard' (not the plan's highest tier) when the
    // requested alias is unauthorized — see the unconditional fallback.
    expect(resolveModel('max', 'pro', 'ok')).toBe(STANDARD)
    expect(resolveModel('max', 'free', 'ok')).toBe(STANDARD)
  })

  it('downgrades research-alias requests on non-Max plans to Standard', () => {
    // Same gating as 'max' — research is only available on Max plans. The
    // chat route's quota check (free-trial research uses) is a separate
    // path; the resolver itself still treats 'research' as a Max-only alias.
    expect(resolveModel('research', 'pro', 'ok')).toBe(STANDARD)
    expect(resolveModel('research', 'free', 'ok')).toBe(STANDARD)
  })
})

describe('[COMP:api/model-resolution] wouldBudgetDowngradeAffectModel', () => {
  it('returns false when the user is already on Standard', () => {
    expect(wouldBudgetDowngradeAffectModel(undefined, 'free')).toBe(false)
    expect(wouldBudgetDowngradeAffectModel('standard', 'pro')).toBe(false)
  })

  it('returns true when the user requested a tier above Standard', () => {
    expect(wouldBudgetDowngradeAffectModel('pro', 'pro')).toBe(true)
    expect(wouldBudgetDowngradeAffectModel('max', 'max_5x')).toBe(true)
  })

  it('returns true on a paid plan with no explicit request — the default is Pro', () => {
    // Paid plans now default to Pro, so a budget downgrade to Standard is a
    // visible change even before the user touches the tier selector.
    expect(wouldBudgetDowngradeAffectModel(undefined, 'pro')).toBe(true)
    expect(wouldBudgetDowngradeAffectModel(undefined, 'max_5x')).toBe(true)
  })
})

describe('[COMP:api/model-resolution] chatTierBudget', () => {
  it('caps the Standard tier at the tighter 10 / 8 budget', () => {
    // Standard runs the same Flash 3 model as Pro; the tighter budget is the
    // differentiator (and the margin lever at its 1-credit price).
    expect(chatTierBudget({ model: STANDARD, researchMode: false }))
      .toEqual({ maxTurns: 10, maxToolCalls: 8 })
    // Flash Lite (background workhorse) classifies Standard too.
    expect(chatTierBudget({ model: 'gemini-3.1-flash-lite', researchMode: false }))
      .toEqual({ maxTurns: 10, maxToolCalls: 8 })
  })

  it('lifts the budget to 20/20 for Pro tier', () => {
    expect(chatTierBudget({ model: 'gemini-flash-3', researchMode: false }))
      .toEqual({ maxTurns: 20, maxToolCalls: 20 })
    expect(chatTierBudget({ model: 'gemini-3-flash-preview', researchMode: false }))
      .toEqual({ maxTurns: 20, maxToolCalls: 20 })
  })

  it('lifts the budget to 100/100 for Max tier', () => {
    // Doubled 2026-06-11 (50→100): Max is now the deep-agentic premium tier,
    // repriced to 10 credits with caps cut 1/10. See cost-and-pricing.md.
    expect(chatTierBudget({ model: 'gemini-3.5-flash', researchMode: false }))
      .toEqual({ maxTurns: 100, maxToolCalls: 100 })
  })

  it('lifts the budget to 200/200 for research mode regardless of resolved tier', () => {
    // Doubled 2026-06-11 (100→200) alongside Max; Research is the 20-credit tier.
    expect(chatTierBudget({ model: 'gemini-3.1-pro-preview', researchMode: true }))
      .toEqual({ maxTurns: 200, maxToolCalls: 200 })
    // research mode preserves the high budget even when the model gets
    // downgraded (chat keeps researchMode true through budget downgrade).
    expect(chatTierBudget({ model: STANDARD, researchMode: true }))
      .toEqual({ maxTurns: 200, maxToolCalls: 200 })
  })

  it('returns null for unknown models — queryLoop defaults stand', () => {
    expect(chatTierBudget({ model: 'unknown-model-id', researchMode: false })).toBeNull()
  })
})

describe('[COMP:api/model-resolution] ensureServableModel — default falls to a configured provider', () => {
  const GEMINI = new Set(['gemini'])
  const QWEN = new Set(['openai-compat:dashscope-intl'])
  const BOTH = new Set(['gemini', 'openai-compat:dashscope-intl'])

  it('keeps the model when its provider is configured', () => {
    expect(ensureServableModel('gemini-3-flash-standard', GEMINI)).toBe('gemini-3-flash-standard')
    expect(ensureServableModel('gemini-3-flash-standard', BOTH)).toBe('gemini-3-flash-standard')
  })

  it('substitutes a configured Qwen model when the Gemini default has no provider', () => {
    // The whole point: a Qwen-only deploy resolves the Gemini tier default,
    // whose provider is absent — swap it for a configured, menu-listed model
    // rather than throwing "not configured" in the router.
    const out = ensureServableModel('gemini-3-flash-standard', QWEN)
    expect(out).not.toBe('gemini-3-flash-standard')
    expect(out.startsWith('qwen') || out.startsWith('deepseek')).toBe(true)
  })

  it('is a no-op when nothing is configured (routing then fails loudly)', () => {
    expect(ensureServableModel('gemini-3-flash-standard', new Set())).toBe('gemini-3-flash-standard')
  })

  it('leaves an already-Qwen pick untouched on a Qwen deploy', () => {
    expect(ensureServableModel('qwen3.7-plus', QWEN)).toBe('qwen3.7-plus')
  })

  // Background lanes (auto-title, topic/research classifiers, session-state
  // diff) are internal routing and never menu-flagged, so the menu-scoped
  // lookup can't see them. Before this, a Qwen-only deploy fell through to a
  // metered CHAT model — a 32-token title billed at chat rates — or, at the
  // call sites that never resolved at all, hard-failed every turn with
  // "[routing] model 'gemini-3.1-flash-lite' ... is not configured".
  it('substitutes the Qwen BACKGROUND model, not a metered chat model', () => {
    expect(ensureServableModel('gemini-3.1-flash-lite', QWEN)).toBe('qwen3.5-flash')
  })

  it('keeps the Gemini background model when Gemini is configured', () => {
    expect(ensureServableModel('gemini-3.1-flash-lite', GEMINI)).toBe('gemini-3.1-flash-lite')
    expect(ensureServableModel('gemini-3.1-flash-lite', BOTH)).toBe('gemini-3.1-flash-lite')
  })

  it('is a no-op for a background model when nothing is configured', () => {
    expect(ensureServableModel('gemini-3.1-flash-lite', new Set())).toBe('gemini-3.1-flash-lite')
  })
})

// The auto-title budget silently assumed a sub-second Gemini Flash Lite.
// Measured 2026-07-21 on a title-shaped call: qwen3.5-flash took 4.3s/9.6s/4.3s
// against the old flat 10s ceiling, so a Qwen-only deploy dropped the in-stream
// title_update on most turns (the title itself still landed in DB).
describe('[COMP:api/model-resolution] backgroundLatencyBudgetMs — budget follows the serving provider', () => {
  it('gives the Gemini background lane the tight budget', () => {
    expect(backgroundLatencyBudgetMs('gemini-3.1-flash-lite')).toBe(10_000)
  })

  it('gives an OpenAI-compatible (DashScope) model a wider budget', () => {
    expect(backgroundLatencyBudgetMs('qwen3.5-flash')).toBeGreaterThan(
      backgroundLatencyBudgetMs('gemini-3.1-flash-lite'),
    )
  })

  it('covers the whole openai-compat family, not one label', () => {
    // A new `openai-compat:<label>` row must inherit the slower budget rather
    // than silently regressing to the Gemini assumption.
    for (const alias of ['qwen3.5-flash', 'qwen3.7-plus', 'deepseek-v4-pro']) {
      expect(backgroundLatencyBudgetMs(alias)).toBe(25_000)
    }
  })

  it('falls back to the tight budget for an unknown id', () => {
    expect(backgroundLatencyBudgetMs('not-a-real-model')).toBe(10_000)
  })
})

describe('[COMP:api/model-resolution] backgroundModelFor — the lane seam boot injects', () => {
  const GEMINI = new Set(['gemini'])
  const QWEN = new Set(['openai-compat:dashscope-intl'])

  it('resolves the Gemini workhorse when Gemini is configured', () => {
    expect(backgroundModelFor(GEMINI)).toBe(BACKGROUND_MODEL)
  })

  it('resolves the Qwen background model on a Google-free deploy', () => {
    // The lane is hardcoded at ~17 call sites; this is the single seam that
    // keeps them alive when the routing provider has no Gemini entry.
    expect(backgroundModelFor(QWEN)).toBe('qwen3.5-flash')
  })

  it('falls back to the literal when the caller has no boot context', () => {
    // Leaf modules and tests call the lanes without a provider table; they
    // must behave exactly as they did before the injection existed.
    expect(backgroundModelFor(undefined)).toBe(BACKGROUND_MODEL)
  })

  it('is a no-op when nothing is configured, so routing still fails loudly', () => {
    expect(backgroundModelFor(new Set())).toBe(BACKGROUND_MODEL)
  })
})
