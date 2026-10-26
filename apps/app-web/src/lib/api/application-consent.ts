/** Native-session application consent; the server alone decides authority. [COMP:app-web/application-consent] */
import {z} from 'zod';
import {getAccessToken} from '@/lib/auth-fetch';
import {publicRuntimeConfig} from '@/lib/runtime-public-config';
const uuid=z.string().uuid();
const reviewSchema=z.object({clientName:z.string().nullable(),clientUri:z.string().nullable(),scope:z.enum(['read','read_write']),workspaces:z.array(z.object({id:uuid,name:z.string()})).length(1),application:z.object({id:uuid,qualified:z.literal(true),review:z.string().min(1).max(65536),resources:z.array(z.object({typeKey:z.string(),selector:z.union([z.object({kind:z.literal('self')}),z.object({kind:z.literal('ids'),ids:z.array(z.string().min(1)).max(4096)})]),actions:z.array(z.string()),readFields:z.array(z.string()),writeFields:z.array(z.string())})).max(128)})});
export type ApplicationConsentReview=z.infer<typeof reviewSchema>;
function base(appId:string){return `${publicRuntimeConfig().apiUrl}/api/applications/${uuid.parse(appId)}/consent`;}
function requestValue(req:string){if(!req||req.length>16384)throw Error('access_unavailable');return req;}
export function applicationConsentSignInUrl(appId:string,req:string,current=window.location.href):string {
 const here=new URL(current),raw=publicRuntimeConfig().primaryAuthUrl;
 if(!raw)throw Error('access_unavailable');const portal=new URL(raw);
 if(portal.username||portal.password||portal.pathname!=='/'||portal.search||portal.hash||portal.protocol!=='https:'&&!(portal.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(portal.hostname)))throw Error('access_unavailable');
 const next=new URL('/oauth/authorize',here.origin);next.searchParams.set('application',uuid.parse(appId));next.searchParams.set('req',requestValue(req));
 const login=new URL('/login',portal);login.searchParams.set('next',next.toString());return login.toString();
}
async function nativeConsentFetch(url:string,init:RequestInit):Promise<Response>{
 const token=getAccessToken();if(!token)throw Error('application_signin_required');
 const response=await fetch(url,{...init,headers:{...init.headers,Authorization:'Bearer '+token},redirect:'error'});
 if(response.status===401)throw Error('application_signin_required');return response;
}
export async function fetchApplicationConsent(appId:string,req:string,signal?:AbortSignal):Promise<ApplicationConsentReview>{
 const query=new URLSearchParams({req:requestValue(req)}),response=await nativeConsentFetch(`${base(appId)}?${query}`,{cache:'no-store',signal});
 if(!response.ok)throw Error('access_unavailable');
 const data=reviewSchema.parse(await response.json());if(data.application.id!==appId)throw Error('access_unavailable');return data;
}
export async function decideApplicationConsent(appId:string,req:string,review:ApplicationConsentReview,decision:'allow'|'deny'){
 const current=reviewSchema.parse(review);if(current.application.id!==appId)throw Error('access_unavailable');
 const response=await nativeConsentFetch(base(appId),{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({req:requestValue(req),workspaceId:current.workspaces[0].id,decision,review:current.application.review,grantedScope:current.scope})});
 if(!response.ok)throw Error('access_unavailable');
 const result=z.object({redirectUrl:z.string().url()}).parse(await response.json()),url=new URL(result.redirectUrl);
 if(url.username||url.password||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('access_unavailable');
 return result.redirectUrl;
}
