/**
 * Workspace groups (migration 252) — named sets of workspace members a doc
 * page can be shared with at a role (Phase 3 of doc page sharing, §13 D3).
 *
 * All ops go through `queryWithRLS`, so the `workspace_groups` /
 * `workspace_group_members` RLS policies gate reads/writes to the caller's
 * workspace. The route layer enforces the tighter owner/admin gate for
 * mutations. Groups are workspace-scoped; a group only admits workspace
 * members (the INSERT's RLS WITH CHECK enforces the group belongs to the
 * caller's workspace; member-of-workspace is the caller's responsibility).
 *
 * [COMP:api/workspace-group-store]
 */

import { queryWithRLS } from './client.js'

export type WorkspaceGroup = {
  id: string
  workspaceId: string
  name: string
  memberCount: number
  createdAt: string
}

export type GroupMember = { userId: string; name: string | null; email: string | null }

export type WorkspaceGroupStore = {
  createGroup(userId: string, workspaceId: string, name: string): Promise<WorkspaceGroup>
  listGroups(userId: string, workspaceId: string): Promise<WorkspaceGroup[]>
  addMember(userId: string, groupId: string, memberUserId: string): Promise<void>
  removeMember(userId: string, groupId: string, memberUserId: string): Promise<boolean>
  listMembers(userId: string, groupId: string): Promise<GroupMember[]>
}

export function createDbWorkspaceGroupStore(): WorkspaceGroupStore {
  return {
    async createGroup(userId, workspaceId, name) {
      const r = await queryWithRLS<{ id: string; workspaceId: string; name: string; createdAt: Date }>(
        userId,
        `INSERT INTO workspace_groups (workspace_id, name, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, workspace_id AS "workspaceId", name, created_at AS "createdAt"`,
        [workspaceId, name, userId],
      )
      const row = r.rows[0]
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        memberCount: 0,
        createdAt: row.createdAt.toISOString(),
      }
    },

    async listGroups(userId, workspaceId) {
      const r = await queryWithRLS<{
        id: string
        workspaceId: string
        name: string
        createdAt: Date
        memberCount: number
      }>(
        userId,
        `SELECT g.id, g.workspace_id AS "workspaceId", g.name, g.created_at AS "createdAt",
                COUNT(gm.id)::int AS "memberCount"
           FROM workspace_groups g
           LEFT JOIN workspace_group_members gm ON gm.group_id = g.id
          WHERE g.workspace_id = $1
          GROUP BY g.id
          ORDER BY g.name ASC`,
        [workspaceId],
      )
      return r.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        memberCount: Number(row.memberCount),
        createdAt: row.createdAt.toISOString(),
      }))
    },

    async addMember(userId, groupId, memberUserId) {
      await queryWithRLS(
        userId,
        `INSERT INTO workspace_group_members (group_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, memberUserId],
      )
    },

    async removeMember(userId, groupId, memberUserId) {
      const r = await queryWithRLS<{ id: string }>(
        userId,
        `DELETE FROM workspace_group_members WHERE group_id = $1 AND user_id = $2 RETURNING id`,
        [groupId, memberUserId],
      )
      return r.rows.length > 0
    },

    async listMembers(userId, groupId) {
      const r = await queryWithRLS<GroupMember>(
        userId,
        `SELECT gm.user_id AS "userId", u.name, u.email
           FROM workspace_group_members gm
           JOIN users u ON u.id = gm.user_id
          WHERE gm.group_id = $1
          ORDER BY u.name ASC NULLS LAST`,
        [groupId],
      )
      return r.rows
    },
  }
}
