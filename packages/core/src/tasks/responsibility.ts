/**
 * Task responsibility: who EXECUTES a task, which human FOLLOWS UP on it, and
 * the task's operating HOME. The three are independent on purpose.
 *
 * - Executor is one typed slot: a person (`assigneeId`, a `workspace_members`
 *   row id), a configured assistant (`executorAssistantId`), or nobody.
 *   Setting one kind clears the other; asking for both at once is a conflict.
 *   `tasks.assistant_id` is private VISIBILITY, never execution identity.
 * - Follow-up is an optional explicit human contact. Selecting one never makes
 *   that person the executor and never stops an assistant executor.
 * - Home is the explicit Department or shared Project the work belongs to. It
 *   is never derived from `project_ids`, compartments, text or authorship; an
 *   unknown home stays unknown until someone selects one.
 *
 * Fallback follow-up is RESOLVED, never stored: assistant work with no
 * explicit contact routes to the current owners of its home, so an owner
 * change or a departure re-resolves attention on the next read.
 *
 * Spec: docs/architecture/features/tasks.md -> "Responsibility".
 * [COMP:tasks/responsibility]
 */

export const TASK_HOME_KINDS = ['department', 'project'] as const
export type TaskHomeKind = (typeof TASK_HOME_KINDS)[number]
export type TaskHome = { kind: TaskHomeKind; id: string }

/** Statuses that still carry work. `done` and `archived` never surface. */
export const OPEN_TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'blocked'] as const

export type TaskExecutor =
  | { kind: 'person'; memberId: string }
  | { kind: 'assistant'; assistantId: string }
  | { kind: 'unassigned' }

export type TaskResponsibility = {
  assigneeId: string | null
  executorAssistantId: string | null
  followUpMemberId: string | null
  home: TaskHome | null
}

/** A partial change. Omitted keys are unchanged; `null` clears. */
export type TaskResponsibilityPatch = {
  assigneeId?: string | null
  executorAssistantId?: string | null
  followUpMemberId?: string | null
  home?: TaskHome | null
}

const TASK_RESPONSIBILITY_ERRORS = {
  task_executor_conflict: 400,
  task_executor_invalid: 400,
  task_follow_up_invalid: 400,
  task_home_invalid: 400,
  task_home_mismatch: 409,
  task_already_claimed: 409,
  task_claim_not_owner: 403,
  task_not_found: 404,
} as const
export type TaskResponsibilityErrorCode = keyof typeof TASK_RESPONSIBILITY_ERRORS

/** Typed refusal shared by REST, Brian tools and MCP. */
export class TaskResponsibilityError extends Error {
  readonly code: TaskResponsibilityErrorCode
  readonly status: number
  constructor(code: TaskResponsibilityErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'TaskResponsibilityError'
    this.code = code
    this.status = TASK_RESPONSIBILITY_ERRORS[code]
  }
}

/** The executor a stored row describes. A row naming both is refused by a CHECK. */
export function taskExecutor(r: Pick<TaskResponsibility, 'assigneeId' | 'executorAssistantId'>): TaskExecutor {
  if (r.assigneeId && r.executorAssistantId) throw new TaskResponsibilityError('task_executor_conflict')
  if (r.assigneeId) return { kind: 'person', memberId: r.assigneeId }
  if (r.executorAssistantId) return { kind: 'assistant', assistantId: r.executorAssistantId }
  return { kind: 'unassigned' }
}

/**
 * Fold a patch over the current responsibility. The executor is one slot, so
 * naming a person clears an assistant executor and the reverse; naming both
 * in one patch is a conflict, not a tie to break. Contact and home changes
 * never touch the executor.
 */
export function applyResponsibilityPatch(current: TaskResponsibility, patch: TaskResponsibilityPatch): TaskResponsibility {
  if (patch.assigneeId && patch.executorAssistantId) throw new TaskResponsibilityError('task_executor_conflict')
  if (patch.home !== undefined && patch.home !== null) {
    if (!TASK_HOME_KINDS.includes(patch.home.kind) || !patch.home.id) throw new TaskResponsibilityError('task_home_invalid')
  }
  let assigneeId = current.assigneeId
  let executorAssistantId = current.executorAssistantId
  if (patch.assigneeId !== undefined) {
    assigneeId = patch.assigneeId
    if (patch.assigneeId) executorAssistantId = null
  }
  if (patch.executorAssistantId !== undefined) {
    executorAssistantId = patch.executorAssistantId
    if (patch.executorAssistantId) assigneeId = null
  }
  return {
    assigneeId,
    executorAssistantId,
    followUpMemberId: patch.followUpMemberId !== undefined ? patch.followUpMemberId : current.followUpMemberId,
    home: patch.home !== undefined ? patch.home : current.home,
  }
}

/**
 * The guarded-claim precondition shared by the claim route and
 * `updateTask({ if_unassigned })`: an unassigned task takes the wanted
 * executor, the same executor again is an idempotent `'noop'`, anyone else
 * already holding it is `task_already_claimed`.
 */
export function claimPrecondition(wanted: { assigneeId?: string | null; executorAssistantId?: string | null }) {
  return (current: Pick<TaskResponsibility, 'assigneeId' | 'executorAssistantId'>): void | 'noop' => {
    if (!current.assigneeId && !current.executorAssistantId) return
    const same = wanted.assigneeId ? current.assigneeId === wanted.assigneeId
      : !!wanted.executorAssistantId && current.executorAssistantId === wanted.executorAssistantId
    if (same) return 'noop'
    throw new TaskResponsibilityError('task_already_claimed', 'Someone already took this task.')
  }
}

/** True when the patch changes who executes the task. */
export function executorChanged(before: TaskResponsibility, after: TaskResponsibility): boolean {
  return before.assigneeId !== after.assigneeId || before.executorAssistantId !== after.executorAssistantId
}

/**
 * Where a task's human attention goes, resolved against CURRENT ownership.
 * `homeOwnerUserIds` is the live owner set of the task's home (Department
 * owners or shared-Project owners), or `null` when the home is unknown or its
 * owners could not be established.
 */
export type TaskFollowUp =
  | { source: 'explicit'; memberId: string }
  | { source: 'executor'; memberId: string }
  | { source: 'home_owners'; home: TaskHome; ownerUserIds: string[] }
  | { source: 'missing_routing'; reason: 'no_home' | 'no_eligible_owner' }
  | { source: 'owner_queue'; home: TaskHome; ownerUserIds: string[] }
  | { source: 'none' }

export function resolveTaskFollowUp(r: TaskResponsibility, homeOwnerUserIds: readonly string[] | null): TaskFollowUp {
  if (r.followUpMemberId) return { source: 'explicit', memberId: r.followUpMemberId }
  const executor = taskExecutor(r)
  if (executor.kind === 'person') return { source: 'executor', memberId: executor.memberId }
  if (executor.kind === 'unassigned') {
    // Unassigned Department work waits in its owners' assignment queue; any
    // other unassigned work has no one to nudge and is not invented one.
    if (r.home?.kind === 'department' && homeOwnerUserIds && homeOwnerUserIds.length > 0) {
      return { source: 'owner_queue', home: r.home, ownerUserIds: [...homeOwnerUserIds] }
    }
    return { source: 'none' }
  }
  if (!r.home) return { source: 'missing_routing', reason: 'no_home' }
  if (!homeOwnerUserIds || homeOwnerUserIds.length === 0) return { source: 'missing_routing', reason: 'no_eligible_owner' }
  return { source: 'home_owners', home: r.home, ownerUserIds: [...homeOwnerUserIds] }
}

/** Who is looking: their user id and their `workspace_members` row id. */
export type WorkViewer = { userId: string; memberId: string }

export type WorkSection = 'needs_you' | 'my_work' | 'needs_assignment'
export type WorkReason =
  | 'blocked'
  | 'in_review'
  | 'overdue'
  | 'question'
  | 'missing_routing'
  | 'assigned_to_you'
  | 'follow_up'
  | 'unassigned'
export type WorkNextAction = 'assign' | 'answer' | 'review' | 'unblock' | 'select_follow_up' | 'open'

export type WorkClassification = { section: WorkSection; reasons: WorkReason[]; nextAction: WorkNextAction }

export type ClassifiableTask = TaskResponsibility & {
  status: string
  due: Date | null
  /** Hosted Goals awaiting a human approval the viewer can see (one approval, one item). */
  openQuestions: number
  /** A hosted Goal the viewer can see is blocked and needs a human. */
  goalBlocked: boolean
  /** The user that created the task (only used to offer a routing choice). */
  createdByUserId: string | null
}

/**
 * Place one task the viewer can already SEE into at most one work section.
 * Visibility is the caller's job (RLS + the access predicate); this function
 * only decides whether the viewer is the right human for it, so attention
 * never widens access. Returns null when the task is not the viewer's work.
 */
export function classifyTaskForViewer(
  task: ClassifiableTask,
  viewer: WorkViewer,
  homeOwnerUserIds: readonly string[] | null,
  now: Date,
): WorkClassification | null {
  if (!(OPEN_TASK_STATUSES as readonly string[]).includes(task.status)) return null
  const followUp = resolveTaskFollowUp(task, homeOwnerUserIds)
  const executor = taskExecutor(task)

  if (followUp.source === 'owner_queue') {
    return followUp.ownerUserIds.includes(viewer.userId)
      ? { section: 'needs_assignment', reasons: ['unassigned'], nextAction: 'assign' }
      : null
  }
  if (followUp.source === 'missing_routing') {
    // No eligible human: offer an explicit selection to whoever put the work
    // in motion. Display only; nobody is assigned by seeing it.
    return task.createdByUserId === viewer.userId
      ? { section: 'needs_you', reasons: ['missing_routing'], nextAction: 'select_follow_up' }
      : null
  }

  const mine =
    (followUp.source === 'explicit' && followUp.memberId === viewer.memberId) ||
    (followUp.source === 'executor' && followUp.memberId === viewer.memberId) ||
    (followUp.source === 'home_owners' && followUp.ownerUserIds.includes(viewer.userId)) ||
    // A person executing the work sees it even with a separate contact.
    (executor.kind === 'person' && executor.memberId === viewer.memberId)
  if (!mine) return null

  const reasons: WorkReason[] = []
  if (task.openQuestions > 0) reasons.push('question')
  if (task.status === 'blocked' || task.goalBlocked) reasons.push('blocked')
  if (task.status === 'in_review') reasons.push('in_review')
  if (task.due && task.due.getTime() < now.getTime()) reasons.push('overdue')
  const base: WorkReason = executor.kind === 'person' && executor.memberId === viewer.memberId ? 'assigned_to_you' : 'follow_up'
  if (reasons.length === 0) return { section: 'my_work', reasons: [base], nextAction: 'open' }
  const nextAction: WorkNextAction = reasons.includes('question') ? 'answer'
    : reasons.includes('blocked') ? 'unblock'
    : reasons.includes('in_review') ? 'review'
    : 'open'
  return { section: 'needs_you', reasons: [...reasons, base], nextAction }
}
