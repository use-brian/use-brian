/**
 * Actor-bound task responsibility: validation of executor / follow-up / home
 * changes, current home owners, and the guarded claim.
 *
 * Validation runs INSIDE the writer transaction of `createTask` /
 * `updateTask` (db/tasks.ts), so Brian tools, brain MCP (which bridges the
 * same core tools), the Brain inbox `/adjust` route and the claim route are
 * all held to one rule set. The eligibility facts live in SECURITY DEFINER
 * SQL helpers (migration 753) because RLS hides co-member rows and other
 * principals' edges from the actor; each helper answers a boolean or an owner
 * set, never row content.
 *
 * Validation never widens access: an ineligible principal is refused, it is
 * not granted whatever would make the assignment work.
 *
 * Spec: docs/architecture/features/tasks.md -> "Responsibility".
 * [COMP:api/task-responsibility]
 */
import {
  TaskResponsibilityError,
  claimPrecondition,
  type TaskHome,
  type TaskRecord,
  type TaskRecordStatus,
  type TaskResponsibility,
  type TaskStore,
} from '@use-brian/core'
import { query } from '../db/client.js'

type Db = { query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

/** The protection of the row being written, as the writer already resolved it. */
type TaskResponsibilityEnvelope = {
  workspaceId: string
  sensitivity: string
  compartments: string[]
  projectIds: string[]
  /** `tasks.user_id`: the private partition, if any. */
  privateUserId: string | null
  /** `tasks.assistant_id`: another assistant's private task, if any. */
  privateAssistantId: string | null
}

const sameHome = (a: TaskHome | null, b: TaskHome | null) =>
  (a === null && b === null) || (a !== null && b !== null && a.kind === b.kind && a.id === b.id)

async function holds(db: Db, sql: string, values: unknown[]): Promise<boolean> {
  const result = await db.query(sql, values)
  return result.rows[0]?.ok === true
}

/**
 * Refuse a responsibility change the actor may not make. Only what changed is
 * checked, so an unrelated edit to a legacy row never fails on a value nobody
 * touched; a home change re-checks the executor and contact against the new
 * home because the write would otherwise move them somewhere they cannot see.
 */
export async function validateTaskResponsibility(
  db: Db,
  actorUserId: string,
  envelope: TaskResponsibilityEnvelope,
  before: TaskResponsibility | null,
  after: TaskResponsibility,
): Promise<void> {
  const homeChanged = !sameHome(before?.home ?? null, after.home)
  const home = after.home
  if (homeChanged && home) {
    if (home.kind === 'project' && envelope.projectIds.length > 0 && !envelope.projectIds.includes(home.id)) {
      throw new TaskResponsibilityError('task_home_mismatch', 'A Project home must be the Project the task belongs to.')
    }
    if (!await holds(db, 'SELECT public.task_home_admissible($1,$2,$3,$4) AS ok',
      [actorUserId, envelope.workspaceId, home.kind, home.id])) {
      throw new TaskResponsibilityError('task_home_invalid', 'You can only place work in a Department or Project you belong to.')
    }
  }
  if (after.executorAssistantId && (homeChanged || after.executorAssistantId !== before?.executorAssistantId)) {
    if (!await holds(db, 'SELECT public.task_executor_eligible($1,$2,$3,$4,$5,$6,$7) AS ok',
      [actorUserId, envelope.workspaceId, after.executorAssistantId, envelope.privateAssistantId,
        envelope.sensitivity, home?.kind ?? null, home?.id ?? null])) {
      throw new TaskResponsibilityError('task_executor_invalid',
        'That assistant cannot execute this task: it is not visible to you, not admitted to the task\'s home, or not cleared for it.')
    }
  }
  if (after.followUpMemberId && (homeChanged || after.followUpMemberId !== before?.followUpMemberId)) {
    if (!await holds(db, 'SELECT public.task_follow_up_eligible($1,$2,$3,$4::text[],$5,$6,$7) AS ok',
      [envelope.workspaceId, after.followUpMemberId, envelope.sensitivity, envelope.compartments,
        envelope.privateUserId, home?.kind ?? null, home?.id ?? null])) {
      throw new TaskResponsibilityError('task_follow_up_invalid',
        'That person cannot follow up on this task: they cannot see it or are not admitted to its home.')
    }
  }
}

/** Current eligible owners of each home, keyed `kind:id`. Resolved on every read. */
export async function homeOwnerIds(workspaceId: string, homes: readonly TaskHome[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const unique = [...new Map(homes.map(h => [`${h.kind}:${h.id}`, h])).values()]
  if (unique.length === 0) return out
  const result = await query<{ kind: string; id: string; owners: string[] }>(
    `SELECT h.kind, h.id, public.task_home_owner_ids($1, h.kind, h.id) AS owners
       FROM unnest($2::text[], $3::uuid[]) AS h(kind, id)`,
    [workspaceId, unique.map(h => h.kind), unique.map(h => h.id)])
  for (const row of result.rows) out.set(`${row.kind}:${row.id}`, row.owners ?? [])
  return out
}

type ClaimExecutor = { kind: 'person' } | { kind: 'assistant'; assistantId: string }

/**
 * The guarded claim behind an owner-queue card: an unassigned task takes the
 * requested executor; the same claim repeated is an idempotent success; a task
 * someone already holds is `task_already_claimed`. The precondition runs on
 * the locked live row inside `updateTask`, and a superseded id forward-resolves
 * to the live head, so racing owners produce one executor and no duplicate.
 */
export async function claimTask(
  store: Pick<TaskStore, 'update'>,
  actorUserId: string,
  workspaceId: string,
  taskId: string,
  executor: ClaimExecutor,
): Promise<TaskRecord> {
  let fields: { assigneeId: string } | { executorAssistantId: string }
  if (executor.kind === 'person') {
    const member = await query<{ id: string }>(
      'SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, actorUserId])
    if (!member.rows[0]) throw new TaskResponsibilityError('task_not_found')
    fields = { assigneeId: member.rows[0].id }
  } else {
    fields = { executorAssistantId: executor.assistantId }
  }
  const guard = claimPrecondition(fields)
  const task = await store.update(actorUserId, taskId, fields, {
    writtenBy: 'user',
    precondition: (current: TaskResponsibility & { status: TaskRecordStatus; workspaceId: string }) => {
      if (current.workspaceId !== workspaceId) throw new TaskResponsibilityError('task_not_found')
      return guard(current)
    },
  })
  if (!task) throw new TaskResponsibilityError('task_not_found')
  return task
}
