import type { ChatControllerIdentity } from './run-controller.js'
import { sameChatControllerIdentity } from './run-controller.js'

/** [COMP:chat-ui/interaction-controller] */
export type ChatInteractionKind = 'question' | 'tool-confirmation'
export type ChatInteractionSource = 'restored' | 'live'
export type ChatInteractionStatus = 'pending' | 'responding' | 'retryable'

export type ChatInteraction<T = unknown> = {
  kind: ChatInteractionKind
  approvalId: string
  toolCallId?: string
  source: ChatInteractionSource
  status: ChatInteractionStatus
  payload: T
  error?: string
}

export type ChatInteractionState<T = unknown> = {
  identity: ChatControllerIdentity
  pending: ChatInteraction<T> | null
}

export const initialChatInteractionState: ChatInteractionState = {
  identity: { sessionId: null, generation: 0 },
  pending: null,
}

export type ChatInteractionAction<T = unknown> =
  | { type: 'visit'; identity: ChatControllerIdentity }
  | { type: 'adopt-session'; identity: ChatControllerIdentity; sessionId: string }
  | { type: 'present'; identity: ChatControllerIdentity; interaction: ChatInteraction<T> }
  | { type: 'respond'; identity: ChatControllerIdentity; approvalId: string }
  | { type: 'response-failed'; identity: ChatControllerIdentity; approvalId: string; error?: string }
  | { type: 'resolved'; identity: ChatControllerIdentity; approvalId: string }

export function chatInteractionReducer<T>(
  state: ChatInteractionState<T>,
  action: ChatInteractionAction<T>,
): ChatInteractionState<T> {
  if (action.type === 'visit') {
    if (action.identity.generation <= state.identity.generation) return state
    return { identity: action.identity, pending: null }
  }

  if (!sameChatControllerIdentity(state.identity, action.identity)) return state

  if (action.type === 'adopt-session') {
    if (state.identity.sessionId === action.sessionId) return state
    if (state.identity.sessionId !== null) return state
    return { ...state, identity: { ...state.identity, sessionId: action.sessionId } }
  }

  if (action.type === 'present') {
    const current = state.pending
    if (current?.approvalId === action.interaction.approvalId) {
      // A durable probe is lower fidelity than the live SSE card. It may seed
      // the card, but it can never roll a live card back to a placeholder.
      if (current.source === 'live' && action.interaction.source === 'restored') {
        return state
      }
      if (
        current.source === action.interaction.source &&
        current.status === action.interaction.status &&
        current.toolCallId === action.interaction.toolCallId &&
        current.payload === action.interaction.payload
      ) {
        return state
      }
    }
    return { ...state, pending: action.interaction }
  }

  if (!state.pending || state.pending.approvalId !== action.approvalId) return state

  switch (action.type) {
    case 'respond':
      if (state.pending.status === 'responding') return state
      return {
        ...state,
        pending: { ...state.pending, status: 'responding', error: undefined },
      }
    case 'response-failed':
      return {
        ...state,
        pending: {
          ...state.pending,
          status: 'retryable',
          ...(action.error ? { error: action.error } : { error: undefined }),
        },
      }
    case 'resolved':
      return { ...state, pending: null }
  }
}
