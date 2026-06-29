/**
 * Late-bound page-lifecycle → workflow-event seam.
 *
 * The saved-views store is built inside `bootOpenApi` (open), but the shared
 * `WorkflowEventDispatcher` is constructed *after* that — by the closed app
 * (`apps/api/src/index.ts`) once the run store + executor deps exist. This
 * module bridges the ordering: the store publishes every page create / update
 * / move here, and whoever owns the dispatcher binds it once via
 * `setPageEventDispatcher`. Until then (and in open builds that never build a
 * dispatcher) `publishPageLifecycle` is a no-op.
 *
 * Same shape as `page-share-fanout.ts` — a module-local holder the boot path
 * wires, keeping the store free of a construction-time dispatcher dependency.
 *
 * Best-effort: the dispatch is fire-and-forget and swallows its own errors, so
 * a page write never waits on — or fails because of — a workflow start.
 *
 * [COMP:api/page-event-fanout]
 */

import {
  createPageLifecycleTrigger,
  type PageLifecycleEvent,
  type WorkflowEventDispatcher,
} from '@sidanclaw/core'

let sink: ((event: PageLifecycleEvent) => Promise<void>) | null = null

/**
 * Bind (or unbind, with `null`) the workflow event dispatcher the page write
 * path feeds. Idempotent — the last writer wins. Called once at app boot,
 * after the dispatcher is constructed.
 */
export function setPageEventDispatcher(
  dispatcher: WorkflowEventDispatcher | null | undefined,
): void {
  sink = dispatcher ? createPageLifecycleTrigger(dispatcher) : null
}

/**
 * Publish one page-lifecycle event to the bound dispatcher. Best-effort and
 * fire-and-forget: returns immediately, never throws, and is a no-op when no
 * dispatcher is bound.
 */
export function publishPageLifecycle(event: PageLifecycleEvent): void {
  const s = sink
  if (!s) return
  void s(event).catch(() => {
    // a failed workflow start must never break a page write
  })
}
