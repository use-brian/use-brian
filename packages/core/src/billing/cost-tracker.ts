/**
 * Cost tracking and model pricing.
 *
 * Tracks per-turn costs using API-reported token usage.
 * Pricing is per million tokens.
 */

import { bracketFor, modelRates, UNKNOWN_MODEL_RATES } from '@use-brian/shared/model-registry'
import type { TokenUsage } from '../providers/types.js'

// ── Model pricing (per million tokens, USD) ────────────────────
//
// All rates live in the model registry (`@use-brian/shared/model-registry`,
// per-row `rates`) — one declarative row per model, list price never promo.
// This module only turns a registry rate blob + API-reported usage into USD.

/**
 * Calculate actual USD cost for a single LLM call. Unknown / unpriced models
 * fall back to `UNKNOWN_MODEL_RATES` (Flash 3) so drift shows up as nonzero
 * cost instead of silently free rows.
 */
export function calculateCost(model: string, usage: TokenUsage): number {
  const rates = modelRates(model) ?? UNKNOWN_MODEL_RATES
  const bracket = bracketFor(rates, usage.inputTokens)

  return (
    (usage.inputTokens / 1_000_000) * bracket.inPerMTok +
    (usage.outputTokens / 1_000_000) * bracket.outPerMTok +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * rates.cacheReadPerMTok +
    ((usage.cacheWriteTokens ?? 0) / 1_000_000) * rates.cacheWritePerMTok
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
// last extended by migration 309) enshrines these exact strings; keep the
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
  // Migration 309 (2026-07-07): the workflow-lifecycle digest pass.
  'overhead:workflow-digest',
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

