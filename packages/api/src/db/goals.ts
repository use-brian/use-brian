/**
 * Goals SQL helpers — the operational goal-seeker primitive.
 *
 * See `docs/architecture/features/goals.md` (forthcoming) and
 * `docs/plans/task-goal-seeker.md` §3.2. Goals are an operational table:
 * writes go through the owner pool (`query()`), the route/engine being the
 * authorization gate; user reads go through the app pool (`queryWithRLS`),
 * confined by the `goals_workspace_member` policy.
 */
import type { DoneWhenNode, EventSubscription, GoalCompletionClaim, GoalCreateParams, GoalHostRef, GoalListFilters, GoalMeans, GoalRecord, GoalStatus } from '@sidanclaw/core'
import { query, queryWithRLS } from './client.js'

/**
 * The durable event-park marker stored in `goals.awaiting_event` (mig 293).
 * `subscriptions` is what the workflow event dispatcher matches to resume the
 * goal; `state` is the acting-loop handoff (the driver's `GoalLoopState`)
 * preserved verbatim so budget counters survive the wait — the store treats it
 * as opaque (the driver owns its shape). NULL column when the goal is not
 * parked on an event. See `goals/driver.ts` (`until:event` resume).
 */
export type GoalAwaitingEventMarker = {
  subscriptions: EventSubscription[]
  state?: Record<string, unknown>
}

const FULL_SELECT = `
  id, workspace_id as "workspaceId", parent_goal_id as "parentGoalId",
  recipe_id as "recipeId", host_type as "hostType", host_id as "hostId",
  outcome, done_when as "doneWhen", means, budget, policy, status,
  blocker_reason as "blockerReason", created_by_user_id as "createdByUserId",
  confirmed_at as "confirmedAt", completion_claim as "completionClaim",
  created_at as "createdAt", updated_at as "updatedAt"
`

const TERMINAL_STATUSES = ['done', 'abandoned']

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
  confirmedAt: Date | null
  completionClaim: GoalCompletionClaim | null
  createdAt: Date
  updatedAt: Date
}

function toRecord(row: GoalRow): GoalRecord {
  return {
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
    confirmedAt: row.confirmedAt,
    completionClaim: row.completionClaim,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Insert a goal (owner pool; the route/engine is the authz gate). */
export async function createGoal(params: GoalCreateParams): Promise<GoalRecord> {
  const host = params.host ?? null
  const result = await query<GoalRow>(
    `INSERT INTO goals (
       workspace_id, parent_goal_id, recipe_id, host_type, host_id,
       outcome, done_when, means, budget, policy, status, created_by_user_id,
       confirmed_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13)
     RETURNING ${FULL_SELECT}`,
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
      // Explicitly-created goals are confirmed; the auto-draft hook passes
      // `confirmed: false` to mint a draft (autopilot §4).
      params.confirmed === false ? null : new Date(),
    ],
  )
  return toRecord(result.rows[0])
}

/** User-scoped read (RLS by workspace membership). */
export async function getGoalById(userId: string, id: string): Promise<GoalRecord | null> {
  const result = await queryWithRLS<GoalRow>(
    userId,
    `SELECT ${FULL_SELECT} FROM goals WHERE id = $1`,
    [id],
  )
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

/** System read by id (engine path; no user context). */
export async function getGoalByIdSystem(id: string): Promise<GoalRecord | null> {
  const result = await query<GoalRow>(`SELECT ${FULL_SELECT} FROM goals WHERE id = $1`, [id])
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
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
  const claim: GoalCompletionClaim = { because, verifiedAt: new Date().toISOString() }
  const result = await query<GoalRow>(
    `UPDATE goals SET completion_claim = $1::jsonb WHERE id = $2 RETURNING ${FULL_SELECT}`,
    [JSON.stringify(claim), id],
  )
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

/** User-scoped workspace listing for the goals board. */
export async function listGoals(
  userId: string,
  workspaceId: string,
  filters: GoalListFilters = {},
): Promise<GoalRecord[]> {
  const wheres: string[] = ['workspace_id = $1']
  const values: unknown[] = [workspaceId]
  let idx = 2

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
    values.push(TERMINAL_STATUSES)
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

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200)
  values.push(limit)

  const result = await queryWithRLS<GoalRow>(
    userId,
    `SELECT ${FULL_SELECT} FROM goals
     WHERE ${wheres.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${idx}`,
    values,
  )
  return result.rows.map(toRecord)
}

/** System read: goals bound to a given host — the rollup lookup. */
export async function listGoalsByHostSystem(host: GoalHostRef): Promise<GoalRecord[]> {
  const result = await query<GoalRow>(
    `SELECT ${FULL_SELECT} FROM goals
     WHERE host_type = $1 AND host_id = $2
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
  const result = await query<GoalRow>(
    `UPDATE goals SET status = $1, blocker_reason = $2 WHERE id = $3 RETURNING ${FULL_SELECT}`,
    [status, blockerReason, id],
  )
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

/** Update a goal's curated fields and/or confirm it (autopilot §4). `confirm:
 *  true` sets `confirmed_at = now()` (arming a draft); `outcome` / `doneWhen`
 *  let the creator amend the auto-drafted detail; `means` sets the workflow the
 *  acting loop runs (spin-up); `budget` backs the kickoff default (no
 *  unbudgeted autonomy). System path (the route/tool is the authz gate). */
export async function updateGoalSystem(
  id: string,
  fields: { outcome?: string; doneWhen?: DoneWhenNode; means?: GoalMeans; budget?: GoalRecord['budget']; confirm?: boolean },
): Promise<GoalRecord | null> {
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1
  if (fields.outcome !== undefined) { sets.push(`outcome = $${idx++}`); values.push(fields.outcome) }
  if (fields.budget !== undefined) { sets.push(`budget = $${idx++}::jsonb`); values.push(JSON.stringify(fields.budget)) }
  if (fields.doneWhen !== undefined) { sets.push(`done_when = $${idx++}::jsonb`); values.push(JSON.stringify(fields.doneWhen)) }
  if (fields.means !== undefined) { sets.push(`means = $${idx++}::jsonb`); values.push(JSON.stringify(fields.means)) }
  if (fields.confirm) {
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
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

/** Single-flight claim for the acting loop: atomically flip an `active` goal to
 *  `running`. Returns true iff THIS call claimed it — a no-op update (no row)
 *  means another tick (a re-arm racing an event wake) already owns the goal, so
 *  the caller backs off. This is the exclusive-runs guard (`goals.md` §7). */
export async function tryClaimGoalForTick(id: string): Promise<boolean> {
  const result = await query(
    `UPDATE goals SET status = 'running' WHERE id = $1 AND status = 'active' RETURNING id`,
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
    [id, TERMINAL_STATUSES],
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
  await query(`UPDATE goals SET awaiting_event = $1::jsonb WHERE id = $2`, [
    JSON.stringify(marker),
    id,
  ])
}

/** Drop a goal's event-park marker. Returns true iff a non-null marker was
 *  cleared — so a resume can be claimed exactly once when two events race on
 *  the same goal (only the call that flips it null schedules the tick). */
export async function clearGoalAwaitingEventSystem(id: string): Promise<boolean> {
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
        AND workspace_id = $1
        AND status <> ALL($2)`,
    [workspaceId, TERMINAL_STATUSES],
  )
  return result.rows.map((r) => ({ goalId: r.goalId, subscriptions: r.subscriptions ?? [] }))
}
