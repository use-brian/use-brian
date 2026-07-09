import type { AccessContext, EntityLinksStore, TaskListFilters, TaskListRow, TaskRecord, TaskRecordStatus, TaskUpdateFields, TaskWriteActor } from '@sidanclaw/core'
import { buildAccessPredicate } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { getAppPool, query, queryGated, queryWithRLS, rollbackAndRelease } from './client.js'
import { emitDependsOnEdges, emitMentionedEdges } from './edge-hooks.js'
import { publishTaskLifecycle } from '../task-event-fanout.js'

const FULL_SELECT = `
  id, workspace_id as "workspaceId", title, status,
  assignee_id as "assigneeId", due, tags,
  parent_id as "parentId", external_ref as "externalRef", attributes,
  created_at as "createdAt", updated_at as "updatedAt"
`

const COMPACT_SELECT = `
  id, workspace_id as "workspaceId", title, status,
  assignee_id as "assigneeId", due, tags,
  parent_id as "parentId", attributes, updated_at as "updatedAt"
`

type TaskRow = {
  id: string
  workspaceId: string
  title: string
  status: TaskRecordStatus
  assigneeId: string | null
  due: Date | null
  tags: string[]
  parentId: string | null
  externalRef: Record<string, unknown>
  attributes: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

type CompactRow = {
  id: string
  workspaceId: string
  title: string
  status: TaskRecordStatus
  assigneeId: string | null
  due: Date | null
  tags: string[]
  parentId: string | null
  attributes: Record<string, unknown>
  updatedAt: Date
}

function toRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    status: row.status,
    assigneeId: row.assigneeId,
    due: row.due,
    tags: row.tags,
    parentId: row.parentId,
    externalRef: row.externalRef ?? {},
    attributes: row.attributes ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toListRow(row: CompactRow): TaskListRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    status: row.status,
    assigneeId: row.assigneeId,
    due: row.due,
    tags: row.tags,
    parentId: row.parentId,
    attributes: row.attributes ?? {},
    updatedAt: row.updatedAt,
  }
}

/**
 * Idempotency window for task creation. A retry or double-fire of the same
 * logical create (an SSE/client retry of `POST /api/tasks`, a re-invoked
 * board-materialization, a model re-emitting the same `saveTask`) lands a
 * character-identical row seconds apart with no dedupe. 120s comfortably
 * covers those (observed exact-duplicate spans were 1-6s) while staying far
 * under the smallest *legitimate* recurring gap seen in prod (~27 min — a
 * recurring workflow re-running), so a daily/weekly task is never collapsed.
 * See docs/architecture/features/tasks.md → "Create idempotency".
 */
const TASK_DEDUP_WINDOW_SECONDS = 120

/**
 * The blank-row placeholder title (`POST /api/tasks` default, `views.ts`
 * `DEFAULT_TASK_TITLE`). Adding several empty rows to a board in quick
 * succession is intentional, so placeholder titles are exempt from the
 * create-idempotency guard — only meaningful titles dedupe.
 */
const PLACEHOLDER_TASK_TITLE = 'Untitled task'

/**
 * Return a live task in `workspaceId` that a create with these exact
 * (title, status, parentId) coordinates would duplicate if it landed within
 * `TASK_DEDUP_WINDOW_SECONDS`. Runs under the caller's RLS so only same-
 * workspace rows are visible. `valid_to IS NULL` (live version) +
 * `retracted_at IS NULL` exclude superseded / retracted rows. Placeholder
 * titles never match. Returns null when there is no recent duplicate.
 */
export async function findRecentDuplicateTask(
  userId: string,
  coords: { workspaceId: string; title: string; status: TaskRecordStatus; parentId: string | null },
): Promise<TaskRecord | null> {
  if (coords.title === PLACEHOLDER_TASK_TITLE) return null
  const result = await queryWithRLS<TaskRow>(
    userId,
    `SELECT ${FULL_SELECT} FROM tasks
      WHERE workspace_id = $1
        AND title = $2
        AND status = $3
        AND parent_id IS NOT DISTINCT FROM $4
        AND valid_to IS NULL
        AND retracted_at IS NULL
        AND created_at > now() - ($5 || ' seconds')::interval
      ORDER BY created_at DESC
      LIMIT 1`,
    [coords.workspaceId, coords.title, coords.status, coords.parentId, String(TASK_DEDUP_WINDOW_SECONDS)],
  )
  return result.rows[0] ? toRecord(result.rows[0]) : null
}

/**
 * Create a task.
 *
 * WU-1.7 edge hook: when `params.linkedEntityIds` is non-empty AND an
 * `entityLinks` store is passed, a `task → entity` `mentioned` edge is
 * emitted per id, fire-and-forget, after the task row is written. Edge
 * failures never affect the task save (see `edge-hooks.ts`). Both
 * arguments are optional so existing call sites keep compiling unchanged.
 */
export async function createTask(
  userId: string,
  params: {
    workspaceId: string
    title: string
    status?: TaskRecordStatus
    assigneeId?: string | null
    due?: Date | null
    tags?: string[]
    parentId?: string | null
    externalRef?: Record<string, unknown>
    /** User-configurable per-task JSONB — sprint estimation / ordering /
     *  velocity keys per `decisions-log.md` 2026-05-14. Defaults to `{}`. */
    attributes?: Record<string, unknown>
    /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
    compartments?: string[]
    /**
     * Fresh-insert `source`. Default `'user'` (interactive chat / API writes;
     * matches the mig-128 DB default). The structural-synthesis engine passes
     * `'extracted'` so synthesis-captured tasks surface in Brain Reviews
     * (`?includeExtracted=true`).
     */
    source?: 'user' | 'extracted'
    /** Task ids this task depends on — each becomes a task→task
     *  `depends_on` edge (fire-and-forget; v1 append-only). */
    dependsOn?: readonly string[]
    /** Entity ids this task references — each gets a `mentioned` edge
     *  (WU-1.7). Optional; empty/absent means no edge emission. */
    linkedEntityIds?: readonly string[]
    /** Write-actor marker for the workflow task-event self-loop guard
     *  (`system` → bot-authored event, gated by `fromBots`). Default
     *  `'user'`. Not persisted. */
    writtenBy?: TaskWriteActor
  },
  entityLinks?: EntityLinksStore,
): Promise<TaskRecord> {
  // WU-4.5 — authorship NOT NULL enforcement at the store layer. The
  // `userId` argument is both the RLS actor and the row author; without
  // it the row would land with a NULL `created_by_user_id` (mig 128
  // leaves the column nullable; the guard, not the schema, enforces).
  // Other universal columns (sensitivity, source, valid_from) take
  // their schema defaults from migration 128.
  assertAuthorshipPresent('createTask', userId)
  const result = await queryWithRLS<TaskRow>(
    userId,
    `INSERT INTO tasks (workspace_id, title, status, assignee_id, due, tags, parent_id, external_ref, attributes, created_by_user_id, compartments, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${FULL_SELECT}`,
    [
      params.workspaceId,
      params.title,
      params.status ?? 'todo',
      params.assigneeId ?? null,
      params.due ?? null,
      params.tags ?? [],
      params.parentId ?? null,
      JSON.stringify(params.externalRef ?? {}),
      JSON.stringify(params.attributes ?? {}),
      userId,
      params.compartments ?? [],
      params.source ?? 'user',
    ],
  )
  const task = toRecord(result.rows[0])

  // Workflow task-event emit — fire-and-forget after the committed insert
  // (single-statement autocommit above). The late-bound fanout is a no-op
  // until bootOpenApi binds the dispatcher. [COMP:api/task-event-fanout]
  publishTaskLifecycle({
    workspaceId: task.workspaceId,
    taskId: task.id,
    kind: 'created',
    title: task.title,
    status: task.status,
    previousStatus: null,
    tags: task.tags,
    previousTags: null,
    assigneeId: task.assigneeId,
    previousAssigneeId: null,
    due: task.due,
    parentId: task.parentId,
    changedFields: [],
    actorId: userId,
    writtenBy: params.writtenBy,
  })

  // Fire-and-forget `mentioned` edges — `void`, never awaited, never
  // able to throw into the task save.
  if (entityLinks && params.linkedEntityIds && params.linkedEntityIds.length > 0) {
    void emitMentionedEdges(entityLinks, userId, {
      sourceKind: 'task',
      sourceId: task.id,
      entityIds: params.linkedEntityIds,
      workspaceId: task.workspaceId,
      source: 'user',
      userId,
    })
  }
  // Fire-and-forget `depends_on` edges from this task → each
  // depended-on task. v1 append-only — never removes existing edges.
  if (entityLinks && params.dependsOn && params.dependsOn.length > 0) {
    void emitDependsOnEdges(entityLinks, userId, {
      sourceTaskId: task.id,
      dependsOnTaskIds: params.dependsOn,
      workspaceId: task.workspaceId,
      source: 'user',
      userId,
    })
  }
  return task
}

export async function getTaskById(ctx: AccessContext, id: string): Promise<TaskRecord | null> {
  // Universal access projection (WU-4.2b) + `valid_to IS NULL` to hide
  // superseded versions. History via `getTaskHistory`.
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<TaskRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM tasks
     WHERE ${ap.sql}
       AND id = $${ap.nextIdx} AND valid_to IS NULL`,
    [...ap.params, id],
  )
  if (result.rows.length === 0) return null
  return toRecord(result.rows[0])
}

export async function listTasks(ctx: AccessContext, filters: TaskListFilters): Promise<TaskListRow[]> {
  // `valid_to IS NULL` filter hides superseded versions. Index
  // `idx_tasks_valid` (migration 128) covers this predicate.
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const wheres: string[] = [ap.sql, 'valid_to IS NULL']
  const values: unknown[] = [...ap.params]
  let idx = ap.nextIdx

  if (filters.assigneeId) {
    wheres.push(`assignee_id = $${idx}`)
    values.push(filters.assigneeId)
    idx++
  }
  if (filters.status) {
    if (Array.isArray(filters.status)) {
      wheres.push(`status = ANY($${idx})`)
      values.push(filters.status)
    } else {
      wheres.push(`status = $${idx}`)
      values.push(filters.status)
    }
    idx++
  } else if (!filters.includeArchived) {
    wheres.push(`status <> 'archived'`)
  }
  if (filters.dueBefore) {
    wheres.push(`due IS NOT NULL AND due < $${idx}`)
    values.push(filters.dueBefore)
    idx++
  }
  if (filters.dueAfter) {
    wheres.push(`due IS NOT NULL AND due > $${idx}`)
    values.push(filters.dueAfter)
    idx++
  }
  if (filters.tag) {
    wheres.push(`$${idx} = ANY(tags)`)
    values.push(filters.tag)
    idx++
  }
  if (filters.parentId) {
    wheres.push(`parent_id = $${idx}`)
    values.push(filters.parentId)
    idx++
  }

  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100)
  values.push(limit)

  const result = await queryGated<CompactRow>(
    ctx,
    `SELECT ${COMPACT_SELECT} FROM tasks
     WHERE ${wheres.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${idx}`,
    values,
  )
  return result.rows.map(toListRow)
}

type OldTaskRow = {
  workspace_id: string
  title: string
  status: TaskRecordStatus
  assignee_id: string | null
  due: Date | null
  tags: string[]
  parent_id: string | null
  external_ref: Record<string, unknown>
  attributes: Record<string, unknown>
  sensitivity: string
  user_id: string | null
  assistant_id: string | null
  source: string
  source_episode_id: string | null
}

/**
 * Which patchable fields the write actually changed (caller passed the key
 * AND the value differs from the old row). Feeds the task lifecycle event's
 * `changedFields` — keys use the `TaskUpdateFields` casing.
 */
function diffChangedFields(
  old: OldTaskRow,
  next: TaskRecord,
  fields: TaskUpdateFields,
): string[] {
  const changed: string[] = []
  if (fields.title !== undefined && next.title !== old.title) changed.push('title')
  if (fields.status !== undefined && next.status !== old.status) changed.push('status')
  if (fields.assigneeId !== undefined && next.assigneeId !== old.assignee_id) changed.push('assigneeId')
  if (
    fields.due !== undefined &&
    (next.due?.getTime() ?? null) !== (old.due?.getTime() ?? null)
  ) {
    changed.push('due')
  }
  if (fields.tags !== undefined && !sameStringSet(next.tags, old.tags ?? [])) changed.push('tags')
  if (fields.parentId !== undefined && next.parentId !== old.parent_id) changed.push('parentId')
  if (
    fields.externalRef !== undefined &&
    JSON.stringify(next.externalRef) !== JSON.stringify(old.external_ref ?? {})
  ) {
    changed.push('externalRef')
  }
  if (
    fields.attributes !== undefined &&
    JSON.stringify(next.attributes) !== JSON.stringify(old.attributes ?? {})
  ) {
    changed.push('attributes')
  }
  return changed
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bs = new Set(b)
  return a.every((x) => bs.has(x))
}

/**
 * Forward-resolve a (possibly superseded) task id to its live head by
 * walking `superseded_by`. A bi-temporal edit rotates the id, so a caller
 * holding a pre-supersession id (e.g. an LLM working from a stale
 * `listTasks` snapshot) would otherwise 404 on its next edit. Append the
 * resolving SELECT, e.g. `SELECT id FROM chain WHERE valid_to IS NULL`.
 * Subject to the caller's RLS (the anchor row must be visible).
 */
const LIVE_TASK_ID_CTE = `WITH RECURSIVE chain AS (
  SELECT id, superseded_by, valid_to FROM tasks WHERE id = $1
  UNION ALL
  SELECT t.id, t.superseded_by, t.valid_to
  FROM tasks t JOIN chain c ON t.id = c.superseded_by
)`

/**
 * Bi-temporal supersession update.
 *
 * Each `updateTask` call closes the prior row (`valid_to = now()`,
 * `superseded_by = <new_id>`) and inserts a new row carrying the merged
 * field values plus all carried-forward universal columns. The new row
 * has a new id — callers consume `result.id` instead of holding onto the
 * input id. A superseded input id is forward-resolved to its live head
 * first (`LIVE_TASK_ID_CTE`), so a caller that still holds a pre-supersession
 * id (an LLM working from a stale `listTasks` snapshot) patches the current
 * row instead of getting a spurious not-found. See
 * `docs/architecture/brain/data-model.md` §"Bi-temporal validity" and
 * `corrections.md` §D.7.
 *
 * Wrapped in BEGIN/COMMIT so the SELECT old + INSERT new + close old +
 * repoint active children sequence is atomic and the per-statement
 * triggers see a consistent state (notably the `parent_id` workspace-match
 * trigger, which fires on the children repoint and validates against the
 * newly inserted row).
 *
 * Empty `fields` is treated as a no-op — returns the current active row
 * without a supersession write. Tool-layer also guards this; the DB-layer
 * check is defense-in-depth.
 */
export async function updateTask(
  userId: string,
  id: string,
  fields: TaskUpdateFields,
  entityLinks?: EntityLinksStore,
  opts?: {
    /** Write-actor marker for the workflow task-event self-loop guard.
     *  An opts arg, NOT a `fields` key, so it can never trip the
     *  empty-patch no-op check or leak into the supersession write. */
    writtenBy?: TaskWriteActor
  },
): Promise<TaskRecord | null> {
  if (Object.keys(fields).length === 0) {
    // No-op short-circuit — read the current row without per-viewer
    // projection (this is the write path; RLS is the workspace gate).
    // Forward-resolve a superseded input id to its live head so a stale id
    // round-trips to the current row (see header).
    const result = await queryWithRLS<TaskRow>(
      userId,
      `${LIVE_TASK_ID_CTE}
       SELECT ${FULL_SELECT} FROM tasks
       WHERE id = (SELECT id FROM chain WHERE valid_to IS NULL LIMIT 1)`,
      [id],
    )
    return result.rows.length === 0 ? null : toRecord(result.rows[0])
  }

  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)
    try {
      // Forward-resolve a superseded input id to its live head (see header)
      // so a caller holding a pre-supersession id patches the current row
      // instead of getting a spurious not-found. A genuinely unknown id (or a
      // chain with no live row) resolves to nothing → not-found, as before.
      const liveRes = await client.query<{ id: string }>(
        `${LIVE_TASK_ID_CTE} SELECT id FROM chain WHERE valid_to IS NULL LIMIT 1`,
        [id],
      )
      if (liveRes.rows.length === 0) {
        await client.query('ROLLBACK')
        return null
      }
      const liveId = liveRes.rows[0].id

      const oldRes = await client.query<OldTaskRow>(
        `SELECT workspace_id, title, status, assignee_id, due, tags, parent_id, external_ref, attributes,
                sensitivity, user_id, assistant_id, source, source_episode_id
         FROM tasks WHERE id = $1 AND valid_to IS NULL`,
        [liveId],
      )
      if (oldRes.rows.length === 0) {
        await client.query('ROLLBACK')
        return null
      }
      const old = oldRes.rows[0]

      const newTitle = fields.title !== undefined ? fields.title : old.title
      const newStatus = fields.status !== undefined ? fields.status : old.status
      const newAssigneeId = fields.assigneeId !== undefined ? fields.assigneeId : old.assignee_id
      const newDue = fields.due !== undefined ? fields.due : old.due
      const newTags = fields.tags !== undefined ? fields.tags : old.tags
      const newParentId = fields.parentId !== undefined ? fields.parentId : old.parent_id
      const newExternalRef = fields.externalRef !== undefined ? fields.externalRef : (old.external_ref ?? {})
      const newAttributes = fields.attributes !== undefined ? fields.attributes : (old.attributes ?? {})

      const insertRes = await client.query<TaskRow>(
        `INSERT INTO tasks (
           workspace_id, title, status, assignee_id, due, tags, parent_id, external_ref, attributes,
           sensitivity, user_id, assistant_id, source, source_episode_id,
           created_by_user_id, valid_from, valid_to, superseded_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
                 $10, $11, $12, $13, $14,
                 $15, now(), NULL, NULL)
         RETURNING ${FULL_SELECT}`,
        [
          old.workspace_id,
          newTitle,
          newStatus,
          newAssigneeId,
          newDue,
          newTags,
          newParentId,
          JSON.stringify(newExternalRef),
          JSON.stringify(newAttributes),
          old.sensitivity,
          old.user_id,
          old.assistant_id,
          old.source,
          old.source_episode_id,
          userId,
        ],
      )
      const newRow = insertRes.rows[0]

      await client.query(
        `UPDATE tasks SET valid_to = now(), superseded_by = $1
         WHERE id = $2 AND valid_to IS NULL`,
        [newRow.id, liveId],
      )

      // Repoint active children to the new parent so the active sub-task
      // tree stays coherent. The parent-workspace-match trigger fires on
      // each child here and sees the just-inserted new row (same
      // transaction, so visible to subsequent statements) and validates
      // against its workspace_id, which carried forward from `old`.
      await client.query(
        `UPDATE tasks SET parent_id = $1
         WHERE parent_id = $2 AND valid_to IS NULL`,
        [newRow.id, liveId],
      )

      // Repoint any goal hosted on this task to the new id (mirrors the
      // child repoint above). A task's auto-drafted goal binds by host_id;
      // supersession would otherwise orphan it, so host_id always tracks the
      // live task id. No-op (0 rows) when the task has no hosted goal.
      await client.query(
        `UPDATE goals SET host_id = $1
         WHERE host_type = 'task' AND host_id = $2`,
        [newRow.id, liveId],
      )

      await client.query('COMMIT')
      const newTask = toRecord(newRow)

      // Workflow task-event emit — fire-and-forget after COMMIT. The old
      // row (already read for the supersession write) supplies the
      // before-snapshot; the producer derives the action set from the
      // diff. [COMP:api/task-event-fanout]
      publishTaskLifecycle({
        workspaceId: newTask.workspaceId,
        taskId: newTask.id,
        kind: 'updated',
        title: newTask.title,
        status: newTask.status,
        previousStatus: old.status,
        tags: newTask.tags,
        previousTags: old.tags ?? [],
        assigneeId: newTask.assigneeId,
        previousAssigneeId: old.assignee_id,
        due: newTask.due,
        parentId: newTask.parentId,
        changedFields: diffChangedFields(old, newTask, fields),
        actorId: userId,
        writtenBy: opts?.writtenBy,
      })

      // Fire-and-forget `depends_on` edges from the new (active) task
      // id → each depended-on target. v1 append-only — does not remove
      // or rewrite edges pointing at the pre-supersession id.
      if (entityLinks && fields.dependsOn && fields.dependsOn.length > 0) {
        void emitDependsOnEdges(entityLinks, userId, {
          sourceTaskId: newTask.id,
          dependsOnTaskIds: fields.dependsOn,
          workspaceId: newTask.workspaceId,
          source: 'user',
          userId,
        })
      }
      return newTask
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
  } finally {
    await rollbackAndRelease(client)
  }
}

/**
 * Walk the full bi-temporal version chain for a task, in `valid_from`
 * order. Returns every row in the chain (including superseded ones)
 * regardless of which id in the chain the caller knew about. Empty array
 * if the id is unknown or RLS-hidden.
 *
 * Implementation walks `superseded_by` both directions from the start id
 * — forward (older→newer) following the pointer, backward (newer→older)
 * matching on rows whose `superseded_by` equals the current id. `UNION`
 * deduplicates the meet point.
 *
 * DB-layer helper only — not exposed via `TaskStore`. WU-6.9 will wire a
 * unified `getRowHistory` surface across primitives.
 */
/**
 * System-level lookup of the active task row by id (no RLS, no
 * `AccessContext`). Returns the post-supersession active row, or null
 * if no such id exists or the task has been fully retracted.
 *
 * Used by the commitment-lifecycle worker — it runs without a
 * per-user session and needs to read task state when resolving
 * `commitment:sprint_variance` memories. The cross-workspace exposure
 * is intentional and bounded: the worker is system-trusted, and the
 * memory it is resolving already carries the workspace context.
 */
export async function getTaskByIdSystem(id: string): Promise<TaskRecord | null> {
  const result = await query<TaskRow>(
    `SELECT ${FULL_SELECT} FROM tasks WHERE id = $1 AND valid_to IS NULL`,
    [id],
  )
  if (result.rows.length === 0) return null
  return toRecord(result.rows[0])
}

export async function getTaskHistory(ctx: AccessContext, id: string): Promise<TaskRecord[]> {
  // D.7 invariant: every row in a supersession chain shares the same
  // universal-column tuple (workspace_id, user_id, assistant_id,
  // sensitivity). Apply the universal access predicate to the anchor
  // only; the recursive step inherits visibility implicitly.
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<TaskRow>(
    ctx.userId,
    `WITH RECURSIVE chain AS (
       SELECT id, workspace_id, title, status, assignee_id, due, tags,
              parent_id, external_ref, attributes, created_at, updated_at,
              valid_from, valid_to, superseded_by
       FROM tasks
       WHERE ${ap.sql} AND id = $${ap.nextIdx}
       UNION
       SELECT t.id, t.workspace_id, t.title, t.status, t.assignee_id, t.due, t.tags,
              t.parent_id, t.external_ref, t.attributes, t.created_at, t.updated_at,
              t.valid_from, t.valid_to, t.superseded_by
       FROM tasks t, chain c
       WHERE t.id = c.superseded_by OR t.superseded_by = c.id
     )
     SELECT
       id, workspace_id as "workspaceId", title, status,
       assignee_id as "assigneeId", due, tags,
       parent_id as "parentId", external_ref as "externalRef", attributes,
       created_at as "createdAt", updated_at as "updatedAt"
     FROM chain
     ORDER BY valid_from ASC`,
    [...ap.params, id],
  )
  return result.rows.map(toRecord)
}
