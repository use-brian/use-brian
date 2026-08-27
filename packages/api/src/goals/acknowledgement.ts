/**
 * Structural goal-acceptance receipt shared by web chat and messaging
 * channels. The model never sees ToolResult.meta, so this signal cannot be
 * fabricated in assistant prose.
 *
 * [COMP:goals/acknowledgement]
 */
import type { ContentBlock, ToolResultMeta } from '@use-brian/core'

export const GOAL_ACCEPTED_CHANNEL_MESSAGE =
  'Goal accepted. Execution has started in Autopilot.'

const GOAL_EVENT_KEY = 'goal_event'
const GOAL_ID_KEY = 'goal_id'
const GOAL_ACCEPTED_EVENT = 'accepted'

export function goalAcceptedMeta(goalId: string): ToolResultMeta {
  return {
    [GOAL_EVENT_KEY]: GOAL_ACCEPTED_EVENT,
    [GOAL_ID_KEY]: goalId,
  }
}

/** Return each successfully armed goal once, in result order. */
export function acceptedGoalIdsFromToolResults(
  results: ContentBlock[],
  metaByToolUseId: Record<string, ToolResultMeta> | undefined,
): string[] {
  const seen = new Set<string>()
  const accepted: string[] = []

  for (const block of results) {
    if (
      block.type !== 'tool_result' ||
      block.name !== 'workTask' ||
      block.isError === true
    ) continue

    const meta = metaByToolUseId?.[block.toolUseId]
    const goalId = meta?.[GOAL_ID_KEY]
    if (
      meta?.[GOAL_EVENT_KEY] !== GOAL_ACCEPTED_EVENT ||
      typeof goalId !== 'string' ||
      goalId.length === 0 ||
      seen.has(goalId)
    ) continue

    seen.add(goalId)
    accepted.push(goalId)
  }

  return accepted
}
