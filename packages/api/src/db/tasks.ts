import { readCurrentScopeSources,validateDerivedWriteInputs,recordDerivedResource } from './derived-scope-store.js'
import { captureLegacyCanonicalTaskCandidates,LEGACY_TASK_FULL_FIELDS,taskNeedsIndependentSourceAuthoritySql } from './task-reader.js'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { ApplicationPlatformError, applicationJsonSchema, applicationResourceRefSchema } from '@use-brian/shared'
import { admitTaskCreate } from '../workspace-access/task-create-admission.js'
import { applyResponsibilityPatch, boundScopeSources, bindScopeSource, executorChanged, maxSensitivity, unionScopeRequirements, TASK_STATUSES } from '@use-brian/core'
import type { AccessContext, EntityLinksStore, Sensitivity, TaskHome, TaskListFilters, TaskListRow, TaskRecord, TaskRecordStatus, TaskResponsibility, TaskUpdateFields, TaskWriteActor, TaskStore, TaskAssignmentProvenance } from '@use-brian/core'
import type pg from 'pg'
import { assertExecutionResourceScope, buildAccessPredicate } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { applyRLSGucs, getAppPool, query, queryWithRLS, rollbackAndRelease } from './client.js'
import { emitDependsOnEdges, emitMentionedEdges } from './edge-hooks.js'
import { abandonGoalsForHostTaskSystem } from './goals.js'
import { currentAgentAccess } from './agent-access-context.js'
import { publishTaskLifecycle } from '../task-event-fanout.js'
import { validateTaskResponsibility } from '../tasks/responsibility.js'
import { getApplicationTransactionBinding } from '../application-platform/execution-context.js'
import { listLegacyCanonicalTasks,readLegacyCanonicalTask,readLegacyCanonicalTaskHistory,listLegacyCanonicalRecordingTasks } from './task-reader.js'

const RESPONSIBILITY_SELECT = `executor_assistant_id AS "executorAssistantId", follow_up_member_id AS "followUpMemberId",
  home_kind AS "homeKind", home_id AS "homeId"`

const FULL_SELECT = `
  id, logical_id AS "logicalId", workspace_id as "workspaceId", title, status,
  assignee_id as "assigneeId", ${RESPONSIBILITY_SELECT}, due, tags,
  parent_id as "parentId", external_ref as "externalRef", attributes,
  sensitivity, compartments, project_ids as "projectIds", user_id AS "userId", assistant_id AS "assistantId", scope_version::text AS "scopeVersion",
  created_at as "createdAt", updated_at as "updatedAt"
`


type ResponsibilityRow = {
  executorAssistantId: string | null
  followUpMemberId: string | null
  homeKind: TaskHome['kind'] | null
  homeId: string | null
}

const homeOf = (row: Pick<ResponsibilityRow, 'homeKind' | 'homeId'>): TaskHome | null =>
  row.homeKind && row.homeId ? { kind: row.homeKind, id: row.homeId } : null

type TaskRow = ResponsibilityRow & {
  logicalId: string
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
    logicalId: row.logicalId,
    workspaceId: row.workspaceId,
    title: row.title,
    status: row.status,
    assigneeId: row.assigneeId,
    executorAssistantId: row.executorAssistantId,
    followUpMemberId: row.followUpMemberId,
    home: homeOf(row),
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
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client,userId)
    coords = await admitTaskCreate(client,userId,coords,taskAccess(userId,coords.workspaceId,coords.access))
    const result = await findTaskDuplicateInTransaction(userId,coords,client)
    await client.query('COMMIT')
    return result
  } finally { await rollbackAndRelease(client) }
}

async function findTaskDuplicateInTransaction(userId: string, coords: Parameters<typeof createTask>[1], client: pg.PoolClient): Promise<TaskRecord | null> {
  const access=checkTaskCreate(userId,coords)
  await checkTaskProject(userId,coords,client)
  // Relationship writes are not represented by the row, so never swallow them.
  if (coords.title === PLACEHOLDER_TASK_TITLE||coords.dependsOn?.length||coords.linkedEntityIds?.length) return null
  const metadata=(await client.query<{id:string}>(`SELECT id FROM tasks WHERE workspace_id=$1 AND valid_to IS NULL
    AND retracted_at IS NULL AND NOT scope_held AND ${coords.derivation?.sources.length
      ? 'native_task_derivation_matches(workspace_id,id,scope_version::text,$2::jsonb)'
      : 'native_task_dedup_candidate_allowed(workspace_id,id,scope_version::text)'} ORDER BY id LIMIT 4097`,
    [coords.workspaceId,...(coords.derivation?.sources.length?[JSON.stringify(coords.derivation.sources)]:[])])).rows
  if(metadata.length>4096)throw new ApplicationPlatformError('access_unavailable','The duplicate domain is unavailable.')
  const captured=await captureLegacyCanonicalTaskCandidates(access,[...LEGACY_TASK_FULL_FIELDS,'createdByUserId','createdByAssistantId','source','sourceSessionId','sourceEpisodeId','sourceStartMs'],client,metadata.map(row=>row.id))
  const ap=buildAccessPredicate(access,{startIdx:24,operation:'mutation'})
  const result = await client.query<{id:string}>(
    `SELECT id FROM tasks
      WHERE workspace_id=$1 AND title=$2 AND status=$3 AND parent_id IS NOT DISTINCT FROM $4
        AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
        AND created_at > now() - ($5 || ' seconds')::interval
        AND sensitivity=$6 AND compartments @> $7::text[] AND compartments <@ $7::text[]
        AND project_ids @> $8::uuid[] AND project_ids <@ $8::uuid[]
        AND user_id IS NOT DISTINCT FROM $9::uuid AND assistant_id IS NOT DISTINCT FROM $10::uuid
        AND assignee_id IS NOT DISTINCT FROM $11::uuid AND due IS NOT DISTINCT FROM $12::timestamptz
        AND executor_assistant_id IS NOT DISTINCT FROM $20::uuid AND follow_up_member_id IS NOT DISTINCT FROM $21::uuid
        AND home_kind IS NOT DISTINCT FROM $22::text AND home_id IS NOT DISTINCT FROM $23::uuid
        AND tags=$13::text[] AND attributes=$14::jsonb AND external_ref=$15::jsonb
        AND created_by_user_id=$16 AND created_by_assistant_id IS NOT DISTINCT FROM $17::uuid
        AND source=$18 AND jsonb_build_array(source_session_id,source_episode_id,source_start_ms)=$19::jsonb
        AND ${ap.sql} AND id=ANY($${ap.nextIdx}::uuid[])
        AND ($${ap.nextIdx+1}::jsonb IS NULL OR native_task_derivation_matches(workspace_id,id,scope_version::text,$${ap.nextIdx+1}::jsonb))
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
      JSON.stringify([coords.sourceSessionId??null,coords.sourceEpisodeId??null,coords.sourceStartMs??null]),
      coords.executorAssistantId??null,coords.followUpMemberId??null,coords.home?.kind??null,coords.home?.id??null,...ap.params,captured.map(candidate=>candidate.id),coords.derivation?.sources.length?JSON.stringify(coords.derivation.sources):null])
  const duplicate=result.rows[0]?await getTaskById(access,result.rows[0].id,client):null
  if((await readCurrentScopeSources(client,coords.workspaceId,boundScopeSources(captured))).some(source=>source.state!=='current'))throw new ApplicationPlatformError('access_unavailable','The duplicate source changed.')
  return duplicate
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
    expectedPolicyRevision?: string
    derivation?: import('@use-brian/core').DerivedWriteEvidence
    title: string
    status?: TaskRecordStatus
    /** PERSON executor. Never together with `executorAssistantId` (task_executor_conflict). */
    assigneeId?: string | null
    /** ASSISTANT executor (migration 753); validated against the actor and the home. */
    executorAssistantId?: string | null
    /** Explicit human follow-up contact; never implies execution. */
    followUpMemberId?: string | null
    /** Explicit operating home; omitted means unknown. */
    home?: TaskHome | null
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
  options?: { deduplicate?: boolean; onInserted?: (task: TaskRecord) => void; onInsertedInTransaction?: (task:TaskRecord)=>void },
): Promise<TaskRecord> {
  // WU-4.5 — authorship NOT NULL enforcement at the store layer. The
  // `userId` argument is both the RLS actor and the row author; without
  // it the row would land with a NULL `created_by_user_id` (mig 128
  // leaves the column nullable; the guard, not the schema, enforces).
  // Other universal columns (sensitivity, source, valid_from) take
  // their schema defaults from migration 128.
  assertAuthorshipPresent('createTask', userId)
  const creationKeys=Object.keys(canonicalTaskPatchSchema.shape)
  const metadataKeys=['derivation','workspaceId','expectedPolicyRevision','sensitivity','visibility','access','compartments','projectIds','source','sourceSessionId','sourceEpisodeId','sourceStartMs','createdByAssistantId','linkedEntityIds','writtenBy']
  if(Object.keys(params).some(key=>!creationKeys.includes(key)&&!metadataKeys.includes(key))
    ||!canonicalTaskPatchSchema.required({title:true}).safeParse(Object.fromEntries(creationKeys.map(key=>[key,(params as unknown as Record<string,unknown>)[key]]))).success) {
    throw new ApplicationPlatformError('invalid_value','The canonical task creation values are invalid.')
  }
  const client = transactionClient ?? await getAppPool().connect()
  let task: TaskRecord
  try {
    if (!transactionClient) {
      await client.query('BEGIN')
      await applyRLSGucs(client,userId)
    }
    const application = getApplicationTransactionBinding(client)
    if (application && (application.workspaceId !== params.workspaceId || application.actorUserId !== userId)) throw new Error('scope_operation_denied')
    if (!application) params = await admitTaskCreate(client,userId,params,taskAccess(userId,params.workspaceId,params.access))
    checkTaskCreate(userId,params)
    if(params.derivation)await validateDerivedWriteInputs(client,params.derivation)
    if (!application) await checkTaskProject(userId,params,client)
    const responsibility = applyResponsibilityPatch(
      { assigneeId: null, executorAssistantId: null, followUpMemberId: null, home: null },
      { assigneeId: params.assigneeId ?? null, executorAssistantId: params.executorAssistantId ?? null,
        followUpMemberId: params.followUpMemberId ?? null, home: params.home ?? null })
    await validateTaskResponsibility(client, userId, {
      workspaceId: params.workspaceId, sensitivity: params.sensitivity ?? 'internal',
      compartments: params.compartments ?? [], projectIds: params.projectIds ?? [],
      privateUserId: params.visibility?.userId ?? null, privateAssistantId: params.visibility?.assistantId ?? null,
    }, null, responsibility)
    if (options?.deduplicate) {
      const duplicate = await findTaskDuplicateInTransaction(userId,params,client)
      if (duplicate) {
        if (!transactionClient) await client.query('COMMIT')
        return duplicate
      }
    }
    const sql =
      `INSERT INTO tasks (workspace_id, title, status, assignee_id, due, tags, parent_id, external_ref, attributes, created_by_user_id, compartments, project_ids, source, source_session_id, source_episode_id, created_by_assistant_id, source_start_ms, sensitivity, user_id, assistant_id,
          executor_assistant_id, follow_up_member_id, home_kind, home_id)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
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
        responsibility.executorAssistantId, responsibility.followUpMemberId,
        responsibility.home?.kind ?? null, responsibility.home?.id ?? null,
      ]
    const { access: _access, writtenBy: _writtenBy, derivation: _derivation, ...applicationParams } = params
    const result = application ? await client.query<TaskRow>(`SELECT ${FULL_SELECT} FROM application_create_canonical_task($1::jsonb)`, [JSON.stringify(applicationParams)])
      : await client.query<TaskRow>(sql, values)
    if (!result.rows[0]) throw Object.assign(new Error('The task operation is outside the current access scope.'), { code: 'scope_operation_denied' })
    task = toRecord(result.rows[0])
    if(params.derivation)await recordDerivedResource(client,params.derivation,boundScopeSources(task)[0],userId)
    options?.onInsertedInTransaction?.(task)
    if (!transactionClient) await client.query('COMMIT')
  } finally {
    if (!transactionClient) await rollbackAndRelease(client)
  }
  if (!transactionClient) options?.onInserted?.(task)

  if(!transactionClient)emitCreatedTaskEffects(task,userId,params,entityLinks)

  return task
}

/** Shared canonical after-commit hooks for ordinary and source-bound task creation. */
export function emitCreatedTaskEffects(task:TaskRecord,userId:string,params:Parameters<typeof createTask>[1],entityLinks?:EntityLinksStore):void {
  // Workflow task-event emit — fire-and-forget after the committed insert
  // (writer transaction above). The late-bound fanout is a no-op
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
      compartments: task.compartments,
      projectIds: task.projectIds,
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
      compartments: task.compartments,
      projectIds: task.projectIds,
    })
  }
}

export async function getTaskById(ctx: AccessContext, id: string, transactionClient?: pg.PoolClient): Promise<TaskRecord | null> {
  return readLegacyCanonicalTask(ctx,id,transactionClient)
}

export async function listTasks(ctx: AccessContext, filters: TaskListFilters): Promise<TaskListRow[]> {
  return listLegacyCanonicalTasks(ctx,filters)
}

type OldTaskRow = {
  logical_id: string
  scope_version: string
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
  /** Migration 753 — responsibility, carried through supersession. */
  executor_assistant_id: string | null
  follow_up_member_id: string | null
  home_kind: TaskHome['kind'] | null
  home_id: string | null
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
  if (next.assigneeId !== old.assignee_id) changed.push('assigneeId')
  if ((next.executorAssistantId ?? null) !== old.executor_assistant_id) changed.push('executorAssistantId')
  if ((next.followUpMemberId ?? null) !== old.follow_up_member_id) changed.push('followUpMemberId')
  if ((next.home?.kind ?? null) !== old.home_kind || (next.home?.id ?? null) !== old.home_id) changed.push('home')
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
    !isDeepStrictEqual(next.externalRef, old.external_ref ?? {})
  ) {
    changed.push('externalRef')
  }
  if (
    fields.attributes !== undefined &&
    !isDeepStrictEqual(next.attributes, old.attributes ?? {})
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
export async function resolveTaskById(ctx:AccessContext,id:string,transactionClient?:pg.PoolClient):Promise<TaskRecord|null> {
  return readLegacyCanonicalTask(ctx,id,transactionClient,true)
}

type ExecutorChangeHook = (task: TaskRecord, previous: TaskResponsibility, actorUserId: string, assignment?: TaskAssignmentProvenance) => void
let executorChangeHook: ExecutorChangeHook | null = null

/**
 * Late-bound consumer of a committed executor change on a top-level task
 * (migration 753). Boot binds executor-gated Goal triage here, so every write
 * path (Brian tools, MCP, the Brain inbox routes, the claim route) reaches it,
 * not only writes through one store instance. Fire-and-forget; a no-op until
 * bound. The drafts made for the previous executor are already retired inside
 * the update transaction.
 */
export function bindTaskExecutorChangeHook(hook: ExecutorChangeHook | null): void {
  executorChangeHook = hook
}

type TaskClosedHook = (task: TaskRecord, previousStatus: TaskRecordStatus) => void
let taskClosedHook: TaskClosedHook | null = null

/**
 * Late-bound consumer of a committed transition INTO `done` / `archived`, on
 * every write path (tools, MCP, Brain inbox, rollup). Boot binds the waiting
 * execution wake here (goals.md -> "Descendants and the shared pool"): a
 * prerequisite that actually completed revalidates the work waiting on it.
 * Fire-and-forget; a no-op until bound.
 */
export function bindTaskClosedHook(hook: TaskClosedHook | null): void {
  taskClosedHook = hook
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
/** Fixed canonical writer composition; no transaction ownership transfer. */
export interface CanonicalTaskWriteTransaction {
  client: pg.PoolClient
  afterCommit(effect: () => void): void
}
const canonicalTaskPatchSchema = z.object({
  title: z.string().min(1).max(512).refine(value => value.trim().length > 0).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assigneeId: z.string().uuid().nullable().optional(), executorAssistantId: z.string().uuid().nullable().optional(),
  followUpMemberId: z.string().uuid().nullable().optional(),
  home: z.object({ kind: z.enum(['department','project']), id: z.string().uuid() }).strict().nullable().optional(),
  due: z.date().nullable().optional(), tags: z.array(z.string()).optional(),
  parentId: z.string().uuid().nullable().optional(), externalRef: z.record(applicationJsonSchema).optional(),
  attributes: z.record(applicationJsonSchema).optional(), dependsOn: z.array(z.string().uuid()).optional(),
}).strict()
/** Metadata admission for native commands; no before-image crosses this port. */
export async function authorizeCanonicalTaskPatch(userId:string,workspaceId:string,id:string,fields:TaskUpdateFields,client:pg.PoolClient,access?:AccessContext) {
 if(!canonicalTaskPatchSchema.safeParse(fields).success)throw new ApplicationPlatformError('invalid_value','The task patch is invalid.')
 const actor=taskAccess(userId,workspaceId,access)
 const current=(await client.query<{value:unknown}>('SELECT application_task_patch_state($1,$2,$3) AS value',[workspaceId,id,Object.keys(fields).filter(key=>key!=='dependsOn')])).rows[0]?.value
 if(current==null)return null
 const state=z.object({workspaceId:z.string().uuid(),id:z.string().uuid(),physicalId:z.string().uuid(),version:z.string().regex(/^[1-9]\d*$/),
  scope:z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),sensitivity:z.enum(['public','internal','confidential']),
   compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).passthrough()}).parse(current)
 if(state.workspaceId!==workspaceId)throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
 assertExecutionResourceScope(state.scope,'mutation',actor)
 return state
}
export async function patchCanonicalTaskFields(userId:string,workspaceId:string,id:string,fields:TaskUpdateFields,client:pg.PoolClient,access?:AccessContext,
 operation?:{expectedVersion?:string;scope?:import('@use-brian/core').TaskWriteScope}) {
 const before=await authorizeCanonicalTaskPatch(userId,workspaceId,id,fields,client,access)
 if(!before)return null
 let value:unknown
 try{value=(await client.query<{value:unknown}>('SELECT application_patch_canonical_task($1,$2,$3,$4,$5) AS value',[workspaceId,id,fields,operation?.expectedVersion??before.version,operation?.scope??null])).rows[0]?.value}
 catch(error){const code=(error as {code?:string}).code
  if(['40001','40P01','23505'].includes(code??''))throw new ApplicationPlatformError('record_version_conflict','The task changed. Refresh before retrying.')
  if(['22023','23514','22P02'].includes(code??''))throw new ApplicationPlatformError('invalid_value','The task values are invalid.')
  if(code==='42501')throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
  throw error
 }
 const parsed=applicationResourceRefSchema.extend({physicalId:z.string().uuid()}).parse(value)
 const {physicalId,...ref}=parsed
 const after=await authorizeCanonicalTaskPatch(userId,workspaceId,physicalId,fields,client,access)
 if(!after||after.id!==ref.id||after.version!==ref.version)throw new ApplicationPlatformError('access_unavailable','The task changed.')
 return {ref,physicalId}
}
export async function updateTask(
  userId: string,
  id: string,
  fields: TaskUpdateFields,
  entityLinks?: EntityLinksStore,
  opts?: Parameters<TaskStore['update']>[3],
  transaction?: CanonicalTaskWriteTransaction,
): Promise<TaskRecord | null> {
  if (!canonicalTaskPatchSchema.safeParse(fields).success) throw new ApplicationPlatformError('invalid_value','The task patch is invalid.')
  if (opts?.expectedVersion !== undefined && !/^[1-9]\d*$/.test(opts.expectedVersion)) {
    throw new ApplicationPlatformError('record_version_conflict','A valid expected task version is required.')
  }
  const readOnly=Object.keys(fields).length===0, own = !transaction
  const client = transaction?.client ?? await getAppPool().connect()
  try {
    if (own) await client.query('BEGIN')
    if (transaction) {
      const role = await client.query(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
        FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.tasks'::regclass WHERE r.rolname=current_user`)
      if (role.rows[0]?.bypass !== false) throw new ApplicationPlatformError('access_unavailable','A non-owner canonical task transaction is required.')
    }
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
        if (own) await client.query('ROLLBACK')
        return null
      }
      let liveId = liveRes.rows[0].id
      const access=taskAccess(userId,liveRes.rows[0].workspaceId,opts?.access)
      const ap=buildAccessPredicate(access,{startIdx:2,operation:readOnly?'read':'mutation'})
      const memberScope=`context_scope_allows_current_principal(workspace_id,sensitivity,compartments,project_ids)
        AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=tasks.workspace_id
          AND wm.user_id=current_setting('app.current_user_id')::uuid
          AND sensitivity_rank(tasks.sensitivity)<=sensitivity_rank(wm.clearance))
        AND (effective_member_team_compartments(current_setting('app.current_user_id')::uuid,workspace_id) IS NULL
          OR compartments <@ effective_member_team_compartments(current_setting('app.current_user_id')::uuid,workspace_id))`
      if(readOnly){
        const current=await readLegacyCanonicalTask(access,liveId,client)
        if (own) await client.query('COMMIT')
        return current
      }

      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[liveRes.rows[0].workspaceId])
      // A concurrent writer may have superseded the head while this one waited
      // for the workspace lock; re-resolve so it edits (or, for a guarded
      // claim, judges) the current row instead of reporting not-found.
      const relocked = await client.query<{ id: string }>(
        `${LIVE_TASK_ID_CTE} SELECT id FROM chain WHERE valid_to IS NULL LIMIT 1`, [liveId])
      if (relocked.rows[0]) liveId = relocked.rows[0].id
      // The legacy writer returns and consumes the complete task DTO. Admit
      // that exact snapshot before reading its body or running a precondition.
      const admittedBefore=await readLegacyCanonicalTask(access,liveId,client)
      if(!admittedBefore){if(own)await client.query('ROLLBACK');return null}
      const oldRes = await client.query<OldTaskRow>(
        `SELECT logical_id, scope_version::text, workspace_id, title, status, assignee_id, due, tags, parent_id, external_ref, attributes,
                sensitivity, compartments, project_ids,
                user_id, assistant_id,
                executor_assistant_id, follow_up_member_id, home_kind, home_id
         FROM tasks WHERE id = $1 AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
           AND ${ap.sql} AND ${memberScope} FOR UPDATE`,
        [liveId,...ap.params],
      )
      if (oldRes.rows.length === 0) {
        if (own) await client.query('ROLLBACK')
        return null
      }
      const old = oldRes.rows[0]
      if (opts?.expectedVersion !== undefined && (liveId !== id || old.scope_version !== opts.expectedVersion)) {
        throw new ApplicationPlatformError('record_version_conflict','The task changed. Refresh before retrying.')
      }

      // Responsibility (migration 753): the executor is one slot, contact and
      // home are independent. A precondition (the guarded claim) runs on the
      // locked live row; 'noop' answers an idempotent repeat without a write.
      const before: TaskResponsibility = {
        assigneeId: old.assignee_id, executorAssistantId: old.executor_assistant_id,
        followUpMemberId: old.follow_up_member_id,
        home: old.home_kind && old.home_id ? { kind: old.home_kind, id: old.home_id } : null,
      }
      if (opts?.precondition?.({ ...before, status: old.status, workspaceId: old.workspace_id }) === 'noop') {
        const current=await readLegacyCanonicalTask(access,liveId,client)
        if (own) await client.query('COMMIT')
        return current
      }
      const after = applyResponsibilityPatch(before, {
        assigneeId: fields.assigneeId, executorAssistantId: fields.executorAssistantId,
        followUpMemberId: fields.followUpMemberId, home: fields.home,
      })

      const newTitle = fields.title !== undefined ? fields.title : old.title
      const newStatus = fields.status !== undefined ? fields.status : old.status
      const newAssigneeId = after.assigneeId
      const newDue = fields.due !== undefined ? fields.due : old.due
      const newTags = fields.tags !== undefined ? fields.tags : old.tags
      const newParentId = fields.parentId !== undefined ? fields.parentId : old.parent_id
      const newExternalRef = fields.externalRef !== undefined ? fields.externalRef : (old.external_ref ?? {})
      const newAttributes = fields.attributes !== undefined ? fields.attributes : (old.attributes ?? {})
      let nextCompartments = unionScopeRequirements(old.compartments, opts?.scope?.compartments)
      let nextProjectIds = unionScopeRequirements(old.project_ids, opts?.scope?.projectIds)
      let nextSensitivity=maxSensitivity(old.sensitivity,opts?.scope?.sensitivity??'public')
      const mergeVisibility=(current:string|null,inherited:string|null|undefined)=>{
        if(current&&inherited&&current!==inherited)throw Object.assign(new Error('Task visibility cannot combine these sources.'),{code:'scope_visibility_incompatible'})
        return current??inherited??null
      }
      let nextUserId=mergeVisibility(old.user_id,opts?.scope?.visibility?.userId)
      let nextAssistantId=mergeVisibility(old.assistant_id,opts?.scope?.visibility?.assistantId)
      const admitted = await admitTaskCreate(client,userId,{
        workspaceId:old.workspace_id,parentId:newParentId,sensitivity:nextSensitivity,
        compartments:nextCompartments,projectIds:nextProjectIds,visibility:{userId:nextUserId,assistantId:nextAssistantId},
      },access,{sensitivity:old.sensitivity,compartments:old.compartments??[],projectIds:old.project_ids??[],userId:old.user_id,assistantId:old.assistant_id})
      nextSensitivity=admitted.sensitivity;nextCompartments=admitted.compartments;nextProjectIds=admitted.projectIds
      nextUserId=admitted.visibility.userId;nextAssistantId=admitted.visibility.assistantId
      assertExecutionResourceScope({workspaceId:old.workspace_id,userId:nextUserId,assistantId:nextAssistantId,
        sensitivity:nextSensitivity,compartments:nextCompartments,projectIds:nextProjectIds},'mutation',access)
      await validateTaskResponsibility(client, userId, {
        workspaceId: old.workspace_id, sensitivity: nextSensitivity, compartments: nextCompartments,
        projectIds: nextProjectIds, privateUserId: nextUserId, privateAssistantId: nextAssistantId,
      }, before, after)

      const {dependsOn: _dependsOn,...canonicalFields}=fields
      const written=await patchCanonicalTaskFields(userId,old.workspace_id,liveId,canonicalFields,client,access,
        {expectedVersion:old.scope_version,scope:{sensitivity:nextSensitivity,compartments:nextCompartments,projectIds:nextProjectIds,
          visibility:{userId:nextUserId,assistantId:nextAssistantId}}})
      if(!written)throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
      const newTask=await readLegacyCanonicalTask(access,written.physicalId,client)
      if(!newTask)throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')

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
        await abandonGoalsForHostTaskSystem(newTask.id, 'host_task_closed', {
          draftsOnly: true,
          exec: client,afterCommit:transaction?.afterCommit,
        })
      }
      // Executor change: an automatic draft made for the previous executor
      // must not continue for the next one. Drafts only; a confirmed Goal is
      // never cancelled by an assignment change (goals.md -> "Host-lifecycle
      // cascade", "Executor-gated triage").
      const reassigned = executorChanged(before, after)
      if (reassigned) {
        await abandonGoalsForHostTaskSystem(newTask.id, 'executor_changed', {
          draftsOnly: true,
          exec: client,afterCommit:transaction?.afterCommit,
        })
      }

      if (own) await client.query('COMMIT')
      const publish = () => {
        if (reassigned && newTask.parentId === null) executorChangeHook?.(newTask, before, userId, opts?.assignment)
        if ((newTask.status === 'done' || newTask.status === 'archived') && old.status !== newTask.status) taskClosedHook?.(newTask, old.status)

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
      }
      if (transaction) transaction.afterCommit(publish); else publish()
      return newTask
    } catch (err) {
      if (own) await client.query('ROLLBACK')
      throw err
    }
  } finally {
    if (own) await rollbackAndRelease(client)
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
    `SELECT ${FULL_SELECT} FROM tasks WHERE id = $1 AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
      AND NOT (${taskNeedsIndependentSourceAuthoritySql('tasks')})`,
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
       AND NOT (${taskNeedsIndependentSourceAuthoritySql('tasks')})
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
export async function getTaskHistory(ctx:AccessContext,id:string):Promise<TaskRecord[]> {
  return readLegacyCanonicalTaskHistory(ctx,id)
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
export async function listTasksBySourceEpisode(ctx:AccessContext,episodeId:string):Promise<RecordingTaskRow[]> {
  return listLegacyCanonicalRecordingTasks(ctx,episodeId)
}
