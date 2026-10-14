/** Shared authenticated HTTP history adapter. [COMP:app-web/engineering-history] */
import {authFetch} from "@/lib/auth-fetch";
import {publicRuntimeConfig} from "@/lib/runtime-public-config";
import {SurfaceCacheEvictionError,invalidateSurfaceCache} from "@/lib/surface-cache";
export type HistoryEvent={id:string;fileId:string;fileVersion:string;revision:number;sequence:string;provider:string;sessionId:string|null;turnId:string|null;sourceEventId:string;profileId:string|null;principalKind:string;principalId:string;actorId:string|null;claimedSubject:string|null;attributionQuality:string;role:"user"|"assistant";occurredAt:string;receivedAt:string;excerpt:string;deliveryStatus:string;annotations:{id:string;text:string;actorId:string;origin:string;createdAt:string}[];content?:string};
export type HistoryQuery={query?:string;provider?:string;sessionId?:string;profileId?:string;keyId?:string;since?:string;until?:string;cursor?:string;limit?:number};
export type HistoryPage={events:HistoryEvent[];nextCursor:string|null;serverHealth:{index:string;localEmitterObserved:false}};
const base=(workspaceId:string)=>`${publicRuntimeConfig().apiUrl??"http://localhost:4000"}/api/workspaces/${encodeURIComponent(workspaceId)}/engineering-history`;
function params(query:HistoryQuery){const p=new URLSearchParams();for(const [k,v] of Object.entries(query))if(v!==undefined&&v!=="")p.set(k,String(v));return p.toString()}
async function checked(response:Response){if(response.ok)return response;const code=(await response.json().catch(()=>({}))).error??"history_unavailable";const error=new Error(code);if([401,403,404].includes(response.status))throw new SurfaceCacheEvictionError(error);throw error}
export async function listEngineeringHistory(workspaceId:string,query:HistoryQuery={}):Promise<HistoryPage>{return (await checked(await authFetch(`${base(workspaceId)}?${params(query)}`,{cache:"no-store"}))).json()}
export async function readEngineeringHistory(workspaceId:string,id:string):Promise<HistoryEvent>{return (await checked(await authFetch(`${base(workspaceId)}/${encodeURIComponent(id)}`,{cache:"no-store"}))).json()}
export async function exportEngineeringHistory(workspaceId:string,query:HistoryQuery){const r=await checked(await authFetch(`${base(workspaceId)}/export?${params(query)}`,{cache:"no-store"}));return {jsonl:await r.text(),status:r.headers.get("X-Brian-Export-Status"),nextCursor:r.headers.get("X-Brian-Next-Cursor"),failureCode:r.headers.get("X-Brian-Export-Error")}}
export async function correctEngineeringHistory(workspaceId:string,event:HistoryEvent,action:"annotate"|"exclude"|"delete",text?:string){
 const r=await checked(await authFetch(`${base(workspaceId)}/${encodeURIComponent(event.id)}${action==="annotate"?"/annotations":action==="exclude"?"/exclude":""}`,{method:action==="delete"?"DELETE":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedRevision:event.revision,expectedFileVersion:event.fileVersion,idempotencyKey:crypto.randomUUID(),...(action==="annotate"?{text}:{})})}));
 invalidateSurfaceCache(`engineering-history:${workspaceId}`);return r.json();
}
