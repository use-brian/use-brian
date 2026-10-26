import type { GoalBrief, GoalStore, TaskRecord, SessionContextAuthority } from '@use-brian/core'
import { getWorkspaceAccessMode } from '../workspace-access/mode-policy.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import {assertTaskGoalSourceCompatible} from '../workspace-access/goal-source-admission.js'
import { produceTaskGoalDraft } from './goal-task-producer.js'

type TriageBrief = GoalBrief & { outcome: string }
export type TaskGoalTriageDeps = {
  goalStore: Pick<GoalStore, 'create'>
  /**
   * Confirm the task's selected executor assistant is usable by the acting
   * user and return it; `undefined` when it is not. Never substitutes another
   * assistant (the creator's primary is not an executor by inference).
   */
  resolveAssistantId: (userId: string, workspaceId: string, executorAssistantId: string) => Promise<string | undefined>
  /** Fixed public server-authored descriptions only: no connector metadata. */
  publicCoreCapabilities: readonly string[]
  /** Legacy only. System connector reads are not proof of ready source scope. */
  summariseCapabilities: (userId: string, workspaceId: string) => Promise<string[]>
  judge: (input: {
    title: string; description: string | null; capabilities: string[]
    userId: string; workspaceId: string; assistantId?: string
  }) => Promise<TriageBrief | null>
}

/** Executor gate (tasks.md -> "Responsibility"; goals.md -> "Executor-gated
 * triage"): automatic formation runs only for a task whose executor is a
 * selected assistant, and drafts for THAT assistant. A human-executed or
 * unassigned task returns null without a judge call; explicit help the user
 * asks for (confirmGoal / workTask) is a separate, unchanged path.
 *
 * The onTaskCreate actor is the executing create user, never historical
 * task authorship. Mode selection is a member-scoped projection only; the
 * selected writer rechecks policy in its insertion transaction. In particular,
 * a ready proof cannot downgrade to legacy and legacy cannot bypass activation.
 * There is deliberately no catch-and-fallback between the two branches. */
export async function triageTaskForGoal(
  task: Pick<TaskRecord, 'id' | 'workspaceId' | 'title' | 'attributes' | 'executorAssistantId'>,
  userId: string,
  deps: TaskGoalTriageDeps,
  authority?: SessionContextAuthority,
) {
  const executor = task.executorAssistantId
  if (!executor) return null
  if(!authority)await assertTaskGoalSourceCompatible(task.workspaceId,task.id)
  const { setupState } = await getWorkspaceAccessMode(task.workspaceId, userId)
  if (setupState !== 'legacy' && setupState !== 'ready') {
    throw new WorkspaceAccessError('access_mode_setup_required', 409)
  }
  if (setupState === 'ready') {
    const assistantId = await deps.resolveAssistantId(userId, task.workspaceId, executor)
    if (!assistantId) throw new WorkspaceAccessError('goal_source_unsupported', 409)
    return produceTaskGoalDraft({ userId, workspaceId: task.workspaceId, assistantId, taskId: task.id, authority }, async canonical => {
      // Dynamic connector labels may carry private/confidential/cross-scope
      // data even while the task producer's runtime is clipped. Never read them.
      const capabilities = [...deps.publicCoreCapabilities]
      return deps.judge({ title: canonical.title,
        description: Object.keys(canonical.attributes ?? {}).length > 0 ? JSON.stringify(canonical.attributes) : null,
        capabilities, userId, workspaceId: task.workspaceId, assistantId })
    })
  }

  // Preserve the pre-admission legacy producer, including optional assistant,
  // original task input, and unconfirmed goalStore.create without fresh proof.
  const capabilities = await deps.summariseCapabilities(userId, task.workspaceId)
  const attrs = Object.keys(task.attributes ?? {}).length > 0 ? JSON.stringify(task.attributes) : null
  const assistantId = await deps.resolveAssistantId(userId, task.workspaceId, executor)
  if (!assistantId) return null
  const brief = await deps.judge({ title: task.title, description: attrs, capabilities,
    userId, workspaceId: task.workspaceId, assistantId })
  if (!brief) return null
  return deps.goalStore.create({ workspaceId: task.workspaceId,
    host: { type: 'task', id: task.id }, outcome: brief.outcome,
    doneWhen: { kind: 'query', query: { description: 'task complete', predicate: { hostTaskDone: true } } },
    means: {}, confirmed: false, createdByUserId: userId,
    brief: { verification: brief.verification, approach: brief.approach, judgeReason: brief.judgeReason },
  })
}
