/**
 * The acting loop — one goal iteration's control flow.
 *
 * Ties the verified cores together (§4.9 / §4.11): run one bounded iteration
 * (the author-defined workflow), evaluate `done_when`, then `decideContinuation`
 * and act on it — finish (`done`/`blocked` + host write-back + message) or
 * re-arm the next iteration per the resume mode.
 *
 * The §4.13 metering barrier is enforced PRE-iteration: an acting goal never
 * runs cost-blind, so if metering is unwired the goal blocks *without* spending
 * untracked COGS (the `decideContinuation` metering check is the post-hoc
 * backstop).
 *
 * Per-iteration history (iteration count, cumulative spend, no-progress streak)
 * is NOT stored on the goal — it is read from `workflow_runs` by the caller and
 * passed in as `state` (§3.2). Port-injected so the control flow is
 * unit-testable; the api layer wires the real workflow runner, resolvers,
 * metering, and write-back.
 *
 * [COMP:goals/loop]
 */
import { decideContinuation, type ContinuationDecision, type GoalResume } from './continuation.js'
import { evaluateDoneWhen, type DoneWhenResolvers, type DoneWhenTraceEntry } from './done-when.js'
import { meansActs, resolveMeans } from './means.js'
import type { GoalRecord, GoalStatus } from './types.js'

export type IterationOutcome = {
  /** Did this iteration move toward the outcome? */
  progressed: boolean
  /** Set when the iteration is waiting on a specific event (-> `until` resume). */
  awaitingEvent?: Record<string, unknown> | null
  /** COGS dollars this iteration recorded (0 when metering is off). */
  spend: number
}

export type LoopState = {
  /** Iterations completed BEFORE this one (count of prior workflow_runs). */
  iteration: number
  /** Cumulative COGS recorded across prior iterations. */
  spend: number
  /** Consecutive prior no-progress iterations. */
  noProgressStreak: number
}

export type ActingLoopDeps = {
  /** §4.13 — is COGS spend being recorded? */
  meteringAvailable: () => boolean
  /** Run one bounded iteration (the author-defined workflow) toward the goal. */
  runIteration: (goal: GoalRecord) => Promise<IterationOutcome>
  /** Done-when resolvers for the goal (subtasks via host, query, tool). */
  resolversFor: (goal: GoalRecord) => DoneWhenResolvers
  /** Persist a status transition (best-effort). */
  setStatus: (goalId: string, status: GoalStatus) => Promise<void>
  /** Terminal: host write-back + deliver the completion/blocked message
   *  (no silent termination, §7). */
  finish: (
    goal: GoalRecord,
    terminal: 'done' | 'blocked',
    reason: string | null,
    trace: DoneWhenTraceEntry[],
  ) => Promise<void>
  /** Re-arm the next iteration per the resume mode (immediate / backoff / event). */
  rearm: (goal: GoalRecord, resume: GoalResume) => Promise<void>
}

export async function processGoalIteration(
  goal: GoalRecord,
  state: LoopState,
  now: string,
  deps: ActingLoopDeps,
): Promise<ContinuationDecision> {
  // Means decides whether this goal ACTS (and so must be metered) or is a
  // MONITOR (no means — it just re-checks done_when and re-arms).
  const acting = meansActs(resolveMeans(goal.means))

  // PRE-iteration metering barrier — never act cost-blind (§4.13). A monitor is
  // exempt; an acting goal blocks before spending a single untracked dollar.
  if (acting && !deps.meteringAvailable()) {
    await deps.finish(goal, 'blocked', 'metering_unavailable', [])
    return { decision: 'blocked', reason: 'metering_unavailable' }
  }

  await deps.setStatus(goal.id, 'running')
  const outcome = acting
    ? await deps.runIteration(goal)
    : { progressed: false, spend: 0 } // monitor: no action this iteration
  const verdict = await evaluateDoneWhen(goal.doneWhen, deps.resolversFor(goal))

  const decision = decideContinuation({
    verdict,
    budget: goal.budget,
    state: {
      iteration: state.iteration + 1,
      spend: state.spend + outcome.spend,
      now,
      progressed: outcome.progressed,
      noProgressStreak: outcome.progressed ? 0 : state.noProgressStreak + 1,
      awaitingEvent: outcome.awaitingEvent ?? null,
    },
    acting,
    meteringAvailable: deps.meteringAvailable(),
  })

  if (decision.decision === 'done') {
    await deps.finish(goal, 'done', null, verdict.trace)
  } else if (decision.decision === 'blocked') {
    await deps.finish(goal, 'blocked', decision.reason, verdict.trace)
  } else {
    await deps.setStatus(goal.id, 'active')
    await deps.rearm(goal, decision.resume)
  }
  return decision
}
