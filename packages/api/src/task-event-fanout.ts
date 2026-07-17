/**
 * Late-bound task-lifecycle → workflow-event seam.
 *
 * The task write helpers (`db/tasks.ts`) are plain functions imported all
 * over the API layer, but the shared `WorkflowEventDispatcher` is constructed
 * late in `bootOpenApi` — once the run store + executor deps exist. This
 * module bridges the ordering exactly like `page-event-fanout.ts`: the write
 * path publishes every task create / update here, and `bootOpenApi` binds the
 * dispatcher once via `setTaskEventDispatcher`. Until then (or if a build
 * never binds one) `publishTaskLifecycle` is a no-op.
 *
 * The bind lives in `bootOpenApi` — not the closed app boot — so BOTH
 * editions get task-event triggers: the OSS standalone entry
 * (`@use-brian/api-open`) and the closed platform app (`@use-brian/api-server`).
 *
 * Best-effort: the dispatch is fire-and-forget and swallows its own errors,
 * so a task write never waits on — or fails because of — a workflow start.
 *
 * [COMP:api/task-event-fanout]
 */

import {
  createTaskLifecycleTrigger,
  type TaskLifecycleEvent,
  type WorkflowEventDispatcher,
} from '@use-brian/core'

let sink: ((event: TaskLifecycleEvent) => Promise<void>) | null = null

/**
 * Bind (or unbind, with `null`) the workflow event dispatcher the task write
 * path feeds. Idempotent — the last writer wins. Called once by `bootOpenApi`
 * after the dispatcher is constructed.
 */
export function setTaskEventDispatcher(
  dispatcher: WorkflowEventDispatcher | null | undefined,
): void {
  sink = dispatcher ? createTaskLifecycleTrigger(dispatcher) : null
}

/**
 * Publish one task-lifecycle event to the bound dispatcher. Best-effort and
 * fire-and-forget: returns immediately, never throws, and is a no-op when no
 * dispatcher is bound.
 */
export function publishTaskLifecycle(event: TaskLifecycleEvent): void {
  const s = sink
  if (!s) return
  void s(event).catch(() => {
    // a failed workflow start must never break a task write
  })
}
