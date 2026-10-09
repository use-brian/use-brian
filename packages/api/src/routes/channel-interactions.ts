import { ChannelConfirmations, buildConfirmationActions, type ChannelInteractionScope, type ToolConfirmationRequest } from '@use-brian/core'
import type { OutgoingMessage } from '@use-brian/channels'
import { formatConfirmationInput, getToolDisplayName } from '@use-brian/shared'

/** One registry for every authenticated transport, including WhatsApp QR login. */
const scopeKey = (scope: ChannelInteractionScope) => JSON.stringify([
  scope.channelType, scope.integrationId, scope.conversationId, scope.senderId,
  scope.sessionId ?? scope.conversationId,
])
type ActiveTurn = { controller: AbortController; messageId?: string; onAbort: () => unknown }

/**
 * The sender slot of a channel room's interaction scope (unified-sessions
 * §4.4): a room's turn and its confirmations belong to the room, not to the
 * person who addressed it, so any reader can Stop it and the addresser or an
 * admin can answer its confirmation.
 */
export const ROOM_INTERACTION_SENDER = '*room*'

/** Rekey a provider interaction scope from its sender to the room. */
export function roomInteractionScope(scope: ChannelInteractionScope): ChannelInteractionScope {
  return { ...scope, senderId: ROOM_INTERACTION_SENDER }
}

const STOP_TEXT = /^\/?(?:stop|cancel|abort|nevermind|never\s+mind)$/i

export class ChannelInteractions extends ChannelConfirmations {
  private readonly turns = new Map<string, ActiveTurn>()
  /** Room turn key -> the provider sender id of the person who addressed it. */
  private readonly roomAddressers = new Map<string, string>()

  registerTurn(scope: ChannelInteractionScope, controller: AbortController,
    options: { messageId?: string; onAbort: () => unknown; addresserId?: string }): () => void {
    const key = scopeKey(scope)
    const { addresserId, ...rest } = options
    const turn = { controller, ...rest }
    if (addresserId !== undefined) this.roomAddressers.set(key, addresserId)
    const dispose = () => {
      if (this.turns.get(key) === turn) {
        this.turns.delete(key)
        if (addresserId !== undefined && this.roomAddressers.get(key) === addresserId) this.roomAddressers.delete(key)
      }
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
    if (event.kind === 'text' && STOP_TEXT.test(event.text.trim())
      && this.stop(scope, true)) return { handled: true, status: 'resolved', decision: 'deny' }
    return super.handle(scope, event)
  }

  /**
   * A room's interaction (`roomInteractionScope`): Stop from any reader; a
   * confirmation answer only from the person who addressed the turn or a
   * workspace admin (`sessionPolicy(kind).confirmations`). Anyone else's
   * "approve" is an ordinary message in the room.
   */
  async handleRoom(scope: ChannelInteractionScope, event: Parameters<ChannelConfirmations['handle']>[1],
    actor: { senderId: string; isAdmin: () => Promise<boolean> }): Promise<ReturnType<ChannelConfirmations['handle']>> {
    if (event.kind === 'text' && STOP_TEXT.test(event.text.trim())) return this.handle(scope, event)
    const addresser = this.roomAddressers.get(scopeKey(scope))
    if (addresser !== undefined && addresser !== actor.senderId && !(await actor.isAdmin())) {
      return { handled: false, status: 'message' }
    }
    return this.handle(scope, event)
  }
}

export const channelConfirmations = new ChannelInteractions()
export type { ChannelInteractionScope }

/** Business content is shared; adapters choose native actions or readable replies. */
export function confirmationMessage(request: Omit<ToolConfirmationRequest, 'classification'>,
  options?: { compactDetails?: boolean }): OutgoingMessage {
  const details = request.displayLines?.join('\n') || formatConfirmationInput(request.input).join('\n') || request.description || ''
  const title = getToolDisplayName(request.toolName)
  const question = `Allow this action?\nReply: approve / deny${request.allowPersistentApproval ? ' / always allow / always deny' : ''}`
  return {
    text: options?.compactDetails ? `${title}\n\n${question}` : `**${title}**\n\n${details}\n\n${question}`,
    ...(options?.compactDetails && details ? { collapsibleDetails: `Watch more\n${details}` } : {}),
    format: 'markdown',
    actions: buildConfirmationActions(request.toolCallId, request.allowPersistentApproval).map(action => ({
      ...action, replyText: action.id === 'always' ? 'always allow' : action.id === 'never' ? 'always deny' : action.id,
    })),
  }
}
