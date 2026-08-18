/**
 * Research-depth budgets for the agentic loop.
 *
 * A "research depth" is how far an agentic `queryLoop` run may dig before it
 * is forced to synthesize: how many turns, how many total tool calls, and
 * (for the bounded workflow `assistant_call` path) how long in wall-clock.
 *
 * Two surfaces let a caller raise depth above the modest default:
 *   - scheduled jobs                 (`scheduled_jobs.research_depth`)
 *   - workflow `assistant_call` steps (`step.depth`)
 *
 * The config is two-layered: a named `tier` preset, with optional numeric
 * overrides that win field-by-field. `resolveResearchBudget` collapses a
 * config plus a caller-specific fallback into a concrete, clamped budget.
 *
 * [COMP:engine/research-depth] — docs/architecture/engine/query-loop.md
 * → "Research depth".
 */

import { z } from 'zod'

/** Named depth presets. `standard` reproduces the historical defaults. */
export type ResearchDepthTier = 'standard' | 'deep'

/** A fully-resolved budget — every field concrete. */
export type ResearchBudget = {
  /** Max agentic turns (model round-trips) in the loop. */
  maxTurns: number
  /** Absolute tool-call cap for the whole run (the loop-detector hard stop). */
  maxToolCalls: number
  /**
   * EXPLICIT wall-clock abort for a single bounded agentic step, or `null`
   * for none (2026-08-19). Every default and tier preset is `null`: a step is
   * bounded by cost (`maxTurns` / `maxToolCalls`) and by liveness (the query
   * loop's stall watchdog - no progress for the idle window aborts it), not
   * by a guess about how fast the model is. Only an author-set
   * `depth.timeoutMs` (or the `ASSISTANT_CALL_TIMEOUT_MS` env) arms a
   * wall-clock, clamped to `[FLOOR, CEILING]`. Honoured on the workflow
   * `assistant_call` path and the blueprint synthesis fill; a legacy
   * scheduled job's `queryLoop` is turn-bounded and ignores this field.
   */
  timeoutMs: number | null
}

/**
 * Absolute ceilings — every resolved field is clamped here so a misconfigured
 * job or workflow step can never run unbounded (cost / runaway protection).
 *
 * Wall-clock ceiling raised 300s → 900s (2026-08-07, the builder's per-step
 * timeout field): a heavy research/authoring step may legitimately need more
 * than 5 minutes, and the value is only ever reached by an EXPLICIT
 * `depth.timeoutMs` — every default and tier preset stays ≤ 300s, so nothing
 * gets slower or costlier without an author asking for it.
 */
export const RESEARCH_BUDGET_CEILING: ResearchBudget = {
  maxTurns: 60,
  maxToolCalls: 50,
  timeoutMs: 900_000,
}

/** Lower bounds — a depth of zero would make a step a no-op. The
 *  `timeoutMs` floor applies to an EXPLICIT wall-clock only. */
export const RESEARCH_BUDGET_FLOOR: ResearchBudget = {
  maxTurns: 1,
  maxToolCalls: 1,
  timeoutMs: 1_000,
}

/**
 * Tier presets. `standard` equals the historical query-loop default. Neither
 * tier arms a wall-clock (2026-08-19): `standard` was 30s and `deep` 300s
 * (itself raised from 180s after the slow `max` model aborted mid-turn), and
 * every one of those numbers clipped legitimate work at the slow end while
 * catching nothing the stall watchdog would not. Cost stays bounded by the
 * turn / tool-call caps.
 */
const TIERS: Record<ResearchDepthTier, ResearchBudget> = {
  standard: { maxTurns: 15, maxToolCalls: 10, timeoutMs: null },
  deep: { maxTurns: 40, maxToolCalls: 35, timeoutMs: null },
}

/** The tier names, for UI / tool enumeration. */
export const RESEARCH_DEPTH_TIERS = Object.keys(TIERS) as ResearchDepthTier[]

/**
 * Default wall-clock for an `assistant_call` step with no `depth`: NONE
 * (2026-08-19). It was 30s, then 90s (2026-07-08, after the 30s abort clipped
 * the common gather-draft-write shape and pushed authors to degrade their
 * workflows to fit) - each number a guess about model speed that failed on
 * the slow end. A step is now progress-bounded (stall watchdog) and
 * cost-bounded (turns / tool calls). An operator who still wants a hard
 * wall-clock sets `ASSISTANT_CALL_TIMEOUT_MS` (clamped to
 * [FLOOR.timeoutMs, CEILING.timeoutMs]); an explicit `step.depth.timeoutMs`
 * still wins field-by-field.
 */
export const DEFAULT_ASSISTANT_CALL_TIMEOUT_MS: number | null = null

/**
 * Resolve the default step wall-clock from a raw env string. Pure (takes the
 * value, not `process.env`) so it's testable without env mutation. An unset,
 * blank, or non-numeric value means NO default wall-clock (`null`); a numeric
 * value is clamped to the same [FLOOR, CEILING] as every other budget.
 */
export function parseAssistantCallTimeoutMs(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ASSISTANT_CALL_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_ASSISTANT_CALL_TIMEOUT_MS
  return clamp(parsed, RESEARCH_BUDGET_FLOOR.timeoutMs!, RESEARCH_BUDGET_CEILING.timeoutMs!)
}

/**
 * Default budget for a workflow `assistant_call` step — and therefore for a
 * scheduled job, which post the scheduling⇄workflow cutover *is* a one-step
 * `assistant_call` workflow. Tighter than `standard` on turns / tool calls
 * (`maxTurns: 5`); no wall-clock unless `ASSISTANT_CALL_TIMEOUT_MS` sets one.
 * A step with no `depth` keeps this exactly; `depth` is purely opt-in.
 */
export const ASSISTANT_CALL_DEFAULT_BUDGET: ResearchBudget = {
  maxTurns: 5,
  maxToolCalls: 10,
  timeoutMs: parseAssistantCallTimeoutMs(process.env.ASSISTANT_CALL_TIMEOUT_MS),
}

/** Boundary schema — reused by the workflow step schema and the cron tools. */
export const ResearchDepthConfigSchema = z
  .object({
    tier: z.enum(['standard', 'deep']).optional(),
    maxTurns: z
      .number()
      .int()
      .min(RESEARCH_BUDGET_FLOOR.maxTurns)
      .max(RESEARCH_BUDGET_CEILING.maxTurns)
      .optional(),
    maxToolCalls: z
      .number()
      .int()
      .min(RESEARCH_BUDGET_FLOOR.maxToolCalls)
      .max(RESEARCH_BUDGET_CEILING.maxToolCalls)
      .optional(),
    timeoutMs: z
      .number()
      .int()
      .min(RESEARCH_BUDGET_FLOOR.timeoutMs!)
      .max(RESEARCH_BUDGET_CEILING.timeoutMs!)
      .optional(),
  })
  .strict()

/**
 * A depth request: a tier preset and/or numeric overrides. Every field is
 * optional — an empty config resolves to the caller's fallback budget.
 */
export type ResearchDepthConfig = z.infer<typeof ResearchDepthConfigSchema>

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, Math.round(value)))
}

/**
 * Collapse a depth config plus caller fallback into a concrete budget.
 *
 * Precedence, low → high:
 *   1. `fallback` — the caller's "no config" budget.
 *   2. `config.tier` preset — when a tier is named it replaces `fallback`
 *      as the base for every field.
 *   3. `config.maxTurns` / `maxToolCalls` / `timeoutMs` — numeric overrides,
 *      applied field-by-field over the base.
 *
 * Every resolved field is clamped to [FLOOR, CEILING].
 */
export function resolveResearchBudget(
  config: ResearchDepthConfig | null | undefined,
  fallback: ResearchBudget,
): ResearchBudget {
  const base = config?.tier ? TIERS[config.tier] : fallback
  return {
    maxTurns: clamp(
      config?.maxTurns ?? base.maxTurns,
      RESEARCH_BUDGET_FLOOR.maxTurns,
      RESEARCH_BUDGET_CEILING.maxTurns,
    ),
    maxToolCalls: clamp(
      config?.maxToolCalls ?? base.maxToolCalls,
      RESEARCH_BUDGET_FLOOR.maxToolCalls,
      RESEARCH_BUDGET_CEILING.maxToolCalls,
    ),
    // `null` = no wall-clock (progress-bounded). Only an explicit number is
    // clamped; the FLOOR is never applied to "none".
    timeoutMs: (() => {
      const raw = config?.timeoutMs ?? base.timeoutMs
      return raw === null || raw === undefined
        ? null
        : clamp(raw, RESEARCH_BUDGET_FLOOR.timeoutMs!, RESEARCH_BUDGET_CEILING.timeoutMs!)
    })(),
  }
}
