/** Current-policy explanations and content-free audit. [COMP:api/workspace-access] */
import type { PoolClient } from 'pg'
import { canRead, scopeGrantContains, type ScopeGrant } from '@use-brian/core'
import type { WorkspaceAccessExplanation, WorkspaceAccessEvents, WorkspaceAccessOverview } from '@use-brian/shared'
import { getPool } from '../db/client.js'
import { createDbContextScopeStore } from '../db/context-scope-store.js'
import { getOrganizationChartInTransaction } from '../db/org-chart-store.js'
import { resolveOperationCeilingsSystem } from '../db/workspace-store.js'
import { ContextNotAvailableError, resolveTurnScopeSystem, type TurnScopeAssistant } from '../context-scope/resolve-turn-scope.js'
import { getWorkspaceAccessInTransaction } from './service.js'
import { workspaceAccessExplanationQuerySchema, workspaceAccessHistoryQuerySchema } from './commands.js'
import { WorkspaceAccessError } from './policy.js'

type Inspection = {client:PoolClient;view:WorkspaceAccessOverview}
async function inspect<T>(workspaceId:string,userId:string,run:(snapshot:Inspection)=>Promise<T>):Promise<T>{
  const client=await getPool().connect()
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const view=await getWorkspaceAccessInTransaction(client,workspaceId,userId)
    const result=await run({client,view})
    await client.query('COMMIT')
    return result
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}

export async function explainWorkspaceAccess(workspaceId:string,userId:string,input:unknown={}):Promise<WorkspaceAccessExplanation>{
  const parsed=workspaceAccessExplanationQuerySchema.safeParse(input)
  if(!parsed.success)throw new WorkspaceAccessError('invalid_command',400)
  const selection=parsed.data
  return inspect(workspaceId,userId,async({client,view})=>{
    if(selection.expectedPolicyRevision&&selection.expectedPolicyRevision!==view.policyRevision)throw new WorkspaceAccessError('access_policy_conflict',409)
    const memberId=selection.memberId??userId
    if(memberId!==userId&&!view.canAdminister)throw new WorkspaceAccessError('not_found',404)
    const person=view.people.find(row=>row.id===memberId)
    if(!person?.access)throw new WorkspaceAccessError('not_found',404)
    const visibleIds=view.teams.map(team=>team.id)
    for(const id of [selection.contextTeamId,selection.targetTeamId])if(id&&!visibleIds.includes(id))throw new WorkspaceAccessError('not_found',404)
    const teams=(await client.query<{id:string;compartment:string;readAll:boolean;bundle:string[]}>(`
      SELECT g.id,g.compartment_key AS compartment,g.read_all AS "readAll",
        ARRAY(SELECT compartment_key FROM workspace_group_compartment_grants WHERE group_id=g.id) AS bundle
      FROM workspace_groups g WHERE g.workspace_id=$1 AND g.id=ANY($2::uuid[])`,[workspaceId,visibleIds])).rows
    const projectRows=(await client.query<{id:string;name:string}>("SELECT id,name FROM workspace_projects WHERE workspace_id=$1 AND status='active' ORDER BY name,id",[workspaceId])).rows
    const directory=await getOrganizationChartInTransaction(client,workspaceId,userId,false)
    if(selection.contextProjectId&&!projectRows.some(row=>row.id===selection.contextProjectId))throw new WorkspaceAccessError('not_found',404)
    let assistant:TurnScopeAssistant={id:memberId,workspaceId,kind:'standard',clearance:'confidential',compartments:null,teamScopeMode:'all',projectScopeMode:'all'}
    if(selection.assistantId){
      if(!directory.subjects.some(subject=>subject.kind==='assistant'&&subject.id===selection.assistantId))throw new WorkspaceAccessError('not_found',404)
      const row=(await client.query<TurnScopeAssistant>(`SELECT id,workspace_id AS "workspaceId",kind,clearance,compartments,
        team_scope_mode AS "teamScopeMode",project_scope_mode AS "projectScopeMode",
        default_workspace_group_id AS "defaultWorkspaceGroupId",default_project_id AS "defaultProjectId"
        FROM assistants WHERE workspace_id=$1 AND id=$2`,[workspaceId,selection.assistantId])).rows[0]
      if(!row)throw new WorkspaceAccessError('not_found',404)
      assistant=row
    }
    let scope
    try{
      scope=await resolveTurnScopeSystem({workspaceId,userId:memberId,assistant,
        session:{contextGroupId:selection.contextTeamId??null,contextProjectId:selection.contextProjectId??null}},
        {store:createDbContextScopeStore(client),resolveReadCeilings:(id,workspace,clearance,compartments)=>
          resolveOperationCeilingsSystem(id,workspace,clearance,compartments,true,(sql,values)=>client.query(sql,values))})
    }catch(error){if(error instanceof ContextNotAvailableError)throw new WorkspaceAccessError('not_found',404);throw error}
    if(scope.access.compartments===undefined||scope.access.mutationCompartments===undefined||!scope.access.clearance)throw new WorkspaceAccessError('access_unavailable',503)
    const teamIds=(grant:ScopeGrant)=>grant===null?null:teams.filter(team=>grant.includes(team.compartment)).map(team=>team.id).sort()
    const paths:WorkspaceAccessExplanation['paths']=[]
    const path=(kind:WorkspaceAccessExplanation['paths'][number]['kind'],reach:ScopeGrant,sourceTeamId:string|null=null,grantId:string|null=null,expiresAt:string|null=null)=>{
      // A path explains underlying authority, including a path currently narrowed
      // by the selected assistant/context. Final reach is reported separately.
      paths.push({kind,sourceTeamId,targetTeamIds:teamIds(reach),grantId,expiresAt})
    }
    if(person.role!=='member')path('trusted_role',null)
    else if(person.access.teamScopeMode==='legacy'){
      const row=(await client.query<{compartments:ScopeGrant}>('SELECT compartments FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,memberId])).rows[0]
      path('legacy',row.compartments)
    }else{
      const memberships=(await client.query<{id:string}>('SELECT gm.group_id AS id FROM workspace_group_members gm JOIN workspace_groups g ON g.id=gm.group_id WHERE g.workspace_id=$1 AND gm.user_id=$2 AND g.status=\'active\' AND g.kind=\'team\'',[workspaceId,memberId])).rows
      for(const membership of memberships){const team=teams.find(t=>t.id===membership.id);if(team)path('membership',team.readAll?null:[team.compartment,...team.bundle],team.id)}
    }
    const grants=(await client.query<{id:string;beneficiaryKind:'member'|'team';beneficiaryId:string;targetTeamId:string;expiresAt:Date|null}>(`
      SELECT g.id,g.beneficiary_kind AS "beneficiaryKind",g.beneficiary_id AS "beneficiaryId",g.target_team_id AS "targetTeamId",g.expires_at AS "expiresAt"
      FROM workspace_access_grants g JOIN workspace_groups target ON target.id=g.target_team_id AND target.workspace_id=g.workspace_id
      WHERE g.workspace_id=$1 AND target.status='active' AND g.revoked_at IS NULL AND g.starts_at<=now() AND (g.expires_at IS NULL OR g.expires_at>now())
      AND ((g.beneficiary_kind='member' AND g.beneficiary_id=$2) OR (g.beneficiary_kind='team' AND EXISTS(
        SELECT 1 FROM workspace_group_members gm JOIN workspace_groups bg ON bg.id=gm.group_id
        WHERE gm.group_id=g.beneficiary_id AND gm.user_id=$2 AND bg.workspace_id=$1 AND bg.status='active')))
      ORDER BY g.id`,[workspaceId,memberId])).rows
    for(const grant of grants){
      const target=teams.find(team=>team.id===grant.targetTeamId)
      if(!target||(grant.beneficiaryKind==='team'&&!visibleIds.includes(grant.beneficiaryId)))continue
      path(grant.beneficiaryKind==='member'?'read_grant':'team_read_grant',[target.compartment],grant.beneficiaryKind==='team'?grant.beneficiaryId:null,grant.id,grant.expiresAt?.toISOString()??null)
    }
    const action=selection.action??'read',sensitivity=selection.sensitivity??'internal'
    const target=teams.find(team=>team.id===selection.targetTeamId)
    const grant=action==='read'?scope.access.compartments:scope.access.mutationCompartments
    const subjectView=memberId===userId?view:await getWorkspaceAccessInTransaction(client,workspaceId,memberId)
    return {workspaceId,policyRevision:view.policyRevision,validForMs:Math.min(view.validForMs,subjectView.validForMs),memberId,
      assistantId:selection.assistantId??null,contextTeamId:selection.contextTeamId??null,contextProjectId:selection.contextProjectId??null,
      choices:{assistants:directory.subjects.filter(subject=>subject.kind==='assistant').map(({id,name})=>({id,name})),projects:projectRows},
      clearance:scope.access.clearance!,readTeamIds:teamIds(scope.access.compartments),mutationTeamIds:teamIds(scope.access.mutationCompartments),
      projectIds:scope.effectiveProjectIds===null?null:projectRows.filter(row=>scope.effectiveProjectIds!.includes(row.id)).map(row=>row.id),paths,
      management:subjectView.teams.filter(team=>visibleIds.includes(team.id)).map(team=>({teamId:team.id,canManageMembers:team.canManageMembers,canApprove:team.canApprove})),
      example:{targetTeamId:target?.id??null,action,sensitivity,matchesScope:canRead(scope.access.clearance!,sensitivity)&&scopeGrantContains(grant===undefined?[]:grant,target?[target.compartment]:[]),resourceAuthorizationRequired:true}}
  })
}

export async function getWorkspaceAccessEvents(workspaceId:string,userId:string,input:unknown={}):Promise<WorkspaceAccessEvents>{
  const parsed=workspaceAccessHistoryQuerySchema.safeParse(input)
  if(!parsed.success)throw new WorkspaceAccessError('invalid_command',400)
  const selection=parsed.data
  return inspect(workspaceId,userId,async({client,view})=>{
    if(selection.expectedPolicyRevision&&selection.expectedPolicyRevision!==view.policyRevision)throw new WorkspaceAccessError('access_history_changed',409)
    const predicate=`e.workspace_id=$1 AND ($3::boolean OR
      (e.kind LIKE 'access.request.%' AND EXISTS(SELECT 1 FROM workspace_access_requests r WHERE r.id=e.subject_id AND r.workspace_id=$1 AND r.target_team_id=ANY($4::uuid[]) AND can_view_department_request(r.id,$2))) OR
      (e.kind='access.grant.revoke' AND EXISTS(SELECT 1 FROM workspace_access_grants g WHERE g.id=e.subject_id AND g.workspace_id=$1 AND g.target_team_id=ANY($4::uuid[]) AND can_view_department_request(g.request_id,$2))) OR
      (e.actor_user_id=$2 AND e.kind LIKE 'department.%' AND e.subject_id=ANY($4::uuid[])) OR
      (e.kind='member.access.set' AND e.subject_id=$2::uuid))`
    const args:unknown[]=[workspaceId,userId,view.canAdminister,view.teams.map(team=>team.id)]
    let anchor:string|undefined
    if(selection.after){anchor=(await client.query<{created:string}>(`SELECT e.created_at::text AS created FROM workspace_access_events e WHERE ${predicate} AND e.id=$5::uuid`,[...args,selection.after])).rows[0]?.created;if(!anchor)throw new WorkspaceAccessError('access_history_changed',409)}
    const rows=(await client.query<{id:string;kind:string;createdAt:Date;policyRevision:string;actorId:string|null;subjectId:string|null}>(`
      SELECT e.id,e.kind,e.created_at AS "createdAt",e.policy_revision::text AS "policyRevision",e.actor_user_id AS "actorId",e.subject_id AS "subjectId"
      FROM workspace_access_events e WHERE ${predicate} ${anchor?'AND (e.created_at,e.id)<($5::timestamptz,$6::uuid)':''}
      ORDER BY e.created_at DESC,e.id DESC LIMIT 51`,anchor?[...args,anchor,selection.after]:args)).rows
    const visibleSubjects=new Set([...view.teams,...view.people].map(row=>row.id))
    return{workspaceId,policyRevision:view.policyRevision,validForMs:view.validForMs,nextCursor:rows.length>50?rows[49].id:null,
      events:rows.slice(0,50).map(({actorId,...row})=>{
        const actor=view.people.find(person=>person.id===actorId)
        return{...row,createdAt:row.createdAt.toISOString(),actor:actor?{id:actor.id,name:actor.name}:null,
          subjectId:view.canAdminister||row.kind.startsWith('access.')||(row.subjectId&&visibleSubjects.has(row.subjectId))?row.subjectId:null}
      })}
  })
}
