import { useReducer, useCallback } from 'react'
import {
  chatReducer,
  initialChatState,
  type ChatAction,
  type ChatState,
} from './chat-reducer.js'
import type { Message, PendingConfirmation, ReplyTo } from './types.js'

export type UseChatSessionResult = {
  state: ChatState
  dispatch: (action: ChatAction) => void
  /** Convenience wrappers around dispatch — same payload shape as the actions. */
  setSession: (sessionId: string | null) => void
  loadMessages: (messages: Message[]) => void
  appendMessage: (message: Message) => void
  setReplyTo: (replyTo: ReplyTo | null) => void
  addConfirmation: (confirmation: PendingConfirmation) => void
  updateConfirmation: (toolCallId: string, patch: Partial<PendingConfirmation>) => void
  clearConfirmations: () => void
}

/**
 * Owns the pure chat state for one session. Streaming, fetch, and SSE all
 * happen elsewhere (see `useMessageStream`) — this hook holds only state.
 *
 * Returned `dispatch` lets host code dispatch actions directly; the wrapper
 * functions cover the common cases without reaching for action types.
 */
export function useChatSession(initial?: Partial<ChatState>): UseChatSessionResult {
  const [state, dispatch] = useReducer(chatReducer, { ...initialChatState, ...initial })

  const setSession = useCallback(
    (sessionId: string | null) => dispatch({ type: 'session/set', sessionId }),
    [],
  )
  const loadMessages = useCallback(
    (messages: Message[]) => dispatch({ type: 'messages/load', messages }),
    [],
  )
  const appendMessage = useCallback(
    (message: Message) => dispatch({ type: 'message/append', message }),
    [],
  )
  const setReplyTo = useCallback(
    (replyTo: ReplyTo | null) => dispatch({ type: 'reply/set', replyTo }),
    [],
  )
  const addConfirmation = useCallback(
    (confirmation: PendingConfirmation) =>
      dispatch({ type: 'confirmation/add', confirmation }),
    [],
  )
  const updateConfirmation = useCallback(
    (toolCallId: string, patch: Partial<PendingConfirmation>) =>
      dispatch({ type: 'confirmation/update', toolCallId, patch }),
    [],
  )
  const clearConfirmations = useCallback(
    () => dispatch({ type: 'confirmation/clear' }),
    [],
  )

  return {
    state,
    dispatch,
    setSession,
    loadMessages,
    appendMessage,
    setReplyTo,
    addConfirmation,
    updateConfirmation,
    clearConfirmations,
  }
}
