/**
 * Goal-seeker structural rollup runner — the api wiring of the non-acting
 * `rollupHost` core (`@use-brian/core`). It builds the `RollupDeps` from the
 * goal store + host adapters + a completion-delivery port, and exposes a single
 * `onTaskTerminal` callback that the task store fires when a sub-task closes.
 *
 * Non-acting and cheap (no workflow run, no metering, no model): on a sub-task
 * close it re-checks every ACTIVE goal bound to the closed task's parent and
 * completes the ones whose `done_when` now holds — a goal-task auto-completes
 * when its decomposition closes. This is the barrier-free half of the
 * primitive; the acting loop (which runs a workflow each iteration) is gated
 * behind the §4.13 metering barrier and is wired separately.
 *
 * `done_when` evaluation here resolves the `subtasks` leaf (the structural
 * sugar) via the host adapter / sub-goal count; `query` and `tool` leaves
 * resolve to NOT-confirmed (`false`) on this non-acting path — confirming them
 * is the acting loop's job. A goal whose `done_when` is a pure `query` / `tool`
 * predicate therefore waits for the acting loop and is never false-completed
 * here.
 *
 * No silent termination (`goals.md` §7): completion sets the goal `done`,
 * writes back to the host (the task adapter closes the host task; readonly
 * adapters no-op), AND delivers a message to the goal's creator via the
 * injected `deliverGoalDone` port.
 *
 * Single-flight (`goals.md`): `rollupGoals` skips any non-`active` goal, so a
 * goal currently being driven by the acting loop is never raced by the rollup.
 *
 * [COMP:goals/rollup-runner]
 */
import {
  rollupHost,
  type GoalHostRef,
  type GoalRecord,
  type GoalStore,
  type RollupDeps,
  type RollupOutcome,
} from '@use-brian/core'
import { buildGoalResolvers, finishGoal } from './writeback.js'

export type GoalRollupDeps = {
  goalStore: GoalStore
  /** Deliver the terminal message to the goal's creator (no silent
   *  termination, §7). Best-effort; the runner swallows its rejection so a
   *  delivery failure never wedges the rollup. Wired in boot to the workspace
   *  primary + the channel-delivery path. */
  deliverGoalDone: (goal: GoalRecord) => Promise<void>
}

export type GoalRollupRunner = {
  /** Fire-and-forget: a task closed; re-check goals bound to it. The task
   *  store calls this from `update`; it never blocks or throws. */
  onTaskTerminal: (host: GoalHostRef) => void
  /** The awaitable rollup `onTaskTerminal` wraps — the deterministic core,
   *  exposed for callers (and tests) that need to await completion. */
  rollup: (host: GoalHostRef) => Promise<RollupOutcome[]>
}

export function createGoalRollupRunner(deps: GoalRollupDeps): GoalRollupRunner {
  const { goalStore, deliverGoalDone } = deps

  const rollupDeps: RollupDeps = {
    // Skip DRAFT (unconfirmed) goals — an auto-drafted goal is inert until the
    // creator confirms it (autopilot §4), so a guessed done_when never
    // auto-completes a task structurally.
    goalsForHost: async (host) =>
      (await goalStore.listByHostSystem(host)).filter((g) => g.confirmedAt !== null),
    resolversFor: (goal) => buildGoalResolvers(goal, goalStore),
    // The rollup only ever completes a goal (it never blocks one), so the
    // terminal is always `done`; `finishGoal` does the status + host write-back
    // + delivery, shared with the acting loop.
    complete: (goal) =>
      finishGoal(goal, 'done', null, { goalStore, deliver: (g) => deliverGoalDone(g) }),
  }

  const rollup = (host: GoalHostRef) => rollupHost(host, rollupDeps)

  return {
    rollup,
    onTaskTerminal: (host) => {
      // Fire-and-forget: a rollup must never block or break the task write that
      // triggered it. A failure is logged, not propagated.
      void rollup(host).catch((err) => {
        console.error('[goals] structural rollup on task close failed:', err)
      })
    },
  }
}
