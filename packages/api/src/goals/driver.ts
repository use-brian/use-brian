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
  type EventSubscription,
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
  /** Consecutive ticks that ERRORED (threw) rather than completed an iteration.
   *  Optional so pre-existing handoffs parse as 0. Reset by every successful
   *  re-arm; at `MAX_CONSECUTIVE_TICK_ERRORS` the goal blocks loudly. */
  errorStreak?: number
}

/** Budget applied at kickoff when the author set none of maxIterations /
 *  maxSpend / deadline — an acting goal never runs unbudgeted (a goal whose
 *  workflow completes without meeting `done_when` would otherwise re-arm on
 *  the `now` cadence forever, bounded only by the workspace credit cap). */
export const DEFAULT_GOAL_BUDGET = { maxIterations: 30, maxSpend: 5 } as const

/** Consecutive errored ticks before the goal gives up loudly (`blocked`,
 *  `tick_error: …`) instead of re-arming another backoff retry. */
export const MAX_CONSECUTIVE_TICK_ERRORS = 5

/** Backoff for an errored tick: 60s doubling per consecutive error, capped at
 *  15 min. Distinct from the continuation gate's no-progress backoff — an
 *  errored tick never reaches the gate. */
export function tickErrorBackoffSeconds(errorStreak: number): number {
  return Math.min(900, 60 * 2 ** Math.max(0, errorStreak - 1))
}

/** The `scheduled_jobs.instructions` discriminant that marks a row as a goal
 *  tick (the acting-loop re-arm), written by `scheduleGoalTick` (boot). A
 *  goal-tick row intentionally carries NO `workflow_id` column — the goal's own
 *  `means.workflowId` drives each iteration and the tick payload rides in
 *  `instructions`. Because the executor's `!workflow_id` invariant would
 *  otherwise reject the row before the delegate can run it, both the delegate
 *  (`runWorkflowFromJob`) and that invariant's exemption key off THIS shape —
 *  so it lives in one place. */
export const GOAL_TICK_KIND = 'goal_tick'

/** Parse a scheduled-job `instructions` string as a goal tick, or `null` when it
 *  is not one (plain reminder text, a workflow trigger, or malformed JSON). The
 *  single source of truth for the `{ kind, goalId, state }` shape — the writer,
 *  the job delegate, and the executor's no-`workflow_id` exemption all go through
 *  here so they can never drift (the drift is exactly what stalled the autopilot
 *  acting loop on 2026-07-13). */
export function parseGoalTick(
  instructions: string,
): { goalId: string; state?: GoalLoopState } | null {
  try {
    const p = JSON.parse(instructions) as { kind?: string; goalId?: string; state?: GoalLoopState }
    if (p.kind === GOAL_TICK_KIND && p.goalId) return { goalId: p.goalId, state: p.state }
  } catch {
    /* not JSON / not a goal tick — the caller falls through to the workflow paths */
  }
  return null
}

/** The durable event-park marker the driver persists while a goal waits on an
 *  external event (`until:event`). `subscriptions` is what the workflow event
 *  dispatcher matches to resume the goal; `state` is the loop-state handoff,
 *  preserved so the budget counters survive the wait. Mirrors
 *  `GoalAwaitingEventMarker` in `db/goals.ts` (the store keeps `state` opaque;
 *  here it is typed). */
export type GoalAwaitingEvent = {
  subscriptions: EventSubscription[]
  state?: GoalLoopState
}

export type DispatchRunResult = {
  runId: string
  /** The run reached a terminal state (completed / failed / timeout). */
  terminal: boolean
  /** The run completed successfully (the "progress" signal). */
  completed: boolean
  /** Set when the iteration's agent parked the goal on an external event this
   *  iteration (the `waitForEvent` tool wrote the subscriptions). Drives the
   *  `until:event` re-arm (durable marker + safety net) instead of the
   *  paused-run poll. Null / absent → not parked on an event. */
  eventSubscriptions?: EventSubscription[] | null
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
  /** Read a goal's durable event-park marker (`until:event`), or null when not
   *  parked. Used by `resumeOnEvent` to restore the preserved loop state. */
  getAwaitingEvent: (goalId: string) => Promise<GoalAwaitingEvent | null>
  /** Persist the event-park marker (the re-arm's external-park branch) so the
   *  event dispatcher can resume the goal AND the budget counters survive. */
  setAwaitingEvent: (goalId: string, marker: GoalAwaitingEvent) => Promise<void>
  /** Drop the event-park marker. Returns true iff a marker was actually cleared
   *  — so an event resume is claimed exactly once under concurrent events. */
  clearAwaitingEvent: (goalId: string) => Promise<boolean>
  /** Persist `DEFAULT_GOAL_BUDGET` onto a goal arming with an empty budget and
   *  return the updated record. Optional: absent → arm with whatever the goal
   *  has (tests / minimal wirings). */
  applyDefaultBudget?: (goalId: string, budget: typeof DEFAULT_GOAL_BUDGET) => Promise<GoalRecord | null>
  /** Observability hook for a tick that threw: fired after the driver handled
   *  the error (backoff re-arm, or the loud terminal block when `willRetry` is
   *  false). Boot wires a `goal_tick_error` analytics event. Best-effort. */
  onTickError?: (goal: GoalRecord, error: unknown, willRetry: boolean) => void
  /** Injected clock (api side; the core takes `now` as a string param). */
  now: () => Date
}

/** The fresh loop state a chain starts (or restarts — the reaper's recovery
 *  re-arm) from. */
export const INITIAL_GOAL_LOOP_STATE: GoalLoopState = { iteration: 0, spend: 0, noProgressStreak: 0, runId: null }
const INITIAL_STATE = INITIAL_GOAL_LOOP_STATE

/** A paused (approval / wait) run is "waiting on the world" with no external
 *  event to wake it — the goal polls its in-flight run on this fixed backoff
 *  until the run completes. (Distinct from an `until:event` external park, which
 *  is woken by the dispatcher and backstopped by the safety net below.) */
const UNTIL_EVENT_POLL_SECONDS = 60

/** Safety-net cadence for an external event park: when a goal parks on
 *  `until:event` the dispatcher is the primary wake path, but a far-out tick is
 *  the backstop for an event that never arrives (or a missed dispatch). Used
 *  when the goal has no `budget.deadline`; a deadline, if set, is the backstop
 *  instead. One redundant (budget-bounded) iteration if the event already
 *  resumed the goal is acceptable (v1). */
const SAFETY_NET_SECONDS = 3600

export type GoalDriver = {
  /** Run one iteration of the goal. `carried` is the loop state handed off from
   *  the prior tick (absent on the first tick → seeded). */
  tickGoal: (goalId: string, carried?: GoalLoopState) => Promise<void>
  /** Arm the first tick of an acting goal (a goal with a `means.workflowId`).
   *  A no-means monitor / structural goal is left to the rollup. */
  kickoffGoal: (goalId: string) => Promise<void>
  /** Resume a goal parked on `until:event` (the workflow event dispatcher's
   *  second-subscriber path): clear the durable marker and schedule an immediate
   *  tick restoring the preserved loop state. A no-op if the goal already
   *  un-parked (the marker is gone) so concurrent events resume it once.
   *
   *  NOTE (v1): the event payload is NOT handed to the agent — the resumed
   *  iteration re-reads the world. */
  resumeOnEvent: (goalId: string) => Promise<void>
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

    // From here the claim is OURS: an unhandled throw would strand the goal in
    // `running` (unclaimable — no re-trigger can flip it back) AND kill the
    // re-arm chain (the poll worker never retries a failed once-job). Handle
    // every error: re-arm with backoff, or give up loudly at the ceiling.
    try {
      await runClaimedTick(goal, carried)
    } catch (err) {
      await handleTickError(goal, carried, err)
    }
  }

  async function handleTickError(
    goal: GoalRecord,
    carried: GoalLoopState | undefined,
    err: unknown,
  ): Promise<void> {
    const streak = (carried?.errorStreak ?? 0) + 1
    const willRetry = streak < MAX_CONSECUTIVE_TICK_ERRORS
    console.error(
      `[goals] tick errored for goal ${goal.id} (${streak}/${MAX_CONSECUTIVE_TICK_ERRORS}${willRetry ? ', retrying' : ', giving up'}):`,
      err,
    )
    try {
      if (willRetry) {
        // Release the claim and re-arm on the error backoff, carrying the
        // bumped streak. `iteration`/`spend`/`noProgressStreak` carry unchanged
        // — an errored attempt is not a completed iteration.
        await deps.goalStore.setStatusSystem(goal.id, 'active')
        const state = carried ?? INITIAL_STATE
        const fireAt = new Date(deps.now().getTime() + tickErrorBackoffSeconds(streak) * 1000)
        await deps.scheduleGoalTick(goal, fireAt, { ...state, errorStreak: streak })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        await finishGoal(goal, 'blocked', `tick_error: ${msg.slice(0, 200)}`, finishDeps)
      }
      deps.onTickError?.(goal, err, willRetry)
    } catch (recoveryErr) {
      // The recovery itself failed — rethrow the ORIGINAL error so the poll
      // worker marks the job failed; the stall reaper is the backstop.
      console.error(`[goals] tick-error recovery failed for goal ${goal.id}:`, recoveryErr)
      throw err
    }
  }

  async function runClaimedTick(goal: GoalRecord, carried?: GoalLoopState): Promise<void> {
    const goalId = goal.id
    // This tick is acting NOW (a resume, a safety-net fire, or a normal tick),
    // so drop any stale `until:event` park marker: a fresh decision (park again,
    // or not) follows from this iteration. Clearing here also takes the goal out
    // of the dispatcher's event-waiting set while it runs, and un-parks a goal
    // whose safety net fired because its event never arrived.
    await deps.clearAwaitingEvent(goalId)

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
        const eventSubs = r.eventSubscriptions ?? null
        return {
          progressed: r.completed,
          // Priority: the agent parked this goal on an EXTERNAL event this
          // iteration (`waitForEvent`) → surface the subscriptions so the gate
          // picks `until:event` and `rearm` persists the durable marker + safety
          // net. Otherwise a non-terminal (paused) run is "waiting on the world"
          // — surface it as `{runId}` so the gate re-arms on the poll cadence; a
          // terminal run with no event park is not awaiting anything.
          awaitingEvent:
            eventSubs && eventSubs.length > 0
              ? { eventSubscriptions: eventSubs }
              : r.terminal
                ? null
                : { runId: r.runId },
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
          // A completed iteration (even a no-progress one) clears the errored-
          // tick streak — only CONSECUTIVE throws count toward the ceiling.
          errorStreak: 0,
        }
        if (resume.kind === 'until') {
          // `until:event` — two shapes carry through the (opaque) resume event:
          const subs = (resume.event as { eventSubscriptions?: EventSubscription[] }).eventSubscriptions
          if (subs && subs.length > 0) {
            // (a) EXTERNAL event park (`waitForEvent`): persist the durable
            // marker WITH the loop state so the dispatcher can resume the goal
            // and the budget counters survive the wait; arm a far-out safety-net
            // tick (the deadline, else `SAFETY_NET_SECONDS`) as the backstop for
            // an event that never arrives.
            await deps.setAwaitingEvent(g.id, { subscriptions: subs, state: nextState })
            const safetyFireAt = g.budget.deadline
              ? new Date(g.budget.deadline)
              : new Date(nowDate.getTime() + SAFETY_NET_SECONDS * 1000)
            await deps.scheduleGoalTick(g, safetyFireAt, nextState)
            return
          }
          // (b) PAUSED run (`{runId}`): no external event — poll the in-flight
          // run on the fixed cadence until it completes.
          await deps.scheduleGoalTick(
            g,
            new Date(nowDate.getTime() + UNTIL_EVENT_POLL_SECONDS * 1000),
            nextState,
          )
          return
        }
        const fireAt =
          resume.kind === 'now'
            ? nowDate
            : new Date(nowDate.getTime() + resume.seconds * 1000)
        await deps.scheduleGoalTick(g, fireAt, nextState)
      },
    }

    await processGoalIteration(goal, state, nowDate.toISOString(), loopDeps)
  }

  async function kickoffGoal(goalId: string): Promise<void> {
    let goal = await deps.goalStore.getByIdSystem(goalId)
    // Only a confirmed, acting goal (a workflow means) self-drives; a draft, or
    // a no-means monitor / structural goal, is not kicked off here.
    if (!goal || !goal.means.workflowId || !goal.confirmedAt) return
    // No unbudgeted autonomy: every arming path converges here, so a goal whose
    // author set none of the three hard backstops arms with the default budget
    // (the task-autopilot draft path always arrives with `budget = {}`).
    const b = goal.budget
    if (deps.applyDefaultBudget && b.maxIterations === undefined && b.maxSpend === undefined && !b.deadline) {
      goal = (await deps.applyDefaultBudget(goal.id, DEFAULT_GOAL_BUDGET)) ?? goal
    }
    await deps.scheduleGoalTick(goal, deps.now(), INITIAL_STATE)
  }

  async function resumeOnEvent(goalId: string): Promise<void> {
    // Read the park marker first so we can restore the preserved loop state.
    const marker = await deps.getAwaitingEvent(goalId)
    if (!marker) return // already un-parked by a concurrent tick — nothing to do.
    // Atomically claim the resume: only the caller that actually flips the
    // marker null schedules the tick, so two events racing on one goal resume it
    // exactly once (the loser no-ops). This also removes the goal from the
    // dispatcher's event-waiting set immediately.
    if (!(await deps.clearAwaitingEvent(goalId))) return
    const goal = await deps.goalStore.getByIdSystem(goalId)
    if (!goal) return
    // Schedule an immediate tick restoring the budget counters (the safety-net
    // tick armed at park time may still fire later; that is a budget-bounded
    // redundant iteration, accepted in v1).
    await deps.scheduleGoalTick(goal, deps.now(), marker.state ?? INITIAL_STATE)
  }

  return { tickGoal, kickoffGoal, resumeOnEvent }
}
