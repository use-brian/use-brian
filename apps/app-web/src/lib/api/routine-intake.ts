/** Native routine configuration/proposal commands. [COMP:app-web/routine-intake] */
import { authFetch } from '@/lib/auth-fetch';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';
import { SurfaceCacheEvictionError } from '@/lib/surface-cache';
import type { WorkflowDefinition, WorkflowTrigger } from './workflow';

export type RoutineConfiguration = {definition:WorkflowDefinition;trigger:WorkflowTrigger;contextGroupId:string|null;contextProjectId:string|null};
export type RoutineProposal = {id:string;workspaceId:string;status:string;arguments:{workflowId:string;expectedRevision:number;
  before:RoutineConfiguration|null;after:RoutineConfiguration;rationale:string;uncertainties:string[];
  creation?:{name:string;authoringAssistantId:string};sourceEvidence:{sources?:{resourceKind:string;resourceId:string}[]}}};
export type RoutineConfigurationState = {workflowId:string;workspaceId:string;revision:number;enabled:boolean;configured:boolean;configuration:RoutineConfiguration};
const base=()=>`${publicRuntimeConfig().apiUrl ?? 'http://localhost:4000'}/api/workflows`;
async function request<T>(path:string,method='GET',body?:unknown):Promise<T> {
  const res=await authFetch(`${base()}${path}`,{method,...(body ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})});
  if (!res.ok) {
    const error=Object.assign(new Error('routine_operation_unavailable'),{status:res.status});
    if ([401,403,404].includes(res.status)) throw new SurfaceCacheEvictionError(error);
    throw error;
  }
  return res.json() as Promise<T>;
}
export const getRoutineIntake=(id:string)=>request<RoutineConfigurationState>(`/${encodeURIComponent(id)}/intake`);
export const getRoutineProposal=(id:string)=>request<RoutineProposal>(`/intake-proposals/${encodeURIComponent(id)}`);
export const listRoutineProposals=(workspaceId:string,workflowId?:string,sessionId?:string)=>request<{proposals:RoutineProposal[]}>(`/intake-proposals?${new URLSearchParams({workspaceId,...(workflowId?{workflowId}:{}),...(sessionId?{sessionId}:{})})}`);
export const proposeRoutineIntake=(workflowId:string,configuration:RoutineConfiguration,expectedRevision:number,rationale:string,idempotencyKey:string)=>
  request<RoutineProposal>('/intake-proposals','POST',{workflowId,configuration,expectedRevision,rationale,idempotencyKey});
export const decideRoutineProposal=(id:string,decision:'apply'|'reject',expectedRevision:number,idempotencyKey:string)=>
  request<{revision?:number;replayed:boolean}>(`/intake-proposals/${encodeURIComponent(id)}/${decision}`,'POST',{expectedRevision,idempotencyKey});
export const toggleRoutineIntake=(id:string,enabled:boolean,expectedRevision:number,idempotencyKey:string)=>
  request<{enabled:boolean;revision:number;replayed:boolean}>(`/${encodeURIComponent(id)}/intake`,'PATCH',{enabled,expectedRevision,idempotencyKey});
