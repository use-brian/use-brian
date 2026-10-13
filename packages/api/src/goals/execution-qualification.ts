/**
 * Execution qualification and automatic entry.
 *
 * Qualification grounds a plan for an assistant-executed task in the original
 * request, the accepted Brief direction, the parent mandate and authorized
 * supporting material, then computes readiness against the SELECTED
 * assistant's actual runtime manifest (never connector labels, workflow-id
 * existence or confident wording).
 *
 * Automatic entry arms a ready plan through the canonical Goal path, once per
 * target, and only from trusted human-assignment provenance captured at an
 * authenticated command boundary. A candidate, a prose mention, an extracted
 * task or a model/MCP write carries no provenance and stays unarmed. Entry
 * never substitutes another assistant and never falls back to the creator's
 * primary.
 *
 * Spec: docs/architecture/features/goals.md -> "Formation, readiness and automatic entry".
 * [COMP:goals/execution-qualification]
 */
import {
  assessExecutionReadiness,
  isTrustedProvenance,
  type AuthoringAuthority,
  type ExecutionDependency,
  type ExecutionPlan,
  type ExecutionPlanDraft,
  type ExecutionProvenance,
  type ExecutionSourceRef,
  type ExecutorManifest,
  type GoalClarityAssessor,
  type GoalDefaultBudget,
  type GoalRecord,
  type TaskRecord,
} from '@use-brian/core'
import { inspectBrief } from '../briefs/service.js'
import { queryWithRLS } from '../db/client.js'
import {
  bindExecutionGoalSystem,
  createRootExecution,
  findActiveNativeExecutionSystem,
  findExecutionsWaitingOnSystem,
  getPoolSystem,
  setExecutionPhaseSystem,
  type ExecutionState,
} from '../db/task-execution-store.js'

export type QualifyTask = Pick<TaskRecord, 'id' | 'workspaceId' | 'title' | 'attributes' | 'executorAssistantId' | 'parentId' | 'home'>

export type GroundedSources = {
  /** Every source actually read, with the version read. */
  sources: ExecutionSourceRef[]
  /** Sources wanted but unreadable by the actor/assistant (labels only). */
  inaccessible: string[]
  /** Plain context handed to the planner (request, Brief direction, parent mandate). */
  context: string
  /** True when the request carries nothing beyond a name. */
  sparse: boolean
  dependencies: ExecutionDependency[]
}

export type QualificationDeps = {
  /** The selected executor is still usable by the acting user. Never substitutes. */
  executorUsable: (actorUserId: string, workspaceId: string, assistantId: string) => Promise<boolean>
  /** The selected assistant's actual runtime manifest, or null when unknown. */
  manifest: (assistantId: string, workspaceId: string, actorUserId: string) => Promise<ExecutorManifest | null>
  readSources: (actorUserId: string, task: QualifyTask) => Promise<GroundedSources>
  /** Plan proposer (a model in production, a fake in tests). null = no plan. */
  planner: (input: { task: QualifyTask; context: string; executorAssistantId: string; manifestTools: string[]; actorUserId: string }) => Promise<ExecutionPlanDraft | null>
  /** Optional §12 clarity gate over the planned outcome. */
  assessClarity?: GoalClarityAssessor
}

export type Qualification =
  | { kind: 'not_assistant_work' }
  | { kind: 'qualified'; executorAssistantId: string; plan: ExecutionPlan }

const EMPTY_DRAFT = (task: QualifyTask): ExecutionPlanDraft => ({
  outcome: task.title, constraints: [], steps: [], completionEvidence: [], requiredOperations: [], requiredAccounts: [],
  requiredInputs: [], questions: [],
})

/** Ground, plan and assess one assistant-executed task. Human or unassigned
 *  work returns `not_assistant_work` without reading or planning anything. */
export async function qualifyTaskExecution(task: QualifyTask, actorUserId: string, deps: QualificationDeps): Promise<Qualification> {
  const executor = task.executorAssistantId
  if (!executor) return { kind: 'not_assistant_work' }
  const usable = await deps.executorUsable(actorUserId, task.workspaceId, executor)
  const manifest = usable ? await deps.manifest(executor, task.workspaceId, actorUserId) : null
  const grounded = await deps.readSources(actorUserId, task)
  const draft = (manifest
    ? await deps.planner({ task, context: grounded.context, executorAssistantId: executor, manifestTools: [...manifest.tools].sort(), actorUserId })
    : null) ?? EMPTY_DRAFT(task)
  if (manifest && deps.assessClarity && draft.outcome) {
    const verdict = await deps.assessClarity({ outcome: draft.outcome, verification: draft.completionEvidence.join('; '),
      approach: draft.steps.map(s => s.title).join('; '), userId: actorUserId, workspaceId: task.workspaceId, assistantId: executor })
    if (!verdict.clear && verdict.clarifyingQuestion) draft.questions = [...draft.questions, verdict.clarifyingQuestion]
  }
  const readiness = assessExecutionReadiness({
    plan: draft, manifest, inaccessibleSources: grounded.inaccessible, dependencies: grounded.dependencies, contextSparse: grounded.sparse,
  })
  const nextStep = readiness.state === 'ready' ? draft.steps[0]?.title ?? null : readiness.reasons[0]?.subject ?? null
  return {
    kind: 'qualified', executorAssistantId: executor,
    plan: { ...draft, sourceBasis: grounded.sources, dependencies: grounded.dependencies, nextStep, readiness },
  }
}

export type EntryDeps = QualificationDeps & {
  /** Canonical authoring envelope for the assigning human + selected assistant. */
  captureAuthority: (input: { userId: string; workspaceId: string; assistantId: string }) => Promise<AuthoringAuthority>
  defaultBudget: (workspaceId: string) => Promise<GoalDefaultBudget>
  /** The canonical Goal path: confirm an existing draft for the task, or create one. */
  armGoal: (input: {
    task: QualifyTask; plan: ExecutionPlan; authority: AuthoringAuthority; createdByUserId: string; budget: GoalDefaultBudget
  }) => Promise<GoalRecord>
  kickoffGoal: (goalId: string) => Promise<void>
}

export type EntryResult =
  | { kind: 'not_entered'; reason: 'not_assistant_work' | 'authority_unproven' }
  | { kind: 'duplicate'; state: ExecutionState }
  | { kind: 'entered'; state: ExecutionState; goalId: string | null; readiness: ExecutionPlan['readiness'] }

const PHASE_FOR = { ready: 'ready', waiting: 'waiting', uncertain: 'planning', unavailable: 'blocked' } as const

/**
 * Enter an actually assigned task. Ready work is armed once through the
 * canonical Goal path; anything else is recorded with its plan and the
 * smallest missing thing, unarmed, so the workbench can ask. A duplicate event
 * finds the active state and writes nothing.
 */
export async function enterAssignedExecution(task: QualifyTask, provenance: ExecutionProvenance | null, deps: EntryDeps): Promise<EntryResult> {
  if (!task.executorAssistantId) return { kind: 'not_entered', reason: 'not_assistant_work' }
  if (!isTrustedProvenance(provenance)) return { kind: 'not_entered', reason: 'authority_unproven' }
  const existing = await findActiveNativeExecutionSystem({ taskId: task.id })
  if (existing) return { kind: 'duplicate', state: existing }

  const q = await qualifyTaskExecution(task, provenance.actorUserId, deps)
  if (q.kind !== 'qualified') return { kind: 'not_entered', reason: 'not_assistant_work' }
  const budget = await deps.defaultBudget(task.workspaceId)
  const readiness = q.plan.readiness
  const { state, created } = await createRootExecution({
    workspaceId: task.workspaceId, taskId: task.id, goalId: null,
    executor: { kind: 'assistant', id: q.executorAssistantId },
    phase: PHASE_FOR[readiness.state],
    plan: q.plan, sourceRefs: q.plan.sourceBasis,
    authoringRef: { ...provenance },
    blocker: readiness.state === 'unavailable' && readiness.reasons[0]
      ? { reason: readiness.reasons[0].kind, detail: readiness.reasons[0].subject } : null,
    budget: { maxSpend: budget.maxSpend, maxIterations: budget.maxIterations },
    enter: { idempotencyKey: `enter:${task.id}:${provenance.at}`,
      actor: { kind: 'user', id: provenance.actorUserId, origin: 'assignment', humanOrigin: true },
      payload: { readiness: readiness.state } },
  })
  if (!created) return { kind: 'duplicate', state }
  if (readiness.state !== 'ready') return { kind: 'entered', state, goalId: null, readiness }

  return armReadyExecution(state, task, q.plan, provenance, q.executorAssistantId, budget, deps)
}

/** Arm a ready execution through the canonical goal path, or record honestly
 *  why it could not be armed. Shared by entry and dependency wake. */
async function armReadyExecution(state: ExecutionState, task: QualifyTask, plan: ExecutionPlan, provenance: ExecutionProvenance,
  executorAssistantId: string, budget: GoalDefaultBudget, deps: EntryDeps): Promise<EntryResult> {
  try {
    const authority = await deps.captureAuthority({ userId: provenance.actorUserId, workspaceId: task.workspaceId, assistantId: executorAssistantId })
    const goal = await deps.armGoal({ task, plan, authority, createdByUserId: provenance.actorUserId, budget })
    const bound = (await bindExecutionGoalSystem(state.id, goal.id)) ?? state
    await deps.kickoffGoal(goal.id)
    return { kind: 'entered', state: bound, goalId: goal.id, readiness: plan.readiness }
  } catch (error) {
    // Authority or arming failed: record it honestly instead of a fresh lease.
    console.error('[execution] could not arm the goal:', error)
    const blocked = await setExecutionPhaseSystem(state.id, 'blocked', { blocker: { reason: 'authority_unproven', detail: 'reauthorize' } })
    return { kind: 'entered', state: blocked ?? state, goalId: null, readiness: plan.readiness }
  }
}

/**
 * Dependency wake (R06): a prerequisite that actually completed revalidates
 * the unarmed work waiting on it, under the provenance captured at entry.
 * Unrelated closes match nothing; a cancelled or unreadable prerequisite
 * re-qualifies as still waiting; a cycle never completes, so it never wakes.
 * Nothing here polls: the wake is the close event.
 */
export async function revalidateWaitingExecutions(closedTaskId: string, deps: EntryDeps & {
  loadTask: (taskId: string) => Promise<QualifyTask | null>
}): Promise<EntryResult[]> {
  const out: EntryResult[] = []
  for (const state of await findExecutionsWaitingOnSystem(closedTaskId)) {
    const provenance = isTrustedProvenance(state.authoringRef) ? state.authoringRef : null
    const task = state.taskId ? await deps.loadTask(state.taskId) : null
    if (!provenance || !task || task.executorAssistantId !== state.executor?.id) continue
    const q = await qualifyTaskExecution(task, provenance.actorUserId, deps)
    if (q.kind !== 'qualified') continue
    const readiness = q.plan.readiness
    if (readiness.state !== 'ready') {
      const updated = await setExecutionPhaseSystem(state.id, PHASE_FOR[readiness.state], {
        plan: q.plan, sourceRefs: q.plan.sourceBasis,
        blocker: readiness.state === 'unavailable' && readiness.reasons[0] ? { reason: readiness.reasons[0].kind, detail: readiness.reasons[0].subject } : null,
      })
      out.push({ kind: 'entered', state: updated ?? state, goalId: null, readiness })
      continue
    }
    await setExecutionPhaseSystem(state.id, 'ready', { plan: q.plan, sourceRefs: q.plan.sourceBasis })
    const pool = await getPoolSystem(state.poolId)
    const budget = { maxSpend: pool?.maxSpend ?? 5, maxIterations: pool?.maxIterations ?? 30 }
    out.push(await armReadyExecution(state, task, q.plan, provenance, q.executorAssistantId, budget, deps))
  }
  return out
}

/** The task-specific acceptance the planner chose, carried into the Goal brief
 *  so the iteration knows what it must produce and check. */
export function briefFromPlan(plan: ExecutionPlan): { verification: string; approach: string; judgeReason: string } {
  return {
    verification: plan.completionEvidence.join('\n'),
    approach: plan.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.contribution}`).join('\n'),
    judgeReason: 'Assigned to this assistant and qualified against its current tools and sources.',
  }
}

type DependencyRow = { target: string; status: string | null; executor: string | null; assignee: string | null }

/**
 * Production grounding: everything is read AS the acting user (RLS), so an
 * unreadable parent, Brief or prerequisite is reported as such and never fed
 * to the planner. Prerequisites come from the task lineage's live `depends_on`
 * edges; a prerequisite the actor cannot see is `missing`, never done.
 */
export async function readExecutionSources(actorUserId: string, task: QualifyTask): Promise<GroundedSources> {
  const sources: ExecutionSourceRef[] = [{ kind: 'task', id: task.id, label: task.title }]
  const inaccessible: string[] = []
  const lines: string[] = [`Request: ${task.title}`]
  const attrs = Object.entries(task.attributes ?? {}).filter(([, v]) => v !== null && v !== '')
  if (attrs.length > 0) lines.push(`Details: ${JSON.stringify(Object.fromEntries(attrs))}`)

  if (task.parentId) {
    const parent = await queryWithRLS<{ title: string; updated_at: Date }>(actorUserId,
      `SELECT title, updated_at FROM tasks WHERE id = $1 AND valid_to IS NULL AND retracted_at IS NULL`, [task.parentId])
    if (parent.rows[0]) {
      sources.push({ kind: 'parent_task', id: task.parentId, version: parent.rows[0].updated_at.toISOString(), label: parent.rows[0].title })
      lines.push(`Parent mandate: ${parent.rows[0].title}`)
    } else inaccessible.push(`parent_task:${task.parentId}`)
  }

  if (task.home) {
    try {
      const brief = await inspectBrief({ userId: actorUserId, workspaceId: task.workspaceId, assistantId: task.executorAssistantId ?? null },
        { owner: { kind: task.home.kind, id: task.home.id } })
      if (brief.established && brief.direction) {
        sources.push({ kind: 'brief', id: brief.binding.id, version: String(brief.binding.directionRevision), label: brief.title ?? undefined })
        for (const [section, items] of Object.entries(brief.direction)) {
          if (items.length > 0) lines.push(`Accepted ${section}: ${items.join('; ')}`)
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'brief_not_found') inaccessible.push(`brief:${task.home.kind}:${task.home.id}`)
    }
  }

  const deps = await queryWithRLS<DependencyRow>(actorUserId,
    `WITH RECURSIVE lineage AS (
       SELECT id, superseded_by FROM tasks WHERE id = $1
       UNION SELECT t.id, t.superseded_by FROM tasks t JOIN lineage l ON t.superseded_by = l.id)
     SELECT DISTINCT ON (e.target_id) e.target_id AS target, live.status, live.executor_assistant_id::text AS executor, live.assignee_id::text AS assignee
       FROM entity_links e
       LEFT JOIN LATERAL (
         WITH RECURSIVE chain AS (
           SELECT id, superseded_by, valid_to, status, executor_assistant_id, assignee_id, retracted_at FROM tasks WHERE id = e.target_id
           UNION ALL SELECT t.id, t.superseded_by, t.valid_to, t.status, t.executor_assistant_id, t.assignee_id, t.retracted_at
             FROM tasks t JOIN chain c ON t.id = c.superseded_by)
         SELECT status, executor_assistant_id, assignee_id FROM chain WHERE valid_to IS NULL AND retracted_at IS NULL LIMIT 1) live ON true
      WHERE e.source_kind = 'task' AND e.edge_type = 'depends_on' AND e.valid_to IS NULL AND e.retracted_at IS NULL
        AND e.source_id IN (SELECT id FROM lineage)`, [task.id])
  const dependencies: ExecutionDependency[] = deps.rows.map(r => ({
    taskId: r.target,
    status: r.status === null ? 'missing' : r.status === 'done' ? 'done' : r.status === 'archived' ? 'cancelled' : 'open',
    owner: r.executor ? 'assistant' : r.assignee ? 'person' : 'unassigned',
  }))
  const substantive = attrs.length > 0 || sources.some(s => s.kind !== 'task') || task.title.trim().split(/\s+/).length >= 4
  return { sources, inaccessible, context: lines.join('\n'), sparse: !substantive, dependencies }
}
