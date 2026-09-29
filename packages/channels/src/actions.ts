import type { OutgoingAction, OutgoingMessage } from './types.js'

/** Transport-neutral action input. Consumers, not adapters, interpret data. */
export type IncomingAction = { data: string; messageId?: string }

export function normalizeActionInput(data: unknown, messageId?: string): IncomingAction | null {
  return typeof data === 'string' && data.length > 0 ? { data, ...(messageId ? { messageId } : {}) } : null
}

/** Do not use opaque callback data as a human reply token. */
export function actionReplyText(action: Exclude<OutgoingAction, { kind: 'web_app' }>): string {
  return action.replyText?.trim() || action.label.trim() || 'Continue'
}

export function actionFallbackText(actions: readonly OutgoingAction[]): string {
  return actions.map(action => action.kind === 'web_app'
    ? `${action.label.trim() || 'Open link'}: ${action.url}`
    : `${action.label.trim() || 'Continue'} — reply: ${actionReplyText(action)}`,
  ).join('\n')
}

/** Always retain a readable alternative, including on native-button channels.
 * Call before chunking/empty checks. Plain format protects reply tokens from
 * markdown converters (e.g. underscores in command arguments).
 */
export function denormalizeActions(response: OutgoingMessage): OutgoingMessage {
  if (!response.actions?.length) return response
  return {
    ...response,
    format: 'plain',
    text: [response.text, actionFallbackText(response.actions)].filter(Boolean).join('\n\n'),
  }
}
