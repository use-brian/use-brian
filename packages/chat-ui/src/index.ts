export type {
  Message,
  MessageAttachment,
  ChatFileAttachment,
  CitationSource,
  DocumentAttachment,
  ToolUsed,
  ActivityNote,
  ReplyTo,
  Session,
  PendingConfirmation,
} from './types.js'

export {
  chatReducer,
  initialChatState,
  type ChatState,
  type ChatAction,
} from './chat-reducer.js'

export { useChatSession, type UseChatSessionResult } from './useChatSession.js'

export {
  chatRunReducer,
  initialChatRunState,
  sameChatControllerIdentity,
  type ChatConnectionState,
  type ChatControllerIdentity,
  type ChatRunAction,
  type ChatRunPhase,
  type ChatRunState,
} from './run-controller.js'

export {
  chatInteractionReducer,
  initialChatInteractionState,
  type ChatInteraction,
  type ChatInteractionAction,
  type ChatInteractionKind,
  type ChatInteractionSource,
  type ChatInteractionState,
  type ChatInteractionStatus,
} from './interaction-controller.js'

export {
  useMessageStream,
  runStream,
  TERMINAL_STREAM_EVENTS,
  type AuthFetch,
  type StreamOptions,
  type StartStream,
  type UseMessageStreamResult,
} from './useMessageStream.js'

export {
  parseSSEStream,
  createSSEBuffer,
  type SSEEvent,
  type SSEBuffer,
} from './sse.js'

export { normalizeBullets } from './normalize-markdown.js'
export { ChatMarkdown, type ChatMarkdownProps } from './markdown.js'

export {
  ChatComposer,
  resolveEnterIntent,
  splitHighlightSegments,
  type ChatComposerProps,
  type ComposerEnterIntent,
  type HighlightRange,
} from './ChatComposer.js'
