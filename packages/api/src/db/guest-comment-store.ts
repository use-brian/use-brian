/**
 * Guest comment store (migration 251) — Phase 2 of doc page sharing.
 *
 * External guests comment on a publicly-shared page with no workspace account.
 * Per §12: the public route is the AUTH GATE (it validates the link token +
 * the per-guest `guest_session_token` before calling here), so every method
 * here writes/reads **system-side** (bare `query` / the system `findOrCreate
 * Session`) — the member-RLS `createDbCommentThreadStore` would reject the
 * non-member sentinel. Identity = a shared sentinel "Doc Guest" user filling
 * the NOT NULL FKs + `external_author_name` carrying the real display name.
 *
 * Privacy (§12 D3/D5): a guest sees ONLY their own threads + their own
 * messages (scoped by `guest_session_token`); member/assistant replies are
 * hidden from guests in Phase 2 (guest comments are inert / owner-reviewable),
 * which also makes a member-identity leak impossible.
 *
 * [COMP:doc/guest-comment]
 */

import { randomUUID } from 'node:crypto'
import { query } from './client.js'
import { findOrCreateSession, addSessionMessage } from './sessions.js'
import { COMMENT_THREAD_CHANNEL_TYPE } from './comment-thread-store.js'

/** Shared sentinel user (migration 251) — fills FKs for guest comments. */
export const SENTINEL_GUEST_USER_ID = '00000000-0000-0000-0000-0000000c0a57'

export type CreateGuestThreadParams = {
  pageId: string
  workspaceId: string
  guestName: string
  guestEmail?: string | null
  guestSessionToken: string
  anchorKind?: 'human_range' | 'human_block'
  anchorBlockId?: string | null
  quote?: string | null
  body: string
}

export type GuestComment = { body: string; createdAt: string }
export type GuestThreadView = {
  threadId: string
  anchorBlockId: string | null
  quote: string | null
  createdAt: string
  authorName: string | null
  comments: GuestComment[]
}

/**
 * Create a guest thread + seed its first comment, all system-side. The route
 * has already validated the live `comment` link grant + the page is public.
 */
export async function createGuestThread(params: CreateGuestThreadParams): Promise<{ threadId: string }> {
  // The thread's session needs an assistant FK; use the workspace's primary
  // (the doc page author). Resolved system-side — the route already gated.
  const a = await query<{ id: string }>(
    `SELECT id FROM assistants WHERE workspace_id = $1 AND kind = 'primary' ORDER BY created_at ASC LIMIT 1`,
    [params.workspaceId],
  )
  const assistantId = a.rows[0]?.id
  if (!assistantId) throw new Error(`no primary assistant for workspace ${params.workspaceId}`)

  // 1. Mint the thread's session under the sentinel user (system write), then
  //    stamp the per-guest capability token on it.
  const session = await findOrCreateSession({
    assistantId,
    userId: SENTINEL_GUEST_USER_ID,
    channelType: COMMENT_THREAD_CHANNEL_TYPE,
    channelId: randomUUID(),
    // Visible to workspace members (it's a comment on their public page); the
    // page is public, so the thread reads at public clearance.
    visibility: 'workspace',
    workspaceId: params.workspaceId,
    effectiveClearance: 'public',
  })
  await query(`UPDATE sessions SET guest_session_token = $1 WHERE id = $2`, [
    params.guestSessionToken,
    session.id,
  ])

  // 2. Insert the thread row system-side (the sentinel is not a member, so
  //    the member-RLS insert path would reject it; the route is the gate).
  const res = await query<{ id: string }>(
    `INSERT INTO comment_threads
       (page_id, workspace_id, session_id, anchor_kind, anchor_block_id, quote,
        created_by, effective_clearance, external_author_name, external_author_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'public', $8, $9)
     RETURNING id`,
    [
      params.pageId,
      params.workspaceId,
      session.id,
      params.anchorKind ?? 'human_range',
      params.anchorBlockId ?? null,
      params.quote ?? null,
      SENTINEL_GUEST_USER_ID,
      params.guestName,
      params.guestEmail ?? null,
    ],
  )
  const threadId = res.rows[0].id

  // 3. Seed the first comment (authored by the sentinel; display name lives on
  //    the thread row).
  await addSessionMessage({
    sessionId: session.id,
    role: 'user',
    content: params.body,
    senderUserId: SENTINEL_GUEST_USER_ID,
  })

  return { threadId }
}

/**
 * Append a guest comment to one of the guest's OWN threads. Validates the
 * thread belongs to this guest (its session carries the same token) AND to the
 * resolved page — returns false otherwise (route → 403/404).
 */
export async function addGuestComment(params: {
  threadId: string
  pageId: string
  guestSessionToken: string
  body: string
}): Promise<boolean> {
  const t = await query<{ sessionId: string }>(
    `SELECT ct.session_id AS "sessionId"
       FROM comment_threads ct
       JOIN sessions s ON s.id = ct.session_id
      WHERE ct.id = $1
        AND ct.page_id = $2
        AND s.guest_session_token = $3`,
    [params.threadId, params.pageId, params.guestSessionToken],
  )
  const sessionId = t.rows[0]?.sessionId
  if (!sessionId) return false
  await addSessionMessage({
    sessionId,
    role: 'user',
    content: params.body,
    senderUserId: SENTINEL_GUEST_USER_ID,
  })
  return true
}

/**
 * List the guest's OWN threads on a page (scoped by token) + their own
 * messages. Member/assistant messages are excluded (Phase 2 privacy: a guest
 * never sees other authors or member identity).
 */
export async function listGuestComments(
  pageId: string,
  guestSessionToken: string,
): Promise<GuestThreadView[]> {
  const threads = await query<{
    threadId: string
    sessionId: string
    anchorBlockId: string | null
    quote: string | null
    createdAt: Date
    authorName: string | null
  }>(
    `SELECT ct.id AS "threadId", ct.session_id AS "sessionId",
            ct.anchor_block_id AS "anchorBlockId", ct.quote,
            ct.created_at AS "createdAt", ct.external_author_name AS "authorName"
       FROM comment_threads ct
       JOIN sessions s ON s.id = ct.session_id
      WHERE ct.page_id = $1 AND s.guest_session_token = $2
      ORDER BY ct.created_at ASC`,
    [pageId, guestSessionToken],
  )
  if (threads.rows.length === 0) return []

  const sessionIds = threads.rows.map((r) => r.sessionId)
  // Only the guest's own messages (sender = sentinel) — never member/AI rows.
  const msgs = await query<{ sessionId: string; content: unknown; createdAt: Date }>(
    `SELECT session_id AS "sessionId", content, created_at AS "createdAt"
       FROM session_messages
      WHERE session_id = ANY($1::uuid[])
        AND sender_user_id = $2
        AND role = 'user'
      ORDER BY sequence_num ASC`,
    [sessionIds, SENTINEL_GUEST_USER_ID],
  )
  const bySession = new Map<string, GuestComment[]>()
  for (const m of msgs.rows) {
    const body = typeof m.content === 'string' ? m.content : ''
    const list = bySession.get(m.sessionId) ?? []
    list.push({ body, createdAt: m.createdAt.toISOString() })
    bySession.set(m.sessionId, list)
  }

  return threads.rows.map((t) => ({
    threadId: t.threadId,
    anchorBlockId: t.anchorBlockId,
    quote: t.quote,
    createdAt: t.createdAt.toISOString(),
    authorName: t.authorName,
    comments: bySession.get(t.sessionId) ?? [],
  }))
}
