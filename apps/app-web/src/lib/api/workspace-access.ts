import type {WorkspaceAccessExplanation,WorkspaceAccessExplanationQuery,WorkspaceAccessEvents} from '@use-brian/shared';
import type { WorkspaceAccessHistory, OrganizationChart, OrganizationCommandIntent, OrganizationCommandApply, OrganizationCommandReview, DepartmentAccessCommand, DepartmentCommandReview, DepartmentCommandApply, WorkspaceAccessOverview, ScopeReviewInventory, ScopeReviewCommand, ScopeReview, ScopeReviewKind } from '@use-brian/shared';
import { protectProjection, type ProtectedProjection } from '@/lib/use-protected-projection';
import { authFetch } from '@/lib/auth-fetch';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';
import { SurfaceCacheEvictionError } from '@/lib/surface-cache';

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

export async function fetchScopeReview(workspaceId:string,kind:ScopeReviewKind,after?:string,reviewId?:string,reviewAfter?:string):Promise<ProtectedProjection<ScopeReviewInventory>> {
  const params=new URLSearchParams({kind});if(after)params.set('after',after);if(reviewId)params.set('reviewId',reviewId);if(reviewAfter)params.set('reviewAfter',reviewAfter);
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
