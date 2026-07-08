export type {
  Message,
  MessageAttachment,
  ChatFileAttachment,
  CitationSource,
  ToolUsed,
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
  useMessageStream,
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

export { ChatComposer, type ChatComposerProps } from './ChatComposer.js'
