/**
 * Resolvers for the inline `@`-mention popup (people + pages tabs).
 *
 *   - `fetchMembers(workspaceId, query)` → workspace members, filtered by
 *     a case-insensitive substring over name/email. Backed by
 *     `GET /api/workspaces/:id` (the workspace-detail route returns
 *     `members[]`); we cache the list per workspace for the session so each
 *     keystroke doesn't re-hit the network — the popup is a fast local
 *     filter once the roster is loaded.
 *   - `fetchPages(workspaceId, query)` → saved + draft pages, filtered by a
 *     substring over the page name. Backed by the existing `listViews` SDK.
 *
 * Both return the trim shapes the shared `<MentionPopup>` expects
 * (`PersonMentionItem` / `PageMentionItem`). Empty query returns a small
 * recent-ish slice (the first N rows) — the popup's "recents" cue.
 *
 * [COMP:app-web/mention-fetchers]
 */

import { authFetch } from "@/lib/auth-fetch";
import { listViews } from "@/lib/api/views";
import type {
  PageMentionItem,
  PersonMentionItem,
} from "@/components/doc/mentions/mention-popup";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** How many rows the popup shows for an empty query (the "recent" cue). */
const EMPTY_QUERY_CAP = 8;

type WorkspaceMemberWire = {
  userId: string;
  userName: string | null;
  email: string | null;
  avatarUrl: string | null;
};

// Per-workspace roster cache, keyed by workspace id. Mentions don't need
// fresh-on-every-keystroke member data — the roster changes rarely, and the
// popup filters locally. Cleared on a full reload.
const memberCache = new Map<string, Promise<PersonMentionItem[]>>();

async function loadMembers(workspaceId: string): Promise<PersonMentionItem[]> {
  const cached = memberCache.get(workspaceId);
  if (cached) return cached;
  const promise = (async () => {
    const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`);
    if (!res.ok) return [];
    const body = (await res.json()) as { members?: WorkspaceMemberWire[] };
    return (body.members ?? []).map(
      (m): PersonMentionItem => ({
        kind: "person",
        id: m.userId,
        name: m.userName || m.email || "Member",
        email: m.email,
        avatarUrl: m.avatarUrl,
      }),
    );
  })();
  memberCache.set(workspaceId, promise);
  // Don't poison the cache on a transient failure.
  promise.catch(() => memberCache.delete(workspaceId));
  return promise;
}

/** `@person` resolver — workspace members, substring-filtered by name/email. */
export async function fetchMembers(
  workspaceId: string,
  query: string,
): Promise<PersonMentionItem[]> {
  const all = await loadMembers(workspaceId);
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, EMPTY_QUERY_CAP);
  return all.filter(
    (m) =>
      m.name.toLowerCase().includes(q) ||
      (m.email ? m.email.toLowerCase().includes(q) : false),
  );
}

/** `@page` resolver — saved + draft pages, substring-filtered by title. */
export async function fetchPages(
  workspaceId: string,
  query: string,
): Promise<PageMentionItem[]> {
  const rows = await listViews({ workspaceId, state: "all" });
  const q = query.trim().toLowerCase();
  const mapped = rows.map(
    (r): PageMentionItem => ({ kind: "page", id: r.id, title: r.name }),
  );
  if (!q) return mapped.slice(0, EMPTY_QUERY_CAP);
  return mapped.filter((p) => p.title.toLowerCase().includes(q));
}
