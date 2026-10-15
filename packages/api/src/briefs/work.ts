/**
 * The viewer-bound work projection behind the Chat work entry and the Brief
 * work section: Needs you, My work and Needs assignment, computed from
 * canonical task state for ONE viewer and ONE scope.
 *
 * Authority: rows come from a single query under the viewer's RLS plus the
 * universal access predicate (`resolveWorkspaceViewpoint`, the same viewpoint
 * as the Tasks surface). Owner sets and hosted-Goal states are read only for
 * those rows, and counts are the lengths of the returned sections, so a task
 * the viewer cannot see contributes neither a row nor a count. Attention
 * never widens access: classification only decides whether a VISIBLE task is
 * this viewer's work.
 *
 * A read never edits Direction, never writes, never calls a model. A failed
 * source raises `WorkUnavailableError` (the route answers 503) instead of an
 * empty queue that would claim there is nothing to do.
 *
 * Spec: docs/architecture/features/project-briefs.md -> "Work".
 * [COMP:api/brief-work]
 */
import {
  OPEN_TASK_STATUSES,
  classifyTaskForViewer,
  resolveTaskFollowUp,
  taskExecutor,
  type TaskHome,
  type WorkNextAction,
  type WorkReason,
} from '@use-brian/core'
import { buildAccessPredicate } from '../db/access-predicate.js'
import { query, queryGated, queryWithRLS } from '../db/client.js'
import { resolveWorkspaceViewpoint } from '../db/workspace-viewpoint.js'
import { homeOwnerIds } from '../tasks/responsibility.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

type WorkScope = { kind: 'personal' } | { kind: 'department' | 'project'; id: string }

type WorkExecutor =
  | { kind: 'person'; memberId: string; name: string | null }
  | { kind: 'assistant'; assistantId: string; name: string | null }
  | { kind: 'unassigned' }

type WorkFollowUp =
  | { source: 'explicit' | 'executor'; memberId: string; name: string | null }
  | { source: 'home_owners'; home: TaskHome; viewerIsOwner: boolean }
  | { source: 'missing_routing'; reason: 'no_home' | 'no_eligible_owner' }
  | { source: 'owner_queue'; home: TaskHome }
  | { source: 'none' }

type WorkItem = {
  taskId: string
  title: string
  status: string
  due: string | null
  home: TaskHome | null
  executor: WorkExecutor
  followUp: WorkFollowUp
  reasons: WorkReason[]
  nextAction: WorkNextAction
  /** A blocked hosted Goal's reason, when the viewer can see it. */
  blockerReason: string | null
  updatedAt: string
}

export type WorkProjection = {
  scope: WorkScope
  /** The viewer's own `workspace_members` id, for "I'll follow up" style actions. */
  viewer: { memberId: string }
  sections: { needsYou: WorkItem[]; myWork: WorkItem[]; needsAssignment: WorkItem[] }
  counts: { needsYou: number; myWork: number; needsAssignment: number }
  generatedAt: string
}

/** A source could not establish the queue; never rendered as empty. */
export class WorkUnavailableError extends Error {
  readonly code = 'work_unavailable'
  constructor(cause: unknown) {
    super('work_unavailable', { cause })
    this.name = 'WorkUnavailableError'
  }
}

type CandidateRow = {
  id: string
  title: string
  status: string
  due: Date | null
  assigneeId: string | null
  executorAssistantId: string | null
  followUpMemberId: string | null
  homeKind: TaskHome['kind'] | null
  homeId: string | null
  createdByUserId: string | null
  updatedAt: Date
}

/** Hard ceiling on candidates; the sections are the viewer's own work, far below it. */
const CANDIDATE_LIMIT = 500

/**
 * Validate the scope owner even when it has no accepted Brief revision: a
 * Department or Project the viewer is not admitted to is `brief_not_found`.
 */
async function assertScopeVisible(viewerUserId: string, workspaceId: string, scope: WorkScope): Promise<void> {
  if (scope.kind === 'personal') return
  const owned = await query<{ ok: boolean }>(
    `SELECT public.task_home_admissible($1,$2,$3,$4)
         OR $1 = ANY(public.task_home_owner_ids($2,$3,$4)) AS ok`,
    [viewerUserId, workspaceId, scope.kind, scope.id])
  if (!owned.rows[0]?.ok) throw new WorkspaceAccessError('brief_not_found', 404)
}

export async function readWorkProjection(
  viewerUserId: string,
  workspaceId: string,
  scope: WorkScope,
  now: Date = new Date(),
): Promise<WorkProjection> {
  const access = await resolveWorkspaceViewpoint(viewerUserId, workspaceId, null)
  if (!access) throw new WorkspaceAccessError('brief_not_found', 404)
  await assertScopeVisible(viewerUserId, workspaceId, scope)
  try {
    return await project(viewerUserId, workspaceId, scope, access, now)
  } catch (error) {
    if (error instanceof WorkspaceAccessError) throw error
    throw new WorkUnavailableError(error)
  }
}

async function project(
  viewerUserId: string,
  workspaceId: string,
  scope: WorkScope,
  access: NonNullable<Awaited<ReturnType<typeof resolveWorkspaceViewpoint>>>,
  now: Date,
): Promise<WorkProjection> {
  const member = await query<{ id: string }>(
    'SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, viewerUserId])
  const viewer = { userId: viewerUserId, memberId: member.rows[0]?.id ?? '' }
  if (!viewer.memberId) throw new WorkspaceAccessError('brief_not_found', 404)

  // Homes the viewer currently owns (own ownership only, for the personal
  // candidate filter; classification re-resolves owners per home below).
  const ownedHomes = await query<{ kind: TaskHome['kind']; id: string }>(
    `SELECT 'department' AS kind, department_id AS id FROM department_owners WHERE workspace_id=$1 AND user_id=$2
     UNION ALL
     SELECT 'project', project_id FROM project_shared_owners
      WHERE workspace_id=$1 AND user_id=$2 AND public.project_member_live(project_id,'user',$2)`,
    [workspaceId, viewerUserId])
  const ownedDepartments = ownedHomes.rows.filter(h => h.kind === 'department').map(h => h.id)
  const ownedProjects = ownedHomes.rows.filter(h => h.kind === 'project').map(h => h.id)

  const ap = buildAccessPredicate(access, { startIdx: 1 })
  const values: unknown[] = [...ap.params]
  const param = (value: unknown) => { values.push(value); return `$${values.length}` }
  const open = param([...OPEN_TASK_STATUSES])
  let scopeSql: string
  if (scope.kind === 'personal') {
    const memberRef = param(viewer.memberId), userRef = param(viewerUserId)
    const depts = param(ownedDepartments), projects = param(ownedProjects)
    scopeSql = `(assignee_id = ${memberRef} OR follow_up_member_id = ${memberRef}
      OR (executor_assistant_id IS NOT NULL AND follow_up_member_id IS NULL
          AND ((home_kind='department' AND home_id = ANY(${depts}::uuid[])) OR (home_kind='project' AND home_id = ANY(${projects}::uuid[]))))
      OR (assignee_id IS NULL AND executor_assistant_id IS NULL AND home_kind='department' AND home_id = ANY(${depts}::uuid[]))
      OR (executor_assistant_id IS NOT NULL AND follow_up_member_id IS NULL AND created_by_user_id = ${userRef}))`
  } else if (scope.kind === 'department') {
    scopeSql = `(home_kind='department' AND home_id = ${param(scope.id)})`
  } else {
    const id = param(scope.id)
    scopeSql = `((home_kind='project' AND home_id = ${id}) OR project_ids = ARRAY[${id}::uuid])`
  }
  const limit = param(CANDIDATE_LIMIT)
  const rows = (await queryGated<CandidateRow>(access,
    `SELECT id, title, status, due, assignee_id AS "assigneeId", executor_assistant_id AS "executorAssistantId",
            follow_up_member_id AS "followUpMemberId", home_kind AS "homeKind", home_id AS "homeId",
            created_by_user_id AS "createdByUserId", updated_at AS "updatedAt"
       FROM tasks
      WHERE ${ap.sql} AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
        AND status = ANY(${open}::text[]) AND ${scopeSql}
      ORDER BY updated_at DESC
      LIMIT ${limit}`, values)).rows

  const homes = rows.flatMap(r => r.homeKind && r.homeId ? [{ kind: r.homeKind, id: r.homeId }] : [])
  const ids = rows.map(r => r.id)
  const [owners, goals, assistants, members] = await Promise.all([
    homeOwnerIds(workspaceId, homes),
    ids.length === 0 ? Promise.resolve({ rows: [] as { hostId: string; status: string; blockerReason: string | null }[] })
      : queryWithRLS<{ hostId: string; status: string; blockerReason: string | null }>(viewerUserId,
        `SELECT host_id AS "hostId", status, blocker_reason AS "blockerReason" FROM goals
          WHERE workspace_id=$1 AND host_type='task' AND host_id = ANY($2::uuid[]) AND status IN ('blocked','awaiting_approval')`,
        [workspaceId, ids]),
    namesOfAssistants(viewerUserId, workspaceId, rows),
    namesOfMembers(workspaceId, rows),
  ])

  const sections: WorkProjection['sections'] = { needsYou: [], myWork: [], needsAssignment: [] }
  for (const row of rows) {
    const home = row.homeKind && row.homeId ? { kind: row.homeKind, id: row.homeId } : null
    const homeOwners = home ? owners.get(`${home.kind}:${home.id}`) ?? [] : null
    const hosted = goals.rows.filter(g => g.hostId === row.id)
    const responsibility = { assigneeId: row.assigneeId, executorAssistantId: row.executorAssistantId, followUpMemberId: row.followUpMemberId, home }
    const classification = classifyTaskForViewer({
      ...responsibility, status: row.status, due: row.due,
      openQuestions: hosted.filter(g => g.status === 'awaiting_approval').length,
      goalBlocked: hosted.some(g => g.status === 'blocked'),
      createdByUserId: row.createdByUserId,
    }, viewer, homeOwners, now)
    if (!classification) continue
    const executor = taskExecutor(responsibility)
    const followUp = resolveTaskFollowUp(responsibility, homeOwners)
    const item: WorkItem = {
      taskId: row.id, title: row.title, status: row.status,
      due: row.due ? row.due.toISOString() : null, home,
      executor: executor.kind === 'person' ? { ...executor, name: members.get(executor.memberId) ?? null }
        : executor.kind === 'assistant' ? { ...executor, name: assistants.get(executor.assistantId) ?? null }
        : executor,
      followUp: followUp.source === 'explicit' || followUp.source === 'executor'
        ? { source: followUp.source, memberId: followUp.memberId, name: members.get(followUp.memberId) ?? null }
        : followUp.source === 'home_owners' ? { source: 'home_owners', home: followUp.home, viewerIsOwner: followUp.ownerUserIds.includes(viewerUserId) }
        : followUp.source === 'owner_queue' ? { source: 'owner_queue', home: followUp.home }
        : followUp,
      reasons: classification.reasons,
      nextAction: classification.nextAction,
      blockerReason: hosted.find(g => g.status === 'blocked')?.blockerReason ?? null,
      updatedAt: row.updatedAt.toISOString(),
    }
    const section = classification.section === 'needs_you' ? 'needsYou' : classification.section === 'my_work' ? 'myWork' : 'needsAssignment'
    sections[section].push(item)
  }
  return {
    scope,
    viewer: { memberId: viewer.memberId },
    sections,
    counts: { needsYou: sections.needsYou.length, myWork: sections.myWork.length, needsAssignment: sections.needsAssignment.length },
    generatedAt: now.toISOString(),
  }
}

/** Executor assistant names, only for assistants whose placement the viewer can see. */
async function namesOfAssistants(viewerUserId: string, workspaceId: string, rows: CandidateRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap(r => r.executorAssistantId ? [r.executorAssistantId] : []))]
  if (ids.length === 0) return new Map()
  const result = await query<{ id: string; name: string }>(
    `SELECT id, name FROM assistants
      WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND public.assistant_placement_visible($3, id)`,
    [workspaceId, ids, viewerUserId])
  return new Map(result.rows.map(r => [r.id, r.name]))
}

/** Display names for the people named on visible rows (the workspace directory already shows them). */
async function namesOfMembers(workspaceId: string, rows: CandidateRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap(r => [r.assigneeId, r.followUpMemberId].filter((v): v is string => !!v)))]
  if (ids.length === 0) return new Map()
  const result = await query<{ id: string; name: string | null; email: string | null }>(
    `SELECT m.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id=$1 AND m.id = ANY($2::uuid[])`, [workspaceId, ids])
  return new Map(result.rows.map(r => [r.id, r.name ?? r.email ?? '']))
}
