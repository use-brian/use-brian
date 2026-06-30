/**
 * Means resolution — what one iteration runs (§3.4 / §4.9).
 *
 * A goal's `means` declares the toolkit each iteration may use. Per D1 an
 * iteration re-runs an author-defined workflow; blueprints / skills compose
 * into that workflow. This PURE resolver picks the iteration strategy by
 * precedence; the api layer materializes each kind against the workflow runner.
 *
 * `none` is a valid plan: a goal with no means is a MONITOR — it never acts, it
 * just re-checks `done_when` and re-arms (waiting on the world). A monitor is
 * not "acting", so it is exempt from the metering barrier (see `meansActs`).
 *
 * [COMP:goals/means]
 */
import type { GoalMeans } from './types.js'

export type MeansPlan =
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'blueprint'; blueprintId: string }
  | { kind: 'skill'; skillId: string }
  | { kind: 'none' }

/** Pick the iteration strategy by precedence: an explicit workflow wins, then a
 *  blueprint, then a skill, else a monitor (`none`). v1 takes the first
 *  blueprint / skill when several are declared. */
export function resolveMeans(means: GoalMeans): MeansPlan {
  if (means.workflowId) return { kind: 'workflow', workflowId: means.workflowId }
  if (means.blueprintIds && means.blueprintIds.length > 0) {
    return { kind: 'blueprint', blueprintId: means.blueprintIds[0] }
  }
  if (means.skillIds && means.skillIds.length > 0) {
    return { kind: 'skill', skillId: means.skillIds[0] }
  }
  return { kind: 'none' }
}

/** Does this plan take action (and so require metered spend)? A monitor
 *  (`none`) does not — it feeds the acting-loop's `acting` flag, so a pure
 *  watch-until-true goal is exempt from the §4.13 metering barrier. */
export function meansActs(plan: MeansPlan): boolean {
  return plan.kind !== 'none'
}
