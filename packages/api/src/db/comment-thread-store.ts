/**
 * `CommentThreadStore` adapter — doc comments (chat-as-threads).
 *
 * Fulfils the interface declared in `packages/core/src/doc/comment-types.ts`
 * against the `comment_threads` table (migration 218) + the existing
 * `sessions` / `session_messages` machinery: each thread is backed by its own
 * session, so its comments ARE that session's messages.
 *
 * Session minting reuses `findOrCreateSession` (system write, like every
 * other session create); the thread-row INSERT goes through
 * `queryWithRLS(userId, …)` so the `comment_threads_workspace_member` policy
 * (which doubles as the INSERT `WITH CHECK`) enforces that the user can
 * access the page — the AI can't open a thread on a page the turn's user
 * can't see. The two writes are not wrapped in a single transaction; the
 * only failure mode (thread INSERT rejected after the session is created) is
 * a benign empty `doc_thread` session, invisible to every listing
 * (`fetchLatestSession` filters by `app_origin`, which thread
 * sessions deliberately do NOT set).
 *
 * [COMP:api/comment-thread-store]
 */

import { randomUUID } from 'node:crypto'
import type {
  CommentMessage,
  CommentThread,
  CommentThreadStore,
  CommentThreadSummary,
  CreateThreadParams,
  InboxPendingReply,
} from '@sidanclaw/core'
import { deriveCommentTitle } from '@sidanclaw/core'
import { query, queryWithRLS } from './client.js'
import { findOrCreateSession, addSessionMessage, getSessionMessages } from './sessions.js'

/** The channel_type that marks a session as a comment thread's transcript.
 *  Distinct from 'web' so thread sessions never surface in the page chat
 *  list, and so per-message author attribution can key on it. */
export const COMMENT_THREAD_CHANNEL_TYPE = 'doc_thread'

type ThreadRow = {
  id: string
  pageId: string
  workspaceId: string
  sessionId: string
  anchorKind: CommentThread['anchorKind']
  anchorBlockId: string | null
  quote: string | null
  resolvedAt: Date | null
  resolvedBy: string | null
  createdBy: string
  createdAt: Date
}

const THREAD_COLS = `
  id, page_id as "pageId", workspace_id as "workspaceId",
  session_id as "sessionId", anchor_kind as "anchorKind",
  anchor_block_id as "anchorBlockId", quote,
  resolved_at as "resolvedAt", resolved_by as "resolvedBy",
  created_by as "createdBy", created_at as "createdAt"`

function mapThread(row: ThreadRow): CommentThread {
  return {
    id: row.id,
    pageId: row.pageId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    anchorKind: row.anchorKind,
    anchorBlockId: row.anchorBlockId,
    quote: row.quote,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedBy: row.resolvedBy,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}


/**
 * Flatten a `session_messages.content` JSONB value to plain text. Content is
 * either a stored string (comment seeds) or an array of Anthropic-style
 * content blocks (`{ type, text }`) when the comment came through `/api/chat`.
 * Mirrors `extractMessageText` on the web side.
 */
function coerceBody(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { text: string } =>
          !!b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text)
      .join('\n')
      .trim()
  }
  return ''
}

/** Recursively find a block by id in a page's block tree and return its text. */
function findBlockText(blocks: unknown[], id: string): string | null {
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    const bb = b as { id?: string; text?: unknown; children?: unknown[]; content?: unknown[] }
    if (bb.id === id) return typeof bb.text === 'string' ? bb.text : null
    for (const kids of [bb.children, bb.content]) {
      if (Array.isArray(kids)) {
        const t = findBlockText(kids, id)
        if (t) return t
      }
    }
  }
  return null
}

/** Pull a short text snippet from the anchored block (the live snapshot, or
 *  the legacy `saved_views.page` fallback). RLS-scoped; best-effort. */
async function deriveQuote(
  userId: string,
  pageId: string,
  blockId: string,
): Promise<string | null> {
  try {
    const res = await queryWithRLS<{ page: { blocks?: unknown[] } | null }>(
      userId,
      `SELECT COALESCE(cd.snapshot_json, sv.page) AS page
         FROM saved_views sv
         LEFT JOIN documents cd ON cd.page_id = sv.id
        WHERE sv.id = $1`,
      [pageId],
    )
    const blocks = res.rows[0]?.page?.blocks
    if (!Array.isArray(blocks)) return null
    const text = findBlockText(blocks, blockId)
    if (!text) return null
    const clean = text.replace(/\s+/g, ' ').trim()
    return clean ? clean.slice(0, 80) : null
  } catch {
    return null
  }
}

/**
 * Read each thread's FIRST comment (its session's oldest `user`/`assistant`
 * message) in one system-side pass, then both:
 *   1. **drop empty threads** — a session with no comment is a half-written
 *      artifact (the first comment never landed) and must paint no badge / rail
 *      card / index row (same contract as before), and
 *   2. **attach a `title`** derived from that first comment (`deriveCommentTitle`)
 *      so the comment index can label a page-level (quote-less) thread by what
 *      it's about instead of a generic "Comments".
 *
 * Read SYSTEM-SIDE (bare `query`) on purpose: `session_messages` RLS is
 * owner-only, so an RLS-scoped read would under-count / under-read a teammate's
 * thread. Callers must have already established access to the threads via an
 * RLS query (same contract as the aggregate read in
 * `listThreadSummariesForPage`).
 */
async function attachFirstCommentTitles(threads: CommentThread[]): Promise<CommentThread[]> {
  if (threads.length === 0) return []
  const sessionIds = threads.map((t) => t.sessionId)
  // DISTINCT ON + sequence_num ASC → the opening comment per session. A session
  // absent from the result has no comment → its thread is empty and is filtered
  // out below.
  const res = await query<{ sessionId: string; content: unknown }>(
    `SELECT DISTINCT ON (session_id) session_id as "sessionId", content
       FROM session_messages
      WHERE session_id = ANY($1::uuid[]) AND role IN ('user', 'assistant')
      ORDER BY session_id, sequence_num ASC`,
    [sessionIds],
  )
  const firstBySession = new Map(res.rows.map((r) => [r.sessionId, coerceBody(r.content)]))
  return threads
    .filter((t) => firstBySession.has(t.sessionId))
    .map((t) => ({ ...t, title: deriveCommentTitle(firstBySession.get(t.sessionId) ?? '') }))
}

/**
 * Attach each thread's backing session `status` (`running` while a turn is in
 * flight) so the editor can reconnect a reloaded thread to a still-running turn.
 * System-side (bare `query`) for the same reason as `attachFirstCommentTitles`:
 * `sessions` RLS is owner-only, so a teammate's running thread would otherwise
 * read NULL. Callers must have established thread access via an RLS query first.
 * See docs/architecture/features/doc-comments.md → "Live turn reconnect".
 */
async function attachSessionStatus(threads: CommentThread[]): Promise<CommentThread[]> {
  if (threads.length === 0) return threads
  const res = await query<{ id: string; status: string | null }>(
    `SELECT id, status FROM sessions WHERE id = ANY($1::uuid[])`,
    [threads.map((t) => t.sessionId)],
  )
  const statusBySession = new Map(res.rows.map((r) => [r.id, r.status]))
  return threads.map((t) => ({ ...t, sessionStatus: statusBySession.get(t.sessionId) ?? null }))
}

/** A neutralized comment thread for the public/published page (read-only). */
export type PublicCommentThread = {
  threadId: string
  anchorBlockId: string | null
  quote: string | null
  messages: { author: string; avatar: string | null; body: string; createdAt: string }[]
}

/**
 * System-side read of a page's comment threads for the PUBLIC share view
 * (Notion-style: a published page shows its comments read-only). Returns each
 * unresolved thread's messages with the author's display name (`u.name`, or the
 * guest's `external_author_name`), body, and timestamp. Bare `query` — the
 * anonymous viewer is not a member, and access to the page is gated upstream
 * (live link/published grant + clearance). Only name + body + time are surfaced.
 */
export async function listPublicThreadsForPage(pageId: string): Promise<PublicCommentThread[]> {
  const threads = await query<ThreadRow>(
    `SELECT ${THREAD_COLS} FROM comment_threads
      WHERE page_id = $1 AND resolved_at IS NULL
      ORDER BY created_at ASC`,
    [pageId],
  )
  if (threads.rows.length === 0) return []
  const sessionIds = threads.rows.map((t) => t.sessionId)
  const msgs = await query<{
    sessionId: string
    author: string | null
    avatar: string | null
    content: unknown
    createdAt: Date
  }>(
    `SELECT m.session_id AS "sessionId",
            COALESCE(ct.external_author_name, u.name) AS author,
            CASE WHEN ct.external_author_name IS NOT NULL THEN NULL ELSE u.avatar_url END AS avatar,
            m.content, m.created_at AS "createdAt"
       FROM session_messages m
       JOIN comment_threads ct ON ct.session_id = m.session_id
       LEFT JOIN users u ON u.id = m.sender_user_id
      WHERE m.session_id = ANY($1::uuid[]) AND m.role IN ('user', 'assistant')
      ORDER BY m.session_id, m.sequence_num ASC`,
    [sessionIds],
  )
  const bySession = new Map<string, PublicCommentThread['messages']>()
  for (const r of msgs.rows) {
    const body = coerceBody(r.content)
    if (!body) continue
    const list = bySession.get(r.sessionId) ?? []
    list.push({ author: r.author || 'Member', avatar: r.avatar, body, createdAt: r.createdAt.toISOString() })
    bySession.set(r.sessionId, list)
  }
  return threads.rows
    .map((t) => ({
      threadId: t.id,
      anchorBlockId: t.anchorBlockId,
      quote: t.quote,
      messages: bySession.get(t.sessionId) ?? [],
    }))
    .filter((t) => t.messages.length > 0)
}

export function createDbCommentThreadStore(): CommentThreadStore {
  return {
    async createThread(params: CreateThreadParams): Promise<CommentThread> {
      // The thread's read-clearance = the owning ASSISTANT's clearance
      // (migration 224). Read it system-side (the denormalization source) and
      // stamp it on BOTH the session and the comment_threads row, so the
      // workspace RLS policies can gate reads without ever reading
      // `assistants` (whose RLS recurses through assistant_members).
      const clearanceRow = await query<{ clearance: string }>(
        `SELECT clearance FROM assistants WHERE id = $1`,
        [params.assistantId],
      )
      const effectiveClearance = clearanceRow.rows[0]?.clearance ?? 'internal'

      // 1. Mint the thread's session (system write, like every session). A
      //    random channel_id keeps the unique key satisfied; the thread is
      //    always resumed by session_id, never by (user, channel).
      const session = await findOrCreateSession({
        assistantId: params.assistantId,
        userId: params.userId,
        channelType: COMMENT_THREAD_CHANNEL_TYPE,
        channelId: randomUUID(),
        // A comment thread is a workspace artifact: any member of the
        // assistant's workspace may read its transcript (migration 223
        // sessions_workspace_shared RLS + the GET /:id/messages branch),
        // even though `user_id` records only the thread's creator.
        // workspace_id backs the RLS gate (the policy avoids reading
        // `assistants`, whose RLS recurses through assistant_members);
        // effective_clearance carries the assistant's clearance for the gate.
        visibility: 'workspace',
        workspaceId: params.workspaceId,
        effectiveClearance,
      })

      // 2. Derive the quote from the anchored block's text when the caller
      //    didn't supply one (a terse AI `postComment` often won't), so the
      //    thread always has a meaningful label in the comment list.
      let quote = params.quote ?? null
      if (!quote && params.anchorBlockId) {
        quote = await deriveQuote(params.userId, params.pageId, params.anchorBlockId)
      }

      // 3. Insert the thread row — RLS-checked (enforces page access).
      const res = await queryWithRLS<ThreadRow>(
        params.userId,
        `INSERT INTO comment_threads
           (page_id, workspace_id, session_id, anchor_kind, anchor_block_id, quote, created_by, effective_clearance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${THREAD_COLS}`,
        [
          params.pageId,
          params.workspaceId,
          session.id,
          params.anchorKind,
          params.anchorBlockId ?? null,
          quote,
          params.userId,
          effectiveClearance,
        ],
      )
      const thread = mapThread(res.rows[0])

      // 3. Seed the first comment, if any.
      if (params.firstComment) {
        await addSessionMessage({
          sessionId: session.id,
          role: params.firstComment.role,
          content: params.firstComment.body,
          senderUserId: params.firstComment.senderUserId ?? null,
        })
      }
      return thread
    },

    async addComment(params: {
      userId: string
      threadId: string
      role: 'user' | 'assistant'
      body: string
      senderUserId?: string | null
    }): Promise<CommentMessage> {
      // Resolve the thread → its session (RLS-scoped), then append.
      const t = await queryWithRLS<{ sessionId: string }>(
        params.userId,
        `SELECT session_id as "sessionId" FROM comment_threads WHERE id = $1`,
        [params.threadId],
      )
      const sessionId = t.rows[0]?.sessionId
      if (!sessionId) {
        throw new Error(`comment thread not found or not accessible: ${params.threadId}`)
      }
      const msg = await addSessionMessage({
        sessionId,
        role: params.role,
        content: params.body,
        senderUserId: params.senderUserId ?? null,
      })
      return {
        id: msg.id,
        threadId: params.threadId,
        role: params.role,
        body: params.body,
        senderUserId: params.senderUserId ?? null,
        createdAt:
          msg.createdAt instanceof Date ? msg.createdAt.toISOString() : String(msg.createdAt),
      }
    },

    async getThread(userId: string, threadId: string): Promise<CommentThread | null> {
      const res = await queryWithRLS<ThreadRow>(
        userId,
        `SELECT ${THREAD_COLS} FROM comment_threads WHERE id = $1`,
        [threadId],
      )
      if (!res.rows[0]) return null
      const [withStatus] = await attachSessionStatus([mapThread(res.rows[0])])
      return withStatus
    },

    async listThreadsForPage(
      userId: string,
      pageId: string,
      opts?: { includeResolved?: boolean },
    ): Promise<CommentThread[]> {
      const onlyOpen = !opts?.includeResolved
      const res = await queryWithRLS<ThreadRow>(
        userId,
        `SELECT ${THREAD_COLS} FROM comment_threads
         WHERE page_id = $1 ${onlyOpen ? 'AND resolved_at IS NULL' : ''}
         ORDER BY created_at DESC`,
        [pageId],
      )
      // Hide empty threads (the first comment never landed) — they must not
      // paint a highlight, gutter badge, or rail card — AND attach each
      // surviving thread's first-comment `title` for the comment index, then
      // its backing session `status` (for the live-turn reconnect indicator).
      // The RLS query above established access; both reads are then system-side.
      return attachSessionStatus(await attachFirstCommentTitles(res.rows.map(mapThread)))
    },

    async listThreadSummariesForPage(
      userId: string,
      pageId: string,
    ): Promise<CommentThreadSummary[]> {
      // Two RLS queries (deterministic ordering, vs. relying on UNION ALL
      // branch order): every open thread, then the latest 10 resolved. The
      // `comment_threads_workspace_member` policy gates both to threads on a
      // page the user can access.
      const [open, resolved] = await Promise.all([
        queryWithRLS<ThreadRow>(
          userId,
          `SELECT ${THREAD_COLS} FROM comment_threads
           WHERE page_id = $1 AND resolved_at IS NULL
           ORDER BY created_at DESC`,
          [pageId],
        ),
        queryWithRLS<ThreadRow>(
          userId,
          `SELECT ${THREAD_COLS} FROM comment_threads
           WHERE page_id = $1 AND resolved_at IS NOT NULL
           ORDER BY resolved_at DESC
           LIMIT 10`,
          [pageId],
        ),
      ])
      const threads = [...open.rows, ...resolved.rows].map(mapThread)
      if (threads.length === 0) return []

      // Message aggregates. Read system-side (bare `query`) — authorization was
      // just established by the RLS thread queries above; `session_messages`
      // RLS is owner-only and would under-count a teammate's thread.
      const sessionIds = threads.map((t) => t.sessionId)
      const agg = await query<{
        sessionId: string
        messageCount: string
        lastActivityAt: Date | null
      }>(
        `SELECT session_id as "sessionId", COUNT(*)::int as "messageCount",
                MAX(created_at) as "lastActivityAt"
         FROM session_messages
         WHERE session_id = ANY($1::uuid[]) AND role IN ('user', 'assistant')
         GROUP BY session_id`,
        [sessionIds],
      )
      const bySession = new Map(agg.rows.map((r) => [r.sessionId, r]))

      return threads
        .map((t) => {
          const a = bySession.get(t.sessionId)
          return {
            ...t,
            messageCount: a ? Number(a.messageCount) : 0,
            lastActivityAt: a?.lastActivityAt ? a.lastActivityAt.toISOString() : null,
          }
        })
        // Drop empty threads — a half-written artifact has nothing for the AI to
        // discover, and listing it as "0 msgs" would invite a pointless read.
        .filter((t) => t.messageCount > 0)
    },

    async listThreadComments(
      userId: string,
      threadId: string,
    ): Promise<CommentMessage[] | null> {
      // RLS gate: only resolves for a thread on a page the user can access.
      const t = await queryWithRLS<{ sessionId: string }>(
        userId,
        `SELECT session_id as "sessionId" FROM comment_threads WHERE id = $1`,
        [threadId],
      )
      const sessionId = t.rows[0]?.sessionId
      if (!sessionId) return null

      // Messages read system-side (access established above). Keep only the
      // human/assistant comments — system/tool rows aren't part of the thread.
      const rows = await getSessionMessages(sessionId)
      return rows
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          id: m.id,
          threadId,
          role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          body: coerceBody(m.content),
          senderUserId: m.senderUserId ?? null,
          createdAt:
            m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
        }))
    },

    async listEmptyThreadIdsForPage(userId: string, pageId: string): Promise<string[]> {
      // Gate on PAGE access (the workspace-membership RLS on saved_views) — the
      // same gate that lets the user open the page they're sweeping marks on.
      const access = await queryWithRLS<{ ok: number }>(
        userId,
        `SELECT 1 AS ok FROM saved_views WHERE id = $1`,
        [pageId],
      )
      if (access.rows.length === 0) return []
      // Emptiness is computed SYSTEM-SIDE (bare query, no per-thread clearance
      // gate): an empty thread holds no content to protect, and its `comment`
      // mark lives in the SHARED Yjs doc, so any member who can open the page
      // should be able to heal the stranded highlight. A non-empty thread is
      // never returned, so a clearance-gated thread's id can't leak here.
      const res = await query<{ id: string }>(
        `SELECT t.id FROM comment_threads t
          WHERE t.page_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM session_messages m
               WHERE m.session_id = t.session_id
                 AND m.role IN ('user', 'assistant')
            )`,
        [pageId],
      )
      return res.rows.map((r) => r.id)
    },

    async setResolved(params: {
      userId: string
      threadId: string
      resolved: boolean
    }): Promise<CommentThread | null> {
      const res = await queryWithRLS<ThreadRow>(
        params.userId,
        `UPDATE comment_threads
            SET resolved_at = ${params.resolved ? 'now()' : 'NULL'},
                resolved_by = ${params.resolved ? '$2' : 'NULL'}
          WHERE id = $1
          RETURNING ${THREAD_COLS}`,
        params.resolved ? [params.threadId, params.userId] : [params.threadId],
      )
      return res.rows[0] ? mapThread(res.rows[0]) : null
    },

    async listPendingRepliesForUser(
      userId: string,
      workspaceId: string,
    ): Promise<InboxPendingReply[]> {
      // Same two-step shape as listThreadSummariesForPage: an RLS thread query
      // (gated by comment_threads_workspace_member) establishes access, then a
      // system-side session_messages read finds each thread's latest comment.
      // We only want threads the user STARTED, so created_by = userId — which
      // also means the user owns each thread's session, but the system-side
      // read keeps us robust to the owner-only session_messages policy either
      // way. Open threads only; the AI-pending state is "latest comment is the
      // assistant's".
      const threadsRes = await queryWithRLS<{
        threadId: string
        pageId: string
        sessionId: string
        pageTitle: string
        quote: string | null
      }>(
        userId,
        `SELECT t.id as "threadId", t.page_id as "pageId",
                t.session_id as "sessionId", sv.name as "pageTitle", t.quote
           FROM comment_threads t
           JOIN saved_views sv ON sv.id = t.page_id
          WHERE t.created_by = $1
            AND t.workspace_id = $2
            AND t.resolved_at IS NULL`,
        [userId, workspaceId],
      )
      if (threadsRes.rows.length === 0) return []

      const sessionIds = threadsRes.rows.map((t) => t.sessionId)
      // Latest user/assistant comment per session (system-side — access was
      // just established above). DISTINCT ON + sequence_num DESC picks the most
      // recent comment in each thread.
      const latest = await query<{
        sessionId: string
        role: 'user' | 'assistant'
        createdAt: Date
      }>(
        `SELECT DISTINCT ON (session_id)
                session_id as "sessionId", role, created_at as "createdAt"
           FROM session_messages
          WHERE session_id = ANY($1::uuid[]) AND role IN ('user', 'assistant')
          ORDER BY session_id, sequence_num DESC`,
        [sessionIds],
      )
      const latestBySession = new Map(latest.rows.map((r) => [r.sessionId, r]))

      const pending: InboxPendingReply[] = []
      for (const t of threadsRes.rows) {
        const last = latestBySession.get(t.sessionId)
        if (!last || last.role !== 'assistant') continue
        pending.push({
          threadId: t.threadId,
          pageId: t.pageId,
          pageTitle: t.pageTitle ?? '',
          quote: t.quote,
          lastActivityAt: last.createdAt.toISOString(),
        })
      }
      // Newest assistant reply first.
      pending.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      return pending
    },
  }
}
