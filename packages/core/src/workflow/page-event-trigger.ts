/**
 * Page → workflow event-trigger adapter (the internal-page half).
 *
 * The third event producer, alongside the connector half
 * (`ingest/workflow-trigger.ts`) and the channel half (the Slack webhook). A
 * doc page created, updated, or moved under a watched parent is normalized
 * here into the source-agnostic `DispatchEvent` and handed to the shared
 * `WorkflowEventDispatcher` (`./event-trigger.ts`).
 *
 * Unlike the other two producers, the page source is *internal*: there is no
 * poller and no webhook. The saved-views store (`packages/api/.../db/
 * saved-views-store.ts`) calls `createPageLifecycleTrigger(dispatcher)` on its
 * write path — create / update / reparent — via the late-bound seam in
 * `packages/api/src/page-event-fanout.ts`. The store knows the workspace, the
 * page, its parent, the acting user, and the action; that is everything the
 * dispatcher needs.
 *
 * Source identity is the **watched page id** — `sourceMatches` compares it
 * exactly, the `connectorInstanceId` / `channelIntegrationId` analog. Which id
 * a write maps to depends on the action: a `created` / `moved` page targets its
 * **destination parent** (you watch a page to hear about children appearing
 * under it), while an `updated` page targets **itself** (you watch a page to
 * hear about its own changes). The **lifecycle action** rides the
 * `DispatchEvent.channelId` sub-channel, so a subscription narrows to one
 * action with `match.inChannels: ['created']` — the same mechanism that narrows
 * a GitHub repo or a Slack channel.
 *
 * Spec: docs/architecture/features/workflow.md → "Page event source".
 *
 * [COMP:workflow/page-event-trigger]
 */

import type { DispatchEvent, WorkflowEventDispatcher } from './event-trigger.js'

/** The doc-page lifecycle actions that fire a page-source workflow. */
export const PAGE_LIFECYCLE_ACTIONS = ['created', 'updated', 'moved'] as const
export type PageLifecycleAction = (typeof PAGE_LIFECYCLE_ACTIONS)[number]

/**
 * Sentinel watched-page id for a `created` / `moved` write at the workspace
 * root (`nest_parent_id IS NULL`). The event still dispatches, but no uuid
 * `{ type: 'page', pageId }` subscription can match the sentinel — "created at
 * the root" is not targetable in v1. (A root page's own `updated` event is not
 * affected: it carries the page's own uuid, not this sentinel.)
 */
export const PAGE_EVENT_ROOT = 'root'

/**
 * What the saved-views store hands the producer for one page write. The store
 * is the single choke point every caller (REST routes, brain-MCP doc tools,
 * the workflow page-anchor adapter) flows through, so one emit site covers
 * them all.
 */
export type PageLifecycleEvent = {
  /** Workspace the page — and any workflow it triggers — belongs to. */
  workspaceId: string
  /** The page that was created / updated / moved (`saved_views.id`). */
  pageId: string
  /**
   * The page's parent (`nest_parent_id`), or null for a workspace-root page.
   * For `moved` this is the *destination* parent.
   */
  parentId: string | null
  /** The page title at the time of the write, or null. */
  title: string | null
  /** The acting user id, or null when unknown. */
  actorId: string | null
  /** Which lifecycle transition fired. */
  action: PageLifecycleAction
  /**
   * Whether a non-human / automated write produced the event (a workflow
   * step, a system job). Gated by `EventMatch.fromBots` exactly like a bot
   * channel message — the self-loop guard for a workflow that writes pages
   * under a parent it watches. Defaults to a human action (`false`) at the
   * emit site.
   */
  isSystem?: boolean
}

/**
 * Normalize a page-lifecycle event into a source-agnostic `DispatchEvent`.
 *
 * The `source.pageId` is the **watched page** this event targets, which depends
 * on the action: a `created` / `moved` page targets its destination parent (a
 * subscription watching that parent hears about the new child); an `updated`
 * page targets itself. So a workflow watching page W fires when a child is
 * created/moved under W, and when W itself is updated — never when a *child* of
 * W is updated.
 *
 * `text` is the page title (matched by `keywords`), `channelId` is the
 * lifecycle action (matched by `inChannels`), `actorId` is the acting user
 * (matched by `fromActors`); the raw payload is written verbatim to
 * `workflow_runs.input.event` so a step addresses `{{input.event.pageId}}` (the
 * page that changed) / `{{input.event.action}}`.
 */
export function pageLifecycleToDispatchEvent(
  event: PageLifecycleEvent,
): DispatchEvent {
  const watchedPageId =
    event.action === 'updated'
      ? event.pageId
      : event.parentId ?? PAGE_EVENT_ROOT
  return {
    workspaceId: event.workspaceId,
    source: { type: 'page', pageId: watchedPageId },
    text: event.title,
    actorId: event.actorId,
    channelId: event.action,
    mentions: [],
    isBot: event.isSystem === true,
    payload: {
      action: event.action,
      pageId: event.pageId,
      parentId: event.parentId,
      title: event.title,
      actorId: event.actorId,
    },
  }
}

/**
 * Build the saved-views store's page-lifecycle sink. Wire it on the store's
 * write path so every create / update / move dispatches to the workspace's
 * `event`-trigger workflows:
 *
 * ```ts
 * createDbSavedViewStore({
 *   onPageLifecycle: createPageLifecycleTrigger(dispatcher),
 * })
 * ```
 *
 * Resolves once the dispatch fans out; the caller invokes it best-effort
 * (fire-and-forget) so a page write never waits on — or fails because of — a
 * workflow start.
 */
export function createPageLifecycleTrigger(
  dispatcher: WorkflowEventDispatcher,
): (event: PageLifecycleEvent) => Promise<void> {
  return async (event) => {
    await dispatcher.dispatch(pageLifecycleToDispatchEvent(event))
  }
}
