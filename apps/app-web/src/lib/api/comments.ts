/**
 * SDK for doc comments (chat-as-threads).
 *
 * Thin typed wrappers around the human-initiated thread routes in
 * `packages/api/src/routes/comments.ts`. All calls go through `authFetch`
 * for transparent token refresh.
 *
 * Wire types are declared locally (not imported from `@sidanclaw/core` —
 * the core barrel pulls in fs-using modules that break the browser bundle;
 * same constraint as `lib/api/views.ts`). They mirror `CommentThread` in
 * `packages/core/src/doc/comment-types.ts`; the server Zod validators are
 * the authoritative contract.
 *
 * A thread's comment messages are read with the existing
 * `fetchSessionMessages(thread.sessionId)` (`lib/api/sessions.ts`); a reply
 * that should wake the AI is sent through the chat stream with that
 * `sessionId`.
 *
 * [COMP:app-web/comments-sdk]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type CommentAnchorKind = "human_range" | "ai_block" | "human_block";

export type CommentThread = {
  id: string;
  pageId: string;
  workspaceId: string;
  sessionId: string;
  anchorKind: CommentAnchorKind;
  anchorBlockId: string | null;
  quote: string | null;
  /** Read-time label derived from the thread's FIRST comment (computed
   *  server-side by the list endpoints) — the comment index shows it so a
   *  page-level (quote-less) thread reads as what it's about instead of a
   *  generic "Comments". Absent on the single-thread responses
   *  (`createCommentThread` / `setThreadResolved`). */
  title?: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdBy: string;
  createdAt: string;
  /** The backing session's status (`running` while a turn is in flight),
   *  attached server-side by the list endpoints. The thread body uses it to
   *  reconnect a reloaded thread to a still-running turn and show the live
   *  "working…" indicator. Absent on the single-thread create/resolve
   *  responses. See doc-comments.md → "Live turn reconnect". */
  sessionStatus?: string | null;
};

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`comments API ${res.status}`);
  return (await res.json()) as T;
}

/** List a page's threads. Open-only unless `includeResolved`. Returns []
 *  on error so the gutter degrades gracefully (no thread badges) rather
 *  than throwing into the editor. */
export async function listPageThreads(
  pageId: string,
  opts: { includeResolved?: boolean; signal?: AbortSignal } = {},
): Promise<CommentThread[]> {
  const qs = opts.includeResolved ? "?includeResolved=1" : "";
  try {
    const res = await authFetch(
      `${API_URL}/api/pages/${pageId}/comment-threads${qs}`,
      opts.signal ? { signal: opts.signal } : {},
    );
    if (!res.ok) return [];
    return (await res.json()) as CommentThread[];
  } catch {
    return [];
  }
}

/** Create a human thread and optionally seed its first comment. Defaults to a
 *  `human_range` thread (the floating-toolbar "Comment" action) — the caller
 *  then stamps the `comment` mark with `thread.id`. Pass
 *  `anchorKind:"human_block"` to anchor on an atom block (chart / image / … —
 *  no inner text to mark); that thread renders as a whole-block highlight from
 *  `anchorBlockId` and is NOT mark-stamped. */
export async function createCommentThread(params: {
  pageId: string;
  assistantId: string;
  workspaceId: string;
  anchorKind?: "human_range" | "human_block";
  anchorBlockId?: string;
  quote?: string;
  body?: string;
}): Promise<CommentThread> {
  const res = await authFetch(
    `${API_URL}/api/pages/${params.pageId}/comment-threads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantId: params.assistantId,
        workspaceId: params.workspaceId,
        anchorKind: params.anchorKind,
        anchorBlockId: params.anchorBlockId,
        quote: params.quote,
        body: params.body,
      }),
    },
  );
  return asJson<CommentThread>(res);
}

/** Ids of the page's EMPTY threads (the first comment never landed) — the
 *  editor sweeps their orphaned `comment` marks out of the Yjs doc on load so a
 *  stranded amber highlight clears. Returns [] on error: the sweep is
 *  best-effort cleanup and must never block the editor. */
export async function listEmptyThreadIds(pageId: string): Promise<string[]> {
  try {
    const res = await authFetch(
      `${API_URL}/api/pages/${pageId}/comment-threads/empty`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { emptyThreadIds?: string[] };
    return Array.isArray(data.emptyThreadIds) ? data.emptyThreadIds : [];
  } catch {
    return [];
  }
}

/** A single comment message (the `addCommentMessage` return shape). */
export type CommentMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  body: string;
  senderUserId: string | null;
  createdAt: string;
};

/** Append a PLAIN human comment to a thread — no AI turn (the "AI reply off"
 *  path). The AI-reply path posts through `/api/chat` with the thread's
 *  sessionId instead; this just stores the message for teammates to read. */
export async function addCommentMessage(
  threadId: string,
  body: string,
): Promise<CommentMessage> {
  const res = await authFetch(`${API_URL}/api/comment-threads/${threadId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  return asJson<CommentMessage>(res);
}

/** Resolve or reopen a thread. */
export async function setThreadResolved(
  threadId: string,
  resolved: boolean,
): Promise<CommentThread> {
  const res = await authFetch(`${API_URL}/api/comment-threads/${threadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolved }),
  });
  return asJson<CommentThread>(res);
}
