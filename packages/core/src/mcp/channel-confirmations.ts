import { interpretConfirmationEvent, type NormalizedConfirmationEvent } from './confirmation-events.js'
import type { ConfirmationResolver, ToolConfirmationRequest } from './types.js'

/** Transport-normalized identity. Integration and sender are never inferred from text. */
export type ChannelInteractionScope = {
  channelType: string
  integrationId: string
  conversationId: string
  senderId: string
  /** Native thread/topic session; omitted for unthreaded conversations. */
  sessionId?: string
}

type Pending = {
  scope: ChannelInteractionScope
  request: ToolConfirmationRequest
  resolver: ConfirmationResolver
  expires: number
  messageId?: string
  dispose: () => void
  cancel: () => void
}

const address = (scope: ChannelInteractionScope) => JSON.stringify([
  scope.channelType, scope.integrationId, scope.conversationId, scope.senderId,
])
const session = (scope: ChannelInteractionScope) => scope.sessionId ?? scope.conversationId

/** Shared pre-lock confirmation state. Provider routes only normalize identities/events.
 * Consume synchronously before resuming a suspended turn, including click/text races.
 */
export class ChannelConfirmations {
  private readonly pending = new Set<Pending>()
  constructor(private readonly now = Date.now) {}

  register(scope: ChannelInteractionScope, request: ToolConfirmationRequest, resolver: ConfirmationResolver,
    signal?: AbortSignal): () => void {
    this.prune()
    // Keep identity and approval capability stable for the lifetime of a prompt.
    const item: Pending = {
      scope: { ...scope }, request: { ...request }, resolver,
      expires: this.now() + 300_000,
      dispose: () => {}, cancel: () => {},
    }
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const dispose = () => {
      if (!active) return
      active = false
      this.pending.delete(item)
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
    const cancel = () => {
      if (!active) return
      dispose()
      resolver.resolve(item.request.toolCallId, 'deny')
    }
    item.dispose = dispose
    item.cancel = cancel
    if (signal?.aborted) { cancel(); return dispose }
    this.pending.add(item)
    signal?.addEventListener('abort', cancel, { once: true })
    // Expiry must release the suspended turn even if no further events arrive.
    timer = setTimeout(cancel, 300_000)
    timer.unref?.()
    return dispose
  }

  /** Bind only a unique live prompt in its original session after delivery.
   * A delayed send must not overwrite an existing delivery binding.
   */
  bindMessage(scope: ChannelInteractionScope, toolCallId: string, messageId: string): boolean {
    this.prune()
    if (!messageId.trim()) return false
    const candidates = [...this.pending].filter(item => address(item.scope) === address(scope)
      && session(item.scope) === session(scope) && item.request.toolCallId === toolCallId)
    if (candidates.length !== 1) return false
    const item = candidates[0]!
    if (item.messageId !== undefined && item.messageId !== messageId) return false
    item.messageId = messageId
    return true
  }

  clear(resolver: ConfirmationResolver): void {
    for (const item of this.pending) if (item.resolver === resolver) item.dispose()
  }

  /** Deny suspended prompts before stopping their owning turn. */
  cancelScope(scope: ChannelInteractionScope): void {
    for (const item of this.pending) {
      if (address(item.scope) === address(scope) && session(item.scope) === session(scope)) item.cancel()
    }
  }

  private prune() {
    for (const item of this.pending) if (item.expires <= this.now()) item.cancel()
  }

  handle(scope: ChannelInteractionScope, event: NormalizedConfirmationEvent): {
    handled: boolean
    status: 'resolved' | 'unavailable' | 'message'
    decision?: string
  } {
    this.prune()
    const parsed = interpretConfirmationEvent(event)
    const explicit = event.kind !== 'text'
    const candidates = [...this.pending].filter(item => {
      if (address(item.scope) !== address(scope)) return false
      if (explicit && (parsed.status !== 'decision' || parsed.toolCallId !== item.request.toolCallId)) return false
      // Native callbacks may omit thread metadata. Only the exact delivered
      // message can recover that session; a supplied wrong message fails closed
      // even when the callback otherwise claims the correct session.
      if (event.kind === 'action' && event.sourceMessageId !== undefined) {
        return item.messageId !== undefined && event.sourceMessageId === item.messageId
      }
      return session(item.scope) === session(scope)
    })
    if (candidates.length !== 1) return {
      handled: explicit || candidates.length > 1,
      status: explicit || candidates.length > 1 ? 'unavailable' : 'message',
    }
    const item = candidates[0]!
    const result = interpretConfirmationEvent(event, item.request.toolCallId)
    if (result.status !== 'decision' || result.toolCallId !== item.request.toolCallId
      || ((result.decision === 'always_allow' || result.decision === 'always_deny')
        && !item.request.allowPersistentApproval)) return { handled: true, status: 'unavailable' }
    item.dispose()
    item.resolver.resolve(item.request.toolCallId, result.decision, result.comment)
    return { handled: result.consume, status: 'resolved', decision: result.decision }
  }
}
