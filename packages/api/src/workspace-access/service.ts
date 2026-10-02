/** Canonical administrative command service. [COMP:api/workspace-access] */
import { createHash,randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { DepartmentAccessCommand, DepartmentAccessRequest, DepartmentReadGrant, WorkspaceAccessOverview, WorkspaceAccessHistory, WorkspaceAccessHistoryQuery } from '@use-brian/shared'
import { projectionLifetime } from './projection-lifetime.js'
import { getDepartmentalReadinessSystem } from './readiness.js'
import { createDbContextScopeStore } from '../db/context-scope-store.js'
import { createDbWorkspaceGroupStore } from '../db/workspace-group-store.js'
import { getPool } from '../db/client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { departmentAccessCommandSchema, workspaceAccessHistoryQuerySchema } from './commands.js'
import { assertApproveReadRequest, assertManageTeamMembers, grantInterval, isAccessAdmin, WorkspaceAccessError, type ManagerCapability, type WorkspaceAccessRole } from './policy.js'

type Principal={workspaceId:string;userId:string;role:WorkspaceAccessRole;now:Date;revision:string}
type Team={id:string;name:string;compartmentKey:string;directoryVisibility:'members'|'workspace';requestable:boolean;readAll:boolean;status:string;bundle:string[];memberIds:string[];assistantIds:string[];managerIds:string[];managers:Array<{userId:string;capabilities:ManagerCapability[]}>;capabilities:ManagerCapability[];expanded:boolean}
type RequestRow={id:string;workspaceId:string;requesterUserId:string;beneficiaryKind:'member'|'team';beneficiaryId:string;targetTeamId:string;reason:string;startsAt:Date;expiresAt:Date|null;requestExpiresAt:Date;version:string;payloadHash:string;status:DepartmentAccessRequest['status'];approvalId:string|null;decidedBy:string|null}
const requestColumns=`id,workspace_id AS "workspaceId",requester_user_id AS "requesterUserId",beneficiary_kind AS "beneficiaryKind",beneficiary_id AS "beneficiaryId",target_team_id AS "targetTeamId",reason,starts_at AS "startsAt",expires_at AS "expiresAt",request_expires_at AS "requestExpiresAt",version::text,payload_hash AS "payloadHash",status,approval_id AS "approvalId",decided_by AS "decidedBy"`

async function principal(client:PoolClient,workspaceId:string,userId:string,write=false):Promise<Principal>{
  if(write)await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId])
  const member=await client.query<{role:WorkspaceAccessRole;now:Date}>(`SELECT role,now() AS now FROM workspace_members WHERE workspace_id=$1 AND user_id=$2${write?' FOR SHARE':''}`,[workspaceId,userId])
  if(!member.rows[0])throw new WorkspaceAccessError('not_found',404)
  if(write)await client.query('INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[workspaceId])
  const policy=await client.query<{revision:string}>(`SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1${write?' FOR UPDATE':''}`,[workspaceId])
  return{workspaceId,userId,role:member.rows[0].role,now:member.rows[0].now,revision:policy.rows[0]?.revision??'1'}
}
async function teams(client:PoolClient,p:Principal):Promise<Team[]>{
  const result=await client.query<Team>(`SELECT g.id,g.name,g.compartment_key AS "compartmentKey",g.directory_visibility AS "directoryVisibility",g.requestable,g.read_all AS "readAll",g.status,
    ARRAY(SELECT compartment_key FROM workspace_group_compartment_grants WHERE group_id=g.id) AS bundle,
    ARRAY(SELECT gm.user_id FROM workspace_group_members gm JOIN workspace_members wm ON wm.user_id=gm.user_id AND wm.workspace_id=g.workspace_id WHERE gm.group_id=g.id) AS "memberIds",
    ARRAY(SELECT assistant_id FROM workspace_group_assistants WHERE group_id=g.id) AS "assistantIds",
    ARRAY(SELECT user_id FROM workspace_team_managers WHERE team_id=g.id AND workspace_id=g.workspace_id AND revoked_at IS NULL) AS "managerIds",
    coalesce((SELECT jsonb_agg(jsonb_build_object('userId',user_id,'capabilities',capabilities)) FROM workspace_team_managers WHERE team_id=g.id AND workspace_id=g.workspace_id AND revoked_at IS NULL),'[]'::jsonb) AS managers,
    coalesce((SELECT capabilities FROM workspace_team_managers WHERE team_id=g.id AND workspace_id=g.workspace_id AND user_id=$2 AND revoked_at IS NULL),ARRAY[]::text[]) AS capabilities,
    EXISTS(SELECT 1 FROM workspace_access_grants ag WHERE ag.workspace_id=g.workspace_id AND ag.beneficiary_kind='team' AND ag.beneficiary_id=g.id AND ag.revoked_at IS NULL AND (ag.expires_at IS NULL OR ag.expires_at>now())) AS expanded
    FROM workspace_groups g WHERE g.workspace_id=$1 AND g.kind='team' ORDER BY g.name,g.id`,[p.workspaceId,p.userId])
  return result.rows
}
function admin(p:Principal){if(!isAccessAdmin(p.role))throw new WorkspaceAccessError('admin_required')}
async function requireDelegationReady(client:PoolClient,p:Principal):Promise<void>{
  const readiness=await getDepartmentalReadinessSystem(p.workspaceId,client.query.bind(client))
  if(!readiness.ready)throw new WorkspaceAccessError('departmental_enforcement_incomplete',409)
}
function approvalInput(p:Principal,r:RequestRow,team:Team,all:Team[]){return{actorUserId:p.userId,role:p.role,capabilities:team.capabilities,requesterUserId:r.requesterUserId,beneficiaryKind:r.beneficiaryKind,beneficiaryId:r.beneficiaryId,beneficiaryMemberIds:all.find(t=>t.id===r.beneficiaryId)?.memberIds??[],startsAt:r.startsAt,expiresAt:r.expiresAt,requestExpiresAt:r.requestExpiresAt,now:p.now,targetActive:team.status==='active'}}
function canDecide(p:Principal,r:RequestRow,team:Team,all:Team[]){try{assertApproveReadRequest(approvalInput(p,r,team,all));return true}catch{return false}}
function canManageMembers(p:Principal,team:Team){try{assertManageTeamMembers({role:p.role,capabilities:team.capabilities,ownCompartment:team.compartmentKey,readBundle:team.readAll?null:team.bundle,hasActiveBeneficiaryGrant:team.expanded});return true}catch{return false}}
/** Filter before both cursor lookup and page limit. Timestamps stay in PostgreSQL precision. */
async function historyIds(client:PoolClient,p:Principal,all:Team[],kind:'requests'|'grants',after?:string) {
  const grant=kind==='grants',table=grant?'workspace_access_grants':'workspace_access_requests';
  const predicate=`workspace_id=$1 AND target_team_id=ANY($2::uuid[])
    AND can_view_department_request(${grant?'request_id':'id'},$3)
    ${grant?`AND ($4::boolean OR (beneficiary_kind='member' AND beneficiary_id=$3)
      OR (beneficiary_kind='team' AND beneficiary_id=ANY($5::uuid[]))
      OR target_team_id=ANY($6::uuid[]))`:''}`;
  const args:unknown[]=[p.workspaceId,all.map(team=>team.id),p.userId];
  if(grant)args.push(isAccessAdmin(p.role),all.filter(team=>team.memberIds.includes(p.userId)).map(team=>team.id),all.filter(team=>team.capabilities.includes('approve_read_requests')).map(team=>team.id));
  let anchor:string|undefined;
  if(after){
    anchor=(await client.query<{created:string}>(`SELECT created_at::text AS created FROM ${table} WHERE ${predicate} AND id=$${args.length+1}::uuid`,[...args,after])).rows[0]?.created;
    if(!anchor)throw new WorkspaceAccessError('access_history_changed',409);
  }
  const boundary=after?`AND (created_at,id)<($${args.length+1}::timestamptz,$${args.length+2}::uuid)`:'';
  const rows=(await client.query<{id:string}>(`SELECT id FROM ${table} WHERE ${predicate} ${boundary} ORDER BY created_at DESC,id DESC LIMIT 51`,after?[...args,anchor,after]:args)).rows;
  const ids=rows.slice(0,50).map(row=>row.id);
  return {ids,nextCursor:rows.length>50?ids[ids.length-1]:null};
}
/** The overview minus request/grant history and departmental readiness. The
 * readiness audit introspects the catalog and counts every scoped row family
 * in the workspace, so read-only inspection surfaces that never return it
 * (registry, explanation, audit) must not pay for it on every refresh. */
export type WorkspaceAccessDirectory=Omit<WorkspaceAccessOverview,'readiness'|'requests'|'grants'|'nextRequestCursor'|'nextGrantCursor'|'appliedCommand'|'commandReceipt'>
async function directory(client:PoolClient,p:Principal):Promise<{all:Team[];visible:Team[];view:WorkspaceAccessDirectory}>{
  const all=await teams(client,p)
  const reach=(await client.query<{reach:string[]|null}>('SELECT effective_member_read_compartments($1,$2) AS reach',[p.userId,p.workspaceId])).rows[0].reach
  const visible=all.filter(t=>t.status==='active'&&(isAccessAdmin(p.role)||t.directoryVisibility==='workspace'||t.managerIds.includes(p.userId)||reach===null||reach.includes(t.compartmentKey)))
  const members=(await client.query<{id:string;name:string;role:WorkspaceAccessRole}>(`SELECT u.id,coalesce(u.name,'') AS name,m.role FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name,u.id`,[p.workspaceId])).rows
  const people:WorkspaceAccessOverview['people']=isAccessAdmin(p.role)?members:members.filter(m=>m.id===p.userId||visible.some(t=>t.managerIds.includes(p.userId)&&t.memberIds.includes(m.id)))
  const settings=await client.query<{id:string;clearance:'public'|'internal'|'confidential';teamScopeMode:'legacy'|'assigned';readReach:string[]|null;membershipReach:string[]|null}>(`SELECT user_id AS id,clearance,team_scope_mode AS "teamScopeMode",
    effective_member_read_compartments(user_id,workspace_id) AS "readReach",
    effective_member_team_compartments(user_id,workspace_id) AS "membershipReach"
    FROM workspace_members WHERE workspace_id=$1 AND ($2::boolean OR user_id=$3)`,[p.workspaceId,isAccessAdmin(p.role),p.userId])
  const teamIds=(reach:string[]|null)=>reach===null?null:visible.filter(team=>reach.includes(team.compartmentKey)).map(team=>team.id)
  for(const person of people){const setting=settings.rows.find(row=>row.id===person.id);if(setting)person.access={clearance:setting.clearance,effectiveClearance:isAccessAdmin(person.role)?'confidential':setting.clearance,teamScopeMode:setting.teamScopeMode,readTeamIds:teamIds(setting.readReach),membershipTeamIds:teamIds(setting.membershipReach),hasUnlistedReadScope:setting.readReach?.some(key=>!visible.some(team=>team.compartmentKey===key))??false,hasUnlistedMembershipScope:setting.membershipReach?.some(key=>!visible.some(team=>team.compartmentKey===key))??false}}
  const policy=(await client.query<{revision:string;mode:WorkspaceAccessOverview['classificationMode']}>('SELECT revision::text,classification_mode AS mode FROM workspace_access_policies WHERE workspace_id=$1',[p.workspaceId])).rows[0]
  return{all,visible,view:{validForMs:await projectionLifetime(client,p.workspaceId,p.userId),workspaceId:p.workspaceId,policyRevision:policy?.revision??'1',classificationMode:policy?.mode??'legacy',canAdminister:isAccessAdmin(p.role),people,teams:visible.map(t=>({id:t.id,name:t.name,directoryVisibility:t.directoryVisibility,requestable:t.requestable,canManageMembers:canManageMembers(p,t),canApprove:isAccessAdmin(p.role)||t.capabilities.includes('approve_read_requests'),expandedPackage:t.expanded||t.readAll||t.bundle.some(key=>key!==t.compartmentKey),memberIds:t.memberIds.filter(id=>people.some(m=>m.id===id)),assistantIds:isAccessAdmin(p.role)||t.managerIds.includes(p.userId)?t.assistantIds:[],managerIds:t.managerIds.filter(id=>people.some(m=>m.id===id)),managers:isAccessAdmin(p.role)?t.managers:[]}))}}
}
async function overview(client:PoolClient,p:Principal,history?:WorkspaceAccessHistoryQuery & {kind:'requests'|'grants';requestId?:string}):Promise<WorkspaceAccessOverview>{
  const {all,visible,view}=await directory(client,p)
  const people=view.people
  const requestPage=history?.requestId?{ids:(await client.query<{id:string}>('SELECT id FROM workspace_access_requests WHERE workspace_id=$1 AND id=$2 AND can_view_department_request(id,$3)',[p.workspaceId,history.requestId,p.userId])).rows.map(row=>row.id),nextCursor:null}:history?.kind==='grants'?{ids:[],nextCursor:null}:await historyIds(client,p,all,'requests',history?.after);
  const grantPage=history?.kind==='requests'?{ids:[],nextCursor:null}:await historyIds(client,p,all,'grants',history?.after);
  const memberName=(id:string)=>people.find(m=>m.id===id)?.name??null
  const rows=(await client.query<RequestRow>(`SELECT ${requestColumns} FROM workspace_access_requests WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY created_at DESC,id DESC`,[p.workspaceId,requestPage.ids])).rows
  const requests:DepartmentAccessRequest[]=[]
  for(const r of rows){
    const team=all.find(t=>t.id===r.targetTeamId);if(!team)continue
    const isBeneficiary=r.beneficiaryKind==='member'?r.beneficiaryId===p.userId:all.some(t=>t.id===r.beneficiaryId&&t.memberIds.includes(p.userId))
    const permitted=isAccessAdmin(p.role)||r.requesterUserId===p.userId||isBeneficiary||team.capabilities.includes('approve_read_requests')
    if(!permitted)continue
    const status=r.status==='pending'&&r.requestExpiresAt<=p.now?'expired':r.status
    requests.push({id:r.id,targetTeamId:r.targetTeamId,requesterUserId:r.requesterUserId,beneficiaryKind:r.beneficiaryKind,beneficiaryId:r.beneficiaryId,reason:r.reason,version:r.version,payloadHash:r.payloadHash,approvalId:r.approvalId,targetTeamName:team.name,beneficiaryName:r.beneficiaryKind==='member'?memberName(r.beneficiaryId):visible.find(t=>t.id===r.beneficiaryId)?.name??null,startsAt:r.startsAt.toISOString(),expiresAt:r.expiresAt?.toISOString()??null,requestExpiresAt:r.requestExpiresAt.toISOString(),status,canDecide:status==='pending'&&canDecide(p,r,team,all),canCancel:status==='pending'&&(isAccessAdmin(p.role)||r.requesterUserId===p.userId)})
  }
  const grants:DepartmentReadGrant[]=[]
  const grantRows=(await client.query<{id:string;requestId:string;beneficiaryKind:'member'|'team';beneficiaryId:string;targetTeamId:string;startsAt:Date;expiresAt:Date|null;revokedAt:Date|null;approvedBy:string}>(`SELECT id,request_id AS "requestId",beneficiary_kind AS "beneficiaryKind",beneficiary_id AS "beneficiaryId",target_team_id AS "targetTeamId",starts_at AS "startsAt",expires_at AS "expiresAt",revoked_at AS "revokedAt",approved_by AS "approvedBy" FROM workspace_access_grants WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY created_at DESC,id DESC`,[p.workspaceId,grantPage.ids])).rows
  for(const grant of grantRows){
    const team=all.find(t=>t.id===grant.targetTeamId);if(!team)continue
    const beneficiary=grant.beneficiaryKind==='member'?grant.beneficiaryId===p.userId:all.some(t=>t.id===grant.beneficiaryId&&t.memberIds.includes(p.userId))
    if(!isAccessAdmin(p.role)&&!beneficiary&&!team.capabilities.includes('approve_read_requests'))continue
    grants.push({...grant,status:grant.revokedAt?'revoked':grant.expiresAt&&grant.expiresAt<=p.now?'expired':grant.startsAt>p.now?'scheduled':'active',targetTeamName:team.name,beneficiaryName:grant.beneficiaryKind==='member'?memberName(grant.beneficiaryId):visible.find(t=>t.id===grant.beneficiaryId)?.name??null,startsAt:grant.startsAt.toISOString(),expiresAt:grant.expiresAt?.toISOString()??null,revokedAt:grant.revokedAt?.toISOString()??null,canRevoke:!grant.revokedAt&&(isAccessAdmin(p.role)||team.capabilities.includes('approve_read_requests')||(grant.beneficiaryKind==='member'&&beneficiary))})
  }
  return{...view,nextRequestCursor:requestPage.nextCursor,nextGrantCursor:grantPage.nextCursor,readiness:await getDepartmentalReadinessSystem(p.workspaceId,client.query.bind(client)),requests,grants}
}

export async function getWorkspaceAccess(workspaceId:string,userId:string):Promise<WorkspaceAccessOverview>{
  const client=await getPool().connect()
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const p=await principal(client,workspaceId,userId);const result=await overview(client,p);await client.query('COMMIT');return result}
  catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}

/** Confirmation reads the authorized immutable request even outside the overview window. */
export async function getWorkspaceAccessRequest(workspaceId:string,userId:string,requestId:string):Promise<{policyRevision:string;request:DepartmentAccessRequest}>{
  const client=await getPool().connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const p=await principal(client,workspaceId,userId);
    const view=await overview(client,p,{kind:'requests',requestId});
    if(!view.requests[0])throw new WorkspaceAccessError('not_found',404);
    await client.query('COMMIT');return{policyRevision:view.policyRevision,request:view.requests[0]};
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}

export async function getWorkspaceAccessHistory(workspaceId:string,userId:string,kind:'requests'|'grants',query:WorkspaceAccessHistoryQuery={}):Promise<WorkspaceAccessHistory>{
  if(!workspaceAccessHistoryQuerySchema.safeParse(query).success)throw new WorkspaceAccessError('invalid_command',400);
  const client=await getPool().connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const p=await principal(client,workspaceId,userId);
    if(query.expectedPolicyRevision&&query.expectedPolicyRevision!==p.revision)throw new WorkspaceAccessError('access_history_changed',409);
    const view=await overview(client,p,{kind,...query});
    await client.query('COMMIT');
    return{kind,workspaceId,policyRevision:view.policyRevision,validForMs:view.validForMs,nextCursor:(kind==='requests'?view.nextRequestCursor:view.nextGrantCursor)??null,requests:view.requests,grants:view.grants};
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}

async function attachApproval(client:PoolClient,p:Principal,r:RequestRow,all:Team[],refresh=false):Promise<void>{
  if((r.approvalId&&!refresh)||r.status!=='pending'||r.requestExpiresAt<=p.now)return
  const target=all.find(t=>t.id===r.targetTeamId);if(!target)return
  p={...p,revision:(await client.query<{revision:string}>('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[p.workspaceId])).rows[0].revision}
  const candidates=(await client.query<{userId:string;role:WorkspaceAccessRole}>(`SELECT user_id AS "userId",role FROM workspace_members WHERE workspace_id=$1 AND (role IN('owner','admin') OR user_id=ANY($2::uuid[])) ORDER BY CASE WHEN role='member' THEN 0 ELSE 1 END,user_id`,[p.workspaceId,target.managerIds])).rows
  let approver:string|undefined
  for(const candidate of candidates){const capabilities=(await client.query<{capabilities:ManagerCapability[]}>(`SELECT capabilities FROM workspace_team_managers WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3 AND revoked_at IS NULL`,[p.workspaceId,target.id,candidate.userId])).rows[0]?.capabilities??[];if(canDecide({...p,userId:candidate.userId,role:candidate.role},r,{...target,capabilities},all)){approver=candidate.userId;break}}
  const previous=r.approvalId?(await client.query<{status:string;approver:string;payload:unknown}>(`SELECT status,approver_user_id AS approver,approval_payload AS payload FROM pending_approvals WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[p.workspaceId,r.approvalId])).rows[0]:null
  if(!approver){
    if(r.approvalId){
      await client.query(`UPDATE pending_approvals SET status='superseded',responded_at=now(),responded_by=$2 WHERE id=$1 AND status='pending'`,[r.approvalId,p.userId])
      await client.query('UPDATE workspace_access_requests SET approval_id=NULL WHERE id=$1',[r.id])
      await client.query(`INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes) VALUES($1,$2,'access.reviewer.refresh',$3,$4,$5::jsonb)`,[p.workspaceId,p.userId,r.id,p.revision,JSON.stringify({before:previous,after:null})])
    }
    return
  }
  const reuse=previous?.status==='pending'
  const id=reuse?r.approvalId!:randomUUID()
  const beneficiaryName=r.beneficiaryKind==='team'?all.find(team=>team.id===r.beneficiaryId)?.name??null:
    (await client.query<{name:string|null}>('SELECT name FROM users WHERE id=$1',[r.beneficiaryId])).rows[0]?.name??null
  const payload={targetTeamName:target.name,beneficiaryName,beneficiaryKind:r.beneficiaryKind,reason:r.reason,startsAt:r.startsAt.toISOString(),expiresAt:r.expiresAt?.toISOString()??null,requestId:r.id,requestVersion:r.version,payloadHash:r.payloadHash,policyRevision:(await client.query<{revision:string}>('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[p.workspaceId])).rows[0].revision,description:'Department read access request',displayLines:[target.name,r.reason,r.expiresAt?`Read only until ${r.expiresAt.toISOString()}`:'Ongoing read only access',r.beneficiaryKind==='team'?'Applies to current and future direct human members.':'Individual access.'],allowPersistentApproval:false}
  if(reuse)await client.query('UPDATE pending_approvals SET approver_user_id=$3,expires_at=$4,approval_payload=$5::jsonb WHERE id=$1 AND workspace_id=$2',[id,p.workspaceId,approver,r.requestExpiresAt,JSON.stringify(payload)])
  else await client.query(`INSERT INTO pending_approvals(id,workspace_id,kind,approver_user_id,delivery_channel_type,expires_at,approval_payload) VALUES($1,$2,'department_access',$3,'web',$4,$5::jsonb)`,[id,p.workspaceId,approver,r.requestExpiresAt,JSON.stringify(payload)])
  if(refresh)await client.query(`INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes) VALUES($1,$2,'access.reviewer.refresh',$3,$4,$5::jsonb)`,[p.workspaceId,p.userId,r.id,payload.policyRevision,JSON.stringify({before:previous,after:{approvalId:id,approver,payload}})])
  await client.query('UPDATE workspace_access_requests SET approval_id=$2 WHERE id=$1',[r.id,id])
}

/** Canonical before/after audit, never a model-written account of the change. */
async function auditState(client:PoolClient,workspaceId:string,command:DepartmentAccessCommand,createdId?:string):Promise<unknown> {
  if(command.type==='workspace.default_department.set')return (await client.query('SELECT access_mode,default_department_id FROM workspace_access_policies WHERE workspace_id=$1',[workspaceId])).rows[0]??null
  if(command.type==='workspace.classification.set')return (await client.query('SELECT workspace_id,classification_mode,revision::text,reviewed_inventory_revision::text FROM workspace_access_policies WHERE workspace_id=$1',[workspaceId])).rows[0]??null
  if(command.type==='assistant.clearance.set')return (await client.query('SELECT id,clearance FROM assistants WHERE workspace_id=$1 AND id=$2',[workspaceId,command.assistantId])).rows[0]??null
  if(command.type==='member.access.set')return (await client.query('SELECT user_id,role,clearance,team_scope_mode FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,command.userId])).rows[0]??null
  if(command.type==='assistant.audience.set')return (await client.query(`SELECT a.id,a.team_scope_mode,a.default_workspace_group_id,a.project_scope_mode,a.default_project_id,
    ARRAY(SELECT group_id FROM workspace_group_assistants WHERE assistant_id=a.id ORDER BY group_id) AS team_ids,
    ARRAY(SELECT project_id FROM assistant_project_grants WHERE assistant_id=a.id ORDER BY project_id) AS project_ids
    FROM assistants a WHERE a.workspace_id=$1 AND a.id=$2`,[workspaceId,command.assistantId])).rows[0]??null
  if(command.type==='department.create'||command.type==='department.update'||command.type==='department.archive'||command.type==='department.read_bundle.set'||command.type==='department.assistant.set') {
    const id=command.type==='department.create'?createdId:command.teamId
    if(!id)return null
    return (await client.query(`SELECT g.id,g.name,g.key,g.description,g.color,g.status,g.directory_visibility,g.requestable,g.read_all,
      ARRAY(SELECT compartment_key FROM workspace_group_compartment_grants WHERE group_id=g.id ORDER BY compartment_key) AS bundle,
      ARRAY(SELECT assistant_id FROM workspace_group_assistants WHERE group_id=g.id ORDER BY assistant_id) AS assistant_ids
      FROM workspace_groups g WHERE g.workspace_id=$1 AND g.id=$2`,[workspaceId,id])).rows[0]??null
  }
  if(command.type==='department.configure')return (await client.query('SELECT id,name,directory_visibility,requestable,read_all FROM workspace_groups WHERE workspace_id=$1 AND id=$2',[workspaceId,command.teamId])).rows[0]??null
  if(command.type==='department.manager.set')return (await client.query('SELECT team_id,user_id,capabilities,granted_by,revoked_at FROM workspace_team_managers WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3',[workspaceId,command.teamId,command.userId])).rows[0]??null
  if(command.type==='department.member.set')return (await client.query(`SELECT g.id,g.read_all,
    (SELECT team_scope_mode FROM workspace_members WHERE workspace_id=$1 AND user_id=$3) AS team_scope_mode,
    EXISTS(SELECT 1 FROM workspace_group_members WHERE group_id=g.id AND user_id=$3) AS member,
    ARRAY(SELECT compartment_key FROM workspace_group_compartment_grants WHERE group_id=g.id) AS bundle
    FROM workspace_groups g WHERE g.workspace_id=$1 AND g.id=$2`,[workspaceId,command.teamId,command.userId])).rows[0]??null
  if(command.type==='access.grant.revoke')return (await client.query('SELECT id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,revoked_at,revoked_by,revocation_reason FROM workspace_access_grants WHERE workspace_id=$1 AND id=$2',[workspaceId,command.grantId])).rows[0]??null
  const requestId=command.type==='access.request.create'?createdId:command.requestId
  if(!requestId)return null
  return (await client.query('SELECT id,status,version,payload_hash,policy_revision,approval_id,decided_by,decided_at,decision_reason,reason,starts_at,expires_at,(SELECT approver_user_id FROM pending_approvals WHERE id=approval_id) AS reviewer_id FROM workspace_access_requests WHERE workspace_id=$1 AND id=$2',[workspaceId,requestId])).rows[0]??null
}

/** Trusted transaction entry. Transport callers must use the saved-review protocol. */
export async function executeDepartmentAccessInTransaction(client:PoolClient,workspaceId:string,userId:string,command:DepartmentAccessCommand):Promise<WorkspaceAccessOverview>{
    const p=await principal(client,workspaceId,userId,true),all=await teams(client,p)
    const before=await auditState(client,workspaceId,command)
    let subjectId:string
    if(command.type==='workspace.default_department.set') {
      admin(p)
      const target=all.find(team=>team.id===command.teamId)
      if(!target||target.status!=='active'||target.readAll||target.bundle.some(key=>key!==target.compartmentKey))throw new WorkspaceAccessError('access_mode_default_invalid',409)
      const policy=(await client.query<{mode:string;defaultId:string|null}>('SELECT access_mode AS mode,default_department_id AS "defaultId" FROM workspace_access_policies WHERE workspace_id=$1 FOR UPDATE',[workspaceId])).rows[0]
      if(policy.mode==='simple'&&policy.defaultId!==command.teamId)throw new WorkspaceAccessError('access_mode_migration_required',409)
      await client.query('UPDATE workspace_access_policies SET default_department_id=$2 WHERE workspace_id=$1',[workspaceId,command.teamId])
      subjectId=workspaceId
    }else if(command.type==='workspace.classification.set') {
      admin(p)
      if(command.expectedPolicyRevision!==p.revision)throw new WorkspaceAccessError('access_policy_conflict',409)
      const policy=(await client.query<{classificationMode:string;inventoryRevision:string|null}>(`SELECT classification_mode AS "classificationMode",reviewed_inventory_revision::text AS "inventoryRevision"
        FROM workspace_access_policies WHERE workspace_id=$1 FOR UPDATE`,[workspaceId])).rows[0]
      if(policy?.classificationMode==='strict')throw new WorkspaceAccessError('classification_already_strict',409)
      if(policy?.inventoryRevision!==command.expectedInventoryRevision)throw new WorkspaceAccessError('scope_review_changed',409)
      await requireDelegationReady(client,p)
      const updated=await client.query(`UPDATE workspace_access_policies SET classification_mode='strict',revision=revision+1,updated_at=now()
        WHERE workspace_id=$1 AND revision=$2::bigint AND reviewed_inventory_revision=$3::bigint RETURNING workspace_id`,[workspaceId,command.expectedPolicyRevision,command.expectedInventoryRevision])
      if(!updated.rows.length)throw new WorkspaceAccessError('access_policy_conflict',409)
      subjectId=workspaceId
    }else if(command.type==='assistant.clearance.set') {
      const target=(await client.query('SELECT id FROM assistants WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,command.assistantId])).rows[0]
      if(!target)throw new WorkspaceAccessError('not_found',404)
      if(!isAccessAdmin(p.role)){
        const ownership=(await client.query<{role:string}>('SELECT role FROM assistant_members WHERE assistant_id=$1 AND user_id=$2 FOR SHARE',[command.assistantId,userId])).rows[0]
        if(ownership?.role!=='owner')throw new WorkspaceAccessError('admin_required')
      }
      await client.query('UPDATE assistants SET clearance=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2',[workspaceId,command.assistantId,command.clearance])
      await client.query("UPDATE sessions SET effective_clearance=$2 WHERE assistant_id=$1 AND visibility='workspace'",[command.assistantId,command.clearance])
      await client.query('UPDATE comment_threads ct SET effective_clearance=$2 FROM sessions s WHERE s.id=ct.session_id AND s.assistant_id=$1',[command.assistantId,command.clearance])
      await client.query('UPDATE workspace_access_policies SET revision=revision+1,updated_at=now() WHERE workspace_id=$1',[workspaceId])
      subjectId=command.assistantId
    }else if(command.type==='member.access.set') {
      admin(p)
      const target=(await client.query<{role:WorkspaceAccessRole;teamScopeMode:string}>('SELECT role,team_scope_mode AS "teamScopeMode" FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[workspaceId,command.userId])).rows[0]
      if(!target)throw new WorkspaceAccessError('not_found',404)
      if(target.role!=='member')throw new WorkspaceAccessError('member_role_required',409)
      if(command.expectedPolicyRevision!==p.revision)throw new WorkspaceAccessError('access_policy_conflict',409)
      if(command.teamScopeMode==='legacy'&&target.teamScopeMode!=='legacy')throw new WorkspaceAccessError('legacy_mode_not_assignable',409)
      if(command.teamScopeMode==='assigned'&&target.teamScopeMode!=='assigned')await requireDelegationReady(client,p)
      await client.query('UPDATE workspace_members SET clearance=$3,team_scope_mode=$4 WHERE workspace_id=$1 AND user_id=$2',[workspaceId,command.userId,command.clearance,command.teamScopeMode])
      subjectId=command.userId
    }else if(command.type==='assistant.audience.set') {
      admin(p)
      if(!(await client.query('SELECT id FROM assistants WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,command.assistantId])).rows.length)throw new WorkspaceAccessError('not_found',404)
      const ids=[...new Set([...command.teamIds,...(command.defaultGroupId?[command.defaultGroupId]:[])])]
      if(ids.some(id=>!all.some(team=>team.id===id&&team.status==='active')))throw new WorkspaceAccessError('not_found',404)
      const projects=[...new Set([...command.projectIds,...(command.defaultProjectId?[command.defaultProjectId]:[])])]
      if(projects.length&&(await client.query("SELECT id FROM workspace_projects WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND status='active' FOR SHARE",[workspaceId,projects])).rows.length!==projects.length)throw new WorkspaceAccessError('not_found',404)
      if(command.teamMode==='assigned'||command.projectMode==='assigned'||command.defaultGroupId||command.defaultProjectId||command.teamIds.length||command.projectIds.length)await requireDelegationReady(client,p)
      await createDbContextScopeStore(client).setAssistantContext(userId,command.assistantId,command)
      subjectId=command.assistantId
    }else if(command.type==='department.create'||command.type==='department.update'||command.type==='department.archive'||command.type==='department.read_bundle.set'||command.type==='department.assistant.set') {
      admin(p)
      const store=createDbWorkspaceGroupStore(client)
      if(command.type==='department.create') {
        const created=await store.createTeam(userId,workspaceId,command)
        subjectId=created.id
      } else {
        const team=all.find(row=>row.id===command.teamId)
        if(!team)throw new WorkspaceAccessError('not_found',404)
        subjectId=team.id
        if(command.type==='department.update') {
          if(!['name','description','color','status'].some(key=>key in command))throw new WorkspaceAccessError('invalid_command',400)
          await store.updateTeam(userId,team.id,command)
        } else if(command.type==='department.archive') {
          await store.archiveTeam(userId,team.id)
        } else if(command.type==='department.read_bundle.set') {
          // Retired by the v2 cutover (D23, D26): in a v2 workspace Team-to-Team
          // read packages and "read every Team" create no access, so the command
          // is refused rather than saved as an inert setting. Per-person access
          // is an edge set through manageDepartments / Organization -> Departments.
          // A workspace rolled back to the legacy read keeps the command.
          const v2=(await client.query<{v2:boolean}>(`SELECT coalesce((to_jsonb(w)->>'department_read_v2')::boolean,false) AS v2 FROM workspaces w WHERE id=$1`,[workspaceId])).rows[0]?.v2===true
          if(v2)throw new WorkspaceAccessError('department_read_bundle_retired',410)
          const selected=command.groupIds.map(id=>all.find(row=>row.id===id&&row.status==='active'))
          if(team.status!=='active'||selected.some(row=>!row))throw new WorkspaceAccessError('not_found',404)
          await store.setTeamReadBundle(userId,team.id,{readAll:command.readAll,compartmentKeys:selected.map(row=>row!.compartmentKey)})
        } else {
          const assistant=(await client.query('SELECT id FROM assistants WHERE workspace_id=$1 AND id=$2 FOR SHARE',[workspaceId,command.assistantId])).rows[0]
          if(!assistant||(command.enabled&&team.status!=='active'))throw new WorkspaceAccessError('not_found',404)
          if(command.enabled&&!team.assistantIds.includes(command.assistantId))await requireDelegationReady(client,p)
          await store.setTeamAssistant(userId,team.id,command.assistantId,command.enabled)
        }
      }
    }else if(command.type==='department.configure'||command.type==='department.manager.set'||command.type==='department.member.set'){
      const c=command,team=all.find(t=>t.id===c.teamId&&t.status==='active')
      if(!team)throw new WorkspaceAccessError('not_found',404)
      subjectId=team.id
      if(c.type==='department.configure'){admin(p);await client.query('UPDATE workspace_groups SET directory_visibility=$3,requestable=$4 WHERE workspace_id=$1 AND id=$2',[workspaceId,team.id,c.directoryVisibility,c.requestable])}
      else{
        if(!(await client.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[workspaceId,c.userId])).rows.length)throw new WorkspaceAccessError('not_found',404)
        if(c.type==='department.manager.set'){
          admin(p)
          const previous=team.managers.find(manager=>manager.userId===c.userId)?.capabilities??[]
          if(c.capabilities.some(capability=>!previous.includes(capability)))await requireDelegationReady(client,p)
          await client.query(`INSERT INTO workspace_team_managers(workspace_id,team_id,user_id,capabilities,granted_by,revoked_at) VALUES($1,$2,$3,$4,$5,CASE WHEN cardinality($4::text[])=0 THEN now() ELSE NULL END)
            ON CONFLICT(workspace_id,team_id,user_id) DO UPDATE SET capabilities=excluded.capabilities,granted_by=excluded.granted_by,revoked_at=excluded.revoked_at`,[workspaceId,team.id,c.userId,[...new Set(c.capabilities)],userId])
          const pending=(await client.query<RequestRow>(`SELECT ${requestColumns} FROM workspace_access_requests WHERE workspace_id=$1 AND target_team_id=$2 AND status='pending' ORDER BY id`,[workspaceId,team.id])).rows
          const refreshed=await teams(client,p);for(const r of pending)await attachApproval(client,p,r,refreshed,true)
        }else{
          assertManageTeamMembers({role:p.role,capabilities:team.capabilities,ownCompartment:team.compartmentKey,readBundle:team.readAll?null:team.bundle,hasActiveBeneficiaryGrant:team.expanded})
          if(c.enabled&&!isAccessAdmin(p.role)&&c.userId===p.userId)throw new WorkspaceAccessError('independent_approver_required')
          if(c.enabled&&!isAccessAdmin(p.role)&&!team.memberIds.includes(c.userId))await requireDelegationReady(client,p)
          if(c.activateAssigned){admin(p);if(!c.enabled)throw new WorkspaceAccessError('invalid_command',400);await requireDelegationReady(client,p)}
          if(c.enabled)await client.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[team.id,c.userId])
          else await client.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[team.id,c.userId])
          if(c.activateAssigned)await createDbWorkspaceGroupStore(client).activateMemberTeamMode(userId,workspaceId,c.userId)
        }
      }
    }else if(command.type==='access.request.create'){
      const current=await overview(client,p),target=current.teams.find(t=>t.id===command.targetTeamId)
      if(!target||(!target.requestable&&!isAccessAdmin(p.role)))throw new WorkspaceAccessError('not_found',404)
      if(!isAccessAdmin(p.role)&&(command.beneficiaryKind!=='member'||command.beneficiaryId!==userId))throw new WorkspaceAccessError('admin_required')
      await requireDelegationReady(client,p)
      const interval=grantInterval({now:p.now,days:command.days,startsAt:command.startsAt?new Date(command.startsAt):undefined,expiresAt:command.ongoing?null:undefined})
      subjectId=randomUUID()
      const tuple={workspaceId,requesterUserId:userId,beneficiaryKind:command.beneficiaryKind,beneficiaryId:command.beneficiaryId,targetTeamId:command.targetTeamId,operation:'read',reason:command.reason,startsAt:interval.startsAt.toISOString(),expiresAt:interval.expiresAt?.toISOString()??null}
      const hash=createHash('sha256').update(JSON.stringify(tuple)).digest('hex')
      const r=(await client.query<RequestRow>(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${requestColumns}`,[subjectId,workspaceId,userId,command.beneficiaryKind,command.beneficiaryId,command.targetTeamId,command.reason,interval.startsAt,interval.expiresAt,hash,p.revision])).rows[0]
      await attachApproval(client,p,r,all)
    }else if(command.type==='access.grant.revoke'){
      const grant=(await client.query<{id:string;targetTeamId:string;beneficiaryKind:string;beneficiaryId:string;revokedAt:Date|null}>(`SELECT id,target_team_id AS "targetTeamId",beneficiary_kind AS "beneficiaryKind",beneficiary_id AS "beneficiaryId",revoked_at AS "revokedAt" FROM workspace_access_grants WHERE workspace_id=$1 AND id=$2 AND can_view_department_request(request_id,$3) FOR UPDATE`,[workspaceId,command.grantId,userId])).rows[0]
      if(!grant)throw new WorkspaceAccessError('not_found',404)
      const target=all.find(t=>t.id===grant.targetTeamId)
      if(!isAccessAdmin(p.role)&&!target?.capabilities.includes('approve_read_requests')&&!(grant.beneficiaryKind==='member'&&grant.beneficiaryId===userId))throw new WorkspaceAccessError('grant_revocation_forbidden')
      if(grant.revokedAt){return overview(client,p)}
      subjectId=grant.id
      await client.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$3,revocation_reason=$4 WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL',[workspaceId,grant.id,userId,command.reason])
    }else{
      const r=(await client.query<RequestRow>(`SELECT ${requestColumns} FROM workspace_access_requests WHERE workspace_id=$1 AND id=$2 AND can_view_department_request(id,$3) FOR UPDATE`,[workspaceId,command.requestId,userId])).rows[0]
      if(!r)throw new WorkspaceAccessError('not_found',404)
      subjectId=r.id;const target=all.find(t=>t.id===r.targetTeamId);if(!target)throw new WorkspaceAccessError('not_found',404)
      if(command.type==='access.request.assign'){admin(p);await attachApproval(client,p,r,all,true)}
      else if(command.type==='access.request.cancel'){
        if(r.requesterUserId!==userId&&!isAccessAdmin(p.role))throw new WorkspaceAccessError('request_cancellation_forbidden')
        if(r.version!==command.expectedVersion||r.status!=='pending')throw new WorkspaceAccessError('request_changed',409)
        await client.query(`UPDATE workspace_access_requests SET status='cancelled',decided_by=$2,decided_at=now() WHERE id=$1`,[r.id,userId])
        if(r.approvalId)await client.query(`UPDATE pending_approvals SET status='superseded',responded_at=now(),responded_by=$2 WHERE id=$1 AND status='pending'`,[r.approvalId,userId])
      }else{
        assertApproveReadRequest({...approvalInput(p,r,target,all),settled:r.status===command.decision})
        if(r.version!==command.expectedVersion||r.payloadHash!==command.payloadHash)throw new WorkspaceAccessError('request_changed',409)
        if(r.status===command.decision){return overview(client,p)}
        if(r.status!=='pending'||p.revision!==command.policyRevision)throw new WorkspaceAccessError('request_review_stale',409)
        if(!r.approvalId)throw new WorkspaceAccessError('independent_approver_required')
        const approval=(await client.query<{status:string;payload:Record<string,unknown>}>(`SELECT status,approval_payload AS payload FROM pending_approvals WHERE id=$1 AND workspace_id=$2 AND kind='department_access' FOR UPDATE`,[r.approvalId,workspaceId])).rows[0]
        if(!approval||approval.status!=='pending'||approval.payload.payloadHash!==r.payloadHash||approval.payload.requestId!==r.id)throw new WorkspaceAccessError('request_changed',409)
        if(command.decision==='approved')await requireDelegationReady(client,p)
        await client.query('UPDATE workspace_access_requests SET status=$2,decided_by=$3,decided_at=now(),decision_reason=$4 WHERE id=$1',[r.id,command.decision,userId,command.reason??null])
        if(command.decision==='approved')await client.query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[workspaceId,r.id,r.beneficiaryKind,r.beneficiaryId,r.targetTeamId,r.startsAt,r.expiresAt,userId])
        await client.query('UPDATE pending_approvals SET status=$2,responded_at=now(),responded_by=$3,reject_reason=$4 WHERE id=$1',[r.approvalId,command.decision,userId,command.decision==='rejected'?command.reason??null:null])
      }
    }
    const result=await overview(client,p)
    const event=await client.query<{id:string}>(`INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,[workspaceId,userId,command.type,subjectId,result.policyRevision,JSON.stringify({command,before,after:await auditState(client,workspaceId,command,subjectId)})])
    return {...result,appliedCommand:{type:command.type,subjectId,auditEventId:event.rows[0].id}}
}

export async function getWorkspaceAccessInTransaction(client:PoolClient,workspaceId:string,userId:string,lock=false):Promise<WorkspaceAccessOverview>{
  return overview(client,await principal(client,workspaceId,userId,lock))
}

/** Read-only inspection: same visibility and lifetime, no history or readiness audit. */
export async function getWorkspaceAccessDirectoryInTransaction(client:PoolClient,workspaceId:string,userId:string):Promise<WorkspaceAccessDirectory>{
  return (await directory(client,await principal(client,workspaceId,userId))).view
}

/** Trusted canonical entry for the common approval protocol; ordinary HTTP writers require saved reviews. */
export async function executeDepartmentAccessCommand(workspaceId:string,userId:string,input:unknown):Promise<WorkspaceAccessOverview>{
  const parsed=departmentAccessCommandSchema.safeParse(input);if(!parsed.success)throw new WorkspaceAccessError('invalid_command',400)
  const client=await getPool().connect()
  try{
    await client.query('BEGIN')
    const result=await executeDepartmentAccessInTransaction(client,workspaceId,userId,parsed.data)
    await client.query('COMMIT');notifyWorkspaceChange(workspaceId,'workspace_config','update');notifyWorkspaceChange(workspaceId,'approval','update');return result
  }catch(error){await client.query('ROLLBACK');if(error instanceof WorkspaceAccessError)throw error;const code=(error as{code?:string}).code;if(code&&['23503','23505','23514','P0001','40001','40P01'].includes(code))throw new WorkspaceAccessError('access_conflict',409);throw error}finally{client.release()}
}
