/**
 * Task → workflow event-trigger adapter (the internal-task half).
 *
 * The fourth event producer, alongside the connector half
 * (`ingest/workflow-trigger.ts`), the channel half (the Slack webhook), and
 * the page half (`page-event-trigger.ts`). A task created or updated is
 * normalized here into the source-agnostic `DispatchEvent` and handed to the
 * shared `WorkflowEventDispatcher` (`./event-trigger.ts`).
 *
 * Like the page source it is *internal*: no poller, no webhook. `createTask` /
 * `updateTask` (`packages/api/.../db/tasks.ts`) — the choke point every task
 * writer funnels through (chat tools, the Brain inbox route, synthesis
 * extraction, the goals host-adapter) — publish after commit via the
 * late-bound seam in `packages/api/src/task-event-fanout.ts`.
 *
 * Unlike every other source the task source is **id-less** (`{type:'task'}`):
 * there is no natural "one task to watch", so the subscription scope is the
 * whole workspace's task table and `match` carries all the selectivity.
 *
 * The task status machine is the lifecycle, so its meaningful transitions are
 * first-class actions on the `inChannels` axis — and because one write can
 * carry several facets (complete AND tag), the event carries the full action
 * set in `DispatchEvent.actions[]` (set-intersection matching; the primary
 * `channelId` is display precedence only, nothing is shadowed).
 *
 * Spec: docs/architecture/features/workflow.md → "Task event source".
 *
 * [COMP:workflow/task-event-trigger]
 */

import type { TaskRecordStatus, TaskWriteActor } from '../tasks/types.js'
import type { DispatchEvent, WorkflowEventDispatcher } from './event-trigger.js'

/** The task lifecycle actions that fire a task-source workflow. */
export const TASK_LIFECYCLE_ACTIONS = [
  'created',
  'completed',
  'blocked',
  'reopened',
  'assigned',
  'tagged',
  'updated',
] as const
export type TaskLifecycleAction = (typeof TASK_LIFECYCLE_ACTIONS)[number]

/**
 * Primary-action precedence for the display `channelId`. Matching uses the
 * full set, so this ordering never hides a facet — it only decides which
 * action names the event where a single string is wanted.
 */
const ACTION_PRECEDENCE: TaskLifecycleAction[] = [
  'created',
  'completed',
  'blocked',
  'reopened',
  'assigned',
  'tagged',
  'updated',
]

/**
 * What the task write path hands the producer: before/after snapshots of the
 * matchable fields. The producer owns the action derivation so the rules live
 * in one unit-testable place; the store only reports facts it already holds
 * (the update path reads the old row for its supersession write anyway).
 */
export type TaskLifecycleEvent = {
  /** Workspace the task — and any workflow it triggers — belongs to. */
  workspaceId: string
  /**
   * The LIVE post-write task id. Updates are bi-temporal supersessions that
   * mint a new row id — always the head, so `{{input.event.taskId}}` feeds
   * `getTask` / `updateTask` directly (stale ids forward-resolve anyway).
   */
  taskId: string
  /** Which write shape fired. */
  kind: 'created' | 'updated'
  /** Post-write title. */
  title: string
  /** Post-write status. */
  status: TaskRecordStatus
  /** Pre-write status; null on `created`. */
  previousStatus: TaskRecordStatus | null
  /** Post-write tag set. */
  tags: string[]
  /** Pre-write tag set; null on `created`. */
  previousTags: string[] | null
  /** Post-write assignee. */
  assigneeId: string | null
  /** Pre-write assignee; null on `created` (and when it was unset). */
  previousAssigneeId: string | null
  /** Post-write due date. */
  due: Date | null
  /** Post-write parent task id. */
  parentId: string | null
  /**
   * Field names the write changed (store-computed diff of the patchable
   * fields). Empty on `created`.
   */
  changedFields: string[]
  /** The acting user id (the RLS actor of the write). */
  actorId: string
  /**
   * Who authored the write. `system` = any automated / assistant path (task
   * chat tools incl. interactive chat, synthesis extraction, the goals
   * host-adapter); `user` = a human edit via the Brain inbox route. Becomes
   * `DispatchEvent.isBot` — the self-loop guard for workflows that write
   * tasks. Defaults to `user` at the emit site.
   */
  writtenBy?: TaskWriteActor
}

const ACTIVE_STATUSES: ReadonlySet<TaskRecordStatus> = new Set([
  'todo',
  'in_progress',
  'blocked',
])

/**
 * Derive every lifecycle facet of one write. `updated` is deliberately a
 * superset — always present on the update path alongside the specifics — so
 * subscribing to `['updated']` reads as "any change to any task".
 */
export function deriveTaskActions(event: TaskLifecycleEvent): TaskLifecycleAction[] {
  if (event.kind === 'created') return ['created']

  const actions: TaskLifecycleAction[] = []
  const prev = event.previousStatus
  if (prev !== null && prev !== event.status) {
    if (event.status === 'done') actions.push('completed')
    if (event.status === 'blocked') actions.push('blocked')
    if ((prev === 'done' || prev === 'archived') && ACTIVE_STATUSES.has(event.status)) {
      actions.push('reopened')
    }
  }
  if (
    event.assigneeId !== null &&
    event.assigneeId !== event.previousAssigneeId
  ) {
    actions.push('assigned')
  }
  if (addedTags(event).length > 0) actions.push('tagged')
  actions.push('updated')
  return actions
}

/** Tags this write ADDED — the appearance set. On `created`, every tag. */
function addedTags(event: TaskLifecycleEvent): string[] {
  if (event.kind === 'created' || event.previousTags === null) return event.tags
  const before = new Set(event.previousTags)
  return event.tags.filter((t) => !before.has(t))
}

/**
 * Normalize a task-lifecycle event into a source-agnostic `DispatchEvent`.
 *
 * `text` is the task title (matched by `keywords`); the action set rides
 * `actions[]` with the precedence-picked primary in `channelId` (matched by
 * `inChannels` as a set); the ADDED tag set rides `tags` (matched by
 * `match.tags` — appearance semantics: a routing-tag subscription fires when
 * the tag appears, never on unrelated edits of an already-tagged task); the
 * current assignee rides `mentions`; `writtenBy` becomes `isBot`. The raw
 * payload is written verbatim to `workflow_runs.input.event` so a step
 * addresses `{{input.event.taskId}}` / `{{input.event.action}}` without a
 * `getTask` round-trip.
 */
export function taskLifecycleToDispatchEvent(
  event: TaskLifecycleEvent,
): DispatchEvent {
  const actions = deriveTaskActions(event)
  const primary =
    ACTION_PRECEDENCE.find((a) => actions.includes(a)) ?? 'updated'
  const tagsAdded = addedTags(event)
  return {
    workspaceId: event.workspaceId,
    source: { type: 'task' },
    text: event.title,
    actorId: event.actorId,
    channelId: primary,
    actions,
    mentions: event.assigneeId !== null ? [event.assigneeId] : [],
    tags: tagsAdded,
    isBot: event.writtenBy === 'system',
    payload: {
      taskId: event.taskId,
      action: primary,
      actions,
      title: event.title,
      status: event.status,
      previousStatus: event.previousStatus,
      tags: event.tags,
      tagsAdded,
      assigneeId: event.assigneeId,
      due: event.due ? event.due.toISOString() : null,
      parentId: event.parentId,
      changedFields: event.changedFields,
      actorId: event.actorId,
    },
  }
}

/**
 * Build the task write path's lifecycle sink. Wired by the late-bound seam in
 * `packages/api/src/task-event-fanout.ts`; `createTask` / `updateTask` invoke
 * it best-effort (fire-and-forget) so a task write never waits on — or fails
 * because of — a workflow start.
 */
export function createTaskLifecycleTrigger(
  dispatcher: WorkflowEventDispatcher,
): (event: TaskLifecycleEvent) => Promise<void> {
  return async (event) => {
    await dispatcher.dispatch(taskLifecycleToDispatchEvent(event))
  }
}
