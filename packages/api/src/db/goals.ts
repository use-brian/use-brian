import { WorkflowDefinitionSchema,runtimeSuccessors,accessCeilingContains,pinAccessCeiling,type AuthoringAuthority } from '@use-brian/core'
import { resolveGoalAuthoritySystem,resolveWorkflowAuthoringScope } from '../context-scope/workflow-authority.js'
import { readWorkflowRunInTransaction } from './workflow-store.js'
import { readExternalSourceAncestors } from '../application-platform/external-source-ancestry.js'
import { readLegacyCanonicalCrmPoint } from './crm-reader.js'
import { taskNeedsIndependentSourceAuthoritySql } from './task-reader.js'
import { randomUUID } from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {boundScopeSources} from '@use-brian/core'
import {WorkspaceAccessError} from '../workspace-access/policy.js'
import { admitGoalSource, bindTaskGoalSource,assertTaskGoalSourceCompatible,retainedTaskGoalWrite,readRetainedTaskGoal,writeRetainedTaskGoal,resolveRetainedTaskGoalAuthority,unboundNativeTaskGoalHost } from '../workspace-access/goal-source-admission.js'
import { admitOperationalAuthoring, type OperationalHumanAuthor } from '../workspace-access/operational-admission.js'
/**
 * Goals SQL helpers — the operational goal-seeker primitive.
 *
 * See `docs/architecture/features/goals.md` (forthcoming) and
 * `docs/plans/task-goal-seeker.md` §3.2. Goals are an operational table:
 * writes go through the owner pool (`query()`), the route/engine being the
 * authorization gate; user reads go through the app pool (`queryWithRLS`),
 * confined by the `goals_workspace_member` policy.
 */
import type { DoneWhenNode, EventSubscription, GoalBrief, GoalCompletionClaim, GoalCreateParams, GoalHostRef, GoalListFilters, GoalListRow, GoalMeans, GoalRecord, GoalStatus, SessionContextAuthority } from '@use-brian/core'
import { applyRLSGucs,getAppPool,rollbackAndRelease,query, queryWithRLS, getPool } from './client.js'
import type pg from 'pg'
import { updateTask } from './tasks.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import type { BrainChangeAction } from '../brain-stream/sse-fanout.js'

/**
 * Store-seam emitter for the `goal` workspace primitive (the goals board /
 * Triage panel / goal detail — docs/architecture/platform/realtime-sync.md).
 * Fired at the lifecycle seams only: create, amend / confirm, status
 * transitions, completion stamps, context narrowing and the host-task cascade.
 * NEVER from `tryClaimGoalForTick` (one flip per acting-loop iteration) and
 * never for the `until:event` park markers — those are the acting loop's
 * bookkeeping, not a change a board needs to repaint for. The 2s coalescer
 * folds bursts per (workspace, primitive). Fire-and-forget, same as
 * `sessions.ts#notifySessionChange`: the write path must never feel a NOTIFY
 * failure, and every emitter reads the workspace id off the row it just
 * wrote (`RETURNING workspace_id`), never a second lookup.
 */
function notifyGoalChange(
  workspaceId: string | null | undefined,
  action: BrainChangeAction,
  goalId: string,
): void {
  notifyWorkspaceChange(workspaceId, 'goal', action, goalId)
}

/**
 * The durable event-park marker stored in `goals.awaiting_event` (mig 293).
 * `subscriptions` is what the workflow event dispatcher matches to resume the
 * goal; `state` is the acting-loop handoff (the driver's `GoalLoopState`)
 * preserved verbatim so budget counters survive the wait — the store treats it
 * as opaque (the driver owns its shape). NULL column when the goal is not
 * parked on an event. See `goals/driver.ts` (`until:event` resume).
 */
export type GoalAwaitingEventMarker = {
  /** Database-overwritten generation used for exact event-resume claims. */
  revision?: string
  subscriptions: EventSubscription[]
  state?: Record<string, unknown>
}

const FULL_SELECT = `
  id, workspace_id as "workspaceId", parent_goal_id as "parentGoalId",
  recipe_id as "recipeId", host_type as "hostType", host_id as "hostId",
  outcome, done_when as "doneWhen", means, budget, policy, status,
  blocker_reason as "blockerReason", created_by_user_id as "createdByUserId",
  origin_session_id as "originSessionId",
  context_group_id as "contextGroupId", context_project_id as "contextProjectId",
  authoring_authority as "authoringAuthority",
  confirmed_at as "confirmedAt", completion_claim as "completionClaim",
  brief, created_at as "createdAt", updated_at as "updatedAt", updated_at::text as "mutationVersion"
`

export const GOAL_TERMINAL_STATUSES = ['done', 'abandoned'] as const

type GoalRow = {
  id: string
  workspaceId: string
  parentGoalId: string | null
  recipeId: string | null
  hostType: string | null
  hostId: string | null
  outcome: string
  doneWhen: unknown
  means: Record<string, unknown> | null
  budget: Record<string, unknown> | null
  policy: Record<string, unknown> | null
  status: GoalStatus
  blockerReason: string | null
  createdByUserId: string | null
  originSessionId: string | null
  contextGroupId: string | null
  contextProjectId: string | null
  authoringAuthority: GoalRecord['authoringAuthority']
  confirmedAt: Date | null
  completionClaim: GoalCompletionClaim | null
  brief: GoalBrief | null
  createdAt: Date
  updatedAt: Date
  mutationVersion:string
}

const goalReadVersions=new WeakMap<GoalRecord,string>()
function toRecord(row: GoalRow): GoalRecord {
  const record:GoalRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    parentGoalId: row.parentGoalId,
    recipeId: row.recipeId,
    host: row.hostType
      ? { type: row.hostType as GoalHostRef['type'], id: row.hostId as string }
      : null,
    outcome: row.outcome,
    doneWhen: row.doneWhen as GoalRecord['doneWhen'],
    means: (row.means ?? {}) as GoalRecord['means'],
    budget: (row.budget ?? {}) as GoalRecord['budget'],
    policy: (row.policy ?? {}) as GoalRecord['policy'],
    status: row.status,
    blockerReason: row.blockerReason,
    createdByUserId: row.createdByUserId,
    originSessionId: row.originSessionId,
    contextGroupId: row.contextGroupId,
    contextProjectId: row.contextProjectId,
    authoringAuthority: row.authoringAuthority,
    confirmedAt: row.confirmedAt,
    completionClaim: row.completionClaim,
    brief: row.brief,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  goalReadVersions.set(record,row.mutationVersion)
  return record
}

const retainedGoalRequiredSql=`EXISTS(SELECT 1 FROM goal_task_source_authority s WHERE s.goal_id=goals.id AND s.proof->'retained' IS NOT NULL)
 OR EXISTS(SELECT 1 FROM tasks source_task WHERE goals.host_type='task' AND source_task.id=goals.host_id AND source_task.workspace_id=goals.workspace_id
   AND (${taskNeedsIndependentSourceAuthoritySql('source_task')} OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=source_task.workspace_id
     AND d.resource_kind='task' AND d.resource_id IN(source_task.id,source_task.logical_id))))`

/** Metadata-only hold for lifecycle adapters without the retained origin frame. */
async function retainedGoalIsHeld(id:string):Promise<boolean>{
  return(await query<{held:boolean}>(`SELECT EXISTS(SELECT 1 FROM goals WHERE id=$1 AND (${retainedGoalRequiredSql})) AS held`,[id])).rows[0]?.held!==false
}

/** Insert a goal (owner pool; the route/engine is the authz gate). */
export async function createGoal(params: GoalCreateParams, humanAuthor?: OperationalHumanAuthor, taskSource?: object): Promise<GoalRecord> {
  const retained=taskSource?retainedTaskGoalWrite(taskSource,client=>insertGoal(params,humanAuthor,taskSource,client)):undefined
  return retained??insertGoal(params,humanAuthor,taskSource)
}
async function insertGoal(params: GoalCreateParams,humanAuthor?:OperationalHumanAuthor,taskSource?:object,transactionClient?:pg.PoolClient):Promise<GoalRecord>{
  const client = transactionClient??await getPool().connect()
  const result = await (async () => {
    try {
      if(!transactionClient)await client.query('BEGIN')
      if(!transactionClient&&params.host?.type==='task')await assertTaskGoalSourceCompatible(params.workspaceId,params.host.id,client)
      // Parent/host/session-derived and autodrafted goals need canonical source
      // proof, not a human default or a creator/owner guess. Block ready mode
      // until those adapters supply it; legacy creation remains unchanged.
      const ordinary = !params.parentGoalId && !params.host && !params.originSessionId
        && !params.recipeId && params.confirmed !== false
      const admitted = taskSource ? await admitGoalSource(client, params, taskSource) : await admitOperationalAuthoring(client, {
        workspaceId: params.workspaceId, userId: params.createdByUserId ?? '',
        contextGroupId: params.contextGroupId, contextProjectId: params.contextProjectId,
        authoringAuthority: params.authoringAuthority,
      }, ordinary ? humanAuthor : undefined)
      params = { ...params, contextGroupId: admitted.contextGroupId,
        contextProjectId: admitted.contextProjectId, authoringAuthority: admitted.authoringAuthority ?? undefined }
      const host = params.host ?? null
      if (params.confirmed !== false && !params.authoringAuthority) {
        throw Object.assign(new Error('Goal authoring permissions are missing. Confirm the goal from a current workspace turn.'), { reason: 'goal_authority_unavailable' })
      }
      const goalId=randomUUID()
      let inserted = await client.query<GoalRow>(
        `INSERT INTO goals (
           ${transactionClient?'id,':''}workspace_id, parent_goal_id, recipe_id, host_type, host_id,
           outcome, done_when, means, budget, policy, status, created_by_user_id,
           origin_session_id, context_group_id, context_project_id, authoring_authority, confirmed_at, brief
         )
         VALUES (${transactionClient?'$19,':''}$1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16::jsonb, $17, $18::jsonb)
         ${transactionClient?'':`RETURNING ${FULL_SELECT}`}`,
        [
          params.workspaceId,
          params.parentGoalId ?? null,
          params.recipeId ?? null,
          host ? host.type : null,
          host ? host.id : null,
          params.outcome,
          JSON.stringify(params.doneWhen),
          JSON.stringify(params.means ?? {}),
          JSON.stringify(params.budget ?? {}),
          JSON.stringify(params.policy ?? {}),
          params.status ?? 'active',
          params.createdByUserId ?? null,
          params.originSessionId ?? null,
          params.contextGroupId ?? null,
          params.contextProjectId ?? null,
          params.authoringAuthority ? JSON.stringify(params.authoringAuthority) : null,
          // Explicitly-created goals are confirmed; the judge-draft path passes
          // `confirmed: false` to mint a draft (autopilot §4/§8).
          params.confirmed === false ? null : new Date(),
          params.brief ? JSON.stringify(params.brief) : null,
          ...(transactionClient?[goalId]:[]),
        ],
      )
      if (taskSource) await bindTaskGoalSource(client, params.host!.id, transactionClient?goalId:inserted.rows[0].id)
      if(transactionClient){
        inserted=await client.query<GoalRow>(`SELECT ${FULL_SELECT} FROM goals WHERE id=$1 AND goal_crm_scope_visible(id)`,[goalId])
        if(inserted.rows.length!==1)throw new Error('goal_source_unsupported')
      }
      if(!transactionClient)await client.query('COMMIT')
      return inserted
    } catch (error) {
      if(!transactionClient)await client.query('ROLLBACK')
      throw error
    } finally {
      if(!transactionClient)client.release()
    }
  })()
  const created = toRecord(result.rows[0])
  if(!transactionClient)notifyGoalChange(created.workspaceId, 'create', created.id)
  return created
}

/** User-scoped read (RLS by workspace membership). */
export async function getGoalById(userId: string, id: string, transactionClient?: pg.PoolClient): Promise<GoalRecord | null> {
  // Feed confirmation freezes this existing primitive in its own transaction.
  // Repeat membership and causal source policies on the owner connection.
  const result = transactionClient ? await transactionClient.query<GoalRow>(
    `SELECT ${FULL_SELECT} FROM goals WHERE id=$1 AND EXISTS
      (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=goals.workspace_id AND wm.user_id=$2)
      AND goal_crm_scope_allows(id,$2) FOR SHARE`,
    [id, userId],
  ) : await queryWithRLS<GoalRow>(
    userId,
    `SELECT ${FULL_SELECT} FROM goals WHERE id = $1 AND goal_crm_scope_visible(id)`,
    [id],
  )
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

/** System read by id (engine path; no user context). */
export async function getGoalByIdSystem(id: string): Promise<GoalRecord | null> {
  const result = await query<GoalRow>(`SELECT ${FULL_SELECT} FROM goals WHERE id = $1 AND NOT (${retainedGoalRequiredSql})`, [id])
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

/** Protected Goal point read uses the caller's original admitted frame. */
export async function getRetainedGoalById(userId:string,id:string,authority:SessionContextAuthority):Promise<GoalRecord|null>{
  if(userId!==authority.execution.security.access.userId)throw new Error('goal_source_unsupported')
  const goal=await readRetainedTaskGoal(id,authority,async client=>{
    const result=await client.query<GoalRow>(`SELECT ${FULL_SELECT} FROM goals WHERE id=$1 AND goal_crm_scope_visible(id)`,[id])
    return result.rows[0]?toRecord(result.rows[0]):null
  })
  if(goal){
    const original=await resolveRetainedTaskGoalAuthority(goal)
    if(!original)throw new Error('goal_source_unsupported')
    await original.assertCurrent()
    await authority.execution.security.authority.assertCurrent()
  }
  return goal
}

/** Driver-only loader: authenticate immutable origin before selecting Goal payload. */
export async function getGoalForExecutionSystem(id:string):Promise<GoalRecord|null>{
  const metadata=(await query<Pick<GoalRow,'id'|'workspaceId'|'createdByUserId'|'authoringAuthority'> & {hostType:string|null;hostId:string|null}>(`SELECT id,workspace_id AS "workspaceId",created_by_user_id AS "createdByUserId",authoring_authority AS "authoringAuthority",host_type AS "hostType",host_id AS "hostId" FROM goals WHERE id=$1`,[id])).rows[0]
  if(!metadata)return null
  const goal={...metadata,host:metadata.hostType?{type:metadata.hostType as GoalHostRef['type'],id:metadata.hostId!}:null}
  const retained=await resolveRetainedTaskGoalAuthority(goal)
  return retained?getRetainedGoalById(metadata.createdByUserId!,id,retained.authority):getGoalByIdSystem(id)
}

/**
 * Stamp the verified-done marker (§12 agentic termination). Called by the
 * `markGoalComplete` tool ONLY after the adversarial verifier passes — the
 * driver's `verify` resolver then reads `completion_claim IS NOT NULL`. A
 * refuted claim is never written; the refutation is fed back to the agent
 * in-session. System path (the tool is the authz gate). Idempotent: re-stamping
 * just refreshes `verifiedAt`.
 */
export async function stampGoalCompletionSystem(
  id: string,
  because: string,
): Promise<GoalRecord | null> {
  if(await retainedGoalIsHeld(id))return null
  const claim: GoalCompletionClaim = { because, verifiedAt: new Date().toISOString() }
  const result = await query<GoalRow>(
    `UPDATE goals SET completion_claim = $1::jsonb WHERE id = $2 RETURNING ${FULL_SELECT}`,
    [JSON.stringify(claim), id],
  )
  if (result.rows.length === 0) return null
  const stamped = toRecord(result.rows[0])
  notifyGoalChange(stamped.workspaceId, 'update', stamped.id)
  return stamped
}

/** User-scoped workspace listing for the goals board + triage surface. Each
 *  row carries `hostTitle` (a scalar subselect on `tasks`; NULL for non-task
 *  hosts) — safe across bi-temporal task edits because host-repoint keeps
 *  `host_id` current. */
export async function listGoals(
  userId: string,
  workspaceId: string,
  filters: GoalListFilters = {},
): Promise<GoalListRow[]> {
  const wheres: string[] = ['workspace_id = $1', 'goal_crm_scope_visible(id)']
  const values: unknown[] = [workspaceId]
  let idx = 2

  if (filters.confirmed !== undefined) {
    wheres.push(filters.confirmed ? 'confirmed_at IS NOT NULL' : 'confirmed_at IS NULL')
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
  } else if (!filters.includeTerminal) {
    wheres.push(`status <> ALL($${idx})`)
    values.push(GOAL_TERMINAL_STATUSES)
    idx++
  }
  if (filters.hostType) {
    wheres.push(`host_type = $${idx}`)
    values.push(filters.hostType)
    idx++
  }
  if (filters.hostId) {
    wheres.push(`host_id = $${idx}`)
    values.push(filters.hostId)
    idx++
  }
  if (filters.parentGoalId) {
    wheres.push(`parent_goal_id = $${idx}`)
    values.push(filters.parentGoalId)
    idx++
  }
  if (filters.originSessionId) {
    wheres.push(`origin_session_id = $${idx}`)
    values.push(filters.originSessionId)
    idx++
  }

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200)
  values.push(limit)

  const result = await queryWithRLS<GoalRow & { hostTitle: string | null }>(
    userId,
    `SELECT ${FULL_SELECT},
       (SELECT t.title FROM tasks t WHERE t.id = goals.host_id AND goals.host_type = 'task') as "hostTitle"
     FROM goals
     WHERE ${wheres.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${idx}`,
    values,
  )
  return result.rows.map((row) => ({ ...toRecord(row), hostTitle: row.hostTitle }))
}

// ── Host-lifecycle cascade ───────────────────────────────────────────────────
//
// `host_id` is deliberately not a FK (it points at task|page|entity|workflow),
// so Postgres cannot cascade for us: when a host task leaves the live set the
// goals bound to it have to be retired in application code. Without this a
// deleted task's judge-drafted goal outlives it forever and keeps its slot on
// the "Tasks assignable" surface + home-dock count — 224 of one workspace's 242
// drafts were exactly this on 2026-07-30.
//
// Cascade, not delete: the host task itself is only SOFT-deleted (`valid_to`),
// so the goal follows with the reversible discard the Dismiss button already
// uses (`status='abandoned'`, the reason in `blocker_reason`). Terminal statuses
// are excluded from every list, count, and sweep, and the judge's brief survives
// as history.

/** Why a host-lifecycle cascade retired the goal. Lands in `blocker_reason`. */
export type GoalHostCascadeReason = 'host_task_deleted' | 'host_task_closed' | 'executor_changed'

/** Task CLOSE skips already-terminal goals plus `running` (the loop may be
 * completing that host). Task DELETE skips terminal goals only: the host is
 * explicitly gone, and guarded driver transitions keep an in-flight bounded
 * iteration from resurrecting its retired goal. */
const CLOSE_CASCADE_SKIP_STATUSES = [...GOAL_TERMINAL_STATUSES, 'running']

/** Minimal executor seam: the default is the owner pool (`query`), but a caller
 *  already inside a transaction passes its own client so the cascade commits
 *  atomically with the task write (`updateTask`'s supersede path). */
type GoalCascadeExecutor = {
  query: (
    text: string,
    values: unknown[],
  ) => Promise<{
    rowCount: number | null
    /** The retired rows (`RETURNING id, workspace_id`) — a pg client returns
     *  them; a narrower executor may omit them and the cascade then emits no
     *  `goal` signal (the write still lands). */
    rows?: Array<{ id: string; workspaceId: string; owner?: boolean; held?: boolean }>
  }>
}

/**
 * Retire the goals bound to a task that is no longer assignable. Returns how
 * many goals were retired (0 is the common case — most tasks have no goal).
 *
 * `draftsOnly` is the difference between the two triggers:
 *   - **deleted** (`host_task_deleted`) — every non-terminal goal goes. The host
 *     is gone; a confirmed goal driving it can never reach `hostTaskDone`.
 *   - **closed** (`host_task_closed`, `draftsOnly: true`) — only UNCONFIRMED
 *     drafts. A confirmed goal whose host task just closed is the goal
 *     *succeeding*; the rollup / acting loop completes it and must not be
 *     pre-empted here.
 */
export async function abandonGoalsForHostTaskSystem(
  taskId: string,
  reason: GoalHostCascadeReason,
  opts: { draftsOnly?: boolean; exec?: GoalCascadeExecutor;afterCommit?:(effect:()=>void)=>void } = {},
): Promise<number> {
  const exec = opts.exec ?? { query: (text: string, values: unknown[]) => query(text, values) }
  const notifyRetired = async (rows: Array<{ id: string; workspaceId: string }>) => {
    if (!rows.length) return
    // Reuse an owner transaction instead of acquiring its max:1 pool again.
    // An app_user transaction cannot inspect private source metadata; its
    // independent owner pool reads only the classification, never Goal payload.
    const owner = await exec.query(`SELECT pg_has_role(current_user,c.relowner,'USAGE') AS owner FROM pg_class c WHERE c.oid='goals'::regclass`, [])
    const sql = `SELECT id, workspace_id AS "workspaceId", (${retainedGoalRequiredSql}) AS held FROM goals WHERE id=ANY($1::uuid[])`
    const admitted = owner.rows?.[0]?.owner === true
      ? await exec.query(sql, [rows.map(row => row.id)])
      : await query<{id:string;workspaceId:string;held:boolean}>(sql, [rows.map(row => row.id)])
    for (const row of admitted.rows ?? []) if (row.held === false) {
      const effect=()=>notifyGoalChange(row.workspaceId,'update',row.id)
      if(opts.afterCommit)opts.afterCommit(effect);else effect()
    }
  }
  const skippedStatuses = opts.draftsOnly
    ? CLOSE_CASCADE_SKIP_STATUSES
    : GOAL_TERMINAL_STATUSES
  const result = await exec.query(
    `UPDATE goals
        SET status = 'abandoned', blocker_reason = $2, updated_at = now()
      WHERE host_type = 'task' AND host_id = $1
        AND status <> ALL($3)${opts.draftsOnly ? '\n        AND confirmed_at IS NULL' : ''}
      RETURNING id, workspace_id as "workspaceId"`,
    [taskId, reason, skippedStatuses],
  )
  await notifyRetired(result.rows ?? [])
  let retired = 0
  if (reason !== 'host_task_closed') {
    // Resumable execution (goals.md -> "Resumable task execution"): a deleted
    // host or a changed executor retires the native execution (history and
    // receipts kept) and fences the pursuit bound to it, CONFIRMED goals
    // included, so the next executor never inherits the previous one's lease.
    const exec2 = await exec.query(
      `WITH retired AS (SELECT goal_id FROM public.task_execution_retire($1, $2::text))
       UPDATE goals SET status = 'abandoned', blocker_reason = $2, updated_at = now()
        WHERE id IN (SELECT goal_id FROM retired WHERE goal_id IS NOT NULL) AND status <> ALL($3)
        RETURNING id, workspace_id as "workspaceId"`,
      [taskId, reason, GOAL_TERMINAL_STATUSES],
    )
    await notifyRetired(exec2.rows ?? [])
    retired = exec2.rowCount ?? 0
  }
  return (result.rowCount ?? 0) + retired
}

/** System read: goals bound to a given host — the rollup lookup. */
export async function listGoalsByHostSystem(host: GoalHostRef): Promise<GoalRecord[]> {
  const result = await query<GoalRow>(
    `SELECT ${FULL_SELECT} FROM goals
     WHERE host_type = $1 AND host_id = $2
       AND NOT (${retainedGoalRequiredSql})
     ORDER BY updated_at DESC`,
    [host.type, host.id],
  )
  return result.rows.map(toRecord)
}

/** System write: set status (+ optional blocker reason; pass null to clear). */
export async function setGoalStatusSystem(
  id: string,
  status: GoalStatus,
  blockerReason: string | null = null,
): Promise<GoalRecord | null> {
  if(await retainedGoalIsHeld(id))return null
  const result = await query<GoalRow>(
    `UPDATE goals SET status = $1, blocker_reason = $2 WHERE id = $3 RETURNING ${FULL_SELECT}`,
    [status, blockerReason, id],
  )
  if (result.rows.length === 0) return null
  const updated = toRecord(result.rows[0])
  notifyGoalChange(updated.workspaceId, 'update', updated.id)
  return updated
}

/**
 * Complete an acting driver's ownership handoff without racing an explicit
 * user cancellation. The driver owns a goal only while it is `running`; task
 * deletion may retire that same row to `abandoned`. A conditional transition
 * makes the deletion win instead of letting a stale bounded iteration
 * overwrite it with `active`, `done`, or `blocked`.
 */
export async function transitionRunningGoalStatusSystem(
  id: string,
  status: GoalStatus,
  blockerReason: string | null = null,
): Promise<boolean> {
  if(await retainedGoalIsHeld(id))return false
  const result = await query<{ id: string; workspaceId: string }>(
    `UPDATE goals
        SET status = $1, blocker_reason = $2, updated_at = now()
      WHERE id = $3 AND status = 'running'
      RETURNING id, workspace_id as "workspaceId"`,
    [status, blockerReason, id],
  )
  const transitioned = (result.rowCount ?? 0) > 0
  if (transitioned) notifyGoalChange(result.rows[0]?.workspaceId, 'update', id)
  return transitioned
}

function goalTerminalMaterial(goal:GoalRecord) {
  return {
    workspaceId: goal.workspaceId,
    createdByUserId: goal.createdByUserId,
    parentGoalId: goal.parentGoalId,
    recipeId: goal.recipeId,
    host: goal.host,
    outcome: goal.outcome,
    doneWhen: goal.doneWhen,
    means: goal.means,
    budget: goal.budget,
    policy: goal.policy,
    originSessionId: goal.originSessionId,
    contextGroupId: goal.contextGroupId,
    contextProjectId: goal.contextProjectId,
    authoringAuthority: goal.authoringAuthority ?? null,
    brief: goal.brief ?? null,
    completionClaim: goal.completionClaim ?? null,
  }
}

/** Claim one structural completion without reviving a cancelled/edited Goal.
 * This compares evaluated material; it is not current source authorization. */
export async function claimGoalRollupTerminalSystem(goal: GoalRecord): Promise<boolean> {
  if (!goal.confirmedAt) return false
  const material = goalTerminalMaterial(goal)
  const result = await query<{ workspaceId: string }>(
    `UPDATE goals SET status='done',blocker_reason=NULL,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND status='active' AND confirmed_at IS NOT NULL
        AND NOT (${retainedGoalRequiredSql})
        AND jsonb_build_object(
          'workspaceId',workspace_id,'createdByUserId',created_by_user_id,
          'parentGoalId',parent_goal_id,'recipeId',recipe_id,
          'host',CASE WHEN host_type IS NULL THEN NULL ELSE jsonb_build_object('type',host_type,'id',host_id) END,
          'outcome',outcome,'doneWhen',done_when,'means',COALESCE(means,'{}'::jsonb),
          'budget',COALESCE(budget,'{}'::jsonb),'policy',COALESCE(policy,'{}'::jsonb),
          'originSessionId',origin_session_id,'contextGroupId',context_group_id,
          'contextProjectId',context_project_id,'authoringAuthority',authoring_authority,
          'brief',brief,'completionClaim',completion_claim
        )=$3::jsonb
      RETURNING workspace_id AS "workspaceId"`,
    [goal.id,goal.workspaceId,JSON.stringify(material)],
  )
  const claimed = (result.rowCount ?? 0) === 1
  if (claimed) notifyGoalChange(result.rows[0].workspaceId,'update',goal.id)
  return claimed
}

/** Atomic terminal composition for explicitly authored, unbound native Task
 * hosts. Source-backed producer proofs require their own authentic transition. */
export async function finishNativeTaskGoalTerminalSystem(goal:GoalRecord,terminal:'done'|'blocked',reason:string|null,
 expectedStatus:'active'|'running'):Promise<GoalRecord|null>{
 if(goal.host?.type!=='task'||!goal.createdByUserId||!goal.authoringAuthority)throw Object.assign(new Error('goal_source_scope_unavailable'),{reason:'goal_source_scope_unavailable'})
 const originalHost=goal.host.id,actor=goal.createdByUserId,authoring=goal.authoringAuthority
 const authority=await resolveGoalAuthoritySystem(goal),effects:Array<()=>void>=[]
 let committed=false
 try{
  const result=await authority.executeWithAuthority(async()=>{
   const client=await getAppPool().connect()
   try{
    await client.query('BEGIN');await applyRLSGucs(client,actor)
    // Canonical task writers take this barrier before any Goal host repoint.
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[goal.workspaceId])
    const current=(await client.query<GoalRow>(`SELECT ${FULL_SELECT} FROM goals WHERE id=$1 AND workspace_id=$2
     AND status=$3 AND confirmed_at IS NOT DISTINCT FROM $4::timestamptz FOR UPDATE`,
     [goal.id,goal.workspaceId,expectedStatus,goal.confirmedAt])).rows[0]
    if(!current){await client.query('ROLLBACK');return null}
    const evaluated=toRecord(current)
    // Physical host rotation is canonical identity maintenance. Every other
    // evaluated field must remain exact, including the immutable authority.
    const {host:_old,...before}=goalTerminalMaterial(goal),{host:_new,...after}=goalTerminalMaterial(evaluated)
    if(!isDeepStrictEqual(before,after)){await client.query('ROLLBACK');return null}
    if(evaluated.host?.type!=='task')throw Object.assign(new Error('goal_source_scope_unavailable'),{reason:'goal_source_scope_unavailable'})
    const locked=await client.query<{id:string}>('SELECT id FROM tasks WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
     [goal.workspaceId,[...new Set([originalHost,evaluated.host.id])]])
    if(locked.rows.length!==new Set([originalHost,evaluated.host.id]).size)throw Object.assign(new Error('Goal host unavailable'),{reason:'goal_host_write_unavailable'})
    // Owner metadata classifies committed ancestry while the exact original and
    // current physical rows are locked. It does not authorize the Task write.
    const native=await unboundNativeTaskGoalHost(goal)
    if(!native||native.id!==evaluated.host.id)throw Object.assign(new Error('goal_source_scope_unavailable'),{reason:'goal_source_scope_unavailable'})
    const scope=()=>resolveWorkflowAuthoringScope({userId:actor,workspaceId:goal.workspaceId,assistantId:authoring.assistantId,
     authoringAuthority:authoring,contextGroupId:goal.contextGroupId,contextProjectId:goal.contextProjectId},client)
    const currentScope=await scope()
    const task=await updateTask(actor,evaluated.host.id,{status:terminal},undefined,{writtenBy:'system',access:{...currentScope.access,
     assistantId:authoring.assistantId,assistantKind:currentScope.access.assistantKind??'primary'}},
     {client,afterCommit:effect=>effects.push(effect)})
    if(!task||task.logicalId!==native.logicalId)throw Object.assign(new Error('Goal host unavailable'),{reason:'goal_host_write_unavailable'})
    await scope()
    const updated=(await client.query<GoalRow>(`UPDATE goals SET status=$2,blocker_reason=$3,updated_at=now()
     WHERE id=$1 AND status=$4 AND host_type='task' AND host_id=$5 RETURNING ${FULL_SELECT}`,
     [goal.id,terminal,reason,expectedStatus,task.id])).rows[0]
    if(!updated)throw Object.assign(new Error('Goal ownership changed'),{reason:'goal_host_write_unavailable'})
    await client.query('COMMIT');committed=true
    return toRecord(updated)
   }finally{await rollbackAndRelease(client)}
  })
  if(!result)return null
  // This is egress revalidation, never a claim of postcommit rollback.
  const current=await unboundNativeTaskGoalHost({...goal,host:{type:'task',id:originalHost}})
  if(!current||current.id!==result.host?.id)throw Object.assign(new Error('goal_source_scope_unavailable'),{reason:'goal_source_scope_unavailable'})
  effects.push(()=>notifyGoalChange(result.workspaceId,'update',result.id))
  for(const effect of effects)effect()
  return result
 }catch(error){
  if(committed)throw Object.assign(error instanceof Error?error:new Error('goal_source_unavailable'),{retrySafe:false,operationMayHaveExecuted:true})
  throw error
 }
}

/** Update a goal's curated fields and/or confirm it (autopilot §4). `confirm:
 *  true` sets `confirmed_at = now()` (arming a draft); `outcome` / `doneWhen` /
 *  `brief` let the creator amend the drafted detail (§8 triage edits); `means`
 *  sets the workflow the acting loop runs (spin-up); `budget` backs the kickoff
 *  default (no unbudgeted autonomy). System path (the route/tool is the authz
 *  gate). */
export async function updateGoalSystem(
  id: string,
  fields: { outcome?: string; doneWhen?: DoneWhenNode; means?: GoalMeans; budget?: GoalRecord['budget']; brief?: GoalBrief | null; confirm?: boolean; originSessionId?: string; authoringAuthority?: NonNullable<GoalRecord['authoringAuthority']> },
): Promise<GoalRecord | null> {
  if(await retainedGoalIsHeld(id))return null
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1
  if (fields.outcome !== undefined) { sets.push(`outcome = $${idx++}`); values.push(fields.outcome) }
  // Backfill-only: an arming turn may claim a goal created elsewhere for its
  // own chat, but never steals one already bound to a session.
  if (fields.originSessionId !== undefined) {
    sets.push(`origin_session_id = COALESCE(origin_session_id, $${idx++})`)
    values.push(fields.originSessionId)
  }
  if (fields.budget !== undefined) { sets.push(`budget = $${idx++}::jsonb`); values.push(JSON.stringify(fields.budget)) }
  if (fields.doneWhen !== undefined) { sets.push(`done_when = $${idx++}::jsonb`); values.push(JSON.stringify(fields.doneWhen)) }
  if (fields.means !== undefined) { sets.push(`means = $${idx++}::jsonb`); values.push(JSON.stringify(fields.means)) }
  if (fields.brief !== undefined) { sets.push(`brief = $${idx++}::jsonb`); values.push(fields.brief ? JSON.stringify(fields.brief) : null) }
  if (fields.confirm) {
    if (!fields.authoringAuthority) {
      throw Object.assign(new Error('Goal authoring permissions are missing. Confirm the goal from a current workspace turn.'), { reason: 'goal_authority_unavailable' })
    }
    sets.push(`authoring_authority = $${idx++}::jsonb`)
    values.push(JSON.stringify(fields.authoringAuthority))
    sets.push('confirmed_at = now()')
    // Confirming resolves an "unconfirmed → needs clarification" block: re-arm
    // so the goal can be spun up again. Leaves any other terminal/active state.
    sets.push(`status = CASE WHEN status = 'blocked' THEN 'active' ELSE status END`)
  }
  if (sets.length === 0) return getGoalByIdSystem(id)
  values.push(id)
  const result = await query<GoalRow>(
    `UPDATE goals SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${FULL_SELECT}`,
    values,
  )
  if (result.rows.length === 0) return null
  const updated = toRecord(result.rows[0])
  notifyGoalChange(updated.workspaceId, 'update', updated.id)
  return updated
}

/**
 * Atomically narrow a goal's immutable execution context. An unset axis may
 * acquire a binding; an existing binding may only be restated. The guarded
 * WHERE clause prevents a racing request from clearing or switching the scope
 * selected by another writer.
 */
export async function narrowGoalContextSystem(
  id: string,
  contextGroupId: string | null,
  contextProjectId: string | null,
): Promise<GoalRecord | null> {
  if(await retainedGoalIsHeld(id))return null
  const result = await query<GoalRow>(
    `UPDATE goals
        SET context_group_id = $1,
            context_project_id = $2,
            updated_at = now()
      WHERE id = $3
        AND (context_group_id IS NULL OR context_group_id = $1)
        AND (context_project_id IS NULL OR context_project_id = $2)
      RETURNING ${FULL_SELECT}`,
    [contextGroupId, contextProjectId, id],
  )
  if (result.rows.length === 0) return null
  const narrowed = toRecord(result.rows[0])
  notifyGoalChange(narrowed.workspaceId, 'update', narrowed.id)
  return narrowed
}

/** Single-flight claim for the acting loop: atomically flip an `active` goal to
 *  `running`. Returns true iff THIS call claimed it — a no-op update (no row)
 *  means another tick (a re-arm racing an event wake) already owns the goal, so
 *  the caller backs off. This is the exclusive-runs guard (`goals.md` §7). */
export async function tryClaimGoalForTick(id: string): Promise<boolean> {
  const result = await query(
    `UPDATE goals SET status = 'running' WHERE id = $1 AND status = 'active' AND NOT (${retainedGoalRequiredSql}) RETURNING id`,
    [id],
  )
  return (result.rowCount ?? 0) > 0
}

/** System read: count of non-terminal direct sub-goals. Backs self-hosted
 *  `subtasks` acceptance (met when this reaches 0). */
export async function countOpenSubGoalsSystem(id: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text as count FROM goals
     WHERE parent_goal_id = $1 AND status <> ALL($2)`,
    [id, GOAL_TERMINAL_STATUSES],
  )
  return Number(result.rows[0]?.count ?? '0')
}

// ── until:event park (mig 293) ──────────────────────────────────────────────
//
// The acting loop parks a goal on an external event rather than polling: the
// `waitForEvent` tool writes `{ subscriptions }`, the driver's re-arm fills in
// `{ subscriptions, state }`, and the workflow event dispatcher (the second
// subscriber in `workflow/event-trigger.ts`) resumes it when a matching event
// arrives. System path (the tool / driver are the authz gate).

/** Park a goal on an external event: write the durable marker. The agent's
 *  `waitForEvent` call writes `{ subscriptions }`; the driver's re-arm later
 *  overwrites it with `{ subscriptions, state }` so the loop-state handoff
 *  (budget counters) survives the wait. */
export async function setGoalAwaitingEventSystem(
  id: string,
  marker: GoalAwaitingEventMarker,
): Promise<void> {
  if(await retainedGoalIsHeld(id))throw new Error('goal_source_unsupported')
  await query(`UPDATE goals SET awaiting_event = $1::jsonb WHERE id = $2`, [
    JSON.stringify(marker),
    id,
  ])
}

/** Drop a goal's event-park marker. Returns true iff a non-null marker was
 *  cleared — so a resume can be claimed exactly once when two events race on
 *  the same goal (only the call that flips it null schedules the tick). */
export async function clearGoalAwaitingEventSystem(id: string): Promise<boolean> {
  if(await retainedGoalIsHeld(id))return false
  const result = await query(
    `UPDATE goals SET awaiting_event = NULL WHERE id = $1 AND awaiting_event IS NOT NULL RETURNING id`,
    [id],
  )
  return (result.rowCount ?? 0) > 0
}

/** Read a goal's event-park marker, or null when the goal is not parked. */
export async function getGoalAwaitingEventSystem(
  id: string,
): Promise<GoalAwaitingEventMarker | null> {
  if(await retainedGoalIsHeld(id))return null
  const result = await query<{ awaitingEvent: GoalAwaitingEventMarker | null }>(
    `SELECT awaiting_event as "awaitingEvent" FROM goals WHERE id = $1`,
    [id],
  )
  return result.rows[0]?.awaitingEvent ?? null
}

/** The event-dispatcher finder (second subscriber): a workspace's goals parked
 *  on `until:event`. Non-terminal only; pulls the subscriptions out of the
 *  marker jsonb for the dispatcher's `matchesEvent` filter. */
export async function findEventWaitingGoalsSystem(
  workspaceId: string,
): Promise<Array<{ goalId: string; subscriptions: EventSubscription[] }>> {
  const result = await query<{ goalId: string; subscriptions: EventSubscription[] | null }>(
    `SELECT id as "goalId", awaiting_event->'subscriptions' as subscriptions
       FROM goals
      WHERE awaiting_event IS NOT NULL
        AND NOT (${retainedGoalRequiredSql})
        AND workspace_id = $1
        AND status <> ALL($2)`,
    [workspaceId, GOAL_TERMINAL_STATUSES],
  )
  return result.rows.map((r) => ({ goalId: r.goalId, subscriptions: r.subscriptions ?? [] }))
}

/** Typed draft confirmation shared by native human and Brian callers. No lifecycle dispatch. */
export async function confirmRetainedGoal(userId:string,expected:GoalRecord,fields:{outcome?:string;brief?:GoalBrief},authority:SessionContextAuthority):Promise<GoalRecord|null>{
 const version=goalReadVersions.get(expected)
 const changed=fields.outcome!==undefined&&fields.outcome!==expected.outcome||fields.brief!==undefined&&!isDeepStrictEqual(fields.brief,expected.brief)
 if(changed&&(authority.accumulator.evidence.sources??[]).some(source=>!boundScopeSources(expected).some(saved=>isDeepStrictEqual(saved,source))))throw new WorkspaceAccessError('goal_source_unsupported',409)
 if(!version||userId!==authority.execution.security.access.userId)throw new Error('goal_source_unsupported')
 const result=await writeRetainedTaskGoal(expected.id,authority,async client=>{
  const result=await client.query<GoalRow>(`UPDATE goals SET confirmed_at=now(),outcome=COALESCE($3,outcome),
   brief=CASE WHEN $4::jsonb IS NULL THEN brief ELSE $4::jsonb END,
   status=CASE WHEN status='blocked' THEN 'active' ELSE status END
   WHERE id=$1 AND updated_at=$2::timestamptz AND confirmed_at IS NULL AND status IN('active','blocked')
    AND means='{}'::jsonb AND goal_crm_scope_visible(id) RETURNING ${FULL_SELECT}`,
   [expected.id,version,fields.outcome??null,fields.brief?JSON.stringify(fields.brief):null])
  return result.rows[0]?toRecord(result.rows[0]):null
 })
 if(result)try{
  const original=await resolveRetainedTaskGoalAuthority(result)
  if(!original)throw new Error('goal_source_unsupported')
  await original.assertCurrent();await authority.execution.security.authority.assertCurrent()
 }catch(error){throw Object.assign(error instanceof Error?error:new Error('goal_source_unavailable'),{retrySafe:false,operationMayHaveExecuted:true})}
 return result
}

/** Recover only the existing pre-wait deterministic checkpoint. Completed
 * branches are evidence, never another execution; every proof must match the
 * original selected graph and the saved frontier. */
function retainedInitialFrontier(definition: ReturnType<typeof WorkflowDefinitionSchema.parse>,
 currentStepId: string | null, vars: Record<string, unknown>,
 rows: {stepId:string;stepType:string;status:string;output:Record<string,unknown>|null}[]): string[] {
 const unavailable=()=>{throw new Error('goal_source_unsupported')}
 const steps=new Map(definition.steps.map(step=>[step.id,step]))
 const starts=Array.isArray(definition.startStepId)?definition.startStepId:[definition.startStepId]
 const completed=new Map<string,{branchTaken:'true'|'false'}>()
 for(const row of rows){
  const step=steps.get(row.stepId),branch=row.output?.branchTaken
  if(step?.type!=='branch'||row.stepType!=='branch'||row.status!=='completed'||completed.has(row.stepId)
   ||!row.output||Object.keys(row.output).join(',')!=='branchTaken'||branch!=='true'&&branch!=='false')unavailable()
  completed.set(row.stepId,{branchTaken:branch as 'true'|'false'})
 }
 const walk=(seeds:string[],proofs?:Set<string>)=>{
  const visited=new Set<string>(),active=new Set<string>(),frontier:string[]=[]
  const visit=(id:string)=>{
   if(active.has(id)||!steps.has(id))unavailable()
   if(visited.has(id))return // Definition joins share one canonical cursor.
   active.add(id);visited.add(id)
   const proof=completed.get(id),step=steps.get(id)!
   if(proof){
    proofs?.add(id)
    for(const successor of runtimeSuccessors(step,{kind:'success',output:proof,...proof},definition.steps.map(step=>step.id)))visit(successor)
   }else frontier.push(id)
   active.delete(id)
  }
  for(const id of seeds)visit(id)
  return frontier
 }
 const proofs=new Set<string>(),expected=walk(starts,proofs)
 if(proofs.size!==completed.size)unavailable()
 let saved:string[]
 if(Object.hasOwn(vars,'__frontier')){
  const frontier=vars.__frontier
  if(!Array.isArray(frontier)||frontier.some(id=>typeof id!=='string'||!steps.has(id))||new Set(frontier).size!==frontier.length)unavailable()
  saved=walk(frontier as string[])
 }else{
  if(rows.length===0){if(currentStepId!==starts[0])unavailable();saved=[...starts]}
  else {if(!currentStepId||!completed.has(currentStepId)||expected.length)unavailable();saved=[]}
 }
 if(!isDeepStrictEqual([...saved].sort(),[...expected].sort()))unavailable()
 return saved
}

/** Internal claim metadata is a fence, never source authority. */
export type RetainedGoalWorkflowClaim={claimedAt:string;claimAttempts:number}
async function retainedGoalWorkflowClaim(client:pg.PoolClient,runId:string):Promise<RetainedGoalWorkflowClaim>{
 const claim=(await client.query<RetainedGoalWorkflowClaim>('SELECT claimed_at::text AS "claimedAt",claim_attempts AS "claimAttempts" FROM workflow_runs WHERE id=$1',[runId])).rows[0]
 if(!claim?.claimedAt||!Number.isInteger(claim.claimAttempts)||claim.claimAttempts<1)throw new Error('goal_source_unsupported')
 return claim
}

/** Explicit native-only deterministic means, shared by the actual Brian command. */
export async function armRetainedGoalWorkflow(userId:string,expected:GoalRecord,workflowId:string,authority:SessionContextAuthority){
 const version=goalReadVersions.get(expected)
 if(!version||!expected.confirmedAt||userId!==authority.execution.security.access.userId)throw new Error('goal_source_unsupported')
 return writeRetainedTaskGoal(expected.id,authority,async client=>{
  const current=(await client.query<GoalRow>(`SELECT ${FULL_SELECT} FROM goals WHERE id=$1 AND updated_at=$2::timestamptz
    AND confirmed_at IS NOT NULL AND status='active' AND goal_crm_scope_visible(id) FOR UPDATE`,[expected.id,version])).rows[0]
  if(!current)throw new Error('goal_source_unsupported')
  const existing=(await client.query<{id:string;status:string;live:boolean;expired:boolean;currentStepId:string|null;vars:Record<string,unknown>}>("SELECT id,status,claimed_at>clock_timestamp()-interval '10 minutes' AS live,claimed_at<=clock_timestamp()-interval '10 minutes' AS expired,current_step_id AS \"currentStepId\",vars FROM workflow_runs WHERE source_goal_id=$1 ORDER BY started_at LIMIT 1 FOR UPDATE",[expected.id])).rows[0]
  if(existing){
   if(current.means?.workflowId!==workflowId||(await client.query<{allowed:boolean}>('SELECT retained_goal_workflow_current($1,false) AS allowed',[existing.id])).rows[0]?.allowed!==true)throw new Error('goal_source_unsupported')
   let dispatch=existing.status==='pending'&&!existing.live
   if(existing.status==='running'&&existing.expired){
    const definition=WorkflowDefinitionSchema.parse((await client.query<{definition:unknown}>('SELECT definition FROM workflows WHERE id=$1 FOR SHARE',[workflowId])).rows[0]?.definition)
    const rows=(await client.query<{stepId:string;stepType:string;status:string;output:Record<string,unknown>|null}>('SELECT step_id AS \"stepId\",step_type AS \"stepType\",status,output FROM workflow_step_runs WHERE run_id=$1 ORDER BY started_at FOR UPDATE',[existing.id])).rows
    if(rows.some(step=>step.stepType==='wait')||(await client.query("SELECT id FROM scheduled_jobs WHERE channel_type='workflow' AND channel_id=$1 FOR UPDATE",[existing.id])).rows.length)throw new Error('goal_source_unsupported') // session-kind-exempt: scheduled_jobs.channel_type identifies a workflow resume job, not a session.
    const frontier=retainedInitialFrontier(definition,existing.currentStepId,existing.vars,rows)
    await client.query("UPDATE workflow_runs SET vars=jsonb_set(vars,'{__frontier}',$2::jsonb) WHERE id=$1",[existing.id,JSON.stringify(frontier)])
    dispatch=true
   }
   if(dispatch)await client.query('UPDATE workflow_runs SET claimed_at=clock_timestamp(),claim_attempts=claim_attempts+1 WHERE id=$1',[existing.id])
   return{goal:toRecord(current),run:(await readWorkflowRunInTransaction(client,expected.workspaceId,existing.id))!,dispatch,
    claim:dispatch?await retainedGoalWorkflowClaim(client,existing.id):undefined}
  }
  if(Object.keys(current.means??{}).length)throw new Error('goal_source_unsupported')
  const workflow=(await client.query<{definition:unknown;authority:AuthoringAuthority;actor:string;contextGroupId:string|null;contextProjectId:string|null}>(`SELECT definition,authoring_authority AS authority,created_by AS actor,
    context_group_id AS "contextGroupId",context_project_id AS "contextProjectId" FROM workflows
    WHERE id=$1 AND workspace_id=$2 AND enabled FOR SHARE`,[workflowId,expected.workspaceId])).rows[0]
  if(!workflow||(await client.query("SELECT id FROM assistants WHERE id=$1 AND workspace_id=$2 AND kind='primary' FOR SHARE",[workflow.authority?.assistantId,expected.workspaceId])).rows.length!==1)throw new Error('goal_source_unsupported')
  const definition=WorkflowDefinitionSchema.parse(workflow.definition)
  if(definition.principal||definition.failureDelivery||definition.taskIntake||definition.steps.some(step=>!['wait','branch'].includes(step.type)||step.type==='wait'&&(!step.at||step.until||(step.at.timezone??'UTC')!=='UTC'))
   ||workflow.actor!==userId||workflow.authority?.assistantId!==expected.authoringAuthority?.assistantId
   ||workflow.contextGroupId!==expected.contextGroupId||workflow.contextProjectId!==expected.contextProjectId)throw new Error('goal_source_unsupported')
  const scope=await resolveWorkflowAuthoringScope({userId,workspaceId:expected.workspaceId,assistantId:workflow.authority.assistantId,
    authoringAuthority:workflow.authority,contextGroupId:workflow.contextGroupId,contextProjectId:workflow.contextProjectId},client)
  if(!accessCeilingContains(pinAccessCeiling(scope.access),expected.authoringAuthority!.ceiling))throw new Error('goal_source_unsupported')
  const roots=boundScopeSources(expected)
  if(roots.some(source=>source.resourceKind==='external_source')||(await readExternalSourceAncestors(expected.workspaceId,roots,client)).length)throw new Error('goal_source_unsupported')
  const task=await readLegacyCanonicalCrmPoint(authority.execution.security.access,'task',expected.host!.id,['title'],client)
  const title=task?.projection.values.title
  if(typeof title!=='string')throw new Error('goal_source_unsupported')
  const input:Record<string,unknown>={goalId:expected.id,goalOutcome:current.outcome,taskTitle:title}
  if(current.brief?.verification)input.goalVerification=current.brief.verification
  if(current.brief?.approach)input.goalApproach=current.brief.approach
  const updated=(await client.query<GoalRow>(`UPDATE goals SET means=jsonb_build_object('workflowId',$3::text)
    WHERE id=$1 AND updated_at=$2::timestamptz RETURNING ${FULL_SELECT}`,[expected.id,version,workflowId])).rows[0]
  if(!updated)throw new Error('goal_source_unsupported')
  const runId=randomUUID()
  const inserted=await client.query(`INSERT INTO workflow_runs(id,workflow_id,workspace_id,triggered_by,trigger_kind,input,source_goal_id,
    context_group_id,context_project_id,context_compartments,context_project_ids)
    SELECT $6,w.id,w.workspace_id,$3,'manual',$4::jsonb,$5,w.context_group_id,w.context_project_id,
     CASE WHEN g.compartment_key IS NULL THEN '{}'::text[] ELSE ARRAY[g.compartment_key] END,
     CASE WHEN w.context_project_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[w.context_project_id] END
    FROM workflows w LEFT JOIN workspace_groups g ON g.id=w.context_group_id WHERE w.id=$1 AND w.workspace_id=$2`,
    [workflowId,expected.workspaceId,userId,JSON.stringify(input),expected.id,runId])
  if(inserted.rowCount!==1)throw new Error('goal_source_unsupported')
  await client.query('SELECT bind_retained_goal_workflow_run($1,$2)',[runId,expected.id])
  return{goal:toRecord(updated),run:(await readWorkflowRunInTransaction(client,expected.workspaceId,runId))!,dispatch:true,
   claim:await retainedGoalWorkflowClaim(client,runId)}
 })
}
