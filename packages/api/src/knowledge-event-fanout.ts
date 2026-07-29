/**
 * Late-bound knowledge-lifecycle → workflow-event seam.
 *
 * The KB store (`db/knowledge-store.ts`) is constructed all over the API
 * layer, but the shared `WorkflowEventDispatcher` is constructed late in
 * `bootOpenApi` — once the run store + executor deps exist. This module
 * bridges the ordering exactly like `task-event-fanout.ts` and
 * `page-event-fanout.ts`: the store's write methods publish every entry
 * create / update / delete here, and `bootOpenApi` binds the dispatcher once
 * via `setKnowledgeEventDispatcher`. Until then (or if a build never binds
 * one) `publishKnowledgeLifecycle` is a no-op.
 *
 * The bind lives in `bootOpenApi` — not the closed app boot — so BOTH
 * editions get knowledge-event triggers: the OSS standalone entry
 * (`@use-brian/api-open`) and the closed platform app (`@use-brian/api-server`).
 *
 * Best-effort: the dispatch is fire-and-forget and swallows its own errors,
 * so a KB write never waits on — or fails because of — a workflow start. This
 * matters more here than for tasks: the sync worker writes one entry per
 * changed file in a tight loop, and a slow dispatch would stretch the tick.
 *
 * [COMP:api/knowledge-event-fanout]
 */

import {
  createKnowledgeLifecycleTrigger,
  type KnowledgeLifecycleEvent,
  type WorkflowEventDispatcher,
} from '@use-brian/core'

let sink: ((event: KnowledgeLifecycleEvent) => Promise<void>) | null = null

/**
 * Bind (or unbind, with `null`) the workflow event dispatcher the KB write
 * path feeds. Idempotent — the last writer wins. Called once by `bootOpenApi`
 * after the dispatcher is constructed.
 */
export function setKnowledgeEventDispatcher(
  dispatcher: WorkflowEventDispatcher | null | undefined,
): void {
  sink = dispatcher ? createKnowledgeLifecycleTrigger(dispatcher) : null
}

/**
 * Publish one knowledge-lifecycle event to the bound dispatcher. Best-effort
 * and fire-and-forget: returns immediately, never throws, and is a no-op when
 * no dispatcher is bound.
 */
export function publishKnowledgeLifecycle(event: KnowledgeLifecycleEvent): void {
  const s = sink
  if (!s) return
  void s(event).catch(() => {
    // a failed workflow start must never break a KB write
  })
}
