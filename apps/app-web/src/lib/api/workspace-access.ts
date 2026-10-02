import type { WorkspaceDepartmentRegistry,WorkspaceAccessExplanation,WorkspaceAccessExplanationQuery,WorkspaceAccessEvents} from '@use-brian/shared';
import type { WorkspaceAccessHistory, OrganizationChart, OrganizationCommandIntent, OrganizationCommandApply, OrganizationCommandReview, DepartmentAccessCommand, DepartmentCommandReview, DepartmentCommandApply, WorkspaceAccessOverview, ScopeReviewInventory, ScopeReviewCommand, ScopeReview, ScopeReviewKind } from '@use-brian/shared';
import { protectProjection, type ProtectedProjection } from '@/lib/use-protected-projection';
import { authFetch } from '@/lib/auth-fetch';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';
import { invalidateSurfaceCache, SurfaceCacheEvictionError } from '@/lib/surface-cache';

export const ORGANIZATION_CHANGED_EVENT = 'brian:organization-changed';
async function request(workspaceId: string, command?: OrganizationCommandApply): Promise<ProtectedProjection<OrganizationChart>> {
  const started=performance.now();
  const root = publicRuntimeConfig().apiUrl ?? 'http://localhost:4000';
  const path = command ? 'access/commands' : 'org-chart';
  const response = await authFetch(`${root}/api/workspaces/${encodeURIComponent(workspaceId)}/${path}`, {
    cache: 'no-store', ...(command ? { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(command) } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as {error?:string};
    const error = new Error(body.error ?? 'organization_unavailable');
    if (!command && [401,403,404].includes(response.status)) throw new SurfaceCacheEvictionError(error);
    throw error;
  }
  return protectProjection(await response.json() as OrganizationChart,started);
}
export const fetchOrganizationChart = (workspaceId: string) => request(workspaceId);
export async function prepareOrganizationCommand(workspaceId:string,intent:OrganizationCommandIntent):Promise<OrganizationCommandReview> {
  const root=publicRuntimeConfig().apiUrl??'http://localhost:4000';
  const response=await authFetch(`${root}/api/workspaces/${encodeURIComponent(workspaceId)}/org-chart/command-review`,{cache:'no-store',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(intent)});
  const body=await response.json();if(!response.ok)throw new Error(body.error??'organization_unavailable');return body;
}
export async function saveOrganizationCommand(workspaceId: string, command: OrganizationCommandApply): Promise<ProtectedProjection<OrganizationChart>> {
  const result = await request(workspaceId,command);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ORGANIZATION_CHANGED_EVENT,{detail:{workspaceId}}));
  return result;
}

export async function fetchWorkspaceAccess(workspaceId: string): Promise<ProtectedProjection<WorkspaceAccessOverview>> {
  return accessRequest(workspaceId);
}
export async function prepareWorkspaceAccessCommand(workspaceId:string,command:DepartmentAccessCommand,expectedPolicyRevision:string,idempotencyKey:string):Promise<DepartmentCommandReview> {
  const root=publicRuntimeConfig().apiUrl??'http://localhost:4000';
  const response=await authFetch(`${root}/api/workspaces/${encodeURIComponent(workspaceId)}/access/command-review`,{cache:'no-store',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,expectedPolicyRevision,idempotencyKey})});
  const body=await response.json();if(!response.ok)throw new Error(body.error??'access_unavailable');return body;
}
export async function saveWorkspaceAccessCommand(workspaceId: string, command: DepartmentCommandApply): Promise<ProtectedProjection<WorkspaceAccessOverview>> {
  const result = await accessRequest(workspaceId,command);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ORGANIZATION_CHANGED_EVENT,{detail:{workspaceId}}));
  return result;
}
async function accessRequest(workspaceId: string, command?: DepartmentCommandApply): Promise<ProtectedProjection<WorkspaceAccessOverview>> {
  const started=performance.now();
  const root = publicRuntimeConfig().apiUrl ?? 'http://localhost:4000';
  const response = await authFetch(`${root}/api/workspaces/${encodeURIComponent(workspaceId)}/access${command?'/commands':''}`, {
    cache:'no-store', ...(command?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)}:{}),
  });
  if(!response.ok) {
    const body = await response.json().catch(()=>({})) as {error?:string};
    const error = new Error(body.error??'access_unavailable');
    if(!command&&[401,403,404].includes(response.status)) throw new SurfaceCacheEvictionError(error);
    throw error;
  }
  return protectProjection(await response.json() as WorkspaceAccessOverview,started);
}

export async function fetchScopeReview(workspaceId:string,kind:ScopeReviewKind,after?:string,reviewId?:string,reviewAfter?:string,includeClassified=false):Promise<ProtectedProjection<ScopeReviewInventory>> {
  const params=new URLSearchParams({kind});if(after)params.set('after',after);if(reviewId)params.set('reviewId',reviewId);if(reviewAfter)params.set('reviewAfter',reviewAfter);if(includeClassified)params.set('includeClassified','true');
  return scopeReviewRequest<ScopeReviewInventory>(workspaceId,`scope-review?${params}`);
}
export async function saveScopeReview(workspaceId:string,command:ScopeReviewCommand):Promise<ProtectedProjection<ScopeReview>> {
  const result=await scopeReviewRequest<ScopeReview>(workspaceId,'access/commands',command);
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(ORGANIZATION_CHANGED_EVENT,{detail:{workspaceId}}));
  return result;
}
async function scopeReviewRequest<T extends {validForMs:number}>(workspaceId:string,path:string,command?:ScopeReviewCommand):Promise<ProtectedProjection<T>> {
  const started=performance.now(),root=publicRuntimeConfig().apiUrl??'http://localhost:4000';
  const response=await authFetch(`${root}/api/workspaces/${encodeURIComponent(workspaceId)}/${path}`,{cache:'no-store',...(command?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)}:{})});
  if(!response.ok){const body=await response.json().catch(()=>({})) as {error?:string};const error=new Error(body.error??'scope_review_unavailable');if(!command&&([401,403,404].includes(response.status)||body.error==='access_history_changed'))throw new SurfaceCacheEvictionError(error);throw error;}
  return protectProjection(await response.json() as T,started);
}

export async function fetchWorkspaceAccessHistory(workspaceId:string,kind:'requests'|'grants',after:string,expectedPolicyRevision:string):Promise<ProtectedProjection<WorkspaceAccessHistory>> {
  const params=new URLSearchParams({after,expectedPolicyRevision});
  return scopeReviewRequest<WorkspaceAccessHistory>(workspaceId,`access/${kind}?${params}`);
}


export function fetchWorkspaceAccessExplanation(workspaceId:string,selection:WorkspaceAccessExplanationQuery):Promise<ProtectedProjection<WorkspaceAccessExplanation>> {
  const params=new URLSearchParams(Object.entries(selection).filter(([,value])=>value!==undefined) as Array<[string,string]>);
  return scopeReviewRequest<WorkspaceAccessExplanation>(workspaceId,`access/explain?${params}`);
}
export function fetchWorkspaceAccessEvents(workspaceId:string,after?:string,expectedPolicyRevision?:string):Promise<ProtectedProjection<WorkspaceAccessEvents>> {
  const params=new URLSearchParams();if(after)params.set('after',after);if(expectedPolicyRevision)params.set('expectedPolicyRevision',expectedPolicyRevision);
  return scopeReviewRequest<WorkspaceAccessEvents>(workspaceId,`access/events?${params}`);
}

export function fetchWorkspaceDepartmentRegistry(workspaceId:string):Promise<ProtectedProjection<WorkspaceDepartmentRegistry>> {
  return scopeReviewRequest<WorkspaceDepartmentRegistry>(workspaceId,'access/registry');
}

export function fetchWorkspaceAccessMode(workspaceId:string):Promise<ProtectedProjection<import('@use-brian/shared').WorkspaceAccessModeState>> {
  return scopeReviewRequest<import('@use-brian/shared').WorkspaceAccessModeState>(workspaceId,'access/mode');
}

/** Wire DTOs for the bounded migration REST facade. */
export type MigrationPlan = {
  id:string; actor_user_id:string; source_mode:'simple'|'departments'; target_mode:'simple'|'departments';
  status:string; proposal_hash:string; policy_revision:string; expires_at:string;
  summary_counts:{applied?:number;total?:number;blockers?:string[]};
};
/** Only the display fields emitted by migration-service.projection. Never mutation input. */
export type MigrationProjection = {
  kind:'member'|'assistant';
  person?:WorkspaceAccessOverview['people'][number];
  readCompartments?:string[]|null; mutationCompartments?:string[]|null;
  config?:{teamMode:'legacy'|'all'|'assigned';teamIds:string[];defaultGroupId:string|null}|null;
  resourceAuthorizationRequired:true; humanIntersectionRequired?:true;
};
export type PrincipalMigrationAction=Extract<DepartmentAccessCommand,{type:'member.access.set'|'department.member.set'|'department.assistant.set'|'assistant.audience.set'}>;
export type ResourceMigrationAction={type:'resource.scope';resourceKind:ScopeReviewKind;resourceId:string;action:'confirm_general'|'assign_team'|'hold'|'consolidate_default';targetTeamId?:string};
type MigrationItemBase={id:string;subject_id:string;subject_kind:string;reason:string;status:string;command_review_id:string|null;diagnostic_code:string|null};
export type PrincipalMigrationItem=MigrationItemBase & {proposed_action:PrincipalMigrationAction;before_state?:MigrationProjection;after_state?:MigrationProjection};
export type ResourceMigrationItem=MigrationItemBase & {
  proposed_action:ResourceMigrationAction;scope_review_id:string|null;
  before_state:{source:ScopeReview['items'][number]['source'];content:ScopeReview['items'][number]['content']};
  after_state:{action:ResourceMigrationAction['action'];targetTeamId:string|null;targetCompartment?:string|null;impact?:ScopeReview['items'][number]['impact'];allowedActions:ResourceMigrationAction['action'][];blocker?:string};
};
export type MigrationItem=PrincipalMigrationItem|ResourceMigrationItem;
export function isResourceMigrationItem(item:MigrationItem):item is ResourceMigrationItem{return item.proposed_action.type==='resource.scope';}
export type ResourceMigrationConfirmation={kind:'resource';reviewId:string;expectedVersion:string;payloadHash:string;expiresAt:string};
export type MigrationConfirmation=DepartmentCommandApply|ResourceMigrationConfirmation;
export type MigrationItemReviewResult=
  | {kind?:never;review:DepartmentCommandReview;item:PrincipalMigrationItem}
  | {kind:'resource';review:ScopeReview;item:ResourceMigrationItem;confirmation:ResourceMigrationConfirmation};
export type MigrationItemApplyResult=PrincipalMigrationItem|(ResourceMigrationItem & {kind:'resource';review:ScopeReview});
export type MigrationDetail = MigrationPlan & {items:MigrationItem[];blockers:string[]};
async function migrationRequest<T>(workspaceId:string,path:string,body?:unknown):Promise<T> {
  const root=publicRuntimeConfig().apiUrl??'http://localhost:4000';
  const response=await authFetch(`${root}/api/workspaces/${encodeURIComponent(workspaceId)}/access/migrations${path}`,{cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const result=await response.json();
  if(!response.ok){const error=new Error(result.error??'access_unavailable');if(body===undefined&&[401,403,404].includes(response.status))throw new SurfaceCacheEvictionError(error);throw error;}
  return result as T;
}
// The legacy migration endpoints have no server TTL. Bound their local display
// lifetime conservatively; this is never an approval or authority lease.
export async function fetchMigrationPlans(workspaceId:string,after='') {
  const started=performance.now();
  const result=await migrationRequest<{plans:MigrationPlan[]}>(workspaceId,after?`?after=${encodeURIComponent(after)}`:'');
  return protectProjection({...result,validForMs:30_000},started);
}
export async function fetchMigrationPlan(workspaceId:string,planId:string) {
  const started=performance.now();
  const result=await migrationRequest<MigrationDetail>(workspaceId,`/${encodeURIComponent(planId)}`);
  return protectProjection({...result,validForMs:30_000},started);
}
export async function prepareMigrationItem(workspaceId:string,planId:string,itemId:string) {
  const result=await migrationRequest<MigrationItemReviewResult>(workspaceId,`/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}/review`,{});
  if(result.kind==='resource')invalidateSurfaceCache(`scope-review:${workspaceId}:`);
  return result;
}
function migrationChanged(workspaceId:string) {
  // Purge all viewers, including unmounted screens, before notifying listeners.
  invalidateSurfaceCache(`workspace-access:${workspaceId}:`);
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(ORGANIZATION_CHANGED_EVENT,{detail:{workspaceId}}));
}
export async function applyMigrationItem(workspaceId:string,planId:string,itemId:string,confirmation:MigrationConfirmation) {
  try{return await migrationRequest<MigrationItemApplyResult>(workspaceId,`/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}/apply`,confirmation);}
  finally{if('kind' in confirmation)invalidateSurfaceCache(`scope-review:${workspaceId}:`);migrationChanged(workspaceId);}
}
export async function setMigrationPlanState(workspaceId:string,planId:string,state:'paused'|'cancelled'|'proposed') {
  try{return await migrationRequest<MigrationPlan>(workspaceId,`/${encodeURIComponent(planId)}/state`,{state});}
  finally{invalidateSurfaceCache(`scope-review:${workspaceId}:`);migrationChanged(workspaceId);}
}

/** Authorized choices and mode revision share a bounded protected lifetime. */
export async function fetchWorkspaceCreationContext(workspaceId:string){
  const started=performance.now(),root=publicRuntimeConfig().apiUrl??'http://localhost:4000';
  async function choices<T>(path:string):Promise<T>{
    const response=await authFetch(`${root}/api/workspaces/${encodeURIComponent(workspaceId)}/${path}`,{cache:'no-store'});
    const body=await response.json();
    if(!response.ok){const error=new Error(body.error??'context_unavailable');if([401,403,404].includes(response.status))throw new SurfaceCacheEvictionError(error);throw error;}
    return body as T;
  }
  const {listAssistants}=await import('./studio');
  const [mode,teams,projects,assistants,authority]=await Promise.all([fetchWorkspaceAccessMode(workspaceId),choices<{groups:import('./context-scopes').ContextTeam[]}>('groups'),choices<{projects:import('./context-scopes').ContextProject[]}>('projects?includeArchived=false'),listAssistants(workspaceId),fetchWorkspaceAccessExplanation(workspaceId,{})]);
  if(mode.policyRevision!==authority.policyRevision)throw new SurfaceCacheEvictionError(new Error('access_policy_conflict'));
  // A directory listing or read-only grant is not a creation destination.
  return protectProjection({teams:teams.groups.filter(team=>authority.mutationTeamIds===null||authority.mutationTeamIds.includes(team.id)),projects:projects.projects.filter(project=>authority.projectIds===null||authority.projectIds.includes(project.id)),assistants:assistants.filter(assistant=>assistant.workspaceId===workspaceId),policyRevision:mode.policyRevision,validForMs:Math.min(mode.validForMs,authority.validForMs)},started);
}
