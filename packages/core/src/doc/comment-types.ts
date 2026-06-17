/**
 * Doc comments (chat-as-threads) — the store contract.
 *
 * A comment thread is a Notion-style, block-anchored discussion on a doc
 * page. Its CONVERSATION is a chat session (`sessions` + `session_messages`)
 * — one session per thread — so threads reuse the whole chat stack and
 * resume independently by `session_id`. The thread row (migration 218) holds
 * only the anchor + resolution state; comments are the session's messages.
 *
 * The interface is declared here in `core` (no `pg`); the DB adapter
 * (`createDbCommentThreadStore`) lives in `packages/api/src/db`. This mirrors
 * the `DocPageStore` / `DocEntityStore` core↔api split.
 *
 * Spec: `docs/architecture/features/doc-comments.md`.
 *
 * [COMP:doc/comment-types]
 */

import type { InboxPendingReply } from './inbox-types.js'

/** How a thread is pinned to the page. */
export type CommentAnchorKind =
  /** A precise human-selected text range, marked with a `comment` Tiptap
   *  mark carrying `threadId` in the Yjs doc. */
  | 'human_range'
  /** A whole block the AI annotated. The AI works at block granularity and
   *  never mutates the Yjs doc — the highlight is a client-side decoration
   *  from `anchorBlockId`. */
  | 'ai_block'
  /** A whole block a HUMAN commented on, used when the block can't carry a
   *  `comment` mark — the atom embeds (chart / diagram / data / image / file /
   *  bookmark / …) have no inner text to mark. Renders the same client-side
   *  whole-block highlight as `ai_block` (decoration from `anchorBlockId`, no
   *  Yjs mutation) but is authored by a person, so it stays distinct from the
   *  AI's own annotations (the `postComment` dedup + discovery key on
   *  `ai_block`). */
  | 'human_block'

/** One comment thread on a doc page (the `comment_threads` row). */
export type CommentThread = {
  id: string
  pageId: string
  workspaceId: string
  /** The session whose `session_messages` are this thread's comments. */
  sessionId: string
  anchorKind: CommentAnchorKind
  /** The block the thread points at. Nullable so an orphaned thread (block
   *  deleted) keeps its history; never null in practice on create. */
  anchorBlockId: string | null
  /** Snapshot of the anchored text for the popover header / thread list. */
  quote: string | null
  /** A short label derived at READ time from the thread's FIRST comment — NOT
   *  a `comment_threads` column. The list endpoints (`listThreadsForPage`)
   *  populate it via `deriveCommentTitle` so the comment index can label a
   *  page-level (quote-less) thread by what it's about instead of a generic
   *  "Comments"; `getThread` / the summaries / pending-replies leave it
   *  undefined (they don't read the messages). */
  title?: string | null
  /** ISO timestamp; null = open. */
  resolvedAt: string | null
  resolvedBy: string | null
  createdBy: string
  createdAt: string
  /** The backing session's `status` (`running` while a turn is in flight,
   *  `idle`/`timeout` otherwise), attached at READ time by `listThreadsForPage`
   *  / `getThread` — NOT a `comment_threads` column. The editor uses it to
   *  reconnect a reloaded thread to a still-running turn (the live "working…"
   *  indicator). Undefined where the listing doesn't read it (summaries /
   *  pending-replies). See doc-comments.md → "Live turn reconnect". */
  sessionStatus?: string | null
}

/**
 * A thread plus the cheap discovery signals the AI uses to decide whether a
 * thread is worth reading: how many comments it has and when it last moved.
 * Metadata only — never the message bodies (those load on demand via
 * `getCommentThread`). Backs the in-page thread discovery index injected into
 * the doc system prompt; see `comment-discovery.ts`.
 */
export type CommentThreadSummary = CommentThread & {
  /** Number of comments (session_messages) in the thread. */
  messageCount: number
  /** ISO timestamp of the most recent comment, or null when empty. */
  lastActivityAt: string | null
}

/** A single comment (a `session_messages` row of the thread's session). */
export type CommentMessage = {
  id: string
  threadId: string
  role: 'user' | 'assistant'
  body: string
  /** The human author (null for assistant comments). */
  senderUserId: string | null
  createdAt: string
}

export type CreateThreadParams = {
  /** RLS actor. For AI-created threads this is the turn's user. */
  userId: string
  workspaceId: string
  pageId: string
  /** The doc assistant the thread's session belongs to. */
  assistantId: string
  anchorKind: CommentAnchorKind
  anchorBlockId?: string | null
  quote?: string | null
  /** Optional first comment, seeded as the session's message #1. The AI's
   *  `postComment` passes its comment here so the thread opens non-empty. */
  firstComment?: { role: 'user' | 'assistant'; body: string; senderUserId?: string | null }
}

export type CommentThreadStore = {
  /**
   * Mint the thread's session and the `comment_threads` row atomically, and
   * optionally seed the first comment. Returns the created thread.
   */
  createThread(params: CreateThreadParams): Promise<CommentThread>

  /** Append a comment to a thread's session. */
  addComment(params: {
    userId: string
    threadId: string
    role: 'user' | 'assistant'
    body: string
    senderUserId?: string | null
  }): Promise<CommentMessage>

  /** Fetch a single thread (RLS-scoped). */
  getThread(userId: string, threadId: string): Promise<CommentThread | null>

  /** List a page's threads, newest first. Open-only unless `includeResolved`. */
  listThreadsForPage(
    userId: string,
    pageId: string,
    opts?: { includeResolved?: boolean },
  ): Promise<CommentThread[]>

  /**
   * Discovery index for a page: every OPEN thread plus the latest 10 RESOLVED
   * threads, each carrying its `messageCount` + `lastActivityAt`. Powers the
   * in-page thread-discovery section injected into the doc system prompt.
   * Access is gated by the workspace-membership RLS on `comment_threads`; the
   * message aggregates are read system-side once that gate has passed.
   */
  listThreadSummariesForPage(
    userId: string,
    pageId: string,
  ): Promise<CommentThreadSummary[]>

  /**
   * The full conversation of one thread (its session's messages), oldest
   * first. Returns null when the thread is absent or the user can't access it.
   * The on-demand "read a thread" path behind the `getCommentThread` tool.
   */
  listThreadComments(userId: string, threadId: string): Promise<CommentMessage[] | null>

  /**
   * The ids of a page's EMPTY threads — rows whose session never got a
   * `user`/`assistant` comment. These are half-written artifacts (a thread was
   * minted and its `comment` mark stamped, but the first comment never landed —
   * e.g. an AI-reply turn that failed to fire), not real threads. The editor
   * sweeps their orphaned `comment` marks out of the Yjs doc on page load so the
   * stranded highlight clears.
   *
   * Gated by page access (the workspace-membership RLS on `saved_views`), then
   * emptiness is computed SYSTEM-SIDE: an empty thread carries no content to
   * protect, and its mark lives in the SHARED doc, so any member who can open
   * the page may heal it regardless of the thread's own clearance. Never
   * surfaces a non-empty thread, so it can't leak a clearance-gated thread's id.
   */
  listEmptyThreadIdsForPage(userId: string, pageId: string): Promise<string[]>

  /** Resolve or reopen a thread. Returns the updated row, or null if absent. */
  setResolved(params: {
    userId: string
    threadId: string
    resolved: boolean
  }): Promise<CommentThread | null>

  /**
   * The doc Inbox "pending replies" source: open threads the user STARTED
   * (`created_by = userId`) across a workspace whose latest comment is the
   * assistant's. Derived at read time — it leaves the list the moment the user
   * replies (latest is no longer the AI) or resolves the thread. Newest first.
   * See `docs/architecture/features/doc-inbox.md`.
   */
  listPendingRepliesForUser(
    userId: string,
    workspaceId: string,
  ): Promise<InboxPendingReply[]>
}
