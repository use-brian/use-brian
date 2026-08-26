/**
 * Trusted Team/Project principal reads and first-class Project/config writes.
 * Resolution consumers intersect these grants in resolve-turn-scope.ts.
 *
 * [COMP:api/context-scope-store]
 */

import { randomUUID } from 'node:crypto'
import {
  canonicalScopeGrant,
  normalizeProjectName,
  type ScopeGrant,
} from '@use-brian/core'
import {
  applyRLSGucs,
  getAppPool,
  query,
  queryWithRLS,
  rollbackAndRelease,
} from './client.js'

export type ContextTeam = {
  id: string
  workspaceId: string
  name: string
  key: string
  description: string | null
  color: string | null
  status: 'active' | 'archived'
  compartmentKey: string
  readAll: boolean
  readBundle: ScopeGrant
}

export type WorkspaceProject = {
  id: string
  workspaceId: string
  name: string
  normalizedName: string
  description: string | null
  icon: string | null
  status: 'active' | 'archived'
  entityId: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type MemberTeamPrincipal = {
  role: 'owner' | 'admin' | 'member'
  mode: 'legacy' | 'assigned'
  grant: ScopeGrant
}

export type AssistantContextPrincipal = {
  teamMode: 'legacy' | 'all' | 'assigned'
  teamGrant: ScopeGrant
  projectMode: 'all' | 'assigned'
  projectGrant: ScopeGrant
  defaultGroupId: string | null
  defaultProjectId: string | null
}

type GroupGrantRow = { readAll: boolean; compartmentKey: string | null }

function groupRowsToGrant(rows: GroupGrantRow[]): ScopeGrant {
  if (rows.some((row) => row.readAll)) return null
  return canonicalScopeGrant(rows.flatMap((row) => (
    row.compartmentKey ? [row.compartmentKey] : []
  )))
}

function mapProject(row: {
  id: string
  workspaceId: string
  name: string
  normalizedName: string
  description: string | null
  icon: string | null
  status: 'active' | 'archived'
  entityId: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}): WorkspaceProject {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export type ContextScopeStore = {
  resolveMemberTeamPrincipalSystem(userId: string, workspaceId: string): Promise<MemberTeamPrincipal | null>
  resolveAssistantPrincipalSystem(assistantId: string, workspaceId: string): Promise<AssistantContextPrincipal | null>
  getTeamSystem(workspaceId: string, groupId: string): Promise<ContextTeam | null>
  getProjectSystem(workspaceId: string, projectId: string): Promise<WorkspaceProject | null>
  listTeams(userId: string, workspaceId: string): Promise<ContextTeam[]>
  listProjects(userId: string, workspaceId: string, includeArchived?: boolean): Promise<WorkspaceProject[]>
  createProject(userId: string, workspaceId: string, input: {
    name: string
    description?: string | null
    icon?: string | null
    entityId?: string | null
  }): Promise<WorkspaceProject>
  setAssistantContext(userId: string, assistantId: string, input: {
    teamMode: 'all' | 'assigned'
    teamIds: string[]
    defaultGroupId: string | null
    projectMode: 'all' | 'assigned'
    projectIds: string[]
    defaultProjectId: string | null
  }): Promise<void>
  archiveProject(userId: string, projectId: string): Promise<boolean>
}

export function createDbContextScopeStore(): ContextScopeStore {
  return {
    async resolveMemberTeamPrincipalSystem(userId, workspaceId) {
      const member = await query<{
        role: MemberTeamPrincipal['role']
        mode: MemberTeamPrincipal['mode']
        compartments: string[] | null
      }>(
        `SELECT role, team_scope_mode AS mode, compartments
           FROM workspace_members
          WHERE user_id = $1 AND workspace_id = $2`,
        [userId, workspaceId],
      )
      const row = member.rows[0]
      if (!row) return null
      if (row.role === 'owner' || row.role === 'admin') {
        return { role: row.role, mode: row.mode, grant: null }
      }
      if (row.mode === 'legacy') {
        return { role: row.role, mode: row.mode, grant: canonicalScopeGrant(row.compartments) }
      }
      const grants = await query<GroupGrantRow>(
        `SELECT g.read_all AS "readAll", gcg.compartment_key AS "compartmentKey"
           FROM workspace_group_members gm
           JOIN workspace_groups g ON g.id = gm.group_id
           LEFT JOIN workspace_group_compartment_grants gcg ON gcg.group_id = g.id
          WHERE gm.user_id = $1
            AND g.workspace_id = $2
            AND g.kind = 'team'`,
        [userId, workspaceId],
      )
      return { role: row.role, mode: row.mode, grant: groupRowsToGrant(grants.rows) }
    },

    async resolveAssistantPrincipalSystem(assistantId, workspaceId) {
      const assistant = await query<{
        teamMode: AssistantContextPrincipal['teamMode']
        compartments: string[] | null
        projectMode: AssistantContextPrincipal['projectMode']
        defaultGroupId: string | null
        defaultProjectId: string | null
      }>(
        `SELECT team_scope_mode AS "teamMode", compartments,
                project_scope_mode AS "projectMode",
                default_workspace_group_id AS "defaultGroupId",
                default_project_id AS "defaultProjectId"
           FROM assistants
          WHERE id = $1 AND workspace_id = $2`,
        [assistantId, workspaceId],
      )
      const row = assistant.rows[0]
      if (!row) return null

      let teamGrant: ScopeGrant
      if (row.teamMode === 'all') {
        teamGrant = null
      } else if (row.teamMode === 'legacy') {
        teamGrant = canonicalScopeGrant(row.compartments)
      } else {
        const teamRows = await query<GroupGrantRow>(
          `SELECT g.read_all AS "readAll", gcg.compartment_key AS "compartmentKey"
             FROM workspace_group_assistants ga
             JOIN workspace_groups g ON g.id = ga.group_id
             LEFT JOIN workspace_group_compartment_grants gcg ON gcg.group_id = g.id
            WHERE ga.assistant_id = $1
              AND g.workspace_id = $2
              AND g.kind = 'team'`,
          [assistantId, workspaceId],
        )
        teamGrant = groupRowsToGrant(teamRows.rows)
      }

      let projectGrant: ScopeGrant = null
      if (row.projectMode === 'assigned') {
        const projectRows = await query<{ id: string }>(
          `SELECT p.id
             FROM assistant_project_grants apg
             JOIN workspace_projects p ON p.id = apg.project_id
            WHERE apg.assistant_id = $1 AND p.workspace_id = $2`,
          [assistantId, workspaceId],
        )
        projectGrant = canonicalScopeGrant(projectRows.rows.map((project) => project.id))
      }
      return {
        teamMode: row.teamMode,
        teamGrant,
        projectMode: row.projectMode,
        projectGrant,
        defaultGroupId: row.defaultGroupId,
        defaultProjectId: row.defaultProjectId,
      }
    },

    async getTeamSystem(workspaceId, groupId) {
      const result = await query<{
        id: string
        workspaceId: string
        name: string
        key: string
        description: string | null
        color: string | null
        status: 'active' | 'archived'
        compartmentKey: string
        readAll: boolean
        grantKey: string | null
      }>(
        `SELECT g.id, g.workspace_id AS "workspaceId", g.name, g.key,
                g.description, g.color, g.status,
                g.compartment_key AS "compartmentKey",
                g.read_all AS "readAll",
                gcg.compartment_key AS "grantKey"
           FROM workspace_groups g
           LEFT JOIN workspace_group_compartment_grants gcg ON gcg.group_id = g.id
          WHERE g.id = $1 AND g.workspace_id = $2 AND g.kind = 'team'`,
        [groupId, workspaceId],
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        key: row.key,
        description: row.description,
        color: row.color,
        status: row.status,
        compartmentKey: row.compartmentKey,
        readAll: row.readAll,
        readBundle: row.readAll
          ? null
          : canonicalScopeGrant(result.rows.flatMap((grant) => (
            grant.grantKey ? [grant.grantKey] : []
          ))),
      }
    },

    async getProjectSystem(workspaceId, projectId) {
      const result = await query<Parameters<typeof mapProject>[0]>(
        `SELECT id, workspace_id AS "workspaceId", name,
                normalized_name AS "normalizedName", description, icon, status,
                entity_id AS "entityId", created_by AS "createdBy",
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM workspace_projects
          WHERE id = $1 AND workspace_id = $2`,
        [projectId, workspaceId],
      )
      return result.rows[0] ? mapProject(result.rows[0]) : null
    },

    async listTeams(userId, workspaceId) {
      const result = await queryWithRLS<{
        id: string
        workspaceId: string
        name: string
        key: string
        description: string | null
        color: string | null
        status: 'active' | 'archived'
        compartmentKey: string
        readAll: boolean
        grants: string[]
      }>(
        userId,
        `SELECT g.id, g.workspace_id AS "workspaceId", g.name, g.key,
                g.description, g.color, g.status,
                g.compartment_key AS "compartmentKey",
                g.read_all AS "readAll",
                COALESCE(array_agg(gcg.compartment_key ORDER BY gcg.compartment_key)
                  FILTER (WHERE gcg.compartment_key IS NOT NULL), '{}') AS grants
           FROM workspace_groups g
           LEFT JOIN workspace_group_compartment_grants gcg ON gcg.group_id = g.id
          WHERE g.workspace_id = $1 AND g.kind = 'team'
          GROUP BY g.id
          ORDER BY g.status, g.name`,
        [workspaceId],
      )
      return result.rows.map((row) => ({
        ...row,
        readBundle: row.readAll ? null : canonicalScopeGrant(row.grants),
      }))
    },

    async listProjects(userId, workspaceId, includeArchived = false) {
      const result = await queryWithRLS<Parameters<typeof mapProject>[0]>(
        userId,
        `SELECT id, workspace_id AS "workspaceId", name,
                normalized_name AS "normalizedName", description, icon, status,
                entity_id AS "entityId", created_by AS "createdBy",
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM workspace_projects
          WHERE workspace_id = $1
            AND ($2::boolean OR status = 'active')
          ORDER BY status, name`,
        [workspaceId, includeArchived],
      )
      return result.rows.map(mapProject)
    },

    async createProject(userId, workspaceId, input) {
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, userId)
        const projectId = randomUUID()
        const name = input.name.trim()
        const result = await client.query<Parameters<typeof mapProject>[0]>(
          `INSERT INTO workspace_projects
             (id, workspace_id, name, normalized_name, description, icon,
              entity_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, workspace_id AS "workspaceId", name,
                     normalized_name AS "normalizedName", description, icon,
                     status, entity_id AS "entityId", created_by AS "createdBy",
                     created_at AS "createdAt", updated_at AS "updatedAt"`,
          [
            projectId,
            workspaceId,
            name,
            normalizeProjectName(name),
            input.description ?? null,
            input.icon ?? null,
            input.entityId ?? null,
            userId,
          ],
        )
        await client.query(
          `INSERT INTO workspace_project_members (project_id, user_id, role)
           VALUES ($1, $2, 'lead')`,
          [projectId, userId],
        )
        await client.query('COMMIT')
        return mapProject(result.rows[0])
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async setAssistantContext(userId, assistantId, input) {
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, userId)
        await client.query(
          'DELETE FROM workspace_group_assistants WHERE assistant_id = $1',
          [assistantId],
        )
        for (const groupId of [...new Set(input.teamIds)]) {
          await client.query(
            `INSERT INTO workspace_group_assistants
               (group_id, assistant_id, added_by_user_id)
             VALUES ($1, $2, $3)`,
            [groupId, assistantId, userId],
          )
        }
        await client.query(
          'DELETE FROM assistant_project_grants WHERE assistant_id = $1',
          [assistantId],
        )
        for (const projectId of [...new Set(input.projectIds)]) {
          await client.query(
            `INSERT INTO assistant_project_grants
               (assistant_id, project_id, added_by_user_id)
             VALUES ($1, $2, $3)`,
            [assistantId, projectId, userId],
          )
        }
        const updated = await client.query(
          `UPDATE assistants
              SET team_scope_mode = $2,
                  default_workspace_group_id = $3,
                  project_scope_mode = $4,
                  default_project_id = $5
            WHERE id = $1
            RETURNING id`,
          [
            assistantId,
            input.teamMode,
            input.defaultGroupId,
            input.projectMode,
            input.defaultProjectId,
          ],
        )
        if (!updated.rows[0]) throw new Error('assistant_not_found')
        await client.query('COMMIT')
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async archiveProject(userId, projectId) {
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE workspace_projects SET status = 'archived'
          WHERE id = $1 AND status = 'active' RETURNING id`,
        [projectId],
      )
      return result.rows.length > 0
    },
  }
}
