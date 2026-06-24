/**
 * Channel adapter interface.
 *
 * Each messaging platform (Telegram, Slack, Web) implements this interface.
 * The core engine consumes IncomingMessage and produces OutgoingMessage —
 * adapters handle platform-specific formatting and delivery.
 */

// ── Incoming ───────────────────────────────────────────────────

export type IncomingFile = {
  url: string
  mimeType: string
  name: string
}

export type IncomingMessage = {
  userId: string
  channelId: string
  messageId?: string
  text: string
  mediaUrl?: string
  mediaType?: 'photo' | 'document' | 'voice' | 'audio' | 'video'
  /** Mime hint when known from the webhook payload (e.g. Telegram document.mime_type). */
  mediaMime?: string
  /** Original file name when known from the webhook payload (e.g. Telegram document.file_name). */
  mediaName?: string
  /** Audio/video duration in seconds when the webhook payload carries it (voice/audio/video). Drives the recording duration surcharge. */
  mediaDurationSec?: number
  /** File size in bytes when the webhook payload carries it. Used to refuse files over the channel's download limit before attempting a doomed download. */
  mediaSizeBytes?: number
  files?: IncomingFile[]
  replyToMessageId?: string
  isEdit?: boolean
  isGroupChat: boolean
  isMentioned?: boolean
  timestamp: number
  raw: unknown
}

// ── Outgoing ───────────────────────────────────────────────────

export type OutgoingAction =
  | { kind?: 'callback'; id: string; label: string; data: string }
  | { kind: 'web_app'; label: string; url: string }

/**
 * An outbound file attachment. Bytes are resolved from storage at delivery
 * time by the channel pipeline (`FilesApi.readBytes`) — adapters receive
 * ready-to-send data and never touch GCS. See
 * docs/architecture/channels/adapter-pattern.md → "Outbound documents".
 */
export type OutgoingDocument = {
  /** User-visible filename, e.g. "q1-recap.md". */
  filename: string
  mime: string
  /** Raw file bytes. */
  data: Uint8Array
  /** Telegram caption / Slack file title. Plain text. */
  caption?: string
}

export type OutgoingMessage = {
  text: string
  format?: 'plain' | 'markdown'
  images?: Array<{ url: string; caption?: string }>
  /**
   * File attachments delivered after the text chunks. A per-document
   * delivery failure must NOT fail the send — the adapter sends a short
   * plain-text notice instead (the reply text already landed).
   */
  documents?: OutgoingDocument[]
  actions?: OutgoingAction[]
}

// ── Adapter interface ──────────────────────────────────────────

export type ChannelAdapter = {
  type: string
  maxMessageLength: number
  supportsMarkdown: boolean
  supportsMessageEdit: boolean
  drainDelayMs: number

  parseIncoming(webhookPayload: unknown): IncomingMessage | null
  deduplicateId(webhookPayload: unknown): string | null

  sendMessage(channelId: string, response: OutgoingMessage, opts?: { threadTs?: string }): Promise<string>
  editMessage(channelId: string, messageId: string, response: OutgoingMessage, opts?: { threadTs?: string }): Promise<void>
  sendTypingIndicator(channelId: string): Promise<void>
  sendStatus(channelId: string, status: string, opts?: { threadTs?: string; messageId?: string }): Promise<string>
  /** Clear any platform-native status indicator (e.g. Slack assistant thread status). */
  clearStatus?(channelId: string, opts?: { messageId?: string }): Promise<void>
  reactToMessage?(channelId: string, messageId: string, emoji: string): Promise<void>
  /** Delete a message. Non-critical — may fail for old messages (>48h on Telegram). */
  deleteMessage?(channelId: string, messageId: string): Promise<void>
  /**
   * Pin a message in the chat. Present on platforms that support pinning
   * (Telegram today). `silent` suppresses the "X pinned a message" broadcast
   * that Telegram emits by default — useful for notices whose point is
   * visibility, not a fresh ping.
   */
  pinMessage?(channelId: string, messageId: string, opts?: { silent?: boolean }): Promise<void>
  /** Unpin a message. Best-effort — swallow errors. */
  unpinMessage?(channelId: string, messageId: string): Promise<void>
}
