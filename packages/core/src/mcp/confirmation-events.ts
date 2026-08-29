import type { ConfirmationDecision } from './types.js'

export const CONFIRMATION_DECISIONS = [
  'allow',
  'deny',
  'always_allow',
  'always_deny',
] as const satisfies readonly ConfirmationDecision[]

const CONFIRMATION_DECISION_SET: ReadonlySet<unknown> = new Set(CONFIRMATION_DECISIONS)

const TEXT_DECISIONS = new Map<string, ConfirmationDecision>([
  ['yes', 'allow'],
  ['y', 'allow'],
  ['allow', 'allow'],
  ['approve', 'allow'],
  ['ok', 'allow'],
  ['no', 'deny'],
  ['n', 'deny'],
  ['deny', 'deny'],
  ['reject', 'deny'],
  ['always', 'always_allow'],
  ['always allow', 'always_allow'],
  ['never', 'always_deny'],
  ['always deny', 'always_deny'],
])

const DECISION_LABELS: Record<ConfirmationDecision, string> = {
  allow: 'Allowed',
  deny: 'Denied',
  always_allow: 'Always allowed',
  always_deny: 'Always denied',
}

export type NormalizedConfirmationEvent =
  | { kind: 'text'; text: string }
  | { kind: 'action'; data: unknown }
  | {
    kind: 'decision'
    toolCallId: unknown
    decision: unknown
    comment?: unknown
  }

export type ConfirmationEventResult =
  | {
    status: 'decision'
    decision: ConfirmationDecision
    toolCallId?: string
    comment?: string
    /** Whether this event is only a confirmation response, not a new message. */
    consume: boolean
  }
  | { status: 'not_confirmation' }
  | { status: 'invalid' }

export type ConfirmationAction = {
  id: string
  label: string
  data: string
}

export function isConfirmationDecision(value: unknown): value is ConfirmationDecision {
  return CONFIRMATION_DECISION_SET.has(value)
}

export function confirmationDecisionLabel(decision: ConfirmationDecision): string {
  return DECISION_LABELS[decision]
}

export function encodeConfirmationAction(
  toolCallId: string,
  decision: ConfirmationDecision,
): string {
  return `mcp_confirm:${toolCallId}:${decision}`
}

export function buildConfirmationActions(
  toolCallId: string,
  allowPersistentApproval = false,
): ConfirmationAction[] {
  const actions: ConfirmationAction[] = [
    { id: 'allow', label: 'Allow', data: encodeConfirmationAction(toolCallId, 'allow') },
    { id: 'deny', label: 'Deny', data: encodeConfirmationAction(toolCallId, 'deny') },
  ]
  if (allowPersistentApproval) {
    actions.push(
      { id: 'always', label: 'Always Allow', data: encodeConfirmationAction(toolCallId, 'always_allow') },
      { id: 'never', label: 'Always Deny', data: encodeConfirmationAction(toolCallId, 'always_deny') },
    )
  }
  return actions
}

/**
 * Interpret a provider-neutral confirmation event.
 *
 * Transports extract text or opaque action data; this function alone maps that
 * normalized input to an executor decision. If unrelated text arrives while a
 * request is parked, the request is denied and the text continues as a fresh
 * message so the suspended turn cannot hold the conversation lock until timeout.
 */
export function interpretConfirmationEvent(
  event: NormalizedConfirmationEvent,
  pendingToolCallId?: string,
): ConfirmationEventResult {
  if (event.kind === 'text') {
    const decision = TEXT_DECISIONS.get(event.text.trim().toLowerCase())
    if (decision) {
      return {
        status: 'decision',
        decision,
        ...(pendingToolCallId ? { toolCallId: pendingToolCallId } : {}),
        consume: true,
      }
    }
    if (pendingToolCallId) {
      return {
        status: 'decision',
        decision: 'deny',
        toolCallId: pendingToolCallId,
        consume: false,
      }
    }
    return { status: 'not_confirmation' }
  }

  if (event.kind === 'action') {
    if (typeof event.data !== 'string') return { status: 'invalid' }
    const parts = event.data.split(':')
    if (parts.length !== 3 || parts[0] !== 'mcp_confirm') return { status: 'invalid' }
    const toolCallId = parts[1]
    const decision = parts[2]
    if (!toolCallId || !isConfirmationDecision(decision)) return { status: 'invalid' }
    return { status: 'decision', toolCallId, decision, consume: true }
  }

  if (
    typeof event.toolCallId !== 'string'
    || !event.toolCallId.trim()
    || !isConfirmationDecision(event.decision)
    || (event.comment !== undefined && typeof event.comment !== 'string')
  ) {
    return { status: 'invalid' }
  }
  const comment = event.comment?.trim()
  return {
    status: 'decision',
    toolCallId: event.toolCallId.trim(),
    decision: event.decision,
    ...(comment ? { comment } : {}),
    consume: true,
  }
}
