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

/**
 * Verbatim source text presented by the Chat operator app's read-only
 * right-hand viewer. The id is the originating tool-use id, which makes live
 * SSE re-emits and persisted-history restoration converge on one identity.
 */
export type DocumentAttachment = {
  id: string
  title: string
  content: string
  format: 'text' | 'markdown'
  sourceName?: string
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
  /**
   * Client-measured wall-clock for the call (`tool_start` → `tool_result`).
   * Live turns only — history restores have no timings.
   */
  durationMs?: number
  /** Short error excerpt when the call failed (status `retried`). */
  errorMessage?: string
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
 * @use-brian/views-renderer (where the typed schema lives) — the
 * apps/web consumer validates at the renderer boundary on mount.
 */
type ViewPayloadAttachment = {
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
  /**
   * Total wall-clock of the turn that produced this assistant message —
   * drives the "Worked for 42s · 6 steps" activity receipt. Live turns
   * only; absent on history restores.
   */
  activityDurationMs?: number
  /** Q5 (§16) — A2UI view payloads emitted via renderView tool calls in this message. */
  views?: ViewPayloadAttachment[]
  /** Full source documents presented in the Chat app's split viewer. */
  documents?: DocumentAttachment[]
  replyTo?: ReplyTo
  followUpQuestions?: string[]
  /**
   * Mid-turn input state for a user message the host sent WHILE a turn was
   * streaming (docs/architecture/engine/mid-turn-input.md).
   *
   * - `pending` — handed to the running turn, waiting to be taken.
   * - `steering` — the same, expedited: the user pressed Steer (or
   *   Cmd/Ctrl+Enter) and the running turn will interrupt itself if it can.
   *
   * Absent on every ordinary message. The flag clears when the server reports
   * `input_applied`, which is also when the message id is re-keyed from the
   * client's `inputId` to the persisted row id. A message still carrying the
   * flag when the stream ends was never taken, and the host sends it as an
   * ordinary turn.
   */
  queued?: 'pending' | 'steering'
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
