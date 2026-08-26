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

import { randomUUID } from 'node:crypto'
import {
  applyRLSGucs,
  getAppPool,
  queryWithRLS,
  rollbackAndRelease,
} from './client.js'

export type WorkspaceGroup = {
  id: string
  workspaceId: string
  name: string
  kind: 'sharing' | 'team'
  key: string | null
  description: string | null
  color: string | null
  status: 'active' | 'archived'
  compartmentKey: string | null
  readAll: boolean
  memberCount: number
  createdAt: string
}

export type GroupMember = { userId: string; name: string | null; email: string | null }

const TEAM_KEY_RE = /^[a-z0-9][a-z0-9-]{0,38}$/

export function validateTeamKey(key: string): string {
  if (!TEAM_KEY_RE.test(key)) throw new Error('invalid_team_key')
  return key
}

export type WorkspaceGroupStore = {
  createGroup(userId: string, workspaceId: string, name: string): Promise<WorkspaceGroup>
  listGroups(userId: string, workspaceId: string): Promise<WorkspaceGroup[]>
  addMember(userId: string, groupId: string, memberUserId: string): Promise<void>
  removeMember(userId: string, groupId: string, memberUserId: string): Promise<boolean>
  listMembers(userId: string, groupId: string): Promise<GroupMember[]>
  createTeam(userId: string, workspaceId: string, input: {
    name: string
    key: string
    description?: string | null
    color?: string | null
    readAll?: boolean
  }): Promise<WorkspaceGroup>
  setTeamReadBundle(userId: string, groupId: string, input: {
    readAll: boolean
    compartmentKeys: string[]
  }): Promise<void>
  setTeamAssistants(userId: string, groupId: string, assistantIds: string[]): Promise<void>
  archiveTeam(userId: string, groupId: string): Promise<boolean>
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
        kind: 'sharing',
        key: null,
        description: null,
        color: null,
        status: 'active',
        compartmentKey: null,
        readAll: false,
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
        kind: 'sharing' | 'team'
        key: string | null
        description: string | null
        color: string | null
        status: 'active' | 'archived'
        compartmentKey: string | null
        readAll: boolean
      }>(
        userId,
        `SELECT g.id, g.workspace_id AS "workspaceId", g.name,
                g.kind, g.key, g.description, g.color, g.status,
                g.compartment_key AS "compartmentKey", g.read_all AS "readAll",
                g.created_at AS "createdAt",
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
        kind: row.kind,
        key: row.key,
        description: row.description,
        color: row.color,
        status: row.status,
        compartmentKey: row.compartmentKey,
        readAll: row.readAll,
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

    async createTeam(userId, workspaceId, input) {
      const client = await getAppPool().connect()
      const groupId = randomUUID()
      const compartmentKey = `team:${groupId}`
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, userId)
        const created = await client.query<{
          id: string
          workspaceId: string
          name: string
          kind: 'team'
          key: string
          description: string | null
          color: string | null
          status: 'active'
          compartmentKey: string
          readAll: boolean
          createdAt: Date
        }>(
          `INSERT INTO workspace_groups
             (id, workspace_id, name, kind, key, description, color, status,
              compartment_key, read_all, created_by)
           VALUES ($1, $2, $3, 'team', $4, $5, $6, 'active', $7, $8, $9)
           RETURNING id, workspace_id AS "workspaceId", name, kind, key,
                     description, color, status,
                     compartment_key AS "compartmentKey",
                     read_all AS "readAll", created_at AS "createdAt"`,
          [
            groupId,
            workspaceId,
            input.name.trim(),
            validateTeamKey(input.key),
            input.description ?? null,
            input.color ?? null,
            compartmentKey,
            input.readAll ?? false,
            userId,
          ],
        )
        await client.query(
          `INSERT INTO workspace_compartments
             (workspace_id, key, label, description, color, created_by,
              managed_by, managed_ref_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'team', $7)`,
          [
            workspaceId,
            compartmentKey,
            input.name.trim(),
            input.description ?? null,
            input.color ?? null,
            userId,
            groupId,
          ],
        )
        await client.query(
          `INSERT INTO workspace_group_compartment_grants
             (group_id, compartment_key, granted_by_user_id)
           VALUES ($1, $2, $3)`,
          [groupId, compartmentKey, userId],
        )
        await client.query(
          `INSERT INTO workspace_group_members (group_id, user_id)
           VALUES ($1, $2) ON CONFLICT (group_id, user_id) DO NOTHING`,
          [groupId, userId],
        )
        await client.query('COMMIT')
        const row = created.rows[0]
        return { ...row, memberCount: 1, createdAt: row.createdAt.toISOString() }
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async setTeamReadBundle(userId, groupId, input) {
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, userId)
        const team = await client.query<{ compartmentKey: string }>(
          `UPDATE workspace_groups
              SET read_all = $2
            WHERE id = $1 AND kind = 'team'
            RETURNING compartment_key AS "compartmentKey"`,
          [groupId, input.readAll],
        )
        if (!team.rows[0]) throw new Error('context_team_not_found')
        const required = new Set([team.rows[0].compartmentKey, ...input.compartmentKeys])
        await client.query(
          'DELETE FROM workspace_group_compartment_grants WHERE group_id = $1',
          [groupId],
        )
        for (const key of required) {
          await client.query(
            `INSERT INTO workspace_group_compartment_grants
               (group_id, compartment_key, granted_by_user_id)
             VALUES ($1, $2, $3)`,
            [groupId, key, userId],
          )
        }
        await client.query('COMMIT')
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async setTeamAssistants(userId, groupId, assistantIds) {
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, userId)
        await client.query('DELETE FROM workspace_group_assistants WHERE group_id = $1', [groupId])
        for (const assistantId of [...new Set(assistantIds)]) {
          await client.query(
            `INSERT INTO workspace_group_assistants
               (group_id, assistant_id, added_by_user_id)
             VALUES ($1, $2, $3)`,
            [groupId, assistantId, userId],
          )
        }
        await client.query('COMMIT')
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async archiveTeam(userId, groupId) {
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE workspace_groups
            SET status = 'archived'
          WHERE id = $1 AND kind = 'team' AND status = 'active'
          RETURNING id`,
        [groupId],
      )
      return result.rows.length > 0
    },
  }
}
