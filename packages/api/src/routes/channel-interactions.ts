import { ChannelConfirmations, buildConfirmationActions, type ChannelInteractionScope, type ToolConfirmationRequest } from '@use-brian/core'
import type { OutgoingMessage } from '@use-brian/channels'
import { formatConfirmationInput, getToolDisplayName } from '@use-brian/shared'

/** One registry for every authenticated transport, including WhatsApp QR login. */
const scopeKey = (scope: ChannelInteractionScope) => JSON.stringify([
  scope.channelType, scope.integrationId, scope.conversationId, scope.senderId,
  scope.sessionId ?? scope.conversationId,
])
type ActiveTurn = { controller: AbortController; messageId?: string; onAbort: () => unknown }

export class ChannelInteractions extends ChannelConfirmations {
  private readonly turns = new Map<string, ActiveTurn>()

  registerTurn(scope: ChannelInteractionScope, controller: AbortController,
    options: { messageId?: string; onAbort: () => unknown }): () => void {
    const key = scopeKey(scope)
    const turn = { controller, ...options }
    const dispose = () => {
      if (this.turns.get(key) === turn) this.turns.delete(key)
      controller.signal.removeEventListener('abort', dispose)
    }
    if (!controller.signal.aborted) {
      this.turns.set(key, turn)
      controller.signal.addEventListener('abort', dispose, { once: true })
    }
    return dispose
  }

  /** Edits only interrupt the exact original message, without a stop acknowledgement. */
  abortForEdit(scope: ChannelInteractionScope, messageId: string | undefined): boolean {
    const turn = this.turns.get(scopeKey(scope))
    if (!messageId || turn?.messageId !== messageId) return false
    return this.stop(scope, false)
  }

  private stop(scope: ChannelInteractionScope, acknowledge: boolean): boolean {
    const key = scopeKey(scope)
    const turn = this.turns.get(key)
    if (!turn) return false
    this.turns.delete(key) // Consume before callbacks: duplicate deliveries cannot cancel twice.
    this.cancelScope(scope)
    turn.controller.abort()
    if (acknowledge) {
      // Delivery failures must not unwind admission or leave an unhandled rejection.
      try { void Promise.resolve(turn.onAbort()).catch(() => {}) } catch { /* best effort */ }
    }
    return true
  }

  override handle(scope: ChannelInteractionScope, event: Parameters<ChannelConfirmations['handle']>[1]):
    ReturnType<ChannelConfirmations['handle']> {
    if (event.kind === 'text' && /^\/?(?:stop|cancel|abort|nevermind|never\s+mind)$/i.test(event.text.trim())
      && this.stop(scope, true)) return { handled: true, status: 'resolved', decision: 'deny' }
    return super.handle(scope, event)
  }
}

export const channelConfirmations = new ChannelInteractions()
export type { ChannelInteractionScope }

/** Business content is shared; adapters choose native actions or readable replies. */
export function confirmationMessage(request: Omit<ToolConfirmationRequest, 'classification'>): OutgoingMessage {
  const details = request.displayLines?.join('\n') || formatConfirmationInput(request.input).join('\n') || request.description || ''
  return {
    text: `**${getToolDisplayName(request.toolName)}**\n\n${details}\n\nAllow this action?\nReply: approve / deny${request.allowPersistentApproval ? ' / always allow / always deny' : ''}`,
    format: 'markdown',
    actions: buildConfirmationActions(request.toolCallId, request.allowPersistentApproval).map(action => ({
      ...action, replyText: action.id === 'always' ? 'always allow' : action.id === 'never' ? 'always deny' : action.id,
    })),
  }
}
