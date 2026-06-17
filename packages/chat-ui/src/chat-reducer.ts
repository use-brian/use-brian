import type { Message, PendingConfirmation, ReplyTo } from './types.js'

export type ChatState = {
  sessionId: string | null
  messages: Message[]
  streamingText: string
  isStreaming: boolean
  pendingConfirmations: PendingConfirmation[]
  replyTo: ReplyTo | null
}

export const initialChatState: ChatState = {
  sessionId: null,
  messages: [],
  streamingText: '',
  isStreaming: false,
  pendingConfirmations: [],
  replyTo: null,
}

export type ChatAction =
  | { type: 'session/set'; sessionId: string | null }
  | { type: 'messages/load'; messages: Message[] }
  | { type: 'message/append'; message: Message }
  | { type: 'message/replace'; messageId: string; message: Message }
  | { type: 'stream/start' }
  | { type: 'stream/append'; text: string }
  | { type: 'stream/finalize'; finalMessage: Message }
  | { type: 'stream/abort' }
  | { type: 'reply/set'; replyTo: ReplyTo | null }
  | { type: 'confirmation/add'; confirmation: PendingConfirmation }
  | { type: 'confirmation/update'; toolCallId: string; patch: Partial<PendingConfirmation> }
  | { type: 'confirmation/clear' }

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'session/set':
      // Only update the id. The chat route emits a `session` SSE event
      // on every turn (including the *first* turn of a fresh session,
      // where state.sessionId is still null and the optimistic user
      // message is sitting in messages with isStreaming=true). A
      // destructive reset here would wipe that user message and the
      // stream state, leaving only the assistant reply on the screen.
      // Consumers that want "switch session and clear" must dispatch
      // `messages/load` (with []) and `confirmation/clear` explicitly.
      if (state.sessionId === action.sessionId) return state
      return { ...state, sessionId: action.sessionId }

    case 'messages/load':
      return { ...state, messages: action.messages }

    case 'message/append':
      return { ...state, messages: [...state.messages, action.message] }

    case 'message/replace':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? action.message : m,
        ),
      }

    case 'stream/start':
      return { ...state, isStreaming: true, streamingText: '' }

    case 'stream/append':
      return { ...state, streamingText: state.streamingText + action.text }

    case 'stream/finalize':
      return {
        ...state,
        isStreaming: false,
        streamingText: '',
        messages: [...state.messages, action.finalMessage],
      }

    case 'stream/abort':
      return { ...state, isStreaming: false, streamingText: '' }

    case 'reply/set':
      return { ...state, replyTo: action.replyTo }

    case 'confirmation/add':
      return {
        ...state,
        pendingConfirmations: [...state.pendingConfirmations, action.confirmation],
      }

    case 'confirmation/update':
      return {
        ...state,
        pendingConfirmations: state.pendingConfirmations.map((c) =>
          c.toolCallId === action.toolCallId ? { ...c, ...action.patch } : c,
        ),
      }

    case 'confirmation/clear':
      return { ...state, pendingConfirmations: [] }
  }
}
