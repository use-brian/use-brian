/**
 * Goal execution activity contract.
 *
 * The acting loop runs outside the interactive chat request, but its inner
 * callee still produces the same query-loop events as a normal turn. This
 * module projects only the display-safe live activity lane onto the normal
 * web SSE names. In particular, `text_delta` is deliberately excluded: an
 * unattended turn that also calls tools is mid-reasoning, not a user reply.
 *
 * [COMP:goals/live-activity]
 */
import type { GoalRecord, QueryEvent, WorkflowRunRecord } from '@use-brian/core'

export type GoalActivityEventName =
  | 'status'
  | 'reasoning'
  | 'tool_start'
  | 'tool_input'
  | 'tool_result'
  | 'tool_dropped'
  | 'done'

export type GoalActivityFrame = {
  event: GoalActivityEventName
  data: Record<string, unknown>
}

export type GoalActivityEnvelope = GoalActivityFrame & {
  goalId: string
  /** Process-local marker used to suppress the publisher's NOTIFY echo. */
  origin?: string
}

const MAX_FRAME_BYTES = 5_000

/** A run input is user-authored; durable workspace/workflow ownership is the relay gate. */
export function goalOwnsWorkflowRun(
  goal: Pick<GoalRecord, 'workspaceId' | 'means' | 'confirmedAt'> | null,
  run: Pick<WorkflowRunRecord, 'workspaceId' | 'workflowId'>,
): boolean {
  return Boolean(
    goal?.confirmedAt
    && goal.workspaceId === run.workspaceId
    && goal.means.workflowId === run.workflowId,
  )
}

export function goalActivityFramesFromQueryEvent(event: QueryEvent): GoalActivityFrame[] {
  switch (event.type) {
    case 'thinking_delta':
      return [{ event: 'reasoning', data: { text: event.text } }]
    case 'tool_start':
      return [{ event: 'tool_start', data: { id: event.id, name: event.name } }]
    case 'tool_input':
      return [{ event: 'tool_input', data: { id: event.id, name: event.name, input: event.input } }]
    case 'tool_result':
      return event.results.flatMap((block) => {
        if (block.type !== 'tool_result') return []
        return [{
          event: 'tool_result' as const,
          data: {
            id: block.toolUseId,
            name: block.name,
            isError: block.isError ?? false,
            ...(block.isError
              ? { errorMessage: block.content.replace(/\s+/g, ' ').trim().slice(0, 240) }
              : {}),
          },
        }]
      })
    case 'tool_dropped':
      return [{ event: 'tool_dropped', data: { id: event.id } }]
    default:
      return []
  }
}

/** Keep PostgreSQL NOTIFY frames below its hard payload ceiling. */
export function compactGoalActivityEnvelope(
  envelope: GoalActivityEnvelope,
): GoalActivityEnvelope {
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= MAX_FRAME_BYTES) return envelope
  if (envelope.event === 'tool_input') {
    return { ...envelope, data: { ...envelope.data, input: {} } }
  }
  if (envelope.event === 'reasoning') {
    const text = typeof envelope.data.text === 'string'
      ? envelope.data.text.slice(-1_000)
      : ''
    return { ...envelope, data: { text } }
  }
  return { ...envelope, data: {} }
}

export function isGoalActivityEnvelope(value: unknown): value is GoalActivityEnvelope {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<GoalActivityEnvelope>
  return typeof candidate.goalId === 'string'
    && typeof candidate.event === 'string'
    && ['status', 'reasoning', 'tool_start', 'tool_input', 'tool_result', 'tool_dropped', 'done']
      .includes(candidate.event)
    && Boolean(candidate.data)
    && typeof candidate.data === 'object'
    && !Array.isArray(candidate.data)
}
