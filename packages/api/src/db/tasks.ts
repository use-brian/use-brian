import { bindScopeSource, maxSensitivity, unionScopeRequirements } from '@use-brian/core'
import type { AccessContext, EntityLinksStore, Sensitivity, TaskListFilters, TaskListRow, TaskRecord, TaskRecordStatus, TaskUpdateFields, TaskWriteActor, TaskStore } from '@use-brian/core'
import type pg from 'pg'
import { assertExecutionResourceScope, buildAccessPredicate } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { applyRLSGucs, getAppPool, query, queryGated, queryWithRLS, rollbackAndRelease } from './client.js'
import { emitDependsOnEdges, emitMentionedEdges } from './edge-hooks.js'
import { abandonGoalsForHostTaskSystem } from './goals.js'
import { currentAgentAccess } from './agent-access-context.js'
import { publishTaskLifecycle } from '../task-event-fanout.js'

const FULL_SELECT = `
  id, workspace_id as "workspaceId", title, status,
  assignee_id as "assigneeId", due, tags,
  parent_id as "parentId", external_ref as "externalRef", attributes,
  sensitivity, compartments, project_ids as "projectIds", user_id AS "userId", assistant_id AS "assistantId", scope_version::text AS "scopeVersion",
  created_at as "createdAt", updated_at as "updatedAt"
`

const COMPACT_SELECT = `
  id, workspace_id as "workspaceId", title, status,
  assignee_id as "assigneeId", due, tags,
  parent_id as "parentId", attributes, sensitivity, compartments,
  project_ids as "projectIds", user_id AS "userId", assistant_id AS "assistantId", scope_version::text AS "scopeVersion", updated_at as "updatedAt"
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
  sensitivity: Sensitivity
  compartments: string[]
  projectIds: string[]
  userId:string|null
  assistantId:string|null
  scopeVersion:string
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
  sensitivity: Sensitivity
  compartments: string[]
  projectIds: string[]
  userId:string|null
  assistantId:string|null
  scopeVersion:string
  updatedAt: Date
}

function bindTaskSource<T extends object>(value:T,row:Pick<TaskRow,'id'|'workspaceId'|'userId'|'assistantId'|'scopeVersion'|'sensitivity'|'compartments'|'projectIds'>):T {
  return bindScopeSource(value,{resourceKind:'task',resourceId:row.id,workspaceId:row.workspaceId,
    userId:row.userId,assistantId:row.assistantId,version:row.scopeVersion,
    sensitivity:row.sensitivity,compartments:row.compartments,projectIds:row.projectIds})
}

function taskAccess(userId:string,workspaceId:string,explicit?:AccessContext):AccessContext {
  const agent=currentAgentAccess()
  if(agent&&(!agent.userId||!agent.workspaceId||agent.userId!==userId||agent.workspaceId!==workspaceId)
    ||explicit&&(explicit.userId!==userId||explicit.workspaceId!==workspaceId))
    throw Object.assign(new Error('The task operation requires the executing author.'),{code:'scope_operation_denied'})
  return explicit??{userId,workspaceId,assistantId:'',assistantKind:'primary'}
}

function checkTaskCreate(userId:string,params:Parameters<typeof createTask>[1]):AccessContext {
  const access=taskAccess(userId,params.workspaceId,params.access)
  assertExecutionResourceScope({workspaceId:params.workspaceId,userId:params.visibility?.userId??null,
    assistantId:params.visibility?.assistantId??null,sensitivity:params.sensitivity??'internal',
    compartments:params.compartments??[],projectIds:params.projectIds??[]},'mutation',access)
  return access
}

function toRecord(row: TaskRow): TaskRecord {
  return bindTaskSource({
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
    sensitivity: row.sensitivity,
    compartments: row.compartments ?? [],
    projectIds: row.projectIds ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  },row)
}

function toListRow(row: CompactRow): TaskListRow {
  return bindTaskSource({
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    status: row.status,
    assigneeId: row.assigneeId,
    due: row.due,
    tags: row.tags,
    parentId: row.parentId,
    attributes: row.attributes ?? {},
    sensitivity: row.sensitivity,
    compartments: row.compartments ?? [],
    projectIds: row.projectIds ?? [],
    updatedAt: row.updatedAt,
  },row)
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

async function checkTaskProject(
  userId: string,
  params: Parameters<typeof createTask>[1],
  transactionClient?: pg.PoolClient,
): Promise<void> {
  if ((params.projectIds?.length ?? 0) > 0) {
    const validProject = transactionClient
      ? await transactionClient.query<{ id: string }>(
        `SELECT id FROM workspace_projects
          WHERE workspace_id = $1 AND id = $2 AND status = 'active'`,
        [params.workspaceId, params.projectIds![0]],
      )
      : await queryWithRLS<{ id: string }>(
        userId,
      `SELECT id FROM workspace_projects
        WHERE workspace_id = $1 AND id = $2 AND status = 'active'`,
      [params.workspaceId, params.projectIds![0]],
      )
    if (validProject.rows.length === 0 || params.projectIds!.length > 1) {
      throw new Error('context_not_available: project')
    }
  }
}

/**
 * Return a live task in `workspaceId` that a create with this exact
 * content, scope, author and provenance would duplicate if it landed within
 * `TASK_DEDUP_WINDOW_SECONDS`. Runs under the caller's RLS so only same-
 * workspace rows are visible. `valid_to IS NULL` (live version) +
 * `retracted_at IS NULL` exclude superseded / retracted rows. Placeholder
 * titles never match. Returns null when there is no recent duplicate.
 */
export async function findRecentDuplicateTask(
  userId: string,
  coords: Parameters<typeof createTask>[1],
): Promise<TaskRecord | null> {
  const access=checkTaskCreate(userId,coords)
  await checkTaskProject(userId,coords)
  // Relationship writes are not represented by the row, so never swallow them.
  if (coords.title === PLACEHOLDER_TASK_TITLE||coords.dependsOn?.length||coords.linkedEntityIds?.length) return null
  const ap=buildAccessPredicate(access,{startIdx:20,operation:'mutation'})
  const result = await queryWithRLS<TaskRow>(userId,
    `SELECT ${FULL_SELECT} FROM tasks
      WHERE workspace_id=$1 AND title=$2 AND status=$3 AND parent_id IS NOT DISTINCT FROM $4
        AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
        AND created_at > now() - ($5 || ' seconds')::interval
        AND sensitivity=$6 AND compartments @> $7::text[] AND compartments <@ $7::text[]
        AND project_ids @> $8::uuid[] AND project_ids <@ $8::uuid[]
        AND user_id IS NOT DISTINCT FROM $9::uuid AND assistant_id IS NOT DISTINCT FROM $10::uuid
        AND assignee_id IS NOT DISTINCT FROM $11::uuid AND due IS NOT DISTINCT FROM $12::timestamptz
        AND tags=$13::text[] AND attributes=$14::jsonb AND external_ref=$15::jsonb
        AND created_by_user_id=$16 AND created_by_assistant_id IS NOT DISTINCT FROM $17::uuid
        AND source=$18 AND jsonb_build_array(source_session_id,source_episode_id,source_start_ms)=$19::jsonb
        AND ${ap.sql}
        AND context_scope_allows_current_principal(workspace_id,sensitivity,compartments,project_ids)
        AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=tasks.workspace_id
          AND wm.user_id=$16 AND sensitivity_rank(tasks.sensitivity)<=sensitivity_rank(wm.clearance))
        AND (effective_member_team_compartments($16,workspace_id) IS NULL
          OR compartments <@ effective_member_team_compartments($16,workspace_id))
      ORDER BY created_at DESC LIMIT 1`,
    [coords.workspaceId,coords.title,coords.status??'todo',coords.parentId??null,String(TASK_DEDUP_WINDOW_SECONDS),
      coords.sensitivity??'internal',coords.compartments??[],coords.projectIds??[],
      coords.visibility?.userId??null,coords.visibility?.assistantId??null,coords.assigneeId??null,coords.due??null,
      coords.tags??[],JSON.stringify(coords.attributes??{}),JSON.stringify(coords.externalRef??{}),
      userId,coords.createdByAssistantId??null,coords.source??'user',
      JSON.stringify([coords.sourceSessionId??null,coords.sourceEpisodeId??null,coords.sourceStartMs??null]),...ap.params])
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
    sensitivity?: Sensitivity
    visibility?: {userId:string|null;assistantId:string|null}
    access?: AccessContext
    /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
    compartments?: string[]
    /** Stable Project association; at most one by schema. */
    projectIds?: string[]
    /**
     * Fresh-insert `source`. Default `'user'` (interactive chat / API writes;
     * matches the mig-128 DB default). The structural-synthesis engine and
     * Pipeline B pass `'extracted'` so extraction-captured tasks surface in
     * Brain Reviews (`?includeExtracted=true`).
     */
    source?: 'user' | 'extracted'
    /**
     * Interactive-write provenance anchor (mig 316) — the `sessions` row of
     * the conversation that created this task. Chat `saveTask` stamps
     * `context.sessionId`; REST creates have no session and leave it NULL.
     * Advisory (no FK); read by the brain-inbox explain ladder.
     */
    sourceSessionId?: string | null
    /**
     * Extraction provenance anchor — the Episode this task was derived from.
     * Pipeline B and the synthesis engine pass `episode.id`; interactive
     * writes leave it NULL. (Column existed since mig 128; unwritten pre-316.)
     */
    sourceEpisodeId?: string | null
    /**
     * Offset into `sourceEpisodeId`'s recording where this task was committed
     * to (mig 338) — set only by a recording fill, whose `saveTask` is widened
     * to ask for it and which validates it against the transcript first. A
     * column, not `attributes`: `updateTask` overwrites that object wholesale.
     */
    sourceStartMs?: number | null
    /** The assistant that mediated the write (chat/workflow saveTask). */
    createdByAssistantId?: string | null
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
  transactionClient?: pg.PoolClient,
): Promise<TaskRecord> {
  // WU-4.5 — authorship NOT NULL enforcement at the store layer. The
  // `userId` argument is both the RLS actor and the row author; without
  // it the row would land with a NULL `created_by_user_id` (mig 128
  // leaves the column nullable; the guard, not the schema, enforces).
  // Other universal columns (sensitivity, source, valid_from) take
  // their schema defaults from migration 128.
  assertAuthorshipPresent('createTask', userId)
  checkTaskCreate(userId,params)
  await checkTaskProject(userId,params,transactionClient)
  const sql =
    `INSERT INTO tasks (workspace_id, title, status, assignee_id, due, tags, parent_id, external_ref, attributes, created_by_user_id, compartments, project_ids, source, source_session_id, source_episode_id, created_by_assistant_id, source_start_ms, sensitivity, user_id, assistant_id)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
     WHERE EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$10)
       AND (effective_member_team_compartments($10,$1) IS NULL
         OR $11::text[] <@ effective_member_team_compartments($10,$1))
     RETURNING ${FULL_SELECT}`
  const values = [
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
      params.projectIds ?? [],
      params.source ?? 'user',
      params.sourceSessionId ?? null,
      params.sourceEpisodeId ?? null,
      params.createdByAssistantId ?? null,
      params.sourceStartMs ?? null,
      params.sensitivity??'internal',params.visibility?.userId??null,params.visibility?.assistantId??null,
    ]
  const result = transactionClient
    ? await transactionClient.query<TaskRow>(sql, values)
    : await queryWithRLS<TaskRow>(userId, sql, values)
  if (!result.rows[0]) throw Object.assign(new Error('The task operation is outside the current access scope.'), { code: 'scope_operation_denied' })
  const task = toRecord(result.rows[0])

  // Workflow task-event emit — fire-and-forget after the committed insert
  // (single-statement autocommit above). The late-bound fanout is a no-op
  // until bootOpenApi binds the dispatcher. [COMP:api/task-event-fanout]
  if (!transactionClient) publishTaskLifecycle({
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
  if (!transactionClient && entityLinks && params.linkedEntityIds && params.linkedEntityIds.length > 0) {
    void emitMentionedEdges(entityLinks, userId, {
      sourceKind: 'task',
      sourceId: task.id,
      entityIds: params.linkedEntityIds,
      workspaceId: task.workspaceId,
      source: 'user',
      userId,
      compartments: task.compartments,
      projectIds: task.projectIds,
    })
  }
  // Fire-and-forget `depends_on` edges from this task → each
  // depended-on task. v1 append-only — never removes existing edges.
  if (!transactionClient && entityLinks && params.dependsOn && params.dependsOn.length > 0) {
    void emitDependsOnEdges(entityLinks, userId, {
      sourceTaskId: task.id,
      dependsOnTaskIds: params.dependsOn,
      workspaceId: task.workspaceId,
      source: 'user',
      userId,
      compartments: task.compartments,
      projectIds: task.projectIds,
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
       AND id = $${ap.nextIdx} AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held`,
    [...ap.params, id],
  )
  if (result.rows.length === 0) return null
  return toRecord(result.rows[0])
}

export async function listTasks(ctx: AccessContext, filters: TaskListFilters): Promise<TaskListRow[]> {
  // `valid_to IS NULL` filter hides superseded versions. Index
  // `idx_tasks_valid` (migration 128) covers this predicate.
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const wheres: string[] = [ap.sql, 'valid_to IS NULL', 'retracted_at IS NULL', 'NOT scope_held']
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
  if (filters.projectId !== undefined) {
    if (filters.projectId === null) {
      wheres.push('cardinality(project_ids) = 0')
    } else {
      wheres.push(`project_ids = ARRAY[$${idx}::uuid]`)
      values.push(filters.projectId)
      idx++
    }
  }
  if (filters.parentId) {
    wheres.push(`parent_id = $${idx}`)
    values.push(filters.parentId)
    idx++
  }

  // DB-layer clamp is 500 for the Tasks operator surface's flat browse
  // (`GET /api/brain/tasks`); the model-facing `listTasks` tool keeps its
  // own zod clamp at 100 so chat payloads stay small (tasks.md → "Operator
  // surface").
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 500)
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
  sensitivity: Sensitivity
  compartments: string[]
  project_ids: string[]
  user_id: string | null
  assistant_id: string | null
  source: string
  source_episode_id: string | null
  source_session_id: string | null
  created_by_assistant_id: string | null
  /** Migration 334 — carried through supersession, see the INSERT below. */
  source_start_ms: number | null
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
  UNION
  SELECT t.id, t.superseded_by, t.valid_to
  FROM tasks t JOIN chain c ON t.id = c.superseded_by
)`

/**
 * Resolve any row in a task's bi-temporal chain to its live head, retaining
 * the universal viewer projection. Temporary thread targets persist a lineage
 * anchor for days, while every edit rotates the live id, so their task gate
 * must compare resolved heads rather than raw ids.
 */
export async function resolveTaskById(
  ctx: AccessContext,
  id: string,
): Promise<TaskRecord | null> {
  const ap = buildAccessPredicate(ctx, { startIdx: 2 })
  const result = await queryWithRLS<TaskRow>(
    ctx.userId,
    `${LIVE_TASK_ID_CTE}
     SELECT ${FULL_SELECT} FROM tasks
      WHERE ${ap.sql}
        AND id = (SELECT id FROM chain WHERE valid_to IS NULL LIMIT 1)
        AND retracted_at IS NULL AND NOT scope_held`,
    [id, ...ap.params],
  )
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

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
  opts?: Parameters<TaskStore['update']>[3],
): Promise<TaskRecord | null> {
  const readOnly=Object.keys(fields).length===0
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client,userId)
    try {
      // Forward-resolve a superseded input id to its live head (see header)
      // so a caller holding a pre-supersession id patches the current row
      // instead of getting a spurious not-found. A genuinely unknown id (or a
      // chain with no live row) resolves to nothing → not-found, as before.
      const liveRes = await client.query<{ id: string; workspaceId:string }>(
        `${LIVE_TASK_ID_CTE} SELECT t.id,t.workspace_id AS "workspaceId" FROM tasks t WHERE t.id=(SELECT id FROM chain WHERE valid_to IS NULL LIMIT 1)`,
        [id],
      )
      if (liveRes.rows.length === 0) {
        await client.query('ROLLBACK')
        return null
      }
      const liveId = liveRes.rows[0].id
      const access=taskAccess(userId,liveRes.rows[0].workspaceId,opts?.access)
      const ap=buildAccessPredicate(access,{startIdx:2,operation:readOnly?'read':'mutation'})
      const memberScope=`context_scope_allows_current_principal(workspace_id,sensitivity,compartments,project_ids)
        AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=tasks.workspace_id
          AND wm.user_id=current_setting('app.current_user_id')::uuid
          AND sensitivity_rank(tasks.sensitivity)<=sensitivity_rank(wm.clearance))
        AND (effective_member_team_compartments(current_setting('app.current_user_id')::uuid,workspace_id) IS NULL
          OR compartments <@ effective_member_team_compartments(current_setting('app.current_user_id')::uuid,workspace_id))`
      if(readOnly){
        const current=await client.query<TaskRow>(`SELECT ${FULL_SELECT} FROM tasks
          WHERE id=$1 AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held AND ${ap.sql} AND ${memberScope}`,[liveId,...ap.params])
        await client.query('COMMIT')
        return current.rows[0]?toRecord(current.rows[0]):null
      }

      const oldRes = await client.query<OldTaskRow>(
        `SELECT workspace_id, title, status, assignee_id, due, tags, parent_id, external_ref, attributes,
                sensitivity, compartments, project_ids,
                user_id, assistant_id, source, source_episode_id,
                source_session_id, created_by_assistant_id, source_start_ms
         FROM tasks WHERE id = $1 AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
           AND ${ap.sql} AND ${memberScope} FOR UPDATE`,
        [liveId,...ap.params],
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
      const nextCompartments = unionScopeRequirements(old.compartments, opts?.scope?.compartments)
      const nextProjectIds = unionScopeRequirements(old.project_ids, opts?.scope?.projectIds)
      const nextSensitivity=maxSensitivity(old.sensitivity,opts?.scope?.sensitivity??'public')
      const mergeVisibility=(current:string|null,inherited:string|null|undefined)=>{
        if(current&&inherited&&current!==inherited)throw Object.assign(new Error('Task visibility cannot combine these sources.'),{code:'scope_visibility_incompatible'})
        return current??inherited??null
      }
      const nextUserId=mergeVisibility(old.user_id,opts?.scope?.visibility?.userId)
      const nextAssistantId=mergeVisibility(old.assistant_id,opts?.scope?.visibility?.assistantId)
      assertExecutionResourceScope({workspaceId:old.workspace_id,userId:nextUserId,assistantId:nextAssistantId,
        sensitivity:nextSensitivity,compartments:nextCompartments,projectIds:nextProjectIds},'mutation',access)

      const insertRes = await client.query<TaskRow>(
        `INSERT INTO tasks (
           workspace_id, title, status, assignee_id, due, tags, parent_id, external_ref, attributes,
           sensitivity, compartments, project_ids,
           user_id, assistant_id, source, source_episode_id,
           source_session_id, created_by_assistant_id, source_start_ms,
           created_by_user_id, valid_from, valid_to, superseded_by
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
                 $10, $11::text[], $12::uuid[],
                 $13, $14, $15, $16,
                 $17, $18, $19,
                 $20, now(), NULL, NULL
         WHERE EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$20)
           AND (effective_member_team_compartments($20,$1) IS NULL
             OR $11::text[] <@ effective_member_team_compartments($20,$1))
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
          nextSensitivity,
          nextCompartments,
          nextProjectIds,
          nextUserId,
          nextAssistantId,
          old.source,
          old.source_episode_id,
          // Provenance anchors carry forward through supersession — the
          // originating conversation/assistant stays answerable after edits
          // (matches updateMemory). created_by_user_id re-stamps the editor.
          old.source_session_id,
          old.created_by_assistant_id,
          // The moment in the recording (migration 338) is provenance too, and
          // it MUST be carried: omitting it defaults the new version to NULL,
          // so any ordinary edit — a status tick, a due date — silently strips
          // the task's pointer into the audio while leaving
          // `source_episode_id` intact. The task then claims to come from a
          // recording but no longer knows where in it, and the brief's
          // "@ 47:21" seek link dies. This is the same wholesale-overwrite trap
          // that put the moment in a column instead of `attributes` in the
          // first place; the column only helps if the supersede carries it.
          old.source_start_ms,
          userId,
        ],
      )
      const newRow = insertRes.rows[0]
      if (!newRow) throw Object.assign(new Error('The task operation is outside the current access scope.'), { code: 'scope_operation_denied' })

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
      const childAccess=buildAccessPredicate(access,{startIdx:3,operation:'mutation'})
      await client.query(
        `UPDATE tasks SET parent_id = $1
         WHERE parent_id = $2 AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
           AND ${childAccess.sql} AND ${memberScope}`,
        [newRow.id, liveId,...childAccess.params],
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

      // Host-lifecycle cascade: a task that just went terminal is no longer
      // assignable, so its DRAFT goals go with it — a "your assistant could
      // help with this" offer on work the user already finished or filed away is
      // noise on the triage surface, and nothing ever clears it (a draft is
      // inert: the rollup skips it and no tick fires). Drafts only — a CONFIRMED
      // goal whose host task closes is the goal succeeding, and completing it is
      // the rollup's / acting loop's job. Runs on the same client as the
      // supersede above, so it commits atomically with the close, and reads the
      // NEW id because the repoint just moved the binding there.
      // See docs/architecture/features/goals.md → "Host-lifecycle cascade".
      if (newStatus === 'done' || newStatus === 'archived') {
        await abandonGoalsForHostTaskSystem(newRow.id, 'host_task_closed', {
          draftsOnly: true,
          exec: client,
        })
      }

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
          compartments: newTask.compartments,
          projectIds: newTask.projectIds,
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
    `SELECT ${FULL_SELECT} FROM tasks WHERE id = $1 AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held`,
    [id],
  )
  if (result.rows.length === 0) return null
  return toRecord(result.rows[0])
}

/**
 * System-level lookup of live, non-archived tasks whose `external_ref` jsonb
 * CONTAINS `match` (`@>` containment). No RLS / AccessContext — the caller
 * (the ingest GitHub task lifecycle) is already authorized for `workspaceId`,
 * which scopes the query. Archived tasks are excluded so a reconciliation
 * (PR merged → done) never re-touches a row the user swept away. Newest first.
 */
export async function findTasksByExternalRefSystem(
  workspaceId: string,
  match: Record<string, unknown>,
): Promise<TaskRecord[]> {
  const result = await query<TaskRow>(
    `SELECT ${FULL_SELECT} FROM tasks
     WHERE workspace_id = $1
       AND external_ref @> $2::jsonb
       AND valid_to IS NULL
       AND status <> 'archived'
       AND retracted_at IS NULL AND NOT scope_held
     ORDER BY created_at DESC`,
    [workspaceId, JSON.stringify(match)],
  )
  return result.rows.map(toRecord)
}

/**
 * Return authorized versions in the bidirectional task history, ordered by
 * valid_from. Every row passes its own full scope predicate; a visible version
 * does not authorize a more restricted successor. Held and retracted bodies
 * remain excluded. UNION prevents repeated traversal of the same version.
 */
export async function getTaskHistory(ctx: AccessContext, id: string): Promise<TaskRecord[]> {
  // Classification can change between versions. Filter each returned row;
  // authorization of one lineage anchor is never authority over the chain.
  const ap=buildAccessPredicate(ctx,{startIdx:2})
  const result=await queryWithRLS<TaskRow>(ctx.userId,
    `WITH RECURSIVE chain(id,superseded_by) AS (
      SELECT id,superseded_by FROM tasks WHERE id=$1
      UNION
      SELECT t.id,t.superseded_by FROM tasks t JOIN chain c ON t.id=c.superseded_by OR t.superseded_by=c.id
    ) SELECT ${FULL_SELECT} FROM tasks
      WHERE id IN(SELECT id FROM chain) AND ${ap.sql} AND NOT scope_held AND retracted_at IS NULL
      ORDER BY valid_from ASC`,[id,...ap.params])
  return result.rows.map(toRecord)
}

/**
 * A task as the RECORDING SURFACE renders it: the title, whether it is done,
 * who owns it, and the moment in the recording it was committed to.
 *
 * A separate shape from `TaskRecord` on purpose. `TaskRecord` is the
 * MODEL-facing row — deliberately compact, carrying no provenance at all (not
 * `sourceEpisodeId`, not `sourceStartMs`), because every field on it is
 * context the model pays for on every `listTasks`. The brief page needs
 * exactly the provenance the model does not, so it gets its own projection
 * rather than widening the model's row for a UI concern.
 *
 * `assigneeId` is a `workspace_members` row id (NOT a user id) — the web
 * client resolves it against the workspace roster, same as the Brain list.
 * See docs/architecture/features/tasks.md → "Source moment".
 */
export type RecordingTaskRow = {
  id: string
  title: string
  status: TaskRecordStatus
  assigneeId: string | null
  /** Milliseconds into the recording, or null when the model cited no moment. */
  sourceStartMs: number | null
  /**
   * False while nobody has confirmed the model actually heard this.
   *
   * Every task synthesis captures is written `source='extracted'` and
   * UNVERIFIED, and the brain inbox deliberately excludes extracted rows (one
   * transcript naming 30 people would flood it overnight) — so until this
   * surface existed, an extracted task landed in the brain with no review
   * anywhere. The rail is the per-recording "extraction queue" the inbox store
   * names as the intended follow-up: one meeting is high signal-to-noise in a
   * way the whole overnight firehose is not.
   */
  verified: boolean
}

/**
 * Every task captured from one recording, oldest moment first — the order they
 * were said, which is the order the brief's action-items list reads in.
 *
 * Tasks with no cited moment sort last rather than being dropped: a real
 * commitment the model failed to timestamp is still a commitment, and hiding it
 * would make the rail quietly lie about what the meeting agreed to.
 */
export async function listTasksBySourceEpisode(
  ctx: AccessContext,
  episodeId: string,
): Promise<RecordingTaskRow[]> {
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryGated<RecordingTaskRow>(
    ctx,
    `SELECT id, title, status,
            assignee_id as "assigneeId",
            source_start_ms as "sourceStartMs",
            (verified_by_user_id IS NOT NULL) as "verified"
     FROM tasks
     WHERE ${ap.sql} AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held AND source_episode_id = $${ap.nextIdx}
     ORDER BY source_start_ms ASC NULLS LAST, created_at ASC`,
    [...ap.params, episodeId],
  )
  return result.rows
}
