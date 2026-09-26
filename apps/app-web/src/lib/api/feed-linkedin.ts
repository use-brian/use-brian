import {authFetch} from '@/lib/auth-fetch';
import {publicRuntimeConfig} from '@/lib/runtime-public-config';
const base=publicRuntimeConfig().apiUrl??'http://localhost:4000';
export async function linkedinRequest<T>(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{const response=await authFetch(`${base}/api/${path}`,{method,headers:body===undefined?undefined:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.code??value.error??'capability_unavailable');return value as T;}
export const linkedinDraftPath=(assistantId:string,sessionId:string)=>`distribution/${assistantId}/draft-sessions/${sessionId}`;
export type LinkedInTarget={id?:string;destinationId:string;authorKind:'person'|'organization';authorUrn:string;displayName:string;status?:string;connectionStatus?:string;canPublishAs:boolean;workspacePublishing?:boolean;canManageGrant?:boolean;capabilities:{post:boolean;link_post:boolean;newsletter_edition:false}};
