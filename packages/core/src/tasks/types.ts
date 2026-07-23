/**
 * Tasks store interface.
 *
 * Workspace-scoped task records (see docs/architecture/features/tasks.md).
 * Schema is deliberately frozen v1 per docs/plans/company-brain.md §14.
 *
 * Read methods take `ctx: AccessContext` (WU-4.2b) so the store can
 * compose the universal access predicate (workspace + visibility double
 * + sensitivity ≤ clearance) consistently with the rest of the brain.
 *
 * Injected by the API layer into `createTaskTools`. The core package has no
 * direct DB dependency — concrete impl lives in `packages/api/src/db/tasks-store.ts`.
 */

import type { AccessContext } from '../security/access-context.js'

export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'blocked', 'done', 'archived'] as const
export type TaskRecordStatus = (typeof TASK_STATUSES)[number]

/**
 * Who authored a task write — the task analog of the page source's
 * `PageWriteActor`, and the input to the workflow task-event self-loop guard
 * (`system` → `DispatchEvent.isBot`, gated by `EventMatch.fromBots`).
 * `system` = any automated / assistant path: the task chat tools (including
 * from interactive chat), synthesis extraction, the goals host-adapter, a
 * workflow step. `user` = a human edit through the Brain inbox REST route.
 * Not persisted — the frozen-v1 `tasks` schema is untouched; the marker only
 * rides the write into the lifecycle emit.
 */
export type TaskWriteActor = 'user' | 'system'

/**
 * External-system reference for synced tasks. Free-form for v1; the intended
 * shape is `{provider, id, url}` but it is not validated at this layer. Open
 * item #5 (sync engine architecture) will firm up the schema later.
 */
export type TaskExternalRef = Record<string, unknown>

/**
 * User-configurable per-task JSONB — sprint estimation / ordering /
 * velocity keys per `docs/historical/decisions-log.md`
 * 2026-05-14 ("SV — Sprint tracking via tasks primitive"). Free-form,
 * unvalidated at this layer. Conventional keys (workspace convention,
 * not enforced): `estimate_days`, `estimate_points`, `order`. Same shape
 * as `entities.attributes` (mig 125) and `external_ref` (mig 113).
 */
export type TaskAttributes = Record<string, unknown>

export type TaskRecord = {
  id: string
  workspaceId: string
  title: string
  status: TaskRecordStatus
  assigneeId: string | null
  due: Date | null
  tags: string[]
  parentId: string | null
  externalRef: TaskExternalRef
  attributes: TaskAttributes
  createdAt: Date
  updatedAt: Date
}

/**
 * Compact projection returned by `listTasks` — omits `externalRef` and
 * `createdAt` to keep model-facing payloads small. Use `getById` for the
 * full record.
 */
export type TaskListRow = Pick<
  TaskRecord,
  'id' | 'workspaceId' | 'title' | 'status' | 'assigneeId' | 'due' | 'tags' | 'parentId' | 'attributes' | 'updatedAt'
>

export type TaskListFilters = {
  assigneeId?: string
  status?: TaskRecordStatus | TaskRecordStatus[]
  dueBefore?: Date
  dueAfter?: Date
  tag?: string
  parentId?: string
  includeArchived?: boolean
  limit?: number
}

export type TaskUpdateFields = {
  title?: string
  status?: TaskRecordStatus
  /** Pass `null` to clear; omit to leave unchanged. */
  assigneeId?: string | null
  /** Pass `null` to clear; omit to leave unchanged. */
  due?: Date | null
  tags?: string[]
  /** Pass `null` to clear; omit to leave unchanged. */
  parentId?: string | null
  externalRef?: TaskExternalRef
  /** Overwrite-on-update (whole object replaces); omit to leave unchanged. */
  attributes?: TaskAttributes
  /**
   * Task ids this task depends on. v1 append-only — emits new edges
   * from the supersession row, does not remove existing dependencies.
   * Omit to leave the dependency graph unchanged.
   */
  dependsOn?: readonly string[]
}

export type TaskStore = {
  create(params: {
    userId: string
    workspaceId: string
    title: string
    status?: TaskRecordStatus
    assigneeId?: string | null
    due?: Date | null
    tags?: string[]
    parentId?: string | null
    externalRef?: TaskExternalRef
    attributes?: TaskAttributes
    /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
    compartments?: string[]
    /** Fresh-insert source; default 'user'; synthesis + Pipeline B pass 'extracted' so the row surfaces in Brain Reviews. */
    source?: 'user' | 'extracted'
    /**
     * Interactive-write provenance anchor (mig 316) — the session of the
     * conversation that created this task. Chat saveTask stamps
     * `context.sessionId`; sessionless paths leave it unset.
     */
    sourceSessionId?: string | null
    /** Extraction provenance anchor — the Episode this task derives from (Pipeline B / synthesis). */
    sourceEpisodeId?: string | null
    /**
     * Offset into `sourceEpisodeId`'s recording where this task was committed
     * to (migration 338) — what turns an action item into a pointer into the
     * audio rather than a detached string. Set only by a recording fill, whose
     * `saveTask` is widened to ask for it; null everywhere else.
     */
    sourceStartMs?: number | null
    /** The assistant that mediated the write (chat/workflow saveTask). */
    createdByAssistantId?: string | null
    /**
     * Task ids this task depends on — each becomes a task→task
     * `depends_on` edge (graph layer; fire-and-forget). v1 append-only.
     */
    dependsOn?: readonly string[]
    /**
     * Write-actor marker for the workflow task-event self-loop guard.
     * Default `'user'`; every automated path (chat tools, synthesis, goals)
     * passes `'system'`. Not persisted.
     */
    writtenBy?: TaskWriteActor
  }): Promise<TaskRecord>

  /**
   * Returns the full record (including externalRef + createdAt). The
   * universal access predicate hides cross-workspace, cross-visibility,
   * or above-clearance rows — the caller sees `null` regardless of why.
   */
  getById(ctx: AccessContext, id: string): Promise<TaskRecord | null>

  list(ctx: AccessContext, filters: TaskListFilters): Promise<TaskListRow[]>

  /**
   * Patch existing fields. `null` on nullable fields explicitly clears them;
   * an absent key leaves the field unchanged. Returns null if no row was
   * affected (RLS-hidden or non-existent id). Write paths keep the
   * pre-WU-4.2b `userId` actor arg — authorship + RLS lives there.
   * `opts.writtenBy` is the write-actor marker for the workflow task-event
   * self-loop guard (default `'user'`; automated paths pass `'system'`) —
   * an opts arg, NOT a `fields` key, so it can never trip the empty-patch
   * no-op check or leak into the supersession write.
   */
  update(
    userId: string,
    id: string,
    fields: TaskUpdateFields,
    opts?: { writtenBy?: TaskWriteActor },
  ): Promise<TaskRecord | null>

  /**
   * System-level lookup (no RLS / `AccessContext`) of live, non-archived tasks
   * whose `external_ref` jsonb CONTAINS `match` (Postgres `@>`). Used by the
   * GitHub task lifecycle in ingest to resolve which task an issue/PR event
   * refers to — the caller (the ingest processor) is already authorized for the
   * workspace. Returns full records (with `externalRef`); empty when none match.
   *
   * Optional: only the DB-backed store (`createDbTaskStore`) provides it, and
   * only the ingest GitHub lifecycle consumes it (guarding on presence). Test
   * mocks and non-ingest stores may omit it.
   */
  findByExternalRefSystem?(
    workspaceId: string,
    match: TaskExternalRef,
  ): Promise<TaskRecord[]>
}
