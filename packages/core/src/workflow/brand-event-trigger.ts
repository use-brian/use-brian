/**
 * Brand primitive → workflow event-trigger adapter.
 *
 * The seventh event producer, joining the connector half
 * (`ingest/workflow-trigger.ts`), the channel half (the Slack webhook), the
 * page half (`page-event-trigger.ts`), the task half
 * (`task-event-trigger.ts`), and the knowledge half
 * (`knowledge-event-trigger.ts`). A brand created, edited as a draft,
 * approved, or superseded is normalized here into the source-agnostic
 * `DispatchEvent` and handed to the shared `WorkflowEventDispatcher`.
 *
 * Like the task and knowledge sources it is *internal*: no poller, no
 * webhook. The brand store's write methods (`packages/api/src/db/brand-store.ts`)
 * are the chokepoint every writer funnels through — the Studio routes, the
 * `updateBrandDraft` chat tool, and the brain-MCP `saveBrandDraft` bridge —
 * and they publish after commit via the late-bound seam in
 * `packages/api/src/brand-event-fanout.ts`.
 *
 * Also **id-less** (`{type:'brand'}`), for the same reason as the other two:
 * a workspace's brand system is one corpus even when it holds several brands
 * (decision D5 keeps the schema multi-brand and the UX single-brand), so the
 * subscription scope is every brand write in the workspace and `match`
 * carries all the selectivity. The brand slug rides `tags`, so a multi-brand
 * workspace can still scope a subscription to one brand without a second
 * source variant.
 *
 * **The event is a pointer, not a payload.** It carries the brand's id, slug,
 * lifecycle action, and version — never the record body. A triggered step
 * reads the record with `getBrand` under its own assistant's clearance, so an
 * event from a `confidential` brand cannot leak that record's contents into a
 * workflow whose assistant could not have read it. This is the same rule the
 * knowledge source holds, and it matters more here: a brand record carries
 * unannounced positioning and prohibited claims.
 *
 * Spec: docs/architecture/features/brand.md → "Brand lifecycle events".
 *
 * [COMP:workflow/brand-event-trigger]
 */

import type { DispatchEvent, WorkflowEventDispatcher } from './event-trigger.js'

/** The brand lifecycle actions that fire a brand-source workflow. */
export const BRAND_LIFECYCLE_ACTIONS = ['created', 'updated', 'approved', 'superseded'] as const
export type BrandLifecycleAction = (typeof BRAND_LIFECYCLE_ACTIONS)[number]

/**
 * Who authored the write. `system` = an assistant (the `updateBrandDraft`
 * chat tool, the brain-MCP `saveBrandDraft` bridge, any automated path);
 * `user` = a human acting through Studio.
 *
 * Becomes `DispatchEvent.isBot`, which is the self-loop guard: a maintenance
 * workflow that itself proposes brand edits would otherwise re-trigger on its
 * own draft write and run forever. Defaults to `user` at the emit site,
 * because the write that matters most — approval — is always human.
 */
export type BrandWriteActor = 'user' | 'system'

/**
 * What the brand write path hands the producer. Every field is metadata the
 * store already holds after the write — no extra read, and deliberately no
 * record body (see the module header).
 */
export type BrandLifecycleEvent = {
  /** Workspace the brand — and any workflow it triggers — belongs to. */
  workspaceId: string
  /** `workspace_brands.id`. Feeds `getBrand` from a step. */
  brandId: string
  /** Which lifecycle facet fired. */
  action: BrandLifecycleAction
  /** Brand slug — the natural scoping axis, matched via `match.tags`. */
  slug: string
  /** Brand display name — the `keywords` haystack. */
  name: string
  /**
   * Approved version number. Set on `approved` (the version just minted) and
   * on `superseded` (the version that was retired). Null for draft-only
   * writes, which have no version by definition.
   */
  version: number | null
  /** The acting user id; null for a system path with no human behind it. */
  actorId: string | null
  /** Who authored the write. Defaults to `user` at the emit site. */
  writtenBy?: BrandWriteActor
}

/**
 * Normalize a brand-lifecycle event into a source-agnostic `DispatchEvent`.
 *
 * `text` is the brand name (matched by `keywords`); the lifecycle action
 * rides `channelId` (matched by `inChannels`); the slug rides `tags` (matched
 * by `match.tags`), which is what lets a multi-brand workspace subscribe to
 * one brand; `writtenBy` becomes `isBot`.
 *
 * The raw payload is written verbatim to `workflow_runs.input.event` so a
 * step addresses `{{input.event.brandId}}` / `{{input.event.slug}}` without a
 * lookup round-trip.
 */
export function brandLifecycleToDispatchEvent(event: BrandLifecycleEvent): DispatchEvent {
  return {
    workspaceId: event.workspaceId,
    source: { type: 'brand' },
    text: event.name,
    actorId: event.actorId,
    channelId: event.action,
    mentions: [],
    tags: [event.slug],
    isBot: event.writtenBy === 'system',
    payload: {
      brandId: event.brandId,
      action: event.action,
      slug: event.slug,
      name: event.name,
      version: event.version,
      actorId: event.actorId,
    },
  }
}

/**
 * Build the brand write path's lifecycle sink. Wired by the late-bound seam
 * in `packages/api/src/brand-event-fanout.ts`; the store's write methods
 * invoke it best-effort (fire-and-forget) so a brand write never waits on —
 * or fails because of — a workflow start.
 */
export function createBrandLifecycleTrigger(
  dispatcher: WorkflowEventDispatcher,
): (event: BrandLifecycleEvent) => Promise<void> {
  return async (event) => {
    await dispatcher.dispatch(brandLifecycleToDispatchEvent(event))
  }
}
