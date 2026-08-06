/**
 * Late-bound brand-lifecycle → workflow-event seam.
 *
 * The brand store is constructed at module scope (`getBrandStore()`), but the
 * shared `WorkflowEventDispatcher` is constructed late in `bootOpenApi` —
 * once the run store + executor deps exist. This module bridges the ordering
 * exactly like `task-event-fanout.ts`, `page-event-fanout.ts`, and
 * `knowledge-event-fanout.ts`: the store's write methods publish every
 * create / draft update / approval here, and `bootOpenApi` binds the
 * dispatcher once via `setBrandEventDispatcher`. Until then (or if a build
 * never binds one) `publishBrandLifecycle` is a no-op.
 *
 * The bind lives in `bootOpenApi` — not the closed app boot — so BOTH
 * editions get brand-event triggers: the OSS standalone entry
 * (`@use-brian/api-open`) and the closed platform app (`@use-brian/api-server`).
 *
 * Best-effort: the dispatch is fire-and-forget and swallows its own errors,
 * so a brand write never waits on — or fails because of — a workflow start.
 * That matters most for approval, which is a human clicking a button in
 * Studio: a slow or broken workflow must not make Approve look like it
 * failed when the version was already committed.
 *
 * [COMP:api/brand-event-fanout]
 */

import {
  createBrandLifecycleTrigger,
  type BrandLifecycleEvent,
  type WorkflowEventDispatcher,
} from '@use-brian/core'

let sink: ((event: BrandLifecycleEvent) => Promise<void>) | null = null

/**
 * Bind (or unbind, with `null`) the workflow event dispatcher the brand write
 * path feeds. Idempotent — the last writer wins. Called once by `bootOpenApi`
 * after the dispatcher is constructed.
 */
export function setBrandEventDispatcher(
  dispatcher: WorkflowEventDispatcher | null | undefined,
): void {
  sink = dispatcher ? createBrandLifecycleTrigger(dispatcher) : null
}

/**
 * Publish one brand-lifecycle event to the bound dispatcher. Best-effort and
 * fire-and-forget: returns immediately, never throws, and is a no-op when no
 * dispatcher is bound.
 */
export function publishBrandLifecycle(event: BrandLifecycleEvent): void {
  const s = sink
  if (!s) return
  void s(event).catch(() => {
    // a failed workflow start must never break a brand write
  })
}
