/**
 * Cached workspace-roster loader — the member list behind the Brain's
 * assignee affordances (the entry page's Assignee row and the grouped
 * list's assignee avatar), both of which resolve a task's `assignee_id`
 * (a `workspace_members` row id) to a person via `resolveAssignee`.
 *
 * The roster changes rarely and these surfaces re-render often, so one
 * fetch per workspace per page load is plenty (mirrors the mention
 * popup's cache in lib/api/mentions.ts). A failed fetch is not cached,
 * so the next call retries.
 *
 * [COMP:app-web/brain-property-fields]
 */

import {
  fetchFeedWorkspaceMembers,
  type FeedWorkspaceMember,
} from "@/lib/api/feed";

const rosterCache = new Map<string, Promise<FeedWorkspaceMember[]>>();

export function loadWorkspaceRoster(
  workspaceId: string,
): Promise<FeedWorkspaceMember[]> {
  const cached = rosterCache.get(workspaceId);
  if (cached) return cached;
  const promise = fetchFeedWorkspaceMembers(workspaceId);
  rosterCache.set(workspaceId, promise);
  promise.catch(() => rosterCache.delete(workspaceId));
  return promise;
}
