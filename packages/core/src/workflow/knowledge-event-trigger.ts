/**
 * Knowledge base → workflow event-trigger adapter (the internal-KB half).
 *
 * The sixth event producer, alongside the connector half
 * (`ingest/workflow-trigger.ts`), the channel half (the Slack webhook), the
 * page half (`page-event-trigger.ts`), and the task half
 * (`task-event-trigger.ts`). A knowledge entry created, updated, or deleted
 * is normalized here into the source-agnostic `DispatchEvent` and handed to
 * the shared `WorkflowEventDispatcher` (`./event-trigger.ts`).
 *
 * Like the page and task sources it is *internal*: no poller, no webhook.
 * The KB store's write methods (`packages/api/.../db/knowledge-store.ts`) are
 * the choke point every writer funnels through — the github/local sync
 * worker's `upsertByPath`, the assistant repo-writer's eager write-through
 * (which calls the same `upsertByPath`), manual entry `create`, and
 * `updateManualEntryContent` — and they publish after commit via the
 * late-bound seam in `packages/api/src/knowledge-event-fanout.ts`.
 *
 * Like the task source it is **id-less** (`{type:'knowledge'}`): a workspace's
 * KB is one corpus even when several repos feed it, so the subscription scope
 * is every KB write in the workspace and `match` carries all the selectivity.
 *
 * **The event is a pointer, not a payload.** It carries the entry's id, path,
 * title, tags, and sensitivity — never its body. A triggered step reads the
 * entry with `readKnowledgeEntry` under its own assistant's clearance, so an
 * event from a confidential entry cannot leak that entry's content into a
 * workflow whose assistant could not have read it.
 *
 * Spec: docs/architecture/features/workflow.md → "Knowledge event source".
 *
 * [COMP:workflow/knowledge-event-trigger]
 */

import type { Sensitivity } from '../security/sensitivity.js'
import type { DispatchEvent, WorkflowEventDispatcher } from './event-trigger.js'

/** The KB lifecycle actions that fire a knowledge-source workflow. */
export const KNOWLEDGE_LIFECYCLE_ACTIONS = ['created', 'updated', 'deleted'] as const
export type KnowledgeLifecycleAction = (typeof KNOWLEDGE_LIFECYCLE_ACTIONS)[number]

/**
 * Who authored a KB write. `system` = the assistant's own repo write-back
 * (the direct-commit tools) or any automated path; `user` = a human commit
 * the sync worker mirrored, or a human edit through the app. Becomes
 * `DispatchEvent.isBot` — the self-loop guard for a maintenance workflow that
 * writes the KB it watches. Defaults to `user` at the emit site, because the
 * overwhelmingly common write is the sync worker mirroring a human commit.
 */
export type KnowledgeWriteActor = 'user' | 'system'

/**
 * What the KB write path hands the producer. Every field is metadata the
 * store already holds after the write — no extra read, and deliberately no
 * body (see the module header).
 */
export type KnowledgeLifecycleEvent = {
  /** Workspace the entry — and any workflow it triggers — belongs to. */
  workspaceId: string
  /** `knowledge_entries.id`. Feeds `readKnowledgeEntry` from a step. */
  entryId: string
  /** Which lifecycle facet fired. */
  action: KnowledgeLifecycleAction
  /** Entry path (`products/vault`), the natural scoping axis. */
  path: string
  /** Entry title — the `keywords` haystack. */
  title: string
  /** Entry frontmatter tags — the `match.tags` axis. */
  tags: string[]
  /** Entry sensitivity tier, so a `match` can scope by tier via keywords-free means. */
  sensitivity: Sensitivity
  /**
   * `workspace_knowledge_sources.id`, or null for a manual entry. The source's
   * repo/branch are deliberately NOT denormalized onto the event — resolving
   * them would put a join on every KB write for a field no `match` axis uses.
   */
  sourceId: string | null
  /** The acting user id when a user caused the write; null for the sync worker. */
  actorId: string | null
  /** Who authored the write. Defaults to `user` at the emit site. */
  writtenBy?: KnowledgeWriteActor
}

/**
 * Normalize a knowledge-lifecycle event into a source-agnostic
 * `DispatchEvent`.
 *
 * `text` is the entry title (matched by `keywords`); the lifecycle action
 * rides `channelId` (matched by `inChannels`); the entry's frontmatter tags
 * ride `tags` (matched by `match.tags`); `writtenBy` becomes `isBot`. Unlike
 * the task producer there is no multi-facet action set — a KB write is
 * exactly one of created / updated / deleted — so `actions` is left absent
 * and `matchesEvent` falls back to the singleton `[channelId]`.
 *
 * The raw payload is written verbatim to `workflow_runs.input.event` so a
 * step addresses `{{input.event.entryId}}` / `{{input.event.path}}` without a
 * lookup round-trip.
 */
export function knowledgeLifecycleToDispatchEvent(
  event: KnowledgeLifecycleEvent,
): DispatchEvent {
  return {
    workspaceId: event.workspaceId,
    source: { type: 'knowledge' },
    text: event.title,
    actorId: event.actorId,
    channelId: event.action,
    mentions: [],
    tags: event.tags,
    isBot: event.writtenBy === 'system',
    payload: {
      entryId: event.entryId,
      action: event.action,
      path: event.path,
      title: event.title,
      tags: event.tags,
      sensitivity: event.sensitivity,
      sourceId: event.sourceId,
      actorId: event.actorId,
    },
  }
}

/**
 * Build the KB write path's lifecycle sink. Wired by the late-bound seam in
 * `packages/api/src/knowledge-event-fanout.ts`; the store's write methods
 * invoke it best-effort (fire-and-forget) so a KB write never waits on — or
 * fails because of — a workflow start.
 */
export function createKnowledgeLifecycleTrigger(
  dispatcher: WorkflowEventDispatcher,
): (event: KnowledgeLifecycleEvent) => Promise<void> {
  return async (event) => {
    await dispatcher.dispatch(knowledgeLifecycleToDispatchEvent(event))
  }
}
