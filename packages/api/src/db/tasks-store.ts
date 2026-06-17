import type { EntityLinksStore, TaskStore } from '@sidanclaw/core'
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
 */
export function createDbTaskStore(deps: { entityLinks?: EntityLinksStore } = {}): TaskStore {
  const { entityLinks } = deps
  return {
    create({ userId, ...params }) {
      // `linkedEntityIds` is not on the `TaskStore.create` interface
      // yet (a follow-up type widening) — read it via a permissive
      // cast and thread it into `createTask` for the `mentioned` edge.
      const extras = params as typeof params & { linkedEntityIds?: readonly string[] }
      return createTask(userId, { ...params, linkedEntityIds: extras.linkedEntityIds }, entityLinks)
    },
    getById(ctx, id) {
      return getTaskById(ctx, id)
    },
    list(ctx, filters) {
      return listTasks(ctx, filters)
    },
    update(userId, id, fields) {
      return updateTask(userId, id, fields, entityLinks)
    },
  }
}
