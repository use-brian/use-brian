import type { ReactNode } from 'react'
import type { Message } from './types.js'
import { ChatMarkdown } from './markdown.js'

export type MessageListProps = {
  messages: Message[]
  /**
   * Optional in-flight assistant message — rendered as a streaming bubble at
   * the end of the list. The host hook supplies this from `state.streamingText`
   * when `state.isStreaming` is true.
   */
  streamingText?: string
  isStreaming?: boolean
  /**
   * Slot for tool-call timeline / activity rendering. Injected as a prop so
   * the package stays free of `apps/web`-only `<ToolTimeline>` deps. Rendered
   * just below the streaming bubble.
   */
  slotToolTimeline?: ReactNode
  /**
   * Slot rendered after each assistant message. Hosts use this for feedback
   * buttons, copy, retry. Index is the position in `messages`.
   */
  slotPerMessage?: (message: Message, index: number) => ReactNode
  className?: string
  /** Optional CSS class for individual message bubbles. */
  bubbleClassName?: string
}

/**
 * Headless message list. Renders user + assistant turns with markdown for
 * assistant content. Attachments render as filename chips (no preview) —
 * hosts that want richer attachment display can wrap and replace.
 */
export function MessageList(props: MessageListProps) {
  const { messages, streamingText, isStreaming, slotToolTimeline } = props

  return (
    <div className={props.className}>
      {messages.map((m, i) => (
        <MessageBubble
          key={m.id}
          message={m}
          bubbleClassName={props.bubbleClassName}
          afterContent={props.slotPerMessage?.(m, i)}
        />
      ))}
      {isStreaming ? (
        <div data-streaming="true" className={props.bubbleClassName}>
          <ChatMarkdown text={streamingText ?? ''} />
        </div>
      ) : null}
      {slotToolTimeline}
    </div>
  )
}

function MessageBubble(props: {
  message: Message
  bubbleClassName?: string
  afterContent?: ReactNode
}) {
  const { message } = props
  return (
    <div
      data-role={message.role}
      data-message-id={message.id}
      className={props.bubbleClassName}
    >
      {message.replyTo ? (
        <div data-reply-to={message.replyTo.id} className="reply-context">
          {message.replyTo.text}
        </div>
      ) : null}
      {message.role === 'assistant' ? (
        <ChatMarkdown text={message.text} />
      ) : (
        <div className="user-text">{message.text}</div>
      )}
      {message.attachments?.length ? (
        <div className="attachments">
          {message.attachments.map((a) => (
            <span key={a.id} className="attachment-chip" data-mime={a.mimeType}>
              {a.fileName}
            </span>
          ))}
        </div>
      ) : null}
      {message.citations?.length ? (
        <ul className="citations">
          {message.citations.map((c) => (
            <li key={c.url}>
              <a href={c.url} target="_blank" rel="noreferrer">
                {c.title || c.url}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {props.afterContent}
    </div>
  )
}
