/**
 * First-class Team/Project management, effective-scope explanation, runtime
 * readiness, and audited reclassification.
 *
 * [COMP:api/context-scope-routes]
 */

import { departmentalReadiness, getDepartmentalReadinessSystem } from '../workspace-access/readiness.js'
import { departmentRouteReview, executeReviewedDepartmentRoute } from '../workspace-access/reviewed-route.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { scopeGrantContains, type ScopeGrant } from '@use-brian/core'
import { buildAccessPredicate } from '../db/access-predicate.js'
import {
  createDbContextScopeStore,
  type ContextScopeStore,
  type ContextTeam,
} from '../db/context-scope-store.js'
import {
  ContextReclassificationError,
  createDbContextReclassificationStore,
  type ContextReclassificationStore,
} from '../db/context-reclassification-store.js'
import {
  createDbWorkspaceGroupStore,
  type WorkspaceGroup,
  type WorkspaceGroupStore,
} from '../db/workspace-group-store.js'
import { query, queryWithRLS } from '../db/client.js'
import { departmentClearancesForUserSystem } from '../db/department-store.js'
import {
  getWorkspaceMembershipWithClearanceSystem,
  type WorkspaceStore,
} from '../db/workspace-store.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import { resolveTurnScopeSystem, type TurnScopeAssistant } from '../context-scope/resolve-turn-scope.js'
import {
  assertContextActivationReady,
  ContextActivationBlockedError,
  getContextReadinessSystem,
  type ContextReadiness,
} from '../context-scope/context-readiness.js'

const UUID = z.string().uuid()
const nullableText = z.string().max(2_000).nullable()

const createTeamBody = z.object({
  name: z.string().trim().min(1).max(120),
  key: z.string().trim().min(1).max(39),
  description: nullableText.optional(),
  color: z.string().max(32).nullable().optional(),
  readAll: z.boolean().optional(),
}).strict()

const updateTeamBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: nullableText.optional(),
  color: z.string().max(32).nullable().optional(),
  status: z.literal('active').optional(),
}).strict().refine((body) => Object.keys(body).length > 0)

const readGrantsBody = z.object({
  readAll: z.boolean(),
  groupIds: z.array(UUID).max(100).default([]),
}).strict()

const memberBody = z.object({
  activateAssigned: z.boolean().default(false),
}).strict()

const createProjectBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: nullableText.optional(),
  icon: z.string().max(64).nullable().optional(),
  entityId: UUID.nullable().optional(),
}).strict()

const updateProjectBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: nullableText.optional(),
  icon: z.string().max(64).nullable().optional(),
  entityId: UUID.nullable().optional(),
  status: z.literal('active').optional(),
}).strict().refine((body) => Object.keys(body).length > 0)

const projectMemberBody = z.object({
  role: z.enum(['lead', 'member']).default('member'),
}).strict()

const assistantContextBody = z.object({
  teamMode: z.enum(['all', 'assigned']),
  teamIds: z.array(UUID).max(100),
  defaultGroupId: UUID.nullable(),
  projectMode: z.enum(['all', 'assigned']),
  projectIds: z.array(UUID).max(100),
  defaultProjectId: UUID.nullable(),
}).strict()

const reclassifyBody = z.object({
  primitive: z.enum(['memory', 'task', 'file', 'entity', 'knowledge', 'recording', 'office']),
  rowId: z.string().min(1).max(200),
  teamIds: z.array(UUID).max(100),
  projectIds: z.array(UUID).max(100),
  reason: z.string().trim().min(1).max(1_000),
  confirmed: z.boolean().default(false),
}).strict()
const reclassifyQuery = z.object({
  primitive: z.enum(['memory', 'task', 'file', 'entity', 'knowledge', 'recording', 'office']),
  rowId: z.string().min(1).max(200),
})

// Either field may be omitted to keep its current value: the header badge
// sets only the department, the Settings binding only the Project.
const connectorContextBody = z.object({
  contextGroupId: UUID.nullable().optional(),
  contextProjectId: UUID.nullable().optional(),
}).strict()

type WorkspaceRole = 'owner' | 'admin' | 'member'

export type ContextScopeRouteOptions = {
  executeAccessCommand?: typeof executeReviewedDepartmentRoute
  getDepartmentalReadiness?: typeof getDepartmentalReadinessSystem
  workspaceStore: Pick<WorkspaceStore, 'getRole'>
  groupStore?: WorkspaceGroupStore
  contextStore?: ContextScopeStore
  reclassificationStore?: ContextReclassificationStore
  getReadiness?: (workspaceId: string) => Promise<ContextReadiness>
  connectorInstanceStore?: ConnectorInstanceStore
  connectorGrantStore?: ConnectorGrantStore
}

function invalid(res: Response, parsed: { error: z.ZodError }): void {
  res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues })
}

function teamProjection(
  team: Pick<WorkspaceGroup, 'id' | 'name' | 'key' | 'description' | 'color' | 'status' | 'readAll' | 'memberCount' | 'createdAt'>,
  readGrantGroupIds: string[],
) {
  return {
    id: team.id,
    name: team.name,
    key: team.key,
    description: team.description,
    color: team.color,
    status: team.status,
    readAll: team.readAll,
    readGrantGroupIds,
    memberCount: team.memberCount,
    createdAt: team.createdAt,
  }
}

function grantGroupIds(team: ContextTeam, teams: ContextTeam[]): string[] {
  if (team.readBundle === null) return []
  return teams
    .filter((candidate) => team.readBundle!.includes(candidate.compartmentKey))
    .map((candidate) => candidate.id)
    .sort()
}

async function loadAssistant(
  workspaceId: string,
  assistantId?: string,
): Promise<TurnScopeAssistant | null> {
  const result = await query<{
    id: string
    workspaceId: string | null
    kind: 'primary' | 'standard' | 'app'
    clearance: 'public' | 'internal' | 'confidential'
    compartments: string[] | null
    defaultCompartments: string[] | null
    teamScopeMode: 'legacy' | 'all' | 'assigned'
    defaultWorkspaceGroupId: string | null
    projectScopeMode: 'all' | 'assigned'
    defaultProjectId: string | null
  }>(
    `SELECT id, workspace_id AS "workspaceId", kind, clearance, compartments,
            default_compartments AS "defaultCompartments",
            team_scope_mode AS "teamScopeMode",
            default_workspace_group_id AS "defaultWorkspaceGroupId",
            project_scope_mode AS "projectScopeMode",
            default_project_id AS "defaultProjectId"
       FROM assistants
      WHERE workspace_id = $1
        AND ($2::uuid IS NOT NULL AND id = $2 OR $2::uuid IS NULL AND kind = 'primary')
      ORDER BY CASE WHEN kind = 'primary' THEN 0 ELSE 1 END
      LIMIT 1`,
    [workspaceId, assistantId ?? null],
  )
  return result.rows[0] ?? null
}

async function projectAggregates(
  userId: string,
  workspaceId: string,
  projectId: string,
): Promise<Record<string, number>> {
  const [membership, grant] = await Promise.all([
    getWorkspaceMembershipWithClearanceSystem(userId, workspaceId),
    query<{ compartments: ScopeGrant }>(
      'SELECT effective_member_team_compartments($1, $2) AS compartments',
      [userId, workspaceId],
    ),
  ])
  if (!membership) return {}
  const principal = {
    role: membership.role,
    clearance: membership.role === 'owner' || membership.role === 'admin'
      ? 'confidential' as const
      : membership.clearance,
    compartments: grant.rows[0]?.compartments ?? [],
  }
  const access = {
    workspaceId,
    userId,
    assistantId: '',
    assistantKind: 'primary' as const,
    clearance: principal.clearance,
    compartments: principal.compartments,
    projectIds: [projectId],
  }
  const tables = {
    memories: 'memories',
    tasks: 'tasks',
    files: 'workspace_files',
    entities: 'entities',
    knowledge: 'knowledge_entries',
    recordings: 'recordings',
    office: 'office_artifacts',
    episodes: 'episodes',
  } as const
  const counts: Record<string, number> = {}
  for (const [label, table] of Object.entries(tables)) {
    const predicate = buildAccessPredicate(access, { alias: 'r' })
    const result = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} r WHERE ${predicate.sql}`,
      predicate.params,
    )
    counts[label] = Number(result.rows[0]?.count ?? '0')
  }
  const pages = await queryWithRLS<{ count: string }>(
    userId,
    `SELECT count(*)::text AS count
       FROM saved_views
      WHERE workspace_id = $1 AND project_id = $2`,
    [workspaceId, projectId],
  )
  counts.pages = Number(pages.rows[0]?.count ?? '0')
  const operational = await query<{ workflows: string; goals: string }>(
    `SELECT
       (SELECT count(*)::text
          FROM workflows w
          LEFT JOIN workspace_groups g ON g.id = w.context_group_id
         WHERE w.workspace_id = $1 AND w.context_project_id = $2
           AND (w.context_group_id IS NULL OR $3::text[] IS NULL OR g.compartment_key = ANY($3::text[]))) AS workflows,
       (SELECT count(*)::text
          FROM goals o
          LEFT JOIN workspace_groups g ON g.id = o.context_group_id
         WHERE o.workspace_id = $1 AND o.context_project_id = $2
           AND (o.context_group_id IS NULL OR $3::text[] IS NULL OR g.compartment_key = ANY($3::text[]))) AS goals`,
    [workspaceId, projectId, principal.compartments],
  )
  counts.workflows = Number(operational.rows[0]?.workflows ?? '0')
  counts.goals = Number(operational.rows[0]?.goals ?? '0')
  return counts
}

export function contextScopeRoutes(options: ContextScopeRouteOptions): Router {
  const router = Router({ mergeParams: true })
  const groupStore = options.groupStore ?? createDbWorkspaceGroupStore()
  const contextStore = options.contextStore ?? createDbContextScopeStore()
  const reclassificationStore = options.reclassificationStore
    ?? createDbContextReclassificationStore()
  const getReadiness = options.getReadiness ?? getContextReadinessSystem
  const executeAccess = (req:Request,workspaceId:string,userId:string,command:unknown) =>
    (options.executeAccessCommand ?? executeReviewedDepartmentRoute)(workspaceId,userId,command,departmentRouteReview(req))

  async function gate(
    req: Request,
    res: Response,
    admin = false,
  ): Promise<{ userId: string; workspaceId: string; role: WorkspaceRole } | null> {
    const userId = req.userId
    const workspaceId = typeof req.params.workspaceId === 'string'
      ? req.params.workspaceId
      : ''
    if (!userId) {
      res.status(401).json({ error: 'unauthorized' })
      return null
    }
    if (!UUID.safeParse(workspaceId).success) {
      res.status(404).json({ error: 'not_found' })
      return null
    }
    const role = await options.workspaceStore.getRole(userId, workspaceId) as WorkspaceRole | null
    if (!role) {
      res.status(404).json({ error: 'not_found' })
      return null
    }
    if (admin && role !== 'owner' && role !== 'admin') {
      res.status(403).json({ error: 'admin_required' })
      return null
    }
    return { userId, workspaceId, role }
  }

  async function teamRows(userId: string, workspaceId: string) {
    const [groups, teams] = await Promise.all([
      groupStore.listGroups(userId, workspaceId),
      contextStore.listTeams(userId, workspaceId),
    ])
    const contextById = new Map(teams.map((team) => [team.id, team]))
    return groups
      .filter((group) => group.kind === 'team')
      .map((group) => {
        const context = contextById.get(group.id)
        return teamProjection(
          group,
          context ? grantGroupIds(context, teams) : [],
        )
      })
  }

  router.get('/workspaces/:workspaceId/groups', async (req, res) => {
    const access = await gate(req, res)
    if (!access) return
    res.json({ groups: await teamRows(access.userId, access.workspaceId) })
  })

  router.post('/workspaces/:workspaceId/groups', async (req, res) => {
    const access = await gate(req, res, true)
    if (!access) return
    const parsed = createTeamBody.safeParse(req.body)
    if (!parsed.success) return invalid(res, parsed)
    const result=await executeAccess(req,access.workspaceId,access.userId,{type:'department.create',...parsed.data})
    const group=(await teamRows(access.userId,access.workspaceId)).find(row=>row.id===result.appliedCommand?.subjectId)
    res.status(201).json({group})
  })

  router.get('/workspaces/:workspaceId/groups/:groupId', async (req, res) => {
    const access = await gate(req, res)
    if (!access) return
    const rows = await teamRows(access.userId, access.workspaceId)
    const group = rows.find((row) => row.id === req.params.groupId)
    if (!group) return void res.status(404).json({ error: 'not_found' })
    const [members, assistants] = await Promise.all([
      groupStore.listMembers(access.userId, group.id),
      queryWithRLS<{ assistantId: string }>(
        access.userId,
        'SELECT assistant_id AS "assistantId" FROM workspace_group_assistants WHERE group_id = $1 ORDER BY assistant_id',
        [group.id],
      ),
    ])
    res.json({
      group: {
        ...group,
        members,
        assistantIds: assistants.rows.map((row) => row.assistantId),
      },
    })
  })

  router.patch('/workspaces/:workspaceId/groups/:groupId', async (req, res) => {
    const access = await gate(req, res, true)
    if (!access) return
    const parsed = updateTeamBody.safeParse(req.body)
    if (!parsed.success) return invalid(res, parsed)
    await executeAccess(req,access.workspaceId,access.userId,{type:'department.update',teamId:req.params.groupId,...parsed.data})
    const group=(await teamRows(access.userId,access.workspaceId)).find(row=>row.id===req.params.groupId)
    res.json({group})
  })

  router.put('/workspaces/:workspaceId/groups/:groupId/members/:userId', async (req,res) => {
    const access=await gate(req,res)
    if(!access)return
    const parsed=memberBody.safeParse(req.body??{})
    if(!parsed.success)return invalid(res,parsed)
    await executeAccess(req,access.workspaceId,access.userId,{type:'department.member.set',teamId:req.params.groupId,userId:req.params.userId,enabled:true,activateAssigned:parsed.data.activateAssigned})
    res.status(204).end()
  })
  router.delete('/workspaces/:workspaceId/groups/:groupId/members/:userId', async (req,res) => {
    const access=await gate(req,res)
    if(!access)return
    await executeAccess(req,access.workspaceId,access.userId,{type:'department.member.set',teamId:req.params.groupId,userId:req.params.userId,enabled:false})
    res.status(204).end()
  })
  router.put('/workspaces/:workspaceId/groups/:groupId/assistants/:assistantId', async (req,res) => {
    const access=await gate(req,res,true)
    if(!access)return
    await executeAccess(req,access.workspaceId,access.userId,{type:'department.assistant.set',teamId:req.params.groupId,assistantId:req.params.assistantId,enabled:true})
    res.status(204).end()
  })
  router.delete('/workspaces/:workspaceId/groups/:groupId/assistants/:assistantId', async (req,res) => {
    const access=await gate(req,res,true)
    if(!access)return
    await executeAccess(req,access.workspaceId,access.userId,{type:'department.assistant.set',teamId:req.params.groupId,assistantId:req.params.assistantId,enabled:false})
    res.status(204).end()
  })
  router.put('/workspaces/:workspaceId/groups/:groupId/read-grants', async (req,res) => {
    const access=await gate(req,res,true)
    if(!access)return
    const parsed=readGrantsBody.safeParse(req.body)
    if(!parsed.success)return invalid(res,parsed)
    await executeAccess(req,access.workspaceId,access.userId,{type:'department.read_bundle.set',teamId:req.params.groupId,...parsed.data})
    res.status(204).end()
  })
  router.post('/workspaces/:workspaceId/groups/:groupId/archive', async (req,res) => {
    const access=await gate(req,res,true)
    if(!access)return
    await executeAccess(req,access.workspaceId,access.userId,{type:'department.archive',teamId:req.params.groupId})
    res.status(204).end()
  })

  router.get('/workspaces/:workspaceId/projects', async (req, res) => {
    const access = await gate(req, res)
    if (!access) return
    const includeArchived = req.query.includeArchived === 'true'
    res.json({
      projects: await contextStore.listProjects(
        access.userId,
        access.workspaceId,
        includeArchived,
      ),
    })
  })

  router.post('/workspaces/:workspaceId/projects', async (req, res) => {
    const access = await gate(req, res, true)
    if (!access) return
    const parsed = createProjectBody.safeParse(req.body)
    if (!parsed.success) return invalid(res, parsed)
    try {
      const project = await contextStore.createProject(access.userId, access.workspaceId, parsed.data)
      res.status(201).json({ project })
    } catch (error) {
      res.status(409).json({ error: (error as Error).message })
    }
  })

  router.get('/workspaces/:workspaceId/projects/:projectId', async (req, res) => {
    const access = await gate(req, res)
    if (!access) return
    const project = await contextStore.getProjectDetail(
      access.userId,
      access.workspaceId,
      req.params.projectId,
    )
    if (!project) return void res.status(404).json({ error: 'not_found' })
    const aggregates = await projectAggregates(access.userId, access.workspaceId, project.id)
    res.json({ project: { ...project, aggregates } })
  })

  router.patch('/workspaces/:workspaceId/projects/:projectId', async (req, res) => {
    const access = await gate(req, res, true)
    if (!access) return
    const parsed = updateProjectBody.safeParse(req.body)
    if (!parsed.success) return invalid(res, parsed)
    const project = await contextStore.updateProject(
      access.userId,
      access.workspaceId,
      req.params.projectId,
      parsed.data,
    )
    if (!project) return void res.status(404).json({ error: 'not_found' })
    res.json({ project })
  })

  router.put('/workspaces/:workspaceId/projects/:projectId/members/:userId', async (req, res) => {
    const access = await gate(req, res, true)
    if (!access) return
    const parsed = projectMemberBody.safeParse(req.body ?? {})
    if (!parsed.success) return invalid(res, parsed)
    const project = await contextStore.getProjectSystem(access.workspaceId, req.params.projectId)
    if (!project || project.status !== 'active') return void res.status(404).json({ error: 'not_found' })
    await contextStore.setProjectMember(access.userId, project.id, req.params.userId, parsed.data.role)
    res.status(204).end()
  })

  router.delete('/workspaces/:workspaceId/projects/:projectId/members/:userId', async (req, res) => {
    const access = await gate(req, res, true)
    if (!access) return
    const project = await contextStore.getProjectSystem(access.workspaceId, req.params.projectId)
    if (!project) return void res.status(404).json({ error: 'not_found' })
    await contextStore.setProjectMember(access.userId, project.id, req.params.userId, null)
    res.status(204).end()
  })

  router.put('/workspaces/:workspaceId/projects/:projectId/assistants/:assistantId', async (req, res) => {
    const access = await gate(req, res, true)
    if (!access) return
    await assertContextActivationReady(access.workspaceId, getReadiness)
    const project = await contextStore.getProjectSystem(access.workspaceId, req.params.projectId)
    if (!project || project.status !== 'active') return void res.status(404).json({ error: 'not_found' })
    await contextStore.setProjectAssistant(access.userId, project.id, req.params.assistantId, true)
    res.status(204).end()
  })

  router.delete('/workspaces/:workspaceId/projects/:projectId/assistants/:assistantId', async (req, res) => {
    const access = await gate(req, res, true)
    if (!access) return
    const project = await contextStore.getProjectSystem(access.workspaceId, req.params.projectId)
    if (!project) return void res.status(404).json({ error: 'not_found' })
    await contextStore.setProjectAssistant(access.userId, project.id, req.params.assistantId, false)
    res.status(204).end()
  })

  router.post('/workspaces/:workspaceId/projects/:projectId/archive', async (req, res) => {
    const access = await gate(req, res, true)
    if (!access) return
    const project = await contextStore.getProjectSystem(access.workspaceId, req.params.projectId)
    if (!project) return void res.status(404).json({ error: 'not_found' })
    await contextStore.archiveProject(access.userId, project.id)
    res.status(204).end()
  })

  async function connectorExposure(
    userId: string,
    workspaceId: string,
    instanceId: string,
  ) {
    if (!options.connectorInstanceStore || !options.connectorGrantStore) return null
    // Resolve workspace grants first: a workspace admin may configure a
    // teammate-owned personal connector without being allowed to read that
    // personal instance directly through its owner-scoped RLS policy. The
    // system grant projection carries public instance metadata only.
    const grant = (await options.connectorGrantStore.listForTargetSystem('workspace', workspaceId))
      .find((row) => row.connectorInstanceId === instanceId)
    if (grant) {
      return {
        kind: 'grant' as const,
        instance: grant.instance,
        grant,
        compartments: grant.compartments,
        projectIds: grant.projectIds,
      }
    }
    const instance = await options.connectorInstanceStore.get(userId, instanceId)
    if (!instance) return null
    if (instance.scope === 'workspace') {
      return instance.workspaceId === workspaceId
        ? { kind: 'instance' as const, instance, compartments: instance.compartments, projectIds: instance.projectIds }
        : null
    }
    return null
  }

  type ConnectorExposure = NonNullable<Awaited<ReturnType<typeof connectorExposure>>>

  /**
   * A connector's department is its audience (mcp.md -> "Connector departments
   * are an audience"). Who may change it: a workspace owner/admin; the member
   * who exposed it; any member in the audience of a workspace-owned connector
   * (it is team-managed). Anyone else in its audience may only read it.
   */
  async function connectorAuthority(
    access: { userId: string; workspaceId: string; role: WorkspaceRole },
    exposure: ConnectorExposure,
    departments: Map<string, unknown>,
  ): Promise<'edit' | 'view' | null> {
    if (access.role === 'owner' || access.role === 'admin') return 'edit'
    if (exposure.kind === 'grant' && exposure.grant.grantedByUserId === access.userId) return 'edit'
    const inAudience = exposure.compartments
      .every((label) => !label.startsWith('team:') || departments.has(label.slice(5)))
    if (!inAudience) return null
    return exposure.kind === 'instance' ? 'edit' : 'view'
  }

  router.get('/workspaces/:workspaceId/connectors/:instanceId/context', async (req, res) => {
    const access = await gate(req, res)
    if (!access) return
    const exposure = await connectorExposure(access.userId, access.workspaceId, req.params.instanceId)
    if (!exposure) return void res.status(404).json({ error: 'not_found' })
    const departments = await departmentClearancesForUserSystem(access.userId, access.workspaceId)
    const authority = await connectorAuthority(access, exposure, departments)
    if (!authority) return void res.status(404).json({ error: 'not_found' })
    const teams = await contextStore.listTeams(access.userId, access.workspaceId)
    const team = teams.find((row) => exposure.compartments.includes(row.compartmentKey))
    const labelled = exposure.compartments.find((label) => label.startsWith('team:'))
    res.json({
      context: {
        contextGroupId: team?.id ?? (labelled ? labelled.slice(5) : null),
        contextProjectId: exposure.projectIds[0] ?? null,
      },
      canEdit: authority === 'edit',
    })
  })

  router.put('/workspaces/:workspaceId/connectors/:instanceId/context', async (req, res) => {
    const access = await gate(req, res)
    if (!access) return
    const parsed = connectorContextBody.safeParse(req.body)
    if (!parsed.success) return invalid(res, parsed)
    const exposure = await connectorExposure(access.userId, access.workspaceId, req.params.instanceId)
    if (!exposure) return void res.status(404).json({ error: 'not_found' })
    const departments = await departmentClearancesForUserSystem(access.userId, access.workspaceId)
    const authority = await connectorAuthority(access, exposure, departments)
    if (!authority) return void res.status(404).json({ error: 'not_found' })
    if (authority !== 'edit') return void res.status(403).json({ error: 'connector_context_forbidden' })
    const currentTeamLabel = exposure.compartments.find((label) => label.startsWith('team:'))
    const groupId = parsed.data.contextGroupId === undefined
      ? currentTeamLabel ? currentTeamLabel.slice(5) : null
      : parsed.data.contextGroupId
    const projectId = parsed.data.contextProjectId === undefined
      ? exposure.projectIds[0] ?? null
      : parsed.data.contextProjectId
    const [team, project] = await Promise.all([
      groupId ? contextStore.getTeamSystem(access.workspaceId, groupId) : null,
      projectId ? contextStore.getProjectSystem(access.workspaceId, projectId) : null,
    ])
    if ((groupId && (!team || team.status !== 'active'))
      || (projectId && (!project || project.status !== 'active'))) {
      return void res.status(404).json({ error: 'context_not_available' })
    }
    // A non-admin may only place a connector in a department they belong to,
    // so they can never move it out of their own sight.
    if (parsed.data.contextGroupId && access.role !== 'owner' && access.role !== 'admin'
        && !departments.has(parsed.data.contextGroupId)) {
      return void res.status(403).json({ error: 'connector_department_not_held' })
    }
    const compartments = team ? [team.compartmentKey] : []
    const projectIds = project ? [project.id] : []
    const updated = exposure.kind === 'instance'
      ? Boolean(await options.connectorInstanceStore!.update(access.userId, exposure.instance.id, {
          compartments,
          projectIds,
        }))
      : await options.connectorGrantStore!.updateContext(
          access.userId,
          exposure.grant.id,
          compartments,
          projectIds,
        )
    if (!updated) return void res.status(404).json({ error: 'not_found' })
    res.status(204).end()
  })

  router.get('/workspaces/:workspaceId/assistants/:assistantId/context', async (req, res) => {
    const access = await gate(req, res)
    if (!access) return
    const config = await contextStore.getAssistantContextConfig(
      access.userId,
      access.workspaceId,
      req.params.assistantId,
    )
    if (!config) return void res.status(404).json({ error: 'not_found' })
    res.json({ context: config })
  })

  router.put('/workspaces/:workspaceId/assistants/:assistantId/context', async (req, res) => {
    const access = await gate(req, res, true)
    if (!access) return
    const parsed = assistantContextBody.safeParse(req.body)
    if (!parsed.success) return invalid(res, parsed)
    await executeAccess(req,access.workspaceId,access.userId,{type:'assistant.audience.set',assistantId:req.params.assistantId,...parsed.data})
    res.status(204).end()
  })

  async function effective(req: Request, res: Response) {
    const access = await gate(req, res)
    if (!access) return null
    const assistantId = typeof req.query.assistantId === 'string'
      ? req.query.assistantId
      : undefined
    const assistant = await loadAssistant(access.workspaceId, assistantId)
    if (!assistant) {
      res.status(404).json({ error: 'not_found' })
      return null
    }
    const groupId = typeof req.query.groupId === 'string' ? req.query.groupId : null
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null
    try {
      const scope = await resolveTurnScopeSystem({
        userId: access.userId,
        assistant,
        workspaceId: access.workspaceId,
        session: { contextGroupId: groupId, contextProjectId: projectId },
      }, { store: contextStore })
      const [teams, projects] = await Promise.all([
        contextStore.listTeams(access.userId, access.workspaceId),
        contextStore.listProjects(access.userId, access.workspaceId, false),
      ])
      const teamIds = scope.effectiveCompartments === null
        ? teams.map((team) => team.id)
        : teams
            .filter((team) => scopeGrantContains(scope.effectiveCompartments, [team.compartmentKey]))
            .map((team) => team.id)
      const projectIds = scope.effectiveProjectIds === null
        ? projects.map((project) => project.id)
        : projects
            .filter((project) => scopeGrantContains(scope.effectiveProjectIds, [project.id]))
            .map((project) => project.id)
      return { access, assistant, scope, teams, projects, teamIds, projectIds }
    } catch {
      res.status(404).json({ error: 'context_not_available' })
      return null
    }
  }

  router.get('/workspaces/:workspaceId/context/effective', async (req, res) => {
    const resolved = await effective(req, res)
    if (!resolved) return
    res.json({
      assistantId: resolved.assistant.id,
      activeGroupId: resolved.scope.activeGroupId,
      activeProjectId: resolved.scope.activeProjectId,
      teamIds: resolved.teamIds,
      projectIds: resolved.projectIds,
      teamUniverse: resolved.scope.effectiveCompartments === null,
      projectUniverse: resolved.scope.effectiveProjectIds === null,
      writeTeamId: resolved.scope.activeGroupId,
      writeProjectId: resolved.scope.activeProjectId,
    })
  })

  router.get('/workspaces/:workspaceId/context/explain', async (req, res) => {
    const resolved = await effective(req, res)
    if (!resolved) return
    const [memberTeams, assistantConfig] = await Promise.all([
      queryWithRLS<{ id: string; name: string; readAll: boolean }>(
        resolved.access.userId,
        `SELECT g.id, g.name, g.read_all AS "readAll"
           FROM workspace_group_members gm
           JOIN workspace_groups g ON g.id = gm.group_id
          WHERE gm.user_id = $1 AND g.workspace_id = $2 AND g.kind = 'team'
          ORDER BY g.name`,
        [resolved.access.userId, resolved.access.workspaceId],
      ),
      contextStore.getAssistantContextConfig(
        resolved.access.userId,
        resolved.access.workspaceId,
        resolved.assistant.id,
      ),
    ])
    res.json({
      memberTeams: memberTeams.rows,
      assistant: assistantConfig,
      activeTeam: resolved.scope.activeTeam
        ? { id: resolved.scope.activeTeam.id, name: resolved.scope.activeTeam.name }
        : null,
      activeProject: resolved.scope.activeProject,
      effective: {
        teamIds: resolved.teamIds,
        projectIds: resolved.projectIds,
        teamUniverse: resolved.scope.effectiveCompartments === null,
        projectUniverse: resolved.scope.effectiveProjectIds === null,
      },
      rule: 'Member, assistant, session Team, and Project grants intersect. Team grant bundles are flat and non-transitive.',
    })
  })

  router.get('/workspaces/:workspaceId/context/readiness', async (req, res) => {
    const access = await gate(req, res, true)
    if (!access) return
    // One evidence pass: the departmental verdict is a pure function of the
    // context evidence, so deriving it avoids a second schema probe and a
    // second inventory read on the same request.
    const context=await getReadiness(access.workspaceId)
    const departmental=options.getDepartmentalReadiness?await options.getDepartmentalReadiness(access.workspaceId):departmentalReadiness(context)
    res.json({...context,readyForActivation:context.readyForActivation&&departmental.ready,
      checks:[...context.checks.filter(check=>check.id!=='delegation'),{id:'delegation',ready:departmental.ready,blocking:true,detail:'Departmental access readiness',missing:departmental.missingCapabilities}],departmental})
  })

  router.post('/workspaces/:workspaceId/context/reclassify', async (req, res) => {
    const access = await gate(req, res)
    if (!access) return
    const parsed = reclassifyBody.safeParse(req.body)
    if (!parsed.success) return invalid(res, parsed)
    try {
      const event = await reclassificationStore.reclassify(access.userId, {
        workspaceId: access.workspaceId,
        ...parsed.data,
      })
      res.json({ event })
    } catch (error) {
      if (error instanceof ContextReclassificationError) {
        const status = error.code === 'not_found' ? 404
          : error.code === 'admin_confirmation_required' ? 403
            : 409
        return void res.status(status).json({ error: error.code })
      }
      throw error
    }
  })

  router.get('/workspaces/:workspaceId/context/reclassify', async (req, res) => {
    const access = await gate(req, res)
    if (!access) return
    const parsed = reclassifyQuery.safeParse(req.query)
    if (!parsed.success) return invalid(res, parsed)
    const requirements = await reclassificationStore.getRequirements(access.userId, {
      workspaceId: access.workspaceId,
      ...parsed.data,
    })
    if (!requirements) return void res.status(404).json({ error: 'not_found' })
    const teams = await contextStore.listTeams(access.userId, access.workspaceId)
    const stableTeamKeys = new Set(teams.map((team) => team.compartmentKey))
    res.json({
      context: {
        teamIds: teams
          .filter((team) => requirements.compartments.includes(team.compartmentKey))
          .map((team) => team.id),
        projectIds: requirements.projectIds,
        hasOtherCompartments: requirements.compartments.some((key) => !stableTeamKeys.has(key)),
      },
    })
  })

  router.use((error: unknown, _req: Request, res: Response, next: (error?: unknown) => void) => {
    if (error instanceof WorkspaceAccessError) { res.status(error.status).json({error:error.code}); return }
    if (error instanceof ContextActivationBlockedError) {
      res.status(409).json({ error: error.code, failedChecks: error.failedChecks })
      return
    }
    next(error)
  })

  return router
}
