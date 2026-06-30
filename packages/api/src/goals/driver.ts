/**
 * Goal driver — the acting loop (R1). The api wiring of the already-built
 * `processGoalIteration` core (`@sidanclaw/core`), modelled on Claude Code's
 * long-running-agent harness (Anthropic, "Effective harnesses for long-running
 * agents"): a **stateless tick** that rehydrates its loop state from a durable
 * handoff each time, runs **one bounded iteration**, self-verifies a
 * **verifiable predicate** (`done_when`), and re-arms — rather than holding an
 * in-process loop.
 *
 * One tick = `tickGoal(goalId, carriedState)`:
 *   1. single-flight claim (atomic active→running; a lost claim just returns).
 *   2. workspace-budget gate (hosted only): over cap → blocked.
 *   3. `processGoalIteration` runs the bounded iteration:
 *        - one `dispatchRun` (create a fresh workflow run, or advance the
 *          in-flight one — the Task-subagent analog; returns only a verdict,
 *          never the run transcript);
 *        - evaluate `done_when` (engine-verified, never model-judged);
 *        - `decideContinuation` → done | blocked | continue(now/after/until);
 *        - done/blocked → `finishGoal` (write-back + deliver);
 *          continue → `rearm` writes the next one-shot tick carrying the
 *          updated `GoalLoopState`.
 *
 * `GoalLoopState` (iteration / spend / no-progress streak / in-flight run id)
 * rides the re-arm chain's handoff (the `scheduled_jobs` instructions), seeded
 * at kickoff and incremented each tick from the run's REAL recorded spend
 * (`sessionCostUsd('workflow_run_' + runId)`, R3) — so the durable truth for
 * spend is `usage_tracking`, never an in-memory counter that could drift. No
 * schema change: the run's session id is derived, not stored.
 *
 * Single-flight on the run: a run that comes back `paused` (approval / wait) is
 * ADVANCED next tick rather than stacking a fresh one — `advanceWorkflowRun` is
 * safe to call repeatedly.
 *
 * Port-injected so the whole tick is unit-testable with fakes, exactly like
 * `processGoalIteration`. The real ports (dispatch via `advanceWorkflowRun`,
 * re-arm via `scheduled_jobs`, the budget gate via `checkCreditBudget`) are
 * wired in boot.
 *
 * [COMP:workflow/goal-seeker]
 */
import {
  processGoalIteration,
  type ActingLoopDeps,
  type GoalRecord,
  type GoalStore,
} from '@sidanclaw/core'
import { buildGoalResolvers, finishGoal, type GoalDeliver } from './writeback.js'

/** The loop state carried across the re-arm chain (the durable handoff). */
export type GoalLoopState = {
  iteration: number
  spend: number
  noProgressStreak: number
  /** The in-flight run id, advanced next tick rather than re-created. Null when
   *  the prior run reached a terminal state (the next tick starts fresh). */
  runId: string | null
}

export type DispatchRunResult = {
  runId: string
  /** The run reached a terminal state (completed / failed / timeout). */
  terminal: boolean
  /** The run completed successfully (the "progress" signal). */
  completed: boolean
}

export type GoalDriverDeps = {
  goalStore: GoalStore
  /** Single-flight claim: atomically flip `active`→`running`. `false` means
   *  another tick already owns this goal — the caller returns without acting. */
  tryClaim: (goalId: string) => Promise<boolean>
  /** Per-run COGS read (R3). Spend for a run = `sessionCostUsd('workflow_run_'
   *  + runId)` — the run's session id is derived, not stored. */
  sessionCostUsd: (sessionId: string) => Promise<number>
  /** §4.13 — is COGS spend being recorded? `false` in OSS (no `usageStore`) →
   *  acting goals block on the metering barrier. */
  meteringAvailable: () => boolean
  /** Optional workspace-budget gate (hosted): `false` → the goal blocks (the
   *  workspace is over its monthly cap; an autonomous loop must not run a
   *  workspace into the ground). Omitted (OSS) → no cap check. */
  workspaceBudgetOk?: (workspaceId: string) => Promise<boolean>
  /** Dispatch one bounded run: create a fresh run of `goal.means.workflowId`,
   *  or advance the in-flight `runId`, to terminal-or-pause. */
  dispatchRun: (params: { goal: GoalRecord; runId: string | null }) => Promise<DispatchRunResult>
  /** Terminal delivery (no silent termination, §7). */
  deliver: GoalDeliver
  /** Re-arm: schedule the next goal tick to fire at `fireAt`, carrying `state`. */
  scheduleGoalTick: (goal: GoalRecord, fireAt: Date, state: GoalLoopState) => Promise<void>
  /** Injected clock (api side; the core takes `now` as a string param). */
  now: () => Date
}

const INITIAL_STATE: GoalLoopState = { iteration: 0, spend: 0, noProgressStreak: 0, runId: null }

/** `until:event` resume has no real dispatcher yet (R2) — a parked goal polls
 *  its in-flight run on this fixed backoff until the run completes. */
const UNTIL_EVENT_POLL_SECONDS = 60

export type GoalDriver = {
  /** Run one iteration of the goal. `carried` is the loop state handed off from
   *  the prior tick (absent on the first tick → seeded). */
  tickGoal: (goalId: string, carried?: GoalLoopState) => Promise<void>
  /** Arm the first tick of an acting goal (a goal with a `means.workflowId`).
   *  A no-means monitor / structural goal is left to the rollup. */
  kickoffGoal: (goalId: string) => Promise<void>
}

export function createGoalDriver(deps: GoalDriverDeps): GoalDriver {
  const finishDeps = { goalStore: deps.goalStore, deliver: deps.deliver }

  async function tickGoal(goalId: string, carried?: GoalLoopState): Promise<void> {
    const goal = await deps.goalStore.getByIdSystem(goalId)
    if (!goal) return
    // A workflow must never autonomously complete a task whose goal the user has
    // not confirmed. If a tick fires on an unconfirmed goal, BLOCK it and ask the
    // user to clarify — never silently skip, never silently run (autopilot §4
    // enforcement). Normal kickoff already requires confirmation, so this is the
    // defense-in-depth net. `confirmGoal` un-blocks it.
    if (!goal.confirmedAt) {
      await finishGoal(goal, 'blocked', 'unconfirmed_needs_clarification', finishDeps)
      return
    }
    // Single-flight: only one tick may drive a goal at a time. The claim flips
    // `active`→`running` atomically; a lost claim means a concurrent tick (a
    // re-arm racing an event wake) already owns it.
    if (!(await deps.tryClaim(goalId))) return

    const state = carried ?? INITIAL_STATE
    const nowDate = deps.now()

    // Workspace-budget backstop (hosted): an autonomous loop respects the same
    // monthly cap a chat turn does. Over cap → block + escalate (the user can
    // upgrade / wait, then re-activate). OSS omits the gate.
    if (deps.meteringAvailable() && deps.workspaceBudgetOk && !(await deps.workspaceBudgetOk(goal.workspaceId))) {
      await finishGoal(goal, 'blocked', 'workspace_over_budget', finishDeps)
      return
    }

    // Per-tick run bookkeeping, captured in the closures below so `rearm` can
    // write the updated handoff without the core threading it back.
    let activeRunId = state.runId
    let lastSpend = 0
    let lastProgressed = false

    const loopDeps: ActingLoopDeps = {
      meteringAvailable: deps.meteringAvailable,
      runIteration: async (g) => {
        const r = await deps.dispatchRun({ goal: g, runId: activeRunId })
        // Terminal run → clear the id so the next tick starts a fresh iteration;
        // paused run → keep it so the next tick advances the same run.
        activeRunId = r.terminal ? null : r.runId
        lastSpend = await deps.sessionCostUsd(`workflow_run_${r.runId}`)
        lastProgressed = r.completed
        return {
          progressed: r.completed,
          // A non-terminal (paused) run is "waiting on the world" — surface it
          // as an event-wait so the gate re-arms on the poll cadence, not now.
          awaitingEvent: r.terminal ? null : { runId: r.runId },
          spend: lastSpend,
        }
      },
      resolversFor: (g) => buildGoalResolvers(g, deps.goalStore),
      setStatus: (id, s) => deps.goalStore.setStatusSystem(id, s).then(() => undefined),
      finish: (g, terminal, reason) => finishGoal(g, terminal, reason, finishDeps),
      rearm: async (g, resume) => {
        const nextState: GoalLoopState = {
          iteration: state.iteration + 1,
          spend: state.spend + lastSpend,
          noProgressStreak: lastProgressed ? 0 : state.noProgressStreak + 1,
          runId: activeRunId,
        }
        const fireAt =
          resume.kind === 'now'
            ? nowDate
            : resume.kind === 'after'
              ? new Date(nowDate.getTime() + resume.seconds * 1000)
              : // `until:event` — no dispatcher yet (R2); poll the in-flight run.
                new Date(nowDate.getTime() + UNTIL_EVENT_POLL_SECONDS * 1000)
        await deps.scheduleGoalTick(g, fireAt, nextState)
      },
    }

    await processGoalIteration(goal, state, nowDate.toISOString(), loopDeps)
  }

  async function kickoffGoal(goalId: string): Promise<void> {
    const goal = await deps.goalStore.getByIdSystem(goalId)
    // Only a confirmed, acting goal (a workflow means) self-drives; a draft, or
    // a no-means monitor / structural goal, is not kicked off here.
    if (!goal || !goal.means.workflowId || !goal.confirmedAt) return
    await deps.scheduleGoalTick(goal, deps.now(), INITIAL_STATE)
  }

  return { tickGoal, kickoffGoal }
}
