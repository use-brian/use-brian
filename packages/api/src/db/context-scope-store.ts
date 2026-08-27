/**
 * Trusted Team/Project principal reads and first-class Project/config writes.
 * Resolution consumers intersect these grants in resolve-turn-scope.ts.
 *
 * [COMP:api/context-scope-store]
 */

import { randomUUID } from 'node:crypto'
import {
  canonicalScopeGrant,
  intersectScopeGrants,
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

export type WorkspaceProjectDetail = WorkspaceProject & {
  members: Array<{ userId: string; role: 'lead' | 'member'; name: string | null; email: string | null }>
  assistantIds: string[]
}

export type AssistantContextConfig = {
  teamMode: 'legacy' | 'all' | 'assigned'
  teamIds: string[]
  defaultGroupId: string | null
  projectMode: 'all' | 'assigned'
  projectIds: string[]
  defaultProjectId: string | null
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

type GroupGrantRow = {
  readAll: boolean
  ownCompartmentKey: string
  compartmentKey: string | null
}

function groupRowsToGrant(rows: GroupGrantRow[]): ScopeGrant {
  if (rows.some((row) => row.readAll)) return null
  return canonicalScopeGrant(rows.flatMap((row) =>
    [row.ownCompartmentKey, row.compartmentKey]
      .filter((value): value is string => typeof value === 'string'),
  ))
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
  getProjectDetail(userId: string, workspaceId: string, projectId: string): Promise<WorkspaceProjectDetail | null>
  listTeams(userId: string, workspaceId: string): Promise<ContextTeam[]>
  listProjects(userId: string, workspaceId: string, includeArchived?: boolean): Promise<WorkspaceProject[]>
  createProject(userId: string, workspaceId: string, input: {
    name: string
    description?: string | null
    icon?: string | null
    entityId?: string | null
  }): Promise<WorkspaceProject>
  updateProject(userId: string, workspaceId: string, projectId: string, input: {
    name?: string
    description?: string | null
    icon?: string | null
    entityId?: string | null
    status?: 'active'
  }): Promise<WorkspaceProject | null>
  setProjectMember(userId: string, projectId: string, memberUserId: string, role: 'lead' | 'member' | null): Promise<void>
  setProjectAssistant(userId: string, projectId: string, assistantId: string, enabled: boolean): Promise<void>
  getAssistantContextConfig(userId: string, workspaceId: string, assistantId: string): Promise<AssistantContextConfig | null>
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
        `SELECT g.read_all AS "readAll",
                g.compartment_key AS "ownCompartmentKey",
                gcg.compartment_key AS "compartmentKey"
           FROM workspace_group_members gm
           JOIN workspace_groups g ON g.id = gm.group_id
           LEFT JOIN workspace_group_compartment_grants gcg ON gcg.group_id = g.id
          WHERE gm.user_id = $1
            AND g.workspace_id = $2
            AND g.kind = 'team'`,
        [userId, workspaceId],
      )
      const teamGrant = groupRowsToGrant(grants.rows)
      return {
        role: row.role,
        mode: row.mode,
        // read_all is the sole wildcard and intentionally supersedes the
        // legacy/direct array, matching effective_member_team_compartments().
        grant: teamGrant === null
          ? null
          : intersectScopeGrants(teamGrant, row.compartments),
      }
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
          `SELECT g.read_all AS "readAll",
                  g.compartment_key AS "ownCompartmentKey",
                  gcg.compartment_key AS "compartmentKey"
             FROM workspace_group_assistants ga
             JOIN workspace_groups g ON g.id = ga.group_id
             LEFT JOIN workspace_group_compartment_grants gcg ON gcg.group_id = g.id
            WHERE ga.assistant_id = $1
              AND g.workspace_id = $2
              AND g.kind = 'team'`,
          [assistantId, workspaceId],
        )
        const assignedGrant = groupRowsToGrant(teamRows.rows)
        // A read_all Team is the explicit wildcard. Otherwise the historical
        // direct array remains an additional compatibility ceiling.
        teamGrant = assignedGrant === null
          ? null
          : intersectScopeGrants(assignedGrant, row.compartments)
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
          : canonicalScopeGrant([
              row.compartmentKey,
              ...result.rows.flatMap((grant) => grant.grantKey ? [grant.grantKey] : []),
            ]),
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

    async getProjectDetail(userId, workspaceId, projectId) {
      const project = await queryWithRLS<Parameters<typeof mapProject>[0]>(
        userId,
        `SELECT id, workspace_id AS "workspaceId", name,
                normalized_name AS "normalizedName", description, icon, status,
                entity_id AS "entityId", created_by AS "createdBy",
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM workspace_projects
          WHERE id = $1 AND workspace_id = $2`,
        [projectId, workspaceId],
      )
      const row = project.rows[0]
      if (!row) return null
      const [members, assistants] = await Promise.all([
        queryWithRLS<{
          userId: string
          role: 'lead' | 'member'
          name: string | null
          email: string | null
        }>(
          userId,
          `SELECT pm.user_id AS "userId", pm.role, u.name, u.email
             FROM workspace_project_members pm
             LEFT JOIN users u ON u.id = pm.user_id
            WHERE pm.project_id = $1
            ORDER BY pm.role, u.name NULLS LAST`,
          [projectId],
        ),
        queryWithRLS<{ assistantId: string }>(
          userId,
          `SELECT assistant_id AS "assistantId"
             FROM assistant_project_grants
            WHERE project_id = $1
            ORDER BY assistant_id`,
          [projectId],
        ),
      ])
      return {
        ...mapProject(row),
        members: members.rows,
        assistantIds: assistants.rows.map((assistant) => assistant.assistantId),
      }
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
            AND (
              public.effective_member_team_compartments($2, $1) IS NULL
              OR ARRAY[g.compartment_key]::text[] <@
                 public.effective_member_team_compartments($2, $1)
            )
          GROUP BY g.id
          ORDER BY g.status, g.name`,
        [workspaceId, userId],
      )
      return result.rows.map((row) => ({
        ...row,
        readBundle: row.readAll
          ? null
          : canonicalScopeGrant([row.compartmentKey, ...row.grants]),
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

    async updateProject(userId, workspaceId, projectId, input) {
      const sets: string[] = []
      const values: unknown[] = []
      const add = (column: string, value: unknown) => {
        values.push(value)
        sets.push(`${column} = $${values.length}`)
      }
      if (input.name !== undefined) {
        const name = input.name.trim()
        add('name', name)
        add('normalized_name', normalizeProjectName(name))
      }
      if (input.description !== undefined) add('description', input.description)
      if (input.icon !== undefined) add('icon', input.icon)
      if (input.entityId !== undefined) add('entity_id', input.entityId)
      if (input.status !== undefined) add('status', input.status)
      if (sets.length === 0) return null
      values.push(projectId, workspaceId)
      const result = await queryWithRLS<Parameters<typeof mapProject>[0]>(
        userId,
        `UPDATE workspace_projects
            SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
          RETURNING id, workspace_id AS "workspaceId", name,
                    normalized_name AS "normalizedName", description, icon, status,
                    entity_id AS "entityId", created_by AS "createdBy",
                    created_at AS "createdAt", updated_at AS "updatedAt"`,
        values,
      )
      return result.rows[0] ? mapProject(result.rows[0]) : null
    },

    async setProjectMember(userId, projectId, memberUserId, role) {
      if (role === null) {
        await queryWithRLS(
          userId,
          'DELETE FROM workspace_project_members WHERE project_id = $1 AND user_id = $2',
          [projectId, memberUserId],
        )
        return
      }
      await queryWithRLS(
        userId,
        `INSERT INTO workspace_project_members (project_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [projectId, memberUserId, role],
      )
    },

    async setProjectAssistant(userId, projectId, assistantId, enabled) {
      if (enabled) {
        await queryWithRLS(
          userId,
          `INSERT INTO assistant_project_grants
             (assistant_id, project_id, added_by_user_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (assistant_id, project_id) DO NOTHING`,
          [assistantId, projectId, userId],
        )
        return
      }
      await queryWithRLS(
        userId,
        'DELETE FROM assistant_project_grants WHERE assistant_id = $1 AND project_id = $2',
        [assistantId, projectId],
      )
    },

    async getAssistantContextConfig(userId, workspaceId, assistantId) {
      const result = await queryWithRLS<{
        teamMode: AssistantContextConfig['teamMode']
        defaultGroupId: string | null
        projectMode: AssistantContextConfig['projectMode']
        defaultProjectId: string | null
        teamIds: string[]
        projectIds: string[]
      }>(
        userId,
        `SELECT a.team_scope_mode AS "teamMode",
                a.default_workspace_group_id AS "defaultGroupId",
                a.project_scope_mode AS "projectMode",
                a.default_project_id AS "defaultProjectId",
                COALESCE(array_agg(DISTINCT ga.group_id)
                  FILTER (WHERE ga.group_id IS NOT NULL), '{}') AS "teamIds",
                COALESCE(array_agg(DISTINCT apg.project_id)
                  FILTER (WHERE apg.project_id IS NOT NULL), '{}') AS "projectIds"
           FROM assistants a
           LEFT JOIN workspace_group_assistants ga ON ga.assistant_id = a.id
           LEFT JOIN assistant_project_grants apg ON apg.assistant_id = a.id
          WHERE a.id = $1 AND a.workspace_id = $2
          GROUP BY a.id`,
        [assistantId, workspaceId],
      )
      return result.rows[0] ?? null
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
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, userId)
        const result = await client.query<{ id: string; workspaceId: string }>(
          `UPDATE workspace_projects SET status = 'archived'
            WHERE id = $1 AND status = 'active'
            RETURNING id, workspace_id AS "workspaceId"`,
          [projectId],
        )
        const archived = result.rows[0]
        if (!archived) {
          await client.query('ROLLBACK')
          return false
        }
        await client.query(
          `UPDATE workflows
              SET enabled = false, paused_reason = 'project_archived', updated_at = now()
            WHERE workspace_id = $1 AND context_project_id = $2 AND enabled = true`,
          [archived.workspaceId, projectId],
        )
        await client.query(
          `UPDATE scheduled_jobs
              SET enabled = false, last_status = 'project_archived', updated_at = now()
            WHERE context_project_id = $1 AND enabled = true`,
          [projectId],
        )
        await client.query('COMMIT')
        return true
      } finally {
        await rollbackAndRelease(client)
      }
    },
  }
}
