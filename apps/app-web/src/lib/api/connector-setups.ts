import {authFetch} from '@/lib/auth-fetch';
import {publicRuntimeConfig} from '@/lib/runtime-public-config';
import {invalidateSurfaceCache,SurfaceCacheEvictionError} from '@/lib/surface-cache';
import {protectProjection} from '@/lib/use-protected-projection';
export type SetupStatus={id:string;provider:string;workspaceId:string;status:'pending_auth'|'pending_review'|'ready'|'active'|'stale'|'failed'|'cancelled'|'expired';version:string;expiresAt:string;result:{instanceId:string;grantIds:string[];outboxIds:string[]}|null};
export type SetupIntent={workspaceId:string;ownership:'personal'|'workspace';sensitivity:'public'|'internal'|'confidential';expectedPolicyRevision:string;destination?:{kind:'department';departmentId:string;projectId?:string}|{kind:'general';projectId?:string}} & ({operation:'create';instanceId?:never;expectedInstanceVersion?:never}|{operation:'reconnect';instanceId:string;expectedInstanceVersion:string;destination?:never});
export type SetupReview={viewerUserId:string;workspaceId:string;policyRevision?:string|null;validForMs:number;setup:SetupStatus;digest?:string;review:null|{account:{subject:string;tenant:string|null;roots:string[];permissions:string[]};setup:{id:string;workspaceId:string;provider:string;policyRevision:string;intent:{ownership:'personal'|'workspace';operation:string;binding:{departments:string[];projects:string[];sensitivityFloor:string};ingestionOptIn:boolean;boundaryProposal:string}}}};
export async function setupRequest<T>(path:string,body:unknown):Promise<T>{
 const root=publicRuntimeConfig().apiUrl??'http://localhost:4000';
 const response=await authFetch(`${root}/api/connectors/${path}`,{cache:'no-store',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const value=await response.json();if(!response.ok){const error=new Error(value.error??'connector_setup_failed');if([401,403,404].includes(response.status)||value.error==='connector_setup_not_found')throw new SurfaceCacheEvictionError(error);throw error;}return value as T;
}
function bound(value:SetupStatus,workspaceId:string,id?:string){if(value.workspaceId!==workspaceId||value.provider!=='shopify'||id&&value.id!==id)throw new SurfaceCacheEvictionError(new Error('connector_setup_binding_mismatch'));return value;}
export async function getSetup(workspaceId:string,id:string){const start=performance.now();const status=bound(await setupRequest<SetupStatus>(`setups/${encodeURIComponent(id)}/status`,{}),workspaceId,id);return protectProjection({...status,validForMs:30000},start);}
export async function reviewSetup(workspaceId:string,id:string,viewerUserId:string){
 const start=performance.now();
 const value=await setupRequest<SetupReview>(`setups/${encodeURIComponent(id)}/review`,{});
 bound(value.setup,workspaceId,id);
 if(value.viewerUserId!==viewerUserId||value.workspaceId!==workspaceId||!value.review||!value.digest
   ||value.review.setup.id!==id||value.review.setup.workspaceId!==workspaceId||value.review.setup.provider!=='shopify'
   ||typeof value.policyRevision!=='string'||value.review.setup.policyRevision!==value.policyRevision
   ||!Number.isFinite(value.validForMs)||value.validForMs<=0)
  throw new SurfaceCacheEvictionError(new Error('connector_setup_review_unavailable'));
 // The server bounds this to setup AND original authentication-session expiry.
 // Never replace it with setup.expiresAt; subtract the full fetch/JSON latency.
 return protectProjection(value,start);
}
export async function mutateSetup(workspaceId:string,id:string,action:'consent'|'activate'|'cancel',digest?:string){try{return bound(await setupRequest<SetupStatus>(`setups/${encodeURIComponent(id)}/${action}`,action==='cancel'?{}:{digest}),workspaceId,id);}finally{invalidateSurfaceCache(`workspace-access:${workspaceId}:`);invalidateSurfaceCache(`connectors:${workspaceId}`);}}
export async function stageShopify(setup:SetupIntent,input:{shopDomain:string;accessToken:string}|{shopDomain:string;clientId:string;clientSecret:string;scopes:string[]}){
 const value=await setupRequest<SetupStatus & {state?:string;authorizeUrl?:string;nonce?:string}>('shopify/'+('accessToken' in input?'store-credentials':'app-credentials'),'accessToken' in input?{setup,shopifyTokens:input}:{setup,...input});bound(value,setup.workspaceId);return value;
}

/** Wire DTO from packages/api/src/connectors/reconnect-projection.ts. No account or credential fields. */
export type ReconnectProjection={viewerUserId:string;workspaceId:string;policyRevision:string;validForMs:number;instanceId:string;instanceVersion:string;provider:string;ownership:'personal'|'workspace';sensitivity:'public'|'internal'|'confidential';binding:{compartments:string[];projectIds:string[];origin:string};eligibility:{eligible:boolean;reason:null|'provider_unsupported'|'workspace_setup_required'|'account_review_required'|'scope_unavailable'}};
export async function getShopifyReconnect(workspaceId:string,viewerUserId:string,instanceId:string){
 const start=performance.now(),root=publicRuntimeConfig().apiUrl??'http://localhost:4000';
 const response=await authFetch(`${root}/api/connectors/setups/reconnect/${encodeURIComponent(instanceId)}?${new URLSearchParams({workspaceId})}`,{method:'GET',cache:'no-store'});
 if(!response.ok)throw new SurfaceCacheEvictionError(new Error('connector_setup_unavailable'));
 const value:ReconnectProjection=await response.json();
 if(value.viewerUserId!==viewerUserId||value.workspaceId!==workspaceId||value.instanceId!==instanceId||value.provider!=='shopify')throw new SurfaceCacheEvictionError(new Error('connector_setup_binding_mismatch'));
 return protectProjection(value,start);
}
export function reconnectIntent(value:ReconnectProjection):SetupIntent {
 return {workspaceId:value.workspaceId,operation:'reconnect',instanceId:value.instanceId,expectedInstanceVersion:value.instanceVersion,expectedPolicyRevision:value.policyRevision,ownership:value.ownership,sensitivity:value.sensitivity};
}
