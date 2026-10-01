import type { GoalBrief } from '@use-brian/core'
import { captureTaskGoalSource, taskGoalProducerInput, executeTaskGoalProducer } from '../workspace-access/goal-source-admission.js'
import { createGoal } from './goals.js'

/** Actual executing actor is a required per-call argument, never task.createdBy.
 * Producer runs without a checked-out connection; insertion rechecks its exact
 * canonical input and saved authority under the workspace-first barrier. */
export async function produceTaskGoalDraft(
  input: Parameters<typeof captureTaskGoalSource>[0],
  judge: (task: ReturnType<typeof taskGoalProducerInput>) => Promise<(GoalBrief & { outcome: string }) | null>,
) {
  const source = await captureTaskGoalSource(input)
  const brief = await executeTaskGoalProducer(source, judge)
  if (!brief) return null
  return createGoal({ workspaceId: input.workspaceId, createdByUserId: input.userId,
    host: { type: 'task', id: input.taskId }, outcome: brief.outcome,
    doneWhen: { kind: 'query', query: { description: 'task complete', predicate: { hostTaskDone: true } } },
    means: {}, confirmed: false,
    brief: { verification: brief.verification, approach: brief.approach, judgeReason: brief.judgeReason },
  }, undefined, source)
}
