/**
 * Model registry — the single declarative source of truth for model identity.
 *
 * Every list that used to be hand-maintained per model — `MODEL_MAP`, the
 * `*_TIER_MODELS` sets, `tierForModel`, the Postgres tier CASE, cost-tracker
 * pricing, context-window limits, provider alias maps — is DERIVED from the
 * rows below. Adding a model is one row here; no other literal model/tier set
 * may exist outside this module (graded invariant `registry-literal-drift`).
 *
 * Spec: docs/architecture/platform/model-registry.md (authoritative; includes
 * the class-vs-tier distinction and the aliasing semantics). Plan of record:
 * docs/plans/model-registry.md.
 *
 * Vocabulary:
 *   - `class`  — the *intelligence/routing* class (L4/L5 anchored buckets).
 *     Standard and Pro share one class ('standard-pro'): same models, they
 *     differ by tool-round budget and credit weight only.
 *   - `tier`   — the *billing* label a recorded `usage_tracking.model` id
 *     classifies to. One class can serve two tiers (standard-pro), which is
 *     why rows carry both.
 *   - `alias`  — the canonical selector/recording id of the row.
 *   - `idAliases` — other ids that resolve AND classify to this row: legacy
 *     aliases, resolved provider ids, bare tier keys recorded defensively.
 *   - `priceAliases` — ids that price at this row's rates but deliberately do
 *     NOT classify to its tier (they fall through to 'other'), so historical
 *     `usage_tracking` rows never silently reprice/reclassify. The live
 *     examples: `gemini-pro` (pre-tier rows stay 'other') and the embedder's
 *     namespaced `gemini:gemini-embedding-001`.
 */

// ── Types ──────────────────────────────────────────────────────

/** Anchored intelligence/routing class (L4/L5). */
export type ModelClass = 'standard-pro' | 'max' | 'research' | 'background' | 'metered'

/** Billing tier a recorded model id classifies to (`usage_tracking` axis). */
export type ModelTier = 'standard' | 'pro' | 'max' | 'research' | 'embedding' | 'other'

/** Keys of the chat selector map (MODEL_MAP). */
export type ChatTierKey = 'standard' | 'pro' | 'max' | 'research'

/** Provider a row dispatches to. `openai-compat:<label>` names one configured
 * OpenAI-compatible endpoint (e.g. `openai-compat:dashscope-intl`). */
export type ModelProvider = 'gemini' | 'anthropic' | 'xai' | `openai-compat:${string}`

/** One input-length pricing bracket. `upToInputTokens: Infinity` = top bracket. */
export type RateBracket = {
  upToInputTokens: number
  inPerMTok: number
  outPerMTok: number
}

/**
 * List price, never promo (L6). `cacheReadPerMTok` is the effective cache-read
 * rate; vendors with no cache discount record the full input rate. Gemini
 * charges cache *storage* per hour, not a write fee — `cacheWritePerMTok`
 * mirrors input as an approximation (pre-existing cost-tracker convention).
 */
export type ModelRates = {
  brackets: readonly RateBracket[]
  thinkingOutPerMTok?: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
}

export type ModelCapabilities = {
  tools: boolean
  vision: boolean
  thinking: boolean
}

export type ModelRegistryRow = {
  /** Canonical selector/recording id. Unique across alias/idAliases/priceAliases. */
  alias: string
  provider: ModelProvider
  /** The id sent on the wire — a dated snapshot where the vendor offers one (L13). */
  apiModelId: string
  class: ModelClass
  tier: ModelTier
  /** `legacy` rows exist for classification/pricing of historical rows only —
   * they are never callable and never appear in menus. */
  status: 'active' | 'legacy'
  /** Marks this row as the chat selector default: `MODEL_MAP[chatTierKey] = alias`. */
  chatTierKey?: ChatTierKey
  /** Ids that resolve AND classify to this row. */
  idAliases?: readonly string[]
  /** Ids that price at this row's rates but classify as 'other' (see header). */
  priceAliases?: readonly string[]
  /** Record `alias` (not `apiModelId`) in usage tracking — the synthetic
   * billing ids that keep Standard/Research billable-distinct from the tier
   * sharing their underlying model. Retired by the (model, tier) decouple
   * (plan L9); kept for live behavior until that migration lands. */
  recordAlias?: boolean
  /** Absent = unpriced: cost tracking falls back to `UNKNOWN_MODEL_RATES`
   * (pre-existing behavior for ids that never had a pricing row). */
  rates?: ModelRates
  contextWindow: number
  /** Informational until the routing provider consumes it (plan §4.2). */
  maxOutput: number
  capabilities: ModelCapabilities
  /** Per-provider quirk-wrapper stack override (plan L2; consumed by the
   * routing provider, not yet by boot). */
  wrappers?: readonly string[]
  /** Same-class-only outage fallback (plan L2; consumed by the routing provider). */
  fallbackAlias?: string
}

// ── Shared rate blobs (one underlying vendor SKU = one blob) ───

const FLASH3_RATES: ModelRates = {
  brackets: [{ upToInputTokens: Infinity, inPerMTok: 0.50, outPerMTok: 3.00 }],
  cacheReadPerMTok: 0.05,
  cacheWritePerMTok: 0.50,
}

const FLASH35_RATES: ModelRates = {
  brackets: [{ upToInputTokens: Infinity, inPerMTok: 1.50, outPerMTok: 9.00 }],
  cacheReadPerMTok: 0.15,
  cacheWritePerMTok: 1.50,
}

// Google lists $4/$18 above 200K input for Pro 3.1; the single bracket below
// deliberately keeps the pre-registry flat pricing so P1 changes no billing
// math. Bracketed repricing is a deliberate follow-up, not a refactor side
// effect. See model-registry.md → "Pricing fidelity".
const PRO31_RATES: ModelRates = {
  brackets: [{ upToInputTokens: Infinity, inPerMTok: 2.00, outPerMTok: 12.00 }],
  cacheReadPerMTok: 0.20,
  cacheWritePerMTok: 2.00,
}

const FLASH25_RATES: ModelRates = {
  brackets: [{ upToInputTokens: Infinity, inPerMTok: 0.30, outPerMTok: 2.50 }],
  cacheReadPerMTok: 0.03,
  cacheWritePerMTok: 0.30,
}

const FLASH_LITE_RATES: ModelRates = {
  brackets: [{ upToInputTokens: Infinity, inPerMTok: 0.25, outPerMTok: 1.50 }],
  cacheReadPerMTok: 0.025,
  cacheWritePerMTok: 0.25,
}

const FREE_RATES: ModelRates = {
  brackets: [{ upToInputTokens: Infinity, inPerMTok: 0, outPerMTok: 0 }],
  cacheReadPerMTok: 0,
  cacheWritePerMTok: 0,
}

// ── The registry ───────────────────────────────────────────────

export const MODEL_REGISTRY: readonly ModelRegistryRow[] = [
  // ── Chat tiers (Gemini incumbents — every class's default, L10) ──
  {
    // Standard chat tier — Flash 3, the same model as Pro, on a tighter
    // tool-round budget. Synthetic id keeps it billable-distinct from Pro.
    alias: 'gemini-3-flash-standard',
    provider: 'gemini',
    apiModelId: 'gemini-3-flash-preview',
    class: 'standard-pro',
    tier: 'standard',
    status: 'active',
    chatTierKey: 'standard',
    recordAlias: true,
    rates: FLASH3_RATES,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    capabilities: { tools: true, vision: true, thinking: true },
  },
  {
    // Pro tier — Gemini Flash 3. Records its resolved provider id.
    alias: 'gemini-flash-3',
    provider: 'gemini',
    apiModelId: 'gemini-3-flash-preview',
    class: 'standard-pro',
    tier: 'pro',
    status: 'active',
    chatTierKey: 'pro',
    // 'pro' = bare tier key recorded defensively; 'gemini-3-flash-preview' =
    // the resolved provider id actually recorded; 'gemini-flash' = legacy alias.
    idAliases: ['pro', 'gemini-3-flash-preview', 'gemini-flash'],
    rates: FLASH3_RATES,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    capabilities: { tools: true, vision: true, thinking: true },
  },
  {
    // Max tier default — Gemini Flash 3.5 (frontier intelligence at Flash speeds).
    alias: 'gemini-3.5-flash',
    provider: 'gemini',
    apiModelId: 'gemini-3.5-flash',
    class: 'max',
    tier: 'max',
    status: 'active',
    chatTierKey: 'max',
    idAliases: ['max'],
    rates: FLASH35_RATES,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    capabilities: { tools: true, vision: true, thinking: true },
  },
  {
    // Research tier — Pro 3.1 on the deep budget. Synthetic id keeps it
    // billable-distinct from Max and from historical Pro-3.1-as-Max rows.
    alias: 'gemini-3-pro-research',
    provider: 'gemini',
    apiModelId: 'gemini-3.1-pro-preview',
    class: 'research',
    tier: 'research',
    status: 'active',
    chatTierKey: 'research',
    idAliases: ['research'],
    recordAlias: true,
    rates: PRO31_RATES,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    capabilities: { tools: true, vision: true, thinking: true },
  },

  // ── Background lane (internal routing, no menu) ──────────────
  {
    // Extraction/classifier/title workhorse — call sites pin this id directly
    // (deliberate; see cost-and-pricing.md → "Standard-tier routing").
    // Classifies Standard for analytics. The retired preview SKU rides along
    // so pre-2026-05-25 rows classify and price unchanged.
    alias: 'gemini-3.1-flash-lite',
    provider: 'gemini',
    apiModelId: 'gemini-3.1-flash-lite',
    class: 'background',
    tier: 'standard',
    status: 'active',
    idAliases: ['gemini-3.1-flash-lite-preview'],
    rates: FLASH_LITE_RATES,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    capabilities: { tools: true, vision: true, thinking: true },
  },

  // ── Legacy rows (classification/pricing of historical usage only) ──
  {
    // Prior Max default + pre-2026-06-02 research turns (billed as Max).
    // Stays tier 'max' so historical rows never reprice. `gemini-pro` is a
    // priceAlias, NOT an idAlias: rows recorded under it have always
    // classified 'other' and must keep doing so.
    alias: 'gemini-3.1-pro-preview',
    provider: 'gemini',
    apiModelId: 'gemini-3.1-pro-preview',
    class: 'max',
    tier: 'max',
    status: 'legacy',
    priceAliases: ['gemini-pro'],
    rates: PRO31_RATES,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    capabilities: { tools: true, vision: true, thinking: true },
  },
  {
    // Retired chat model (pre-Gemini-3 era). Classifies 'other', priced for
    // historical rows.
    alias: 'gemini-2.5-flash',
    provider: 'gemini',
    apiModelId: 'gemini-2.5-flash',
    class: 'background',
    tier: 'other',
    status: 'legacy',
    idAliases: ['gemini-flash-25'],
    rates: FLASH25_RATES,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    capabilities: { tools: true, vision: true, thinking: true },
  },
  {
    // Legacy Standard tier (superseded by Flash Lite). Always $0 (Google AI
    // Studio free tier) — kept so historical cost math still computes.
    alias: 'gemma-4-26b-a4b-it',
    provider: 'gemini',
    apiModelId: 'gemma-4-26b-a4b-it',
    class: 'background',
    tier: 'other',
    status: 'legacy',
    idAliases: ['gemma-4-26b'],
    rates: FREE_RATES,
    contextWindow: 131_072,
    maxOutput: 8_192,
    capabilities: { tools: false, vision: false, thinking: false },
  },

  // ── Anthropic (outage fallback + deferred) ───────────────────
  {
    // The outage-only fallback model (`FALLBACK_PROVIDER_ENABLED`). The
    // anthropic provider records the resolved snapshot id, so it rides along
    // as a priceAlias-equivalent via apiModelId pricing.
    alias: 'claude-haiku-4-5',
    provider: 'anthropic',
    apiModelId: 'claude-haiku-4-5-20251001',
    class: 'standard-pro',
    tier: 'other',
    status: 'active',
    rates: {
      brackets: [{ upToInputTokens: Infinity, inPerMTok: 1.00, outPerMTok: 5.00 }],
      cacheReadPerMTok: 0.10,
      cacheWritePerMTok: 1.25,
    },
    contextWindow: 200_000,
    maxOutput: 64_000,
    capabilities: { tools: true, vision: true, thinking: true },
  },
  {
    alias: 'claude-sonnet-4-6',
    provider: 'anthropic',
    apiModelId: 'claude-sonnet-4-6',
    class: 'max',
    tier: 'other',
    status: 'legacy',
    rates: {
      brackets: [{ upToInputTokens: Infinity, inPerMTok: 3.00, outPerMTok: 15.00 }],
      cacheReadPerMTok: 0.30,
      cacheWritePerMTok: 3.75,
    },
    contextWindow: 200_000,
    maxOutput: 64_000,
    capabilities: { tools: true, vision: true, thinking: true },
  },
  {
    alias: 'claude-opus-4-6',
    provider: 'anthropic',
    apiModelId: 'claude-opus-4-6',
    class: 'research',
    tier: 'other',
    status: 'legacy',
    rates: {
      brackets: [{ upToInputTokens: Infinity, inPerMTok: 5.00, outPerMTok: 25.00 }],
      cacheReadPerMTok: 0.50,
      cacheWritePerMTok: 6.25,
    },
    contextWindow: 200_000,
    maxOutput: 32_000,
    capabilities: { tools: true, vision: true, thinking: true },
  },

  // ── xAI (special-purpose X-search plumbing, not a chat provider) ──
  {
    alias: 'grok-4-1-fast',
    provider: 'xai',
    apiModelId: 'grok-4-1-fast',
    class: 'background',
    tier: 'other',
    status: 'active',
    rates: {
      // xAI does not charge for cache writes on the Responses API.
      brackets: [{ upToInputTokens: Infinity, inPerMTok: 0.20, outPerMTok: 0.50 }],
      cacheReadPerMTok: 0.05,
      cacheWritePerMTok: 0,
    },
    contextWindow: 2_000_000,
    maxOutput: 8_192,
    capabilities: { tools: false, vision: false, thinking: true },
  },
  {
    alias: 'grok-4-1-fast-non-reasoning',
    provider: 'xai',
    apiModelId: 'grok-4-1-fast-non-reasoning',
    class: 'background',
    tier: 'other',
    status: 'active',
    rates: {
      brackets: [{ upToInputTokens: Infinity, inPerMTok: 0.20, outPerMTok: 0.50 }],
      cacheReadPerMTok: 0.05,
      cacheWritePerMTok: 0,
    },
    contextWindow: 2_000_000,
    maxOutput: 8_192,
    capabilities: { tools: false, vision: false, thinking: false },
  },

  // ── Embeddings (own cost class; the models themselves are out of scope
  //    here — changing them invalidates the brain vector store, L11) ──
  {
    // Input-only pricing; the batch response carries no usage metadata, so
    // callers record the ~4-chars/token estimate as inputTokens. The
    // embedder's namespaced model_id prices here but classifies 'other'
    // (pre-existing behavior — those rows are overhead-excluded anyway).
    alias: 'gemini-embedding-001',
    provider: 'gemini',
    apiModelId: 'gemini-embedding-001',
    class: 'background',
    tier: 'embedding',
    status: 'active',
    priceAliases: ['gemini:gemini-embedding-001'],
    rates: {
      brackets: [{ upToInputTokens: Infinity, inPerMTok: 0.025, outPerMTok: 0 }],
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 0,
    },
    contextWindow: 2_048,
    maxOutput: 0,
    capabilities: { tools: false, vision: false, thinking: false },
  },
  {
    // Retired embedding endpoints — classification only, deliberately
    // unpriced (historical cost math used the unknown-model fallback).
    alias: 'text-embedding-004',
    provider: 'gemini',
    apiModelId: 'text-embedding-004',
    class: 'background',
    tier: 'embedding',
    status: 'legacy',
    contextWindow: 2_048,
    maxOutput: 0,
    capabilities: { tools: false, vision: false, thinking: false },
  },
  {
    alias: 'text-embedding-005',
    provider: 'gemini',
    apiModelId: 'text-embedding-005',
    class: 'background',
    tier: 'embedding',
    status: 'legacy',
    contextWindow: 2_048,
    maxOutput: 0,
    capabilities: { tools: false, vision: false, thinking: false },
  },
]

// ── Index maps (built once; loud failure on identity collisions) ──

const byClassifierId = new Map<string, ModelRegistryRow>()
const byPricingId = new Map<string, ModelRegistryRow>()

function registerId(map: Map<string, ModelRegistryRow>, id: string, row: ModelRegistryRow): void {
  const existing = map.get(id)
  if (existing && existing !== row) {
    throw new Error(
      `model-registry: id '${id}' claimed by both '${existing.alias}' and '${row.alias}' — every id must belong to exactly one row`,
    )
  }
  map.set(id, row)
}

for (const row of MODEL_REGISTRY) {
  registerId(byClassifierId, row.alias, row)
  for (const id of row.idAliases ?? []) registerId(byClassifierId, id, row)
  registerId(byPricingId, row.alias, row)
  for (const id of row.idAliases ?? []) registerId(byPricingId, id, row)
  for (const id of row.priceAliases ?? []) registerId(byPricingId, id, row)
}

// apiModelId also prices (an outage-fallback turn records the resolved
// snapshot id, e.g. `claude-haiku-4-5-20251001`). Rows sharing an apiModelId
// share a rate blob by construction; first row wins, and it never overrides
// an id already claimed as an alias.
for (const row of MODEL_REGISTRY) {
  if (!byPricingId.has(row.apiModelId)) byPricingId.set(row.apiModelId, row)
}

// ── Lookups ────────────────────────────────────────────────────

/** Row a selector/recorded id classifies to (alias + idAliases). */
export function registryRow(id: string): ModelRegistryRow | undefined {
  return byClassifierId.get(id)
}

/** Row an id prices at (alias + idAliases + priceAliases + apiModelId). */
export function registryRowForPricing(id: string): ModelRegistryRow | undefined {
  return byPricingId.get(id)
}

/** Every id (alias + idAliases) classifying to the given billing tier, in
 * registry order. This IS the derivation of the old `*_TIER_MODELS` sets. */
export function tierModelIds(tier: ModelTier): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const row of MODEL_REGISTRY) {
    if (row.tier !== tier) continue
    ids.add(row.alias)
    for (const id of row.idAliases ?? []) ids.add(id)
  }
  return ids
}

/** Billing tier for a recorded model id — 'other' when unknown, so drift
 * surfaces on dashboards instead of being silently swallowed. */
export function tierForModelId(id: string): ModelTier {
  return byClassifierId.get(id)?.tier ?? 'other'
}

/** The chat selector defaults (`MODEL_MAP`): chat tier key → row alias. */
export function chatTierDefaults(): Record<ChatTierKey, string> {
  const map = {} as Record<ChatTierKey, string>
  for (const row of MODEL_REGISTRY) {
    if (row.chatTierKey) map[row.chatTierKey] = row.alias
  }
  return map
}

/**
 * Postgres CASE expression classifying a `model` column into the same tier
 * labels as `tierForModelId()` — keeps the JS/SQL classifiers symmetric so
 * dashboards never disagree. Arm order matches the historical classifier
 * (standard, pro, research, max, embedding).
 */
export function tierCaseExpression(column = 'model'): string {
  const arm = (tier: ModelTier) => Array.from(tierModelIds(tier)).join("','")
  return `
  CASE
    WHEN ${column} IN ('${arm('standard')}') THEN 'standard'
    WHEN ${column} IN ('${arm('pro')}')      THEN 'pro'
    WHEN ${column} IN ('${arm('research')}') THEN 'research'
    WHEN ${column} IN ('${arm('max')}')      THEN 'max'
    WHEN ${column} IN ('${arm('embedding')}')     THEN 'embedding'
    ELSE 'other'
  END
`
}

/** List rates for cost tracking; undefined for unknown/unpriced ids. */
export function modelRates(id: string): ModelRates | undefined {
  return byPricingId.get(id)?.rates
}

/** First bracket the given input size fits under; the top bracket otherwise.
 * Single-bracket models (everything Gemini today) hit index 0 unconditionally. */
export function bracketFor(rates: ModelRates, inputTokens: number): RateBracket {
  for (const b of rates.brackets) {
    if (inputTokens <= b.upToInputTokens) return b
  }
  return rates.brackets[rates.brackets.length - 1]!
}

/**
 * A measured per-tier token mix (from `usage_tracking`): what fraction of a
 * tier's blended token volume is uncached input, cache reads, plain output,
 * and thinking output. Shares must sum to 1; `typicalInputTokens` selects the
 * length bracket a typical call of this tier lands in.
 */
export type TokenMix = {
  inputShare: number
  cacheReadShare: number
  outputShare: number
  thinkingShare?: number
  typicalInputTokens: number
}

/**
 * The L6 "effective rate": one honest USD-per-Mtok number for a model at a
 * tier's measured mix — blended across input/cache/output shares,
 * length-bracket-aware, thinking-mode-aware, computed from LIST rates (the
 * registry never stores promo pricing). This is the number the frozen bucket
 * anchors compare against (graded invariant `bucket-anchor-fit`); sticker
 * price classification is forbidden because cache terms and brackets flip
 * real orderings — see docs/plans/model-registry.md §5 for two live
 * counterexamples.
 */
export function effectiveRatePerMTok(rates: ModelRates, mix: TokenMix): number {
  const bracket = bracketFor(rates, mix.typicalInputTokens)
  const thinkingRate = rates.thinkingOutPerMTok ?? bracket.outPerMTok
  return (
    mix.inputShare * bracket.inPerMTok +
    mix.cacheReadShare * rates.cacheReadPerMTok +
    mix.outputShare * bracket.outPerMTok +
    (mix.thinkingShare ?? 0) * thinkingRate
  )
}

/** Pre-registry behavior, preserved: an unknown model prices at Flash 3
 * rates rather than $0, so drift shows up as nonzero cost. */
export const UNKNOWN_MODEL_RATES: ModelRates = FLASH3_RATES

/** Input-token window for a known id; undefined for unknown ids (callers
 * apply their own substring fallback — see core's `resolveInputTokenLimit`). */
export function modelContextWindow(id: string): number | undefined {
  return byPricingId.get(id)?.contextWindow
}

/** Alias → wire id map for one provider (every registered id whose string
 * differs from the row's `apiModelId`). Replaces the per-provider
 * `MODEL_ALIASES` literals. */
export function providerAliasMap(provider: ModelProvider): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [id, row] of byPricingId) {
    if (row.provider !== provider) continue
    if (id !== row.apiModelId) map[id] = row.apiModelId
  }
  return map
}

/** Ids the provider must RECORD as-is (not as their resolved apiModelId) —
 * the synthetic billing ids. Replaces gemini's `SYNTHETIC_TIER_IDS`. */
export function recordedAliasIds(provider: ModelProvider): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const row of MODEL_REGISTRY) {
    if (row.provider === provider && row.recordAlias) ids.add(row.alias)
  }
  return ids
}

const CHAT_TIER_KEYS: ReadonlySet<string> = new Set(['standard', 'pro', 'max', 'research'])

/** Callable ids for a provider's `models` listing: active, non-embedding
 * rows' alias + idAliases, minus the bare chat tier keys (those belong to
 * the resolver, not the provider). */
export function providerModelIds(provider: ModelProvider): readonly string[] {
  const ids: string[] = []
  for (const row of MODEL_REGISTRY) {
    if (row.provider !== provider || row.status !== 'active' || row.tier === 'embedding') continue
    for (const id of [row.alias, ...(row.idAliases ?? [])]) {
      if (!CHAT_TIER_KEYS.has(id)) ids.push(id)
    }
  }
  return ids
}
