/**
 * The continuation gate — the goal-seeker loop's decision core.
 *
 * After an iteration (a bounded workflow run, §4.9) the engine evaluates
 * `done_when` and calls this PURE function to decide what happens next:
 * `done`, `blocked` (+reason), or `continue` with a resume mode. Kept free of
 * DB/engine deps so the whole decision surface is unit-testable — the same
 * discipline as the done_when evaluator.
 *
 * Resume modes (§4.11):
 *   now           — more work to do; re-arm immediately.
 *   after(seconds)— waiting on the world; exponential backoff on consecutive
 *                   no-progress iterations (author base/max caps).
 *   until(event)  — the iteration declared it is waiting on a specific event;
 *                   wake via the event dispatcher rather than polling.
 *
 * Barriers it enforces:
 *   §4.13 metering — an ACTING goal cannot run cost-blind: if it acts and
 *                    spend is not being recorded, it blocks rather than burn
 *                    untracked COGS.
 *   §4 budget      — deadline / maxIterations / maxSpend are hard backstops;
 *                    exhaustion -> blocked (the loop can never mean "forever").
 *
 * [COMP:goals/continuation-gate]
 */
import type { GoalBudget } from './types.js'

export type GoalResume =
  | { kind: 'now' }
  | { kind: 'after'; seconds: number }
  | { kind: 'until'; event: Record<string, unknown> }

export type ContinuationDecision =
  | { decision: 'done' }
  | { decision: 'blocked'; reason: string }
  | { decision: 'continue'; resume: GoalResume }

export type ContinuationState = {
  /** Iterations completed so far (this one included). */
  iteration: number
  /** COGS dollars recorded so far. */
  spend: number
  /** Current time, ISO-8601 (passed in — the core has no clock). */
  now: string
  /** Did this iteration make progress toward the outcome? */
  progressed: boolean
  /** Consecutive no-progress iterations (drives backoff growth). */
  noProgressStreak: number
  /** Set when the iteration declared it is waiting on a specific event. */
  awaitingEvent?: Record<string, unknown> | null
}

export type ContinuationInput = {
  /** The done_when verdict for this iteration. */
  verdict: { met: boolean }
  budget: GoalBudget
  state: ContinuationState
  /** Does this goal take real actions (and so require metered spend)? A purely
   *  structural goal (the rollup case) does not act and is exempt. */
  acting: boolean
  /** §4.13 — is COGS spend being recorded? */
  meteringAvailable: boolean
  /** Backoff bounds for the `after` resume mode. */
  backoff?: { baseSeconds?: number; maxSeconds?: number }
}

const DEFAULT_BACKOFF_BASE_SECONDS = 60
const DEFAULT_BACKOFF_MAX_SECONDS = 3600

export function backoffSeconds(
  streak: number,
  bounds?: { baseSeconds?: number; maxSeconds?: number },
): number {
  const base = bounds?.baseSeconds ?? DEFAULT_BACKOFF_BASE_SECONDS
  const max = bounds?.maxSeconds ?? DEFAULT_BACKOFF_MAX_SECONDS
  // Cap the exponent so `2 ** streak` can't overflow on a long-stalled goal.
  const factor = 2 ** Math.min(Math.max(streak, 0), 20)
  return Math.min(max, Math.round(base * factor))
}

export function decideContinuation(input: ContinuationInput): ContinuationDecision {
  const { verdict, budget, state, acting, meteringAvailable } = input

  // 1. Met -> done. A satisfied (engine-verified) done_when wins even if a
  //    budget would also be exhausted, and a structural done_when needs no
  //    metering.
  if (verdict.met) return { decision: 'done' }

  // 2. Metering barrier (§4.13) — an acting goal may not run cost-blind.
  if (acting && !meteringAvailable) {
    return { decision: 'blocked', reason: 'metering_unavailable' }
  }

  // 3. Hard budget backstops (§4) — "until done" can never mean "forever".
  if (budget.deadline && new Date(state.now).getTime() >= new Date(budget.deadline).getTime()) {
    return { decision: 'blocked', reason: 'deadline' }
  }
  if (budget.maxIterations !== undefined && state.iteration >= budget.maxIterations) {
    return { decision: 'blocked', reason: 'max_iterations' }
  }
  if (budget.maxSpend !== undefined && state.spend >= budget.maxSpend) {
    return { decision: 'blocked', reason: 'max_spend' }
  }

  // 4. Continue — pick the resume mode (§4.11).
  if (state.awaitingEvent) {
    return { decision: 'continue', resume: { kind: 'until', event: state.awaitingEvent } }
  }
  if (state.progressed) {
    return { decision: 'continue', resume: { kind: 'now' } }
  }
  return {
    decision: 'continue',
    resume: { kind: 'after', seconds: backoffSeconds(state.noProgressStreak, input.backoff) },
  }
}
