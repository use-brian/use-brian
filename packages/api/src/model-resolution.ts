/**
 * Shared model alias → actual model resolution.
 *
 * Used by the web chat route, Slack route, and Telegram route.
 * See docs/architecture/platform/cost-and-pricing.md for tier definitions.
 *
 * Every model-identity table here is DERIVED from the declarative registry
 * (`@use-brian/shared/model-registry` — spec:
 * docs/architecture/platform/model-registry.md) and re-exported under the
 * pre-registry names so call sites don't churn. Policy that is not model
 * identity — plan gating, budgets, sandbox leg routing — still lives here.
 */

import {
  chatTierDefaults,
  tierModelIds,
  tierForModelId,
  tierCaseExpression,
  type ModelTier,
} from '@use-brian/shared/model-registry'

/**
 * Model alias mapping for the selector — the registry rows flagged with a
 * `chatTierKey`. Standard runs Flash 3 (the same model as Pro) under a
 * synthetic id and a tighter budget; Research runs Pro 3.1 under a synthetic
 * id on the deep budget. See the registry rows for the full provenance notes.
 */
export const MODEL_MAP: Record<string, string> = chatTierDefaults()

/**
 * Aliases (and resolved provider ids) that count as the "Standard"
 * intelligence tier: the synthetic chat id + the Flash Lite background
 * workhorse (+ its retired preview SKU, so historical rows keep classifying).
 * Derived from registry rows with `tier: 'standard'`.
 */
export const STANDARD_TIER_MODELS: ReadonlySet<string> = tierModelIds('standard')

/** Whether the given alias / provider id maps to the Standard intelligence tier. */
export function isStandardTier(model: string): boolean {
  return STANDARD_TIER_MODELS.has(model)
}

/**
 * Aliases (and resolved provider ids) for the Pro tier — Gemini Flash 3.
 * Derived from registry rows with `tier: 'pro'`.
 */
export const PRO_TIER_MODELS: ReadonlySet<string> = tierModelIds('pro')

/**
 * Aliases (and resolved provider ids) for the Max tier — Gemini Flash 3.5,
 * plus the bare `gemini-3.1-pro-preview` legacy row (prior Max default +
 * pre-2026-06-02 research turns billed as Max — historical rows never
 * reprice). Derived from registry rows with `tier: 'max'`.
 */
export const MAX_TIER_MODELS: ReadonlySet<string> = tierModelIds('max')

/**
 * Aliases for the Research tier — Pro 3.1 on the deep (100/100) budget under
 * the synthetic `gemini-3-pro-research` id. Derived from registry rows with
 * `tier: 'research'`.
 */
export const RESEARCH_TIER_MODELS: ReadonlySet<string> = tierModelIds('research')

/** Whether the model maps to the Pro intelligence tier. */
export function isProTier(model: string): boolean {
  return PRO_TIER_MODELS.has(model)
}

/** Whether the model maps to the Max intelligence tier. */
export function isMaxTier(model: string): boolean {
  return MAX_TIER_MODELS.has(model)
}

/** Whether the model maps to the Research intelligence tier (Pro 3.1, deep budget). */
export function isResearchTier(model: string): boolean {
  return RESEARCH_TIER_MODELS.has(model)
}

/**
 * Embedding model identifiers (used by Pipeline B / brain-mcp / retrieval).
 * Embeddings live on their own provider rate ladder and never feed back
 * into Standard / Pro / Max — they're a separate cost class on the
 * admin dashboard. Derived from registry rows with `tier: 'embedding'`.
 */
export const EMBEDDING_MODELS: ReadonlySet<string> = tierModelIds('embedding')

/** Whether the model is one of the known embedding endpoints. */
export function isEmbeddingModel(model: string): boolean {
  return EMBEDDING_MODELS.has(model)
}

/**
 * Map `usage_tracking.model` → cost-and-pricing tier label.
 *
 * Returns one of: `standard` | `pro` | `max` | `research` | `embedding` |
 * `other`. The `other` bucket exists because `usage_tracking.model` may
 * contain legacy or per-call provider ids that aren't covered by any
 * registry row — instead of silently swallowing those rows the cost surface
 * surfaces them so we can spot drift.
 */
export type ModelTierLabel = ModelTier

export function tierForModel(model: string): ModelTierLabel {
  return tierForModelId(model)
}

/**
 * Postgres CASE expression that classifies a `model` column into the
 * same tier labels as `tierForModel()`. Inline this into SQL whenever
 * the admin store needs to GROUP BY tier — keeps the JS/SQL classifiers
 * symmetric so dashboards never disagree about which tier a row falls
 * into.
 */
export const MODEL_TIER_SQL_CASE = tierCaseExpression('model')

/**
 * Models each plan tier is allowed to use (plan = `workspaces.plan`).
 * Free → Standard only. Paid tiers → Standard + Pro + Max.
 * The backend silently downgrades unauthorized requests to the best
 * model the plan allows (no error — matches the "downgrade" spec).
 *
 * These are chat TIER KEYS (MODEL_MAP keys), not model ids — plan policy,
 * deliberately not a registry derivation.
 */
export const PLAN_ALLOWED_MODELS: Record<string, Set<string>> = {
  free:       new Set(['standard']),
  pro:        new Set(['standard', 'pro']),
  max_5x:     new Set(['standard', 'pro', 'max', 'research']),
  max_10x:    new Set(['standard', 'pro', 'max', 'research']),
  enterprise: new Set(['standard', 'pro', 'max', 'research']),
}

/**
 * The default tier alias for a billing plan when no tier is explicitly
 * requested. Paid plans default to **Pro** (per the cost-and-pricing spec —
 * "Default chat is Pro, not Max"); free / unknown plans default to Standard.
 *
 * Derived from `PLAN_ALLOWED_MODELS` rather than hard-coded so it stays
 * correct if a plan's tier access changes: any plan that may use Pro defaults
 * to Pro, everything else to Standard. This is the per-plan resolver default;
 * the per-workspace `minimum_tier` override (migration 151) is a separate,
 * not-yet-wired follow-up — see `docs/architecture/platform/cost-and-pricing.md`
 * → "Model routing".
 */
export function defaultTierForPlan(plan: string): string {
  const allowed = PLAN_ALLOWED_MODELS[plan] ?? PLAN_ALLOWED_MODELS.free
  return allowed.has('pro') ? 'pro' : 'standard'
}

/**
 * Resolve the model alias, enforcing plan restrictions AND budget status.
 *
 * Priority order:
 *   1. If the user's rolling budget is exhausted, force 'standard'
 *      regardless of the requested alias.
 *   2. Otherwise, when no alias is requested, fall back to the plan's default
 *      tier (`defaultTierForPlan` — Pro for paid plans, Standard for free).
 *   3. Downgrade to the best alias the user's plan allows.
 */
export function resolveModel(
  requestedModel: string | undefined,
  plan: string,
  budgetStatus: 'ok' | 'downgraded' | 'blocked' = 'ok',
): string {
  if (budgetStatus === 'downgraded') {
    return MODEL_MAP.standard
  }
  const alias = requestedModel ?? defaultTierForPlan(plan)
  const allowed = PLAN_ALLOWED_MODELS[plan] ?? PLAN_ALLOWED_MODELS.free
  const effectiveAlias = allowed.has(alias) ? alias : 'standard'
  return MODEL_MAP[effectiveAlias] ?? MODEL_MAP.standard
}

/**
 * Whether a budget downgrade would actually change the model the user sees.
 * Returns false when the user is already on Standard (free plan, or the
 * assistant's alias resolves to Standard) — in that case the downgrade is
 * a no-op and showing "Running on the standard model — usage limit
 * reached" would be misleading noise.
 */
export function wouldBudgetDowngradeAffectModel(
  requestedModel: string | undefined,
  plan: string,
): boolean {
  return !isStandardTier(resolveModel(requestedModel, plan, 'ok'))
}

/**
 * Per-turn `queryLoop` ceilings the chat route applies based on the
 * resolved intelligence tier. Higher tiers earn more headroom for
 * multi-step reasoning; research mode lifts the ceiling further so deep
 * web synthesis can run across many sources before the loop forces
 * synthesis. See `docs/architecture/engine/query-loop.md` → "Chat-tier
 * budget".
 */
export type ChatTierBudget = {
  maxTurns: number
  maxToolCalls: number
}

/**
 * Resolve the per-turn budget for a chat invocation. Returns `null` only for
 * an unrecognised model, in which case `queryLoop`'s defaults (15 turns / 10
 * tool calls) stand. `researchMode` wins over tier classification: a research
 * turn always gets the research budget, even when downgraded (the chat route
 * preserves the research flag through budget downgrade so the worker pipeline
 * still runs).
 *
 * Standard runs the **same Flash 3 model as Pro**; the tighter 10 / 8 budget
 * is what differentiates it (cheaper, shallower agentic depth) and is the
 * lever that keeps its margin positive at the lower credit price. See
 * `docs/architecture/platform/cost-and-pricing.md` → "Margin per credit".
 */
export function chatTierBudget(args: {
  model: string
  researchMode: boolean
}): ChatTierBudget | null {
  // Max and Research depth doubled 2026-06-11 (Max 50→100, Research 100→200):
  // these are now the low-volume, deep-agentic premium tiers — repriced to 10
  // and 20 credits with plan caps cut to 1/2, so the extra depth is the premium
  // users pay for. See cost-and-pricing.md → "Margin per credit" / "Chat-tier
  // budget" and packages/api/src/billing/credit-usage.ts (CREDIT_PER_TIER).
  if (args.researchMode) return { maxTurns: 200, maxToolCalls: 200 }
  if (isMaxTier(args.model)) return { maxTurns: 100, maxToolCalls: 100 }
  if (isProTier(args.model)) return { maxTurns: 20, maxToolCalls: 20 }
  if (isStandardTier(args.model)) return { maxTurns: 10, maxToolCalls: 8 }
  return null
}

// ── Computer-use model routing (§4.14, computer-use.md §6) ─────
//
// The sandbox loop has three legs, each riding THIS tier router — no sandbox
// tool or module hardcodes a model id (grep-asserted by
// `packages/api/src/__tests__/sandbox-model-routing.test.ts`):
//
//   - orchestrator      → the TOP agentic tier ('max'). Non-negotiable in
//                         v1: reliability compounds over a 30-60-step task.
//                         Downgrades are gated on cost-per-COMPLETED-task
//                         evals over our own suite, never $/token.
//   - browserGrounding  → the cheap tier: agent-browser's ref-based a11y
//                         snapshots carry the grounding, so the model reads
//                         structure, not pixels.
//   - leaf              → the cheap tier: one-shot extractions/summaries.
//
// Plan allowances + budget downgrades apply exactly as they do for chat
// (resolveModel), so a free workspace's legs all resolve to Standard.

export type SandboxLeg = 'orchestrator' | 'browserGrounding' | 'leaf'

export const SANDBOX_LEG_TIERS: Record<SandboxLeg, string> = {
  orchestrator: 'max',
  browserGrounding: 'standard',
  leaf: 'standard',
}

export function resolveSandboxModel(
  leg: SandboxLeg,
  plan: string,
  budgetStatus: 'ok' | 'downgraded' | 'blocked' = 'ok',
): string {
  return resolveModel(SANDBOX_LEG_TIERS[leg], plan, budgetStatus)
}

/**
 * Max execution-plan continuation nudges per attempt, tier-scaled (locked
 * decision D, docs/architecture/context-engine/execution-plan.md). Lives beside
 * `chatTierBudget` so the completeness gate's persistence scales with the
 * same tier knob as the turn/tool budget. Weaker tiers get a tighter cap.
 */
export function planNudgeCap(args: {
  model: string
  researchMode: boolean
}): number {
  if (args.researchMode) return 4
  if (isMaxTier(args.model)) return 4
  if (isProTier(args.model)) return 3
  return 2 // Standard / unknown
}
