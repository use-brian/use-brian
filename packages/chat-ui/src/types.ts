// Lifted from apps/web/src/app/chat/page.tsx:41-106. Kept structurally identical
// so a host migrating onto this package can swap imports without changing
// callsites. Add fields cautiously — adding here forces every consumer to
// either populate or default the field.

export type MessageAttachment = {
  id: string
  fileName: string
  mimeType: string
  /**
   * Optional local preview URL set during the live send flow so we don't wait
   * for a round-trip. Cleared once the message is committed by the server.
   */
  localPreviewUrl?: string
}

/**
 * Server-persisted outbound file attachment on an assistant message — the
 * `sendFile` tool (`session_messages.attachments`, migration 273). Distinct
 * from `MessageAttachment` (the composer's user-upload chips): these
 * soft-reference a durable `workspace_files` row; the host downloads them
 * through its signed-URL route (`GET /api/doc-files/:workspaceId/:fileId`).
 */
export type ChatFileAttachment = {
  fileId: string
  workspaceId: string
  path: string
  name: string
  mime: string
  sizeBytes: number
  caption?: string
}

export type CitationSource = {
  url: string
  title: string
}

export type ToolUsed = {
  id: string
  name: string
  status: 'running' | 'done' | 'retried'
  workerId?: string
  description?: string
  url?: string
  /** For spawnWorker tools: the workerId that was spawned (for nesting). */
  spawnedWorkerId?: string
  workerDescription?: string
}

export type ReplyTo = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

/**
 * A2UI v0.8 view payload attached to an assistant message.
 *
 * Origin: Q5 §16. The `renderView` chat tool returns an A2UI ViewPayload;
 * the chat route forwards it as a dedicated `view_payload` SSE event. The
 * client maps each payload to one entry here, keyed by `toolUseId` so
 * re-emits are idempotent.
 *
 * `payload` is typed as `unknown` because chat-ui has no dependency on
 * @sidanclaw/views-renderer (where the typed schema lives) — the
 * apps/web consumer validates at the renderer boundary on mount.
 */
export type ViewPayloadAttachment = {
  toolUseId: string
  payload: unknown
  entity?: string
  viewType?: string
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: Date
  attachments?: MessageAttachment[]
  /** Outbound workspace-file attachments (`sendFile`) — rendered as download cards. */
  fileAttachments?: ChatFileAttachment[]
  citations?: CitationSource[]
  toolsUsed?: ToolUsed[]
  /** Q5 (§16) — A2UI view payloads emitted via renderView tool calls in this message. */
  views?: ViewPayloadAttachment[]
  replyTo?: ReplyTo
  followUpQuestions?: string[]
}

export type Session = {
  id: string
  title: string
  channelId?: string
  lastActive: Date
}

export type PendingConfirmation = {
  toolCallId: string
  toolName: string
  displayName?: string
  input: Record<string, unknown>
  description?: string
  /** Pre-formatted lines supplied by the tool (e.g. memory summaries). */
  displayLines?: string[]
  sessionId: string
  status: 'pending' | 'approving' | 'approved' | 'denied' | 'failed'
  result?: string
}
