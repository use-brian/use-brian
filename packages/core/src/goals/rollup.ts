/**
 * Structural rollup — the non-acting goal path.
 *
 * When a host changes in a way that could satisfy acceptance (a sub-task
 * closes, a sub-goal completes), re-check every ACTIVE goal bound to that host
 * and complete the ones whose `done_when` now holds. No workflow run, no
 * metering, no model — this is the cheap, event-driven half of the primitive
 * (a goal-task auto-completes when its decomposition closes).
 *
 * Only `active` goals are rolled up: a `running` goal is being driven by the
 * acting loop, which checks its own `done_when` per iteration — the rollup must
 * not race it (single-flight, §8). Terminal / blocked goals are skipped.
 *
 * Port-injected so the whole control flow is unit-testable; the api layer wires
 * the real goal store, host resolvers, and the `complete` write-back (which
 * also delivers the terminal message — no silent termination, §7).
 *
 * [COMP:goals/rollup]
 */
import { evaluateDoneWhen, type DoneWhenResolvers } from './done-when.js'
import type { GoalHostRef, GoalRecord } from './types.js'

export type RollupGoalDeps = {
  /** Done-when resolvers for a goal — `subtasks` via the host's
   *  `acceptanceSource` (host-bound goals) or the sub-goal count (self-hosted),
   *  plus query / tool. */
  resolversFor: (goal: GoalRecord) => DoneWhenResolvers
  /** Terminal write-back for a met goal: set status `done`, write back to the
   *  host (or own status for self-hosted), deliver the completion message. */
  complete: (goal: GoalRecord) => Promise<void>
}

export type RollupDeps = RollupGoalDeps & {
  /** Goals bound to this host (the `idx_goals_host` lookup). */
  goalsForHost: (host: GoalHostRef) => Promise<GoalRecord[]>
}

export type RollupOutcome = { goalId: string; met: boolean }

/** Re-check a set of ACTIVE goals and complete the ones whose `done_when` now
 *  holds. The shared core of both rollup triggers — host-keyed (a sub-task
 *  closes) and self-hosted/parent (a sub-goal completes -> re-check its
 *  parent). Skips non-active goals so it never races the acting loop. */
export async function rollupGoals(
  goals: GoalRecord[],
  deps: RollupGoalDeps,
): Promise<RollupOutcome[]> {
  const outcomes: RollupOutcome[] = []
  for (const goal of goals) {
    if (goal.status !== 'active') continue // skip running / blocked / terminal
    const verdict = await evaluateDoneWhen(goal.doneWhen, deps.resolversFor(goal))
    if (verdict.met) await deps.complete(goal)
    outcomes.push({ goalId: goal.id, met: verdict.met })
  }
  return outcomes
}

/** Host-keyed rollup: re-check every active goal bound to `host`. */
export async function rollupHost(host: GoalHostRef, deps: RollupDeps): Promise<RollupOutcome[]> {
  return rollupGoals(await deps.goalsForHost(host), deps)
}
