/** Canonical organization transaction boundary. [COMP:api/organization-chart] */
import type { PoolClient } from 'pg'
import type { OrganizationChart, OrganizationCommand, OrganizationPlacement, OrganizationSubject } from '@use-brian/shared'
import { projectionLifetime } from '../workspace-access/projection-lifetime.js'
import { getPool } from './client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { organizationCommandSchema } from '../workspace-access/commands.js'
import { projectOrganizationChart, type DirectoryUnit } from '../workspace-access/org-chart.js'

export class OrganizationError extends Error {
  constructor(readonly code: 'not_found' | 'admin_required' | 'invalid_command' | 'organization_conflict', readonly status: number) { super(code) }
}

async function authority(client: PoolClient, workspaceId: string, userId: string, lockMembership = true): Promise<boolean> {
  const result = await client.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2${lockMembership?' FOR SHARE':''}`,[workspaceId,userId])
  if (!result.rows.length) throw new OrganizationError('not_found',404)
  return ['owner','admin'].includes(result.rows[0].role)
}

async function chart(client: PoolClient, workspaceId: string, userId: string, canManage: boolean): Promise<OrganizationChart> {
  const units = await client.query<DirectoryUnit>(
    `SELECT u.id,u.parent_id AS "parentId",u.name,u.position,u.team_id AS "teamId",g.name AS "teamName",
      u.directory_visibility AS "directoryVisibility",u.version::text,
      (g.directory_visibility='workspace' OR effective_member_read_compartments($2,$1) IS NULL
       OR g.compartment_key=ANY(effective_member_read_compartments($2,$1))
       OR EXISTS(SELECT 1 FROM workspace_team_managers m WHERE m.workspace_id=$1 AND m.team_id=u.team_id AND m.user_id=$2 AND m.revoked_at IS NULL)) IS TRUE AS "teamVisible",
      (g.status='active' AND (effective_member_read_compartments($2,$1) IS NULL
         OR g.compartment_key=ANY(effective_member_read_compartments($2,$1)))
       OR EXISTS(SELECT 1 FROM workspace_team_managers m WHERE m.workspace_id=$1 AND m.team_id=u.team_id AND m.user_id=$2 AND m.revoked_at IS NULL)) IS TRUE AS entitled
     FROM workspace_org_units u LEFT JOIN workspace_groups g ON g.id=u.team_id AND g.workspace_id=u.workspace_id
     WHERE u.workspace_id=$1 AND u.archived_at IS NULL ORDER BY u.position,u.name,u.id`,[workspaceId,userId])
  const placements = await client.query<OrganizationPlacement>(
    `SELECT p.id,p.unit_id AS "unitId",p.user_id AS "userId",p.assistant_id AS "assistantId",p.is_primary AS "isPrimary",
      p.reports_to_user_id AS "reportsToUserId",p.accountable_user_id AS "accountableUserId",p.version::text
     FROM workspace_org_placements p JOIN workspace_org_units u ON u.id=p.unit_id AND u.workspace_id=p.workspace_id
     WHERE p.workspace_id=$1 AND u.archived_at IS NULL
       AND (p.assistant_id IS NULL OR public.assistant_placement_visible($2,p.assistant_id)) ORDER BY p.id`,[workspaceId,userId])
  const subjects = await client.query<OrganizationSubject>(
    `SELECT u.id,'member' AS kind,coalesce(nullif(u.name,''),'') AS name FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1
     UNION ALL SELECT a.id,'assistant' AS kind,a.name FROM assistants a WHERE a.workspace_id=$1 AND public.assistant_placement_visible($2,a.id)`,[workspaceId,userId])
  const teams = await client.query<{id: string;name: string}>(`SELECT id,name FROM workspace_groups WHERE workspace_id=$1 AND kind='team' AND status='active' ORDER BY name`,[workspaceId])
  const state = await client.query<{revision: string}>(`SELECT revision::text FROM workspace_org_state WHERE workspace_id=$1`,[workspaceId])
  const result = projectOrganizationChart({validForMs:await projectionLifetime(client,workspaceId,userId),workspaceId,userId,canManage,revision:state.rows[0]?.revision ?? '0',units:units.rows,placements:placements.rows,subjects:subjects.rows,teams:teams.rows})
  if (canManage) {
    const assignments = await client.query<{subjectId:string;kind:'member'|'assistant';teamId:string}>(`
      SELECT gm.user_id AS "subjectId",'member' AS kind,g.id AS "teamId"
      FROM workspace_group_members gm JOIN workspace_groups g ON g.id=gm.group_id
      JOIN workspace_members m ON m.user_id=gm.user_id AND m.workspace_id=g.workspace_id
      WHERE g.workspace_id=$1 AND g.kind='team' AND g.status='active'
      UNION ALL
      SELECT ga.assistant_id AS "subjectId",'assistant' AS kind,g.id AS "teamId"
      FROM workspace_group_assistants ga JOIN workspace_groups g ON g.id=ga.group_id
      JOIN assistants a ON a.id=ga.assistant_id AND a.workspace_id=g.workspace_id
      WHERE g.workspace_id=$1 AND g.kind='team' AND g.status='active'
        AND public.assistant_placement_visible($2,a.id)`, [workspaceId,userId])
    const candidates = new Map<string, NonNullable<OrganizationChart['initialization']>['candidates'][number]>()
    for (const assignment of assignments.rows) {
      if (placements.rows.some(p => p.isPrimary && (assignment.kind === 'member' ? p.userId : p.assistantId) === assignment.subjectId)) continue
      const key = `${assignment.kind}:${assignment.subjectId}`
      const candidate = candidates.get(key) ?? { subjectId: assignment.subjectId, kind: assignment.kind, teamIds: [] }
      candidate.teamIds.push(assignment.teamId)
      candidates.set(key, candidate)
    }
    const policy = await client.query<{revision:string}>('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1', [workspaceId])
    result.initialization = { policyRevision: policy.rows[0]?.revision ?? '1',
      candidates: [...candidates.values()].map(candidate => ({ ...candidate, teamIds: [...new Set(candidate.teamIds)].sort() }))
        .sort((a,b) => `${a.kind}:${a.subjectId}`.localeCompare(`${b.kind}:${b.subjectId}`)) }
  }
  return result
}

export async function getOrganizationChart(workspaceId: string, userId: string): Promise<OrganizationChart> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result = await getOrganizationChartInTransaction(client,workspaceId,userId,false)
    await client.query('COMMIT')
    return result
  } catch(error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

async function applyCommand(client: PoolClient, workspaceId: string, command: Exclude<OrganizationCommand,{type:'org.initialize.subject'}>): Promise<string> {
  if (command.type==='org.unit.save') {
    const values = [workspaceId,command.name,command.parentId,command.teamId,command.directoryVisibility,command.position]
    const result = command.id
      ? await client.query<{id:string}>(`UPDATE workspace_org_units SET name=$2,parent_id=$3,team_id=$4,directory_visibility=$5,position=$6
          WHERE workspace_id=$1 AND id=$7 AND version=$8 AND archived_at IS NULL RETURNING id`,[...values,command.id,command.expectedVersion])
      : await client.query<{id:string}>(`INSERT INTO workspace_org_units(workspace_id,name,parent_id,team_id,directory_visibility,position) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,values)
    if (!result.rows.length) throw new OrganizationError('organization_conflict',409)
    return result.rows[0].id
  }
  if (command.type==='org.unit.archive') {
    const unit = await client.query(`SELECT id FROM workspace_org_units WHERE workspace_id=$1 AND id=$2 AND version=$3 AND archived_at IS NULL`,[workspaceId,command.id,command.expectedVersion])
    if (!unit.rows.length || command.destinationId===command.id) throw new OrganizationError('organization_conflict',409)
    if (command.destinationId) {
      const target = await client.query('SELECT id FROM workspace_org_units WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL',[workspaceId,command.destinationId])
      if (!target.rows.length) throw new OrganizationError('organization_conflict',409)
    }
    await client.query('UPDATE workspace_org_units SET parent_id=$3 WHERE workspace_id=$1 AND parent_id=$2 AND archived_at IS NULL',[workspaceId,command.id,command.destinationId])
    if (command.destinationId) await client.query('UPDATE workspace_org_placements SET unit_id=$3 WHERE workspace_id=$1 AND unit_id=$2',[workspaceId,command.id,command.destinationId])
    else await client.query('DELETE FROM workspace_org_placements WHERE workspace_id=$1 AND unit_id=$2',[workspaceId,command.id])
    await client.query('UPDATE workspace_org_units SET archived_at=now() WHERE workspace_id=$1 AND id=$2',[workspaceId,command.id])
    return command.id
  }
  if (command.type==='org.placement.remove') {
    const result = await client.query('DELETE FROM workspace_org_placements WHERE workspace_id=$1 AND id=$2 AND version=$3 RETURNING id',[workspaceId,command.id,command.expectedVersion])
    if (!result.rows.length) throw new OrganizationError('organization_conflict',409)
    return command.id
  }
  const values = [workspaceId,command.unitId,command.userId,command.assistantId,command.isPrimary,command.reportsToUserId,command.accountableUserId]
  const result = command.id
    ? await client.query<{id:string}>(`UPDATE workspace_org_placements SET unit_id=$2,user_id=$3,assistant_id=$4,is_primary=$5,reports_to_user_id=$6,accountable_user_id=$7
       WHERE workspace_id=$1 AND id=$8 AND version=$9 RETURNING id`,[...values,command.id,command.expectedVersion])
    : await client.query<{id:string}>(`INSERT INTO workspace_org_placements(workspace_id,unit_id,user_id,assistant_id,is_primary,reports_to_user_id,accountable_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,values)
  if (!result.rows.length) throw new OrganizationError('organization_conflict',409)
  return result.rows[0].id
}

async function initializeSubject(client: PoolClient, workspaceId: string,
  command: Extract<OrganizationCommand,{type:'org.initialize.subject'}>, before: OrganizationChart): Promise<string> {
  const candidate = before.initialization?.candidates.find(row => row.kind === command.kind && row.subjectId === command.subjectId)
  const team = before.teams.find(row => row.id === command.teamId)
  if (before.revision !== command.expectedRevision || before.initialization?.policyRevision !== command.expectedPolicyRevision
    || !candidate?.teamIds.includes(command.teamId) || !team) throw new OrganizationError('organization_conflict',409)
  let unitId = before.units.find(unit => unit.teamId === command.teamId)?.id
  if (!unitId) unitId = await applyCommand(client,workspaceId,{type:'org.unit.save',name:team.name,
    parentId:null,teamId:team.id,directoryVisibility:'members',position:0})
  const existing = before.placements.find(p => p.unitId === unitId && (command.kind === 'member' ? p.userId : p.assistantId) === command.subjectId)
  return applyCommand(client,workspaceId,{type:'org.placement.save',
    ...(existing ? {id:existing.id,expectedVersion:existing.version} : {}),unitId,
    userId:command.kind === 'member' ? command.subjectId : null,
    assistantId:command.kind === 'assistant' ? command.subjectId : null,
    isPrimary:true,reportsToUserId:null,accountableUserId:null})
}

export async function getOrganizationChartInTransaction(client:PoolClient,workspaceId:string,userId:string,lockMembership=true):Promise<OrganizationChart> {
  return chart(client,workspaceId,userId,await authority(client,workspaceId,userId,lockMembership))
}

/** Caller owns transaction, notifications and receipt settlement. */
export async function executeOrganizationCommandInTransaction(client:PoolClient,workspaceId:string,userId:string,command:OrganizationCommand):Promise<OrganizationChart> {
    // Global graph lock first, then membership, matching the constraint triggers.
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId])
    if (!await authority(client,workspaceId,userId)) throw new OrganizationError('admin_required',403)
    {
      // Serialize the reviewed direct assignments with the same revision that
      // existing membership/assistant-assignment triggers advance.
      await client.query('INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[workspaceId])
      await client.query('SELECT revision FROM workspace_access_policies WHERE workspace_id=$1 FOR UPDATE',[workspaceId])
    }
    const before = await chart(client,workspaceId,userId,true)
    const subjectId = command.type === 'org.initialize.subject'
      ? await initializeSubject(client,workspaceId,command,before)
      : await applyCommand(client,workspaceId,command)
    await client.query(`INSERT INTO workspace_org_state(workspace_id) VALUES($1) ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_org_state.revision+1`,[workspaceId])
    const result = await chart(client,workspaceId,userId,true)
    const policy = await client.query<{revision:string}>('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[workspaceId])
    // Structural before/after only. No content, clearance or private profile data.
    const audit=await client.query<{id:string}>(`INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,[workspaceId,userId,command.type,subjectId,policy.rows[0]?.revision ?? '1',JSON.stringify({command,before:{units:before.units,placements:before.placements},after:{units:result.units,placements:result.placements}})])
    return {...result,appliedCommand:{type:command.type,subjectId,auditEventId:audit.rows[0].id}}
}

export async function executeOrganizationCommand(workspaceId: string, userId: string, input: unknown): Promise<OrganizationChart> {
  const parsed = organizationCommandSchema.safeParse(input)
  if (!parsed.success) throw new OrganizationError('invalid_command',400)
  const command = parsed.data
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result=await executeOrganizationCommandInTransaction(client,workspaceId,userId,command)
    await client.query('COMMIT')
    notifyWorkspaceChange(workspaceId,'workspace_config','update')
    return result
  } catch(error) {
    await client.query('ROLLBACK')
    if (error instanceof OrganizationError) throw error
    const code = (error as {code?:string}).code
    if (code && ['23503','23505','23514','P0001','40001','40P01'].includes(code)) throw new OrganizationError('organization_conflict',409)
    throw error
  } finally { client.release() }
}
