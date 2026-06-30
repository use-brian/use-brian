/**
 * Task host adapter — wires a goal whose host is a task to the tasks
 * primitive (the first `HostAdapter`; see `docs/plans/task-goal-seeker.md`
 * §3.4 / §4.12). The acting user is the goal's creator (the goal carries
 * `created_by_user_id`); the close rides the normal `updateTask` bi-temporal
 * path so it is attributed and supersedes correctly.
 *
 * KNOWN LIMITATION (supersession churn) — `updateTask` mints a NEW task id on
 * every edit, so a host task edited by a user mid-goal leaves `goals.host_id`
 * pointing at a superseded row. `acceptanceSource` resolves the active row by
 * id and reports "host missing -> not satisfied" when the link is stale, so
 * the loop blocks legibly rather than false-completing. A durable task
 * identity for the host link is a follow-up (the same bi-temporal awkwardness
 * that kept goals OUT of `tasks.attributes`).
 */
import type {
  GoalHostRef,
  GoalHostTerminal,
  GoalHostType,
  HostAdapter,
  HostStore,
} from '@sidanclaw/core'
import { query } from '../db/client.js'
import { updateTask } from '../db/tasks.js'

export function createTaskHostAdapter(deps: { actorUserId: string }): HostAdapter {
  const { actorUserId } = deps
  return {
    async setTerminal(host: GoalHostRef, terminal: GoalHostTerminal): Promise<void> {
      // 'done' -> close the task; 'blocked' -> mark it blocked. The blocker
      // reason lives on the goal (tasks have no reason field).
      const status = terminal === 'done' ? 'done' : 'blocked'
      await updateTask(actorUserId, host.id, { status })
    },
    async recordProgress(): Promise<void> {
      // No-op for tasks in v1 — per-iteration progress is read from
      // workflow_runs by the goal, not stamped on the host task.
    },
    async acceptanceSource(host: GoalHostRef): Promise<{ subtasksClosed: boolean }> {
      // True iff the active host task exists AND has no open (non
      // done/archived) sub-tasks. A superseded/missing host id returns
      // exists=0, which we surface as `false` so a stale link blocks the
      // loop instead of false-completing it.
      const res = await query<{ open: string; present: string }>(
        `SELECT
           (SELECT count(*) FROM tasks WHERE id = $1 AND valid_to IS NULL)::text AS present,
           (SELECT count(*) FROM tasks
              WHERE parent_id = $1 AND valid_to IS NULL
                AND status <> ALL (ARRAY['done', 'archived']))::text AS open`,
        [host.id],
      )
      const present = Number(res.rows[0]?.present ?? '0') > 0
      const open = Number(res.rows[0]?.open ?? '0')
      return { subtasksClosed: present && open === 0 }
    },
  }
}

/**
 * Conservative adapter for page / entity / workflow hosts. These hosts have no
 * natural "done" status to force, and the host-frozen invariant says we don't
 * mutate them — so `setTerminal` is a no-op (the goal's own status + the goals
 * board is the record of truth). Richer per-host write-back (post a comment,
 * move a deal stage, ...) is a future product decision. `acceptanceSource`
 * throws: a non-task host has no sub-tasks, so a `subtasks` done_when is a
 * misuse — these hosts drive on a `query` / `tool` predicate.
 */
function createReadonlyHostAdapter(type: GoalHostType): HostAdapter {
  return {
    async setTerminal() {},
    async recordProgress() {},
    async acceptanceSource(): Promise<{ subtasksClosed: boolean }> {
      throw new Error(
        `'subtasks' done_when is not applicable to a '${type}' host — use a query/tool predicate`,
      )
    },
  }
}

/**
 * Build a HostStore bound to a goal's acting context. The `task` adapter writes
 * back to the tasks primitive; `page` / `entity` / `workflow` use the
 * conservative read-only adapter (no host mutation, query/tool acceptance)
 * pending a product decision on richer write-back. Self-hosted goals (host
 * null) are handled by the goal store, not here.
 */
export function createHostStore(deps: { actorUserId: string }): HostStore {
  const task = createTaskHostAdapter(deps)
  const readonly: Record<Exclude<GoalHostType, 'task'>, HostAdapter> = {
    page: createReadonlyHostAdapter('page'),
    entity: createReadonlyHostAdapter('entity'),
    workflow: createReadonlyHostAdapter('workflow'),
  }
  return {
    adapterFor(type: GoalHostType): HostAdapter {
      return type === 'task' ? task : readonly[type]
    },
  }
}
