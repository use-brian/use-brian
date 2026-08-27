/** [COMP:goals/live-activity] Safe normal-event projection for goal SSE. */
import { describe, expect, it } from 'vitest'
import type { QueryEvent } from '@use-brian/core'
import {
  compactGoalActivityEnvelope,
  goalActivityFramesFromQueryEvent,
  goalOwnsWorkflowRun,
} from '../activity.js'

describe('[COMP:goals/live-activity] activity projection', () => {
  it('relays reasoning and tool lifecycle events using normal chat SSE names', () => {
    expect(goalActivityFramesFromQueryEvent({
      type: 'thinking_delta',
      text: 'Checking the profile requirements',
    })).toEqual([{
      event: 'reasoning',
      data: { text: 'Checking the profile requirements' },
    }])

    expect(goalActivityFramesFromQueryEvent({
      type: 'tool_input',
      id: 'tool-1',
      name: 'webSearch',
      input: { query: 'profile requirements' },
    })).toEqual([{
      event: 'tool_input',
      data: { id: 'tool-1', name: 'webSearch', input: { query: 'profile requirements' } },
    }])

    expect(goalActivityFramesFromQueryEvent({
      type: 'tool_result',
      id: '',
      results: [{
        type: 'tool_result',
        toolUseId: 'tool-1',
        name: 'webSearch',
        content: 'network failed with a long diagnostic',
        isError: true,
      }],
    })).toEqual([{
      event: 'tool_result',
      data: {
        id: 'tool-1',
        name: 'webSearch',
        isError: true,
        errorMessage: 'network failed with a long diagnostic',
      },
    }])
  })

  it('never relays unattended text deltas as a user reply', () => {
    const event: QueryEvent = { type: 'text_delta', text: 'I should inspect this first' }
    expect(goalActivityFramesFromQueryEvent(event)).toEqual([])
  })

  it('drops oversized tool input while preserving its identity', () => {
    expect(compactGoalActivityEnvelope({
      goalId: 'goal-1',
      event: 'tool_input',
      data: { id: 'tool-1', name: 'renderPage', input: { body: 'x'.repeat(10_000) } },
    })).toEqual({
      goalId: 'goal-1',
      event: 'tool_input',
      data: { id: 'tool-1', name: 'renderPage', input: {} },
    })
  })

  it('caps multibyte reasoning using the PostgreSQL byte limit', () => {
    const compacted = compactGoalActivityEnvelope({
      goalId: 'goal-1',
      event: 'reasoning',
      data: { text: '🧠'.repeat(2_000) },
    })

    expect(Buffer.byteLength(JSON.stringify(compacted), 'utf8')).toBeLessThanOrEqual(5_000)
  })

  it('trusts goal activity correlation only after durable workspace and workflow checks', () => {
    const goal = {
      workspaceId: 'workspace-1',
      means: { workflowId: 'workflow-1' },
      confirmedAt: new Date(),
    }

    expect(goalOwnsWorkflowRun(goal, {
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
    })).toBe(true)
    expect(goalOwnsWorkflowRun(goal, {
      workspaceId: 'workspace-2',
      workflowId: 'workflow-1',
    })).toBe(false)
    expect(goalOwnsWorkflowRun(goal, {
      workspaceId: 'workspace-1',
      workflowId: 'workflow-2',
    })).toBe(false)
    expect(goalOwnsWorkflowRun({ ...goal, confirmedAt: null }, {
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
    })).toBe(false)
  })
})
