/**
 * Goal terminal write-back + resolvers — shared by the non-acting rollup
 * (`rollup-runner.ts`) and the acting loop (`driver.ts`).
 *
 * Both paths need the same two things when a goal reaches a verdict:
 *   - `buildGoalResolvers` — the `done_when` resolvers (the `subtasks` leaf via
 *     the host adapter / sub-goal count; `query` / `tool` conservatively
 *     not-confirmed, so neither path false-completes on an unverified predicate
 *     — a real query/tool evaluator is a follow-up).
 *   - `finishGoal` — terminal write-back: set the goal's status, write back to
 *     the host (the task adapter closes/blocks the host task; readonly adapters
 *     no-op), and deliver the terminal message (no silent termination, §7).
 *
 * Keeping these in one place is why the rollup and the acting loop can never
 * disagree about how a goal completes or how it is delivered.
 *
 * [COMP:goals/writeback]
 */
import {
  type DoneWhenResolvers,
  type GoalHostTerminal,
  type GoalRecord,
  type GoalStore,
} from '@sidanclaw/core'
import { query } from '../db/client.js'
import { createHostStore } from './host-task.js'

/** Deliver a goal's terminal message to its creator / `policy.escalateTo`.
 *  Best-effort; callers swallow its rejection so a delivery failure never
 *  wedges the loop. */
export type GoalDeliver = (
  goal: GoalRecord,
  terminal: GoalHostTerminal,
  reason: string | null,
) => Promise<void>

/** `done_when` resolvers shared by the rollup (non-acting) and the driver
 *  (acting): `subtasks` is real (host adapter for a host-bound goal, sub-goal
 *  count for self-hosted); `query` / `tool` resolve to NOT-confirmed (`false`)
 *  pending a real evaluator, so an unverified predicate never false-completes. */
export function buildGoalResolvers(goal: GoalRecord, goalStore: GoalStore): DoneWhenResolvers {
  return {
    subtasksClosed: async () => {
      if (goal.host) {
        // Host-bound: the host adapter answers "no open sub-tasks". The task
        // adapter's read uses the owner pool and ignores the actor id, so a
        // null creator is harmless on this read path.
        const hostStore = createHostStore({ actorUserId: goal.createdByUserId ?? '' })
        return (await hostStore.adapterFor(goal.host.type).acceptanceSource(goal.host)).subtasksClosed
      }
      // Self-hosted: met once no open sub-goals remain.
      return (await goalStore.countOpenSubGoalsSystem(goal.id)) === 0
    },
    query: async (q) => {
      // The one query predicate the autopilot uses today: the bound task is
      // done. A task-completion goal's done_when is
      // `{kind:'query', query:{predicate:{hostTaskDone:true}}}` — it holds when
      // the host task's active row has status 'done' (the acting loop's
      // workflow closes the task; the next iteration verifies it here). Any
      // other predicate stays not-confirmed (a general predicate engine is a
      // follow-up), so it never false-completes. See task-goal-autopilot.md.
      if (goal.host?.type === 'task' && q.predicate?.hostTaskDone === true) {
        // Follow the bi-temporal supersession chain from the (possibly stale)
        // host id to the LIVE row: `updateTask` mints a new id on every edit,
        // including the close, so a direct id lookup would miss the done row.
        const res = await query<{ done: string }>(
          `WITH RECURSIVE chain AS (
             SELECT id, status, valid_to, superseded_by FROM tasks WHERE id = $1
             UNION ALL
             SELECT t.id, t.status, t.valid_to, t.superseded_by
               FROM tasks t JOIN chain ch ON t.id = ch.superseded_by
           )
           SELECT count(*)::text AS done FROM chain
             WHERE valid_to IS NULL AND status = 'done'`,
          [goal.host.id],
        )
        return Number(res.rows[0]?.done ?? '0') > 0
      }
      return false
    },
    tool: async () => false,
    verifiedDone: async () => {
      // Agentic termination (§12): the `markGoalComplete` tool stamps
      // `completion_claim` ONLY after the adversarial verifier passed. Re-read
      // FRESH — the marker is written during the iteration that ran just before
      // this evaluation, so the `goal` snapshot passed in is stale. A null
      // marker = not verified (the fail-safe: a verify goal completes only on a
      // verifier pass, never on an unverified claim).
      const res = await query<{ claim: unknown }>(
        `SELECT completion_claim AS claim FROM goals WHERE id = $1`,
        [goal.id],
      )
      return res.rows[0]?.claim != null
    },
  }
}

/** Terminal write-back for a goal (`done` | `blocked`): set the status (+ blocker
 *  reason), write back to the host (task adapter closes/blocks the host task;
 *  readonly adapters no-op — the goal's own status is their record of truth),
 *  and deliver the terminal message. No silent termination (§7). */
export async function finishGoal(
  goal: GoalRecord,
  terminal: GoalHostTerminal,
  reason: string | null,
  deps: { goalStore: GoalStore; deliver: GoalDeliver },
): Promise<void> {
  await deps.goalStore.setStatusSystem(goal.id, terminal, reason)
  if (goal.host && goal.createdByUserId) {
    const hostStore = createHostStore({ actorUserId: goal.createdByUserId })
    await hostStore.adapterFor(goal.host.type).setTerminal(goal.host, terminal, reason)
  }
  await deps.deliver(goal, terminal, reason)
}
