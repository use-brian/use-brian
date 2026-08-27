/**
 * [COMP:goals/acknowledgement] Structural acceptance receipts.
 */
import { describe, expect, it } from 'vitest'
import type { ContentBlock, ToolResultMeta } from '@use-brian/core'
import {
  acceptedGoalIdsFromToolResults,
  goalAcceptedMeta,
  GOAL_ACCEPTED_CHANNEL_MESSAGE,
} from '../acknowledgement.js'

function result(
  overrides: Partial<Extract<ContentBlock, { type: 'tool_result' }>> = {},
): ContentBlock {
  return {
    type: 'tool_result',
    toolUseId: 'tool-1',
    name: 'workTask',
    content: 'started',
    ...overrides,
  }
}

describe('[COMP:goals/acknowledgement] goal acceptance receipt', () => {
  it('recognises only a successful workTask result carrying trusted metadata', () => {
    const meta: Record<string, ToolResultMeta> = {
      'tool-1': goalAcceptedMeta('goal-1'),
    }
    expect(acceptedGoalIdsFromToolResults([result()], meta)).toEqual(['goal-1'])
    expect(
      acceptedGoalIdsFromToolResults(
        [result({ name: 'setGoal' }), result({ toolUseId: 'tool-2', isError: true })],
        { ...meta, 'tool-2': goalAcceptedMeta('goal-2') },
      ),
    ).toEqual([])
    expect(acceptedGoalIdsFromToolResults([result()], undefined)).toEqual([])
  })

  it('de-duplicates repeated result blocks for the same goal', () => {
    expect(
      acceptedGoalIdsFromToolResults(
        [result(), result({ toolUseId: 'tool-2' })],
        {
          'tool-1': goalAcceptedMeta('goal-1'),
          'tool-2': goalAcceptedMeta('goal-1'),
        },
      ),
    ).toEqual(['goal-1'])
  })

  it('keeps channel copy concise and explicit about execution', () => {
    expect(GOAL_ACCEPTED_CHANNEL_MESSAGE).toBe(
      'Goal accepted. Execution has started in Autopilot.',
    )
  })
})
