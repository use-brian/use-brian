/**
 * Cost tracking and model pricing.
 *
 * Tracks per-turn costs using API-reported token usage.
 * Pricing is per million tokens.
 */

import type { TokenUsage } from '../providers/types.js'

// ── Model pricing (per million tokens, USD) ────────────────────

type ModelPricing = {
  inputPerM: number
  outputPerM: number
  cacheReadPerM: number
  cacheWritePerM: number
}

const PRICING: Record<string, ModelPricing> = {
  // Gemini (at launch) — prices from https://ai.google.dev/gemini-api/docs/pricing
  // cacheWritePerM: Google charges cache *storage* per hour, not a one-time write
  // cost. Kept as an approximation; the provider never sets cacheWriteTokens.
  'gemini-3-flash-preview':       { inputPerM: 0.50,  outputPerM: 3.00,  cacheReadPerM: 0.05,  cacheWritePerM: 0.50 },
  'gemini-3.1-pro-preview':       { inputPerM: 2.00,  outputPerM: 12.00, cacheReadPerM: 0.20,  cacheWritePerM: 2.00 },
  // Gemini 3.5 Flash (Google I/O 2026 release, 2026-05-19). Max-tier default
  // model — frontier-class on agentic/coding/tool-calling benchmarks at Flash
  // speeds. Pricing per https://ai.google.dev/gemini-api/docs/pricing; cache
  // read is 10% of input (the published Flash-family ratio) and cache write
  // mirrors input as an approximation (Google charges storage per hour, not a
  // one-time write fee — see the gemini-3-flash-preview comment above).
  'gemini-3.5-flash':             { inputPerM: 1.50,  outputPerM: 9.00,  cacheReadPerM: 0.15,  cacheWritePerM: 1.50 },
  'gemini-2.5-flash':             { inputPerM: 0.30,  outputPerM: 2.50,  cacheReadPerM: 0.03,  cacheWritePerM: 0.30 },
  // Gemini 3.1 Flash Lite (Standard tier — replaces Gemma 4 26B). Google's
  // published pricing for the Lite variant per docs/research/external/
  // model-cost-comparison-2026.md. Cache pricing follows the same 10%-of-input
  // / 100%-of-input ratio Google uses for the Flash family.
  'gemini-3.1-flash-lite':         { inputPerM: 0.25, outputPerM: 1.50,  cacheReadPerM: 0.025, cacheWritePerM: 0.25 },
  // Gemma 4 26B A4B (legacy Standard tier — superseded by Flash Lite). Kept
  // here so cost calculations on historical `usage_tracking` rows that
  // reference the old `model_resolved` value continue to compute (always $0
  // since Gemma was Google AI Studio free-tier only).
  'gemma-4-26b-a4b-it':           { inputPerM: 0.00,  outputPerM: 0.00,  cacheReadPerM: 0.00,  cacheWritePerM: 0.00 },
  // Anthropic (deferred)
  'claude-haiku-4-5':         { inputPerM: 1.00,  outputPerM: 5.00,  cacheReadPerM: 0.10,  cacheWritePerM: 1.25 },
  'claude-sonnet-4-6':        { inputPerM: 3.00,  outputPerM: 15.00, cacheReadPerM: 0.30,  cacheWritePerM: 3.75 },
  'claude-opus-4-6':          { inputPerM: 5.00,  outputPerM: 25.00, cacheReadPerM: 0.50,  cacheWritePerM: 6.25 },
  // xAI Grok — powers the xSearch tool (reasoning variant) and the x.com
  // URL redirect in urlReader (non-reasoning variant). Both variants price
  // identically; reasoning is a free upgrade when the task benefits.
  // Rates per https://docs.x.ai/docs/models (verified 2026-04-22).
  // xAI does not charge for cache writes on the Responses API.
  'grok-4-1-fast':                { inputPerM: 0.20, outputPerM: 0.50, cacheReadPerM: 0.05, cacheWritePerM: 0 },
  'grok-4-1-fast-non-reasoning':  { inputPerM: 0.20, outputPerM: 0.50, cacheReadPerM: 0.05, cacheWritePerM: 0 },
  // Gemini embedding model (brain vectors — embeddings.md §"Cost model").
  // Input-only pricing; the batchEmbedContents response carries no usage
  // metadata, so callers record the ~4-chars/token estimate as inputTokens.
  'gemini-embedding-001':         { inputPerM: 0.025, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 },
}

// Alias mapping
const MODEL_ALIASES: Record<string, string> = {
  'gemini-flash': 'gemini-3-flash-preview',
  'gemini-flash-3': 'gemini-3-flash-preview',   // Pro tier — explicit alias
  // Standard chat tier — same Flash 3 model as Pro (tighter tool budget), so
  // it costs the same per token. The synthetic id keeps the row Standard-tier
  // for billing while pricing at Flash-3 rates here. See model-resolution.ts.
  'gemini-3-flash-standard': 'gemini-3-flash-preview',
  // Research tier — same Pro 3.1 model, synthetic id; prices at Pro-3.1 rates.
  'gemini-3-pro-research': 'gemini-3.1-pro-preview',
  'gemini-pro': 'gemini-3.1-pro-preview',
  'gemini-flash-25': 'gemini-2.5-flash',
  // Historical id — Google retired the preview SKU on 2026-05-25; alias
  // it back to the GA id so cost calculations on pre-cutover
  // `usage_tracking` rows continue to resolve.
  'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite',
  'gemma-4-26b': 'gemma-4-26b-a4b-it',
  // The embedder's namespaced model_id (`GEMINI_EMBEDDING_MODEL_ID`) — the
  // embedding worker records usage under this string.
  'gemini:gemini-embedding-001': 'gemini-embedding-001',
}

/**
 * Calculate actual USD cost for a single LLM call.
 */
export function calculateCost(model: string, usage: TokenUsage): number {
  const resolvedModel = MODEL_ALIASES[model] ?? model
  const p = PRICING[resolvedModel] ?? PRICING['gemini-3-flash-preview']

  return (
    (usage.inputTokens / 1_000_000) * p.inputPerM +
    (usage.outputTokens / 1_000_000) * p.outputPerM +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * p.cacheReadPerM +
    ((usage.cacheWriteTokens ?? 0) / 1_000_000) * p.cacheWritePerM
  )
}

// ── Overhead source labels ─────────────────────────────────────
//
// Auxiliary LLM calls that run on every user turn but are not the
// user's "real" turn. Each carries full per-user / per-session /
// per-model attribution so the admin dashboard can show the breakdown,
// but is excluded from billing math (the credit derivation, the cost
// SUM, the daily aggregate) — see UsageStore.recordUsage, getWeeklyCost,
// and packages/api/src/billing/credit-gate.ts (overhead never debits credits).
//
// The `usage_tracking` `valid_source` CHECK (000_overlay_v1.sql baseline,
// last extended by migration 305) enshrines these exact strings; keep the
// list in sync with the latest migration when adding new subsystems — a
// source missing from the CHECK makes its INSERTs fail 23514 silently
// (the exact failure class migration 305 closed for synthesis + goals).

export const OVERHEAD_SOURCES = [
  'overhead:compaction',
  'overhead:extraction',
  'overhead:classifier',
  'overhead:reactive-compact',
  'overhead:consolidation',
  'overhead:nudge',
  'overhead:title',
  'overhead:transcription',
  'overhead:splitter',
  'overhead:session-state-diff',
  'overhead:recovery-message',
  'overhead:empty-turn-synthesis',
  'overhead:distribution-classifier',
  'overhead:distribution-safety',
  'overhead:distribution-draft',
  'overhead:skill-review',
  // Migration 305 additions (2026-07-07): async embedding-worker batches,
  // the GENERATE/blueprint synthesis engine, and the goal clarity gate +
  // completion verifier.
  'overhead:embedding',
  'overhead:synthesis',
  'overhead:goal-clarity',
  'overhead:goal-verify',
] as const

export type OverheadSource = typeof OVERHEAD_SOURCES[number]

/**
 * True iff the given source string marks a row that should be
 * visible on dashboards but excluded from billing math.
 */
export function isOverheadSource(source: string): boolean {
  return source.startsWith('overhead:')
}

// ── Budget enforcement vocabulary ──────────────────────────────
//
// The live budget gate is the monthly CREDIT CAP and lives in the API
// layer (`packages/api/src/billing/credit-gate.ts`): it needs the
// per-message tier classifier and billing-period derivation, which are
// DB concerns. The legacy rolling-dollar budget that used to live here —
// a rolling-weekly window plus a 5-hour burst sub-window, with per-plan
// dollar ceilings in `PLAN_BUDGETS` — was retired on 2026-06-05. See
// docs/architecture/platform/cost-and-pricing.md → "Migration: dollar
// budget to credit cap".

// ── Budget enforcement status ──────────────────────────────────
//
// `BudgetStatus` is the shared vocabulary `resolveModel` consumes:
//   - `ok`:         within the allowance — requested model honored.
//   - `downgraded`: at the cap on a paid plan — forced to Standard (Flash);
//                   feature access unchanged, the UI shows a one-time notice.
//   - `blocked`:    at the cap on Free — turn rejected (Free is already on
//                   Standard, so there is no downgrade path).
export type BudgetStatus = 'ok' | 'downgraded' | 'blocked'

// ── Usage store interface ──────────────────────────────────────

export type UsageStore = {
  recordUsage(params: {
    /** The user who drove the turn — per-user analytics axis. */
    userId: string
    assistantId: string
    /**
     * Chat-session ID when recording per-turn usage. NULL is permitted for
     * background workers (e.g. consolidation) that have no user-facing
     * session. Migration 067 widened the DB column to allow NULL.
     */
    sessionId: string | null
    /**
     * Fallback attribution axis for recorders that have no assistant in
     * hand (embedding batches, connector-drip ingest extraction). When
     * `assistantId` is blank, implementations resolve a representative
     * assistant from this workspace (the DB row requires a real one) and
     * may also fall back `userId` to that assistant's owner when blank.
     * Ignored when `assistantId` is set. Optional — recorders with a real
     * assistant never need it.
     */
    workspaceId?: string
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    actualCostUsd: number
    source: string
    /** Groups per-turn rows back to the user message that triggered them. */
    userMessageId?: string
    /**
     * The user who actually drove the turn. For first-party traffic this
     * equals `userId` (and the store fills it in for you when omitted).
     * For public-API and team-custom-connector traffic the API-key owner
     * pays (`userId`) but the shadow user drives the turn — pass the
     * shadow's id here so admin per-user views can pivot to the actor.
     * See migration 100 and docs/architecture/platform/analytics.md.
     */
    actorUserId?: string
    /**
     * Per-trigger LLM call identifier — names the *thing* that fired the
     * call (`main_response`, `pattern_extractor`, `compaction_full`,
     * `session_title`, etc) independently of `source` (which is the
     * billing classification — main vs `overhead:*`). Enables per-trigger
     * cost rollups without scraping log strings. Optional — null on legacy
     * rows pre-migration 164.
     */
    triggerKey?: string
    /**
     * Which API key drove the LLM call: the platform's (`platform`, the
     * default) or the workspace's bring-your-own key (`user`). BYO turns are
     * recorded with `actualCostUsd = 0` because the workspace pays its provider
     * directly; this field records the provenance for attribution/audit.
     * Optional — null on legacy rows and non-LLM rows.
     */
    providerKeySource?: 'user' | 'platform'
  }): Promise<void>

  /** Total cost for the workspace in the rolling trailing 7 days. */
  getWeeklyCost(workspaceId: string): Promise<number>
  /**
   * Timestamp of the earliest charge at or after the given cutoff, so
   * callers can compute when the next "drop" happens on the rolling
   * weekly window. Returns null if the window is empty.
   */
  getEarliestChargeAfter(workspaceId: string, after: Date): Promise<Date | null>

  /**
   * Total recorded COGS (excl. `overhead:*`) for one session. Backs the
   * goal-seeker per-iteration / per-goal spend read: a goal iteration runs
   * under its own session, so summing `usage_tracking` by `session_id` is the
   * deterministic per-iteration COGS the acting loop feeds into `maxSpend`
   * (see docs/architecture/features/goals.md → metering). Distinct from the
   * workspace-scoped reads above — it is keyed by session, not workspace.
   */
  getSessionCostUsd(sessionId: string): Promise<number>

  // ── Per-assistant queries (Cost tab) ──────────────────────
  /** Total cost for one assistant in the last 7 days. */
  getAssistantWeeklyCost(workspaceId: string, assistantId: string): Promise<number>
  /** Cost breakdown by model for one assistant, last 7 days. */
  getAssistantModelMix(workspaceId: string, assistantId: string): Promise<Array<{ model: string; costUsd: number }>>
  /** Daily cost totals for one assistant over the last N days. */
  getAssistantDailyTrend(workspaceId: string, assistantId: string, days: number): Promise<Array<{ date: string; costUsd: number }>>
}

