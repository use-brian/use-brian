import type { EntityLinksStore, TaskRecord, TaskStore } from '@sidanclaw/core'
import { createTask, getTaskById, listTasks, updateTask } from './tasks.js'

/**
 * Create a TaskStore backed by PostgreSQL.
 * Adapts the SQL helpers in `tasks.ts` to the core `TaskStore` interface.
 *
 * All operations route through `queryWithRLS(userId, ...)` so the
 * `tasks_workspace_member` RLS policy enforces workspace isolation. The
 * SQL also filters by `workspace_id` explicitly — RLS is the second
 * layer of defense.
 *
 * WU-1.7 — the optional `entityLinks` dependency wires the edge-write
 * hook: `create` emits a `task → entity` `mentioned` edge per id in the
 * (cast-supplied) `linkedEntityIds` field, fire-and-forget. Optional so
 * callers without the graph layer keep working.
 *
 * The optional `onTaskTerminal` dependency wires the goal-seeker structural
 * rollup: when a sub-task closes (transitions to a terminal status), the
 * goal-seeker re-checks goals bound to that sub-task's PARENT — a parent's
 * `subtasks` done_when becomes met once its last open child closes (see
 * `docs/architecture/features/goals.md` → "The structural rollup"). Same
 * shape as `entityLinks`: best-effort, fire-and-forget, never blocks or
 * fails the task write, and absent callers keep working unchanged.
 *
 * The optional `onTaskCreate` dependency wires the task-autopilot auto-draft:
 * a TOP-LEVEL task auto-drafts a (curated, UNCONFIRMED) goal bound to it (see
 * `docs/plans/task-goal-autopilot.md`). A sub-task is decomposition under its
 * parent's goal, so it gets none. Same fire-and-forget contract.
 */
export function createDbTaskStore(
  deps: {
    entityLinks?: EntityLinksStore
    onTaskTerminal?: (host: { type: 'task'; id: string }) => void
    onTaskCreate?: (task: TaskRecord, userId: string) => void
  } = {},
): TaskStore {
  const { entityLinks, onTaskTerminal, onTaskCreate } = deps
  return {
    async create({ userId, ...params }) {
      // `linkedEntityIds` is not on the `TaskStore.create` interface
      // yet (a follow-up type widening) — read it via a permissive
      // cast and thread it into `createTask` for the `mentioned` edge.
      const extras = params as typeof params & { linkedEntityIds?: readonly string[] }
      const record = await createTask(userId, { ...params, linkedEntityIds: extras.linkedEntityIds }, entityLinks)
      // Autopilot: a top-level task auto-drafts a bound goal. Fire-and-forget —
      // drafting a goal must never fail or block the task write.
      if (onTaskCreate && record.parentId === null) onTaskCreate(record, userId)
      return record
    },
    getById(ctx, id) {
      return getTaskById(ctx, id)
    },
    list(ctx, filters) {
      return listTasks(ctx, filters)
    },
    async update(userId, id, fields) {
      const record = await updateTask(userId, id, fields, entityLinks)
      // Fire the rollup only on an actual close (status set to terminal) of a
      // task that has a parent to roll up to. Fire-and-forget: a goal rollup
      // must never block or break a task write (the goal also re-checks itself
      // when next driven). `updateTask` carries `parentId` forward onto the
      // new bi-temporal row, so `record.parentId` is the live parent id.
      if (
        onTaskTerminal &&
        record?.parentId &&
        (fields.status === 'done' || fields.status === 'archived')
      ) {
        onTaskTerminal({ type: 'task', id: record.parentId })
      }
      return record
    },
  }
}
