/**
 * SDK for the doc Inbox + mention recording.
 *
 * Thin typed wrappers around the inbox routes in
 * `packages/api/src/routes/inbox.ts`. All calls go through `authFetch` for
 * transparent token refresh.
 *
 * Wire types are declared locally (not imported from `@use-brian/core` — the
 * core barrel pulls in fs-using modules that break the browser bundle; same
 * constraint as `lib/api/comments.ts` / `views.ts`). They mirror
 * `packages/core/src/doc/inbox-types.ts`; the server is authoritative.
 *
 * [COMP:app-web/inbox-sdk]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type InboxPendingReply = {
  threadId: string;
  pageId: string;
  pageTitle: string;
  quote: string | null;
  lastActivityAt: string;
};

export type InboxMention = {
  id: string;
  pageId: string;
  pageTitle: string;
  threadId: string | null;
  actorUserId: string;
  actorName: string | null;
  preview: string | null;
  createdAt: string;
  readAt: string | null;
};

export type InboxPayload = {
  pending: InboxPendingReply[];
  mentions: InboxMention[];
  pendingCount: number;
  unreadMentionCount: number;
};

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`inbox API ${res.status}`);
  return (await res.json()) as T;
}

/** The merged Inbox payload for a workspace (pending replies + mentions). */
export async function fetchInbox(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<InboxPayload> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/inbox`,
    opts.signal ? { signal: opts.signal } : {},
  );
  return asJson<InboxPayload>(res);
}

/** The unread-badge total: pending replies + unread mentions. Returns 0 on
 *  error so the sidebar badge degrades silently. */
export async function fetchInboxBadgeCount(workspaceId: string): Promise<number> {
  try {
    const p = await fetchInbox(workspaceId);
    return p.pendingCount + p.unreadMentionCount;
  } catch {
    return 0;
  }
}

/** Mark mentions read. Omit `ids` to mark all of the caller's mentions read. */
export async function markInboxRead(workspaceId: string, ids?: string[]): Promise<void> {
  await authFetch(`${API_URL}/api/workspaces/${workspaceId}/inbox/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ids ? { ids } : {}),
  });
}

/**
 * Record an @-mention to each recipient's Inbox. One uniform path for a
 * page-body mention (omit `threadId`) and a comment mention (`threadId` set).
 * Best-effort: a failure must never block the edit that triggered it, so
 * callers fire-and-forget and this swallows errors.
 */
export async function recordDocMention(params: {
  workspaceId: string;
  pageId: string;
  threadId?: string;
  mentionedUserIds: string[];
  preview?: string;
}): Promise<void> {
  if (params.mentionedUserIds.length === 0) return;
  try {
    await authFetch(`${API_URL}/api/workspaces/${params.workspaceId}/doc-mentions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageId: params.pageId,
        threadId: params.threadId,
        mentionedUserIds: params.mentionedUserIds,
        preview: params.preview,
      }),
    });
  } catch {
    // Best-effort; the comment / page edit already succeeded.
  }
}
