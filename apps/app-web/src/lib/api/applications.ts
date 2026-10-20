import type { ApplicationManagementCommand, ApplicationManagementOverview, ApplicationManagementResult } from '@use-brian/shared';
import { authFetch } from '@/lib/auth-fetch';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';
import { protectProjection } from '@/lib/use-protected-projection';
import { invalidateSurfaceCache, SurfaceCacheEvictionError } from '@/lib/surface-cache';

export const applicationManagementCacheKey=(workspaceId:string,viewerId:string,appId?:string)=>`application-management:${workspaceId}:${viewerId}:${appId??''}`;
const url=(workspaceId:string)=>`${publicRuntimeConfig().apiUrl??'http://localhost:4000'}/api/applications/workspaces/${encodeURIComponent(workspaceId)}/management`;
export class ApplicationManagementError extends Error {
 constructor(readonly code:string,readonly uncertain=false){super(code);}
}
export async function fetchApplicationManagement(workspaceId:string,viewerId:string,appId?:string){
 const started=performance.now();
 const response=await authFetch(`${url(workspaceId)}${appId?`?appId=${encodeURIComponent(appId)}`:''}`,{cache:'no-store'});
 if(!response.ok){const error=new ApplicationManagementError('access_unavailable');if([401,403,404].includes(response.status))throw new SurfaceCacheEvictionError(error);throw error;}
 const body=await response.json() as ApplicationManagementOverview;
 if(body.workspaceId!==workspaceId||body.actor.userId!==viewerId)throw new SurfaceCacheEvictionError(new ApplicationManagementError('identity_changed'));
 return protectProjection(body,started);
}
/** Commands are never retried. An uncertain response requires reading current state. */
export async function executeApplicationManagement(workspaceId:string,command:ApplicationManagementCommand):Promise<ApplicationManagementResult>{
 let response:Response;
 try{response=await authFetch(`${url(workspaceId)}/commands`,{cache:'no-store',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)});}
 catch{throw new ApplicationManagementError('effect_uncertain',true);}
 const authorityDenied=[401,403,404].includes(response.status);
 // The status is authoritative even when a proxy's denial body is not JSON.
 if(authorityDenied)invalidateSurfaceCache(`application-management:${workspaceId}:`);
 let body:ApplicationManagementResult;
 try{body=await response.json();}catch{throw new ApplicationManagementError(authorityDenied?'access_unavailable':'effect_uncertain',!authorityDenied);}
 if(!response.ok){
  throw new ApplicationManagementError(String(body.error??'access_unavailable'),body.effect==='uncertain'||body.effect==='committed'||response.status>=500);
 }
 return body;
}
