/**
 * Workspace directory — the `WorkspaceDirectoryStore` the core roster tool
 * (`listWorkspaceMembers`), view bindings and synthesizers read through.
 *
 * A thin projection over `WorkspaceStore.listMembers`: `workspace_members.id`
 * (the value `tasks.assignee_id` references) plus the joined user's name /
 * email / avatar. `listMembers` additionally marks the CALLER's own row with
 * `isCurrentUser: true` so the model can resolve "me" / "my tasks" to an
 * assignee id without name-matching itself against the roster (2026-08-19:
 * a Slack "how many open tasks do I have?" was answered from a teammate's
 * id after exactly that guess). `get` / `batchGet` have no caller in the
 * loop and never set it.
 *
 * Spec: docs/architecture/platform/workspaces.md → "Member directory tool".
 * `[COMP:workspace/tools]`.
 */
import type { WorkspaceDirectoryStore, WorkspaceMemberInfo } from '@use-brian/core'
import type { WorkspaceMember, WorkspaceStore } from './workspace-store.js'

type DirectoryWorkspaceStore = Pick<WorkspaceStore, 'getMembership' | 'listMembers'>

/** Project one `workspace_members` row into the roster shape the tool returns. */
export function toWorkspaceMemberInfo(
  m: Pick<WorkspaceMember, 'id' | 'userId' | 'role' | 'userName' | 'email' | 'avatarUrl'>,
  callerUserId: string | null,
): WorkspaceMemberInfo {
  return {
    memberId: m.id,
    name: m.userName ?? null,
    email: m.email ?? null,
    avatarUrl: m.avatarUrl ?? null,
    role: m.role,
    ...(callerUserId && m.userId === callerUserId ? { isCurrentUser: true as const } : {}),
  }
}

export function createWorkspaceDirectoryStore(workspaceStore: DirectoryWorkspaceStore): WorkspaceDirectoryStore {
  const store: WorkspaceDirectoryStore = {
    async listMembers(userId, workspaceId) {
      const membership = await workspaceStore.getMembership(userId, workspaceId)
      if (!membership) return []
      const members = await workspaceStore.listMembers(userId, workspaceId)
      return members.map((m) => toWorkspaceMemberInfo(m, userId))
    },
    async get(workspaceId, memberId) {
      const map = await store.batchGet(workspaceId, [memberId])
      return map.get(memberId) ?? null
    },
    async batchGet(workspaceId, memberIds) {
      if (memberIds.length === 0) return new Map()
      const members = await workspaceStore.listMembers('', workspaceId)
      const requested = new Set(memberIds)
      const out = new Map<string, WorkspaceMemberInfo>()
      for (const m of members) {
        if (!requested.has(m.id)) continue
        out.set(m.id, toWorkspaceMemberInfo(m, null))
      }
      return out
    },
  }
  return store
}
