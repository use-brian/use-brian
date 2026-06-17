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
   * Wall-clock abort for a single bounded agentic step. Honoured only on the
   * workflow `assistant_call` path; a legacy scheduled job's `queryLoop` is
   * turn-bounded and ignores this field.
   */
  timeoutMs: number
}

/**
 * Absolute ceilings — every resolved field is clamped here so a misconfigured
 * job or workflow step can never run unbounded (cost / runaway protection).
 */
export const RESEARCH_BUDGET_CEILING: ResearchBudget = {
  maxTurns: 60,
  maxToolCalls: 50,
  timeoutMs: 300_000,
}

/** Lower bounds — a depth of zero would make a step a no-op. */
export const RESEARCH_BUDGET_FLOOR: ResearchBudget = {
  maxTurns: 1,
  maxToolCalls: 1,
  timeoutMs: 1_000,
}

/** Tier presets. `standard` equals the historical query-loop default. */
const TIERS: Record<ResearchDepthTier, ResearchBudget> = {
  standard: { maxTurns: 15, maxToolCalls: 10, timeoutMs: 30_000 },
  // Wall-clock raised 180s → 300s (the ceiling): scheduled / workflow `deep`
  // steps doing genuine multi-source synthesis on the slow `max` model were
  // hitting the 180s abort mid-turn and failing with `dispatch_threw`
  // ("This operation was aborted"). Turn / tool-call caps are unchanged, so
  // cost stays bounded — only the wall-clock allowance widens.
  deep: { maxTurns: 40, maxToolCalls: 35, timeoutMs: 300_000 },
}

/** The tier names, for UI / tool enumeration. */
export const RESEARCH_DEPTH_TIERS = Object.keys(TIERS) as ResearchDepthTier[]

/**
 * Default budget for a workflow `assistant_call` step — and therefore for a
 * scheduled job, which post the scheduling⇄workflow cutover *is* a one-step
 * `assistant_call` workflow. Tighter than `standard`: historically these
 * steps ran `maxTurns: 5` with a 30s abort. A step with no `depth` keeps that
 * behaviour exactly; `depth` is purely opt-in.
 */
export const ASSISTANT_CALL_DEFAULT_BUDGET: ResearchBudget = {
  maxTurns: 5,
  maxToolCalls: 10,
  timeoutMs: 30_000,
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
      .min(RESEARCH_BUDGET_FLOOR.timeoutMs)
      .max(RESEARCH_BUDGET_CEILING.timeoutMs)
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
    timeoutMs: clamp(
      config?.timeoutMs ?? base.timeoutMs,
      RESEARCH_BUDGET_FLOOR.timeoutMs,
      RESEARCH_BUDGET_CEILING.timeoutMs,
    ),
  }
}
