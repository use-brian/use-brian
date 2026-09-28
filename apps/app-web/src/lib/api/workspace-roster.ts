/**
 * Cached workspace-roster loader — the member list behind the Brain's
 * assignee affordances (the entry page's Assignee row and the grouped
 * list's assignee avatar), both of which resolve a task's `assignee_id`
 * (a `workspace_members` row id) to a person via `resolveAssignee`.
 *
 * The task-shaped rows are derived from the same bounded member-directory
 * projection used by mentions and Office controls. There is no second broad
 * workspace-detail request or session-long promise map.
 *
 * [COMP:app-web/brain-property-fields]
 */

import type { FeedWorkspaceMember } from "@/lib/api/feed";
import { getUserInfo } from "@/lib/user";
import { loadSurfaceCache, readSurfaceCache } from "@/lib/surface-cache";
import { workspaceMemberDirectoryCacheKey } from "@/lib/surface-prefetch";
import { projectionRemainingMs } from "@/lib/use-protected-projection";
import {
  readWorkspaceMemberDirectory,
  type WorkspaceMemberDirectory,
} from "@/lib/api/mentions";

export async function loadWorkspaceRoster(
  workspaceId: string,
): Promise<FeedWorkspaceMember[]> {
  const viewerId=getUserInfo()?.id;
  if(!viewerId)return [];
  const key=workspaceMemberDirectoryCacheKey(workspaceId,viewerId);
  let directory=readSurfaceCache<WorkspaceMemberDirectory>(key).data;
  if(!directory||projectionRemainingMs(directory)<=0){
    directory=await loadSurfaceCache(key,()=>readWorkspaceMemberDirectory(workspaceId,viewerId),{expiresInMs:projectionRemainingMs});
  }
  if(!directory||projectionRemainingMs(directory)<=0)return [];
  return directory.members.map(member=>({
    id:member.memberId,
    userId:member.userId,
    email:member.email,
    userName:member.name,
    avatarUrl:member.avatarUrl,
    role:member.role,
    canDraft:member.canDraft,
  }));
}
