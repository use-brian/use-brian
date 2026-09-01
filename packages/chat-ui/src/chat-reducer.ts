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
  | { type: 'message/rekey'; messageId: string; id: string }
  /**
   * Set (or clear, with `state: null`) a message's mid-turn queued state.
   * Clearing is what `input_applied` does: the running turn took the message,
   * so it stops being "waiting" and becomes an ordinary user bubble.
   */
  | { type: 'message/queued'; messageId: string; state: 'pending' | 'steering' | null }
  /**
   * Drop a message from the thread. Used for exactly one thing today: a
   * queued message the running turn never took. The host removes it and
   * re-sends it as an ordinary turn, which appends it again — leaving it in
   * place would show it twice.
   */
  | { type: 'message/remove'; messageId: string }
  | { type: 'stream/start' }
  | { type: 'stream/append'; text: string }
  | { type: 'stream/reset' }
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

    // Swap ONLY the id (optimistic local id → server row id), keeping every
    // other field — including consumer-widened ones the reducer doesn't know
    // about (app-web's `userAttachments` thumbnails, `views`). The
    // `user_message_saved` re-key must use this, not `message/replace`: a
    // rebuilt bare message drops the attachment previews the send snapshotted,
    // so the user's image vanished the moment the turn started streaming.
    case 'message/rekey':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? { ...m, id: action.id } : m,
        ),
      }

    case 'message/queued':
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== action.messageId) return m
          if (action.state === null) {
            const { queued: _dropped, ...rest } = m
            return rest
          }
          return { ...m, queued: action.state }
        }),
      }

    case 'message/remove':
      return {
        ...state,
        messages: state.messages.filter((m) => m.id !== action.messageId),
      }

    case 'stream/start':
      return { ...state, isStreaming: true, streamingText: '' }

    case 'stream/append':
      return { ...state, streamingText: state.streamingText + action.text }

    // Clear the live stream buffer WITHOUT ending the stream — used to drop an
    // intermediate text segment (step narration the model emitted alongside a
    // tool call) so it never becomes part of the final answer. Unlike
    // `stream/start` this leaves `isStreaming` untouched. See the chat consumer's
    // `pendingAnswerResetRef` (segment-aware answer accumulation).
    case 'stream/reset':
      return { ...state, streamingText: '' }

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

    case 'confirmation/add': {
      const existingIndex = state.pendingConfirmations.findIndex((confirmation) =>
        action.confirmation.approvalId
          ? confirmation.approvalId === action.confirmation.approvalId
          : confirmation.toolCallId === action.confirmation.toolCallId,
      )
      if (existingIndex === -1) {
        return {
          ...state,
          pendingConfirmations: [...state.pendingConfirmations, action.confirmation],
        }
      }
      const existing = state.pendingConfirmations[existingIndex]
      // A live SSE card carries the real toolCallId and wins over a recovered
      // placeholder. A slower reload probe must never replace it in reverse.
      if (!existing?.restored && action.confirmation.restored) return state
      return {
        ...state,
        pendingConfirmations: state.pendingConfirmations.map((confirmation, index) =>
          index === existingIndex ? action.confirmation : confirmation,
        ),
      }
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
