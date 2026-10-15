/** Current-authority delivery projections. No persistent offline copy.
 * [COMP:app-web/client-delivery-oversight]
 */
import type { WorkScope } from './work';
import type { WorkspaceSearchTarget } from '@use-brian/shared';
import { crmOperationsRequest } from './crm-references';
import { SurfaceCacheEvictionError } from '@/lib/surface-cache';
import { protectProjection, type ProtectedProjection } from '@/lib/use-protected-projection';

type DeliverySource = {kind:'episode'|'session_message'|'entity'|'file_segment';id:string;revision:string;quote:string;start:number;end:number};
type DeliveryCommitment = {id:string;outcome:string;dueDate:string|null;version:number;recognitionState:'recognised'|'needs_review'|'dismissed'|'superseded';
  recognitionReason:string;source:DeliverySource;sourceNavigation?:WorkspaceSearchTarget|null;agreeingName?:string|null;originChatId:string|null;taskIds:string[];goalIds:string[]};
type DeliveryObservation = {id:string;source:DeliverySource;sourceNavigation?:WorkspaceSearchTarget|null;kind:'observed_fact'|'human_report'|'coverage_gap'|'conflict';
  claim:string;statement:string;reporterUserId:string|null;reporterName?:string|null;occurredAt:string;readAt:string;workId:string|null};
type DeliveryLinkedWork={id:string;kind:'task'|'goal';title:string;status:string;taskId:string;executorLabel:string|null;followUpLabel:string|null};
export type DeliveryDetail={commitment:DeliveryCommitment;observations:DeliveryObservation[];linkedWork?:DeliveryLinkedWork[];evidenceCursor:string|null;assessment:{
  recognition:DeliveryCommitment['recognitionState'];coverage:'observed'|'reported'|'partial'|'conflicting'|'unobserved';outcome:'verified_delivery'|'reported_completion'|'unknown';
  issue:{kind:'delay'|'blocker';statement:string;occurredAt:string;reported:boolean;observationId:string}|null;
  nextAction:{kind:'inspect_work';workId:string;observationId:string}|null;lastKnownAt:string|null;evaluatedAt:string;partial:boolean;reasonCodes:string[]}};
export type DeliveryPage={commitments:DeliveryCommitment[];nextCursor:string|null};
export type DeliveryUiCommand={operationId:string;commitmentId:string;expectedVersion:number}&(
 {kind:'refresh_delivery_assessment'}|{kind:'review_delivery_recognition';decision:'recognise'|'correct'|'dismiss';reason:string;outcome?:string});
const base=(workspaceId:string)=>`/api/crm/${encodeURIComponent(workspaceId)}/operations`;
async function protectedRead<T>(path:string):Promise<ProtectedProjection<T>> {
  const started=performance.now();
  try { return protectProjection(await crmOperationsRequest<T&{validForMs:number}>(path,{cache:'no-store'}),started); }
  catch(cause){throw new SurfaceCacheEvictionError(cause);}
}
export function fetchDeliveryCommitments(workspaceId:string,scope:WorkScope,cursor?:string,chatId?:string):Promise<ProtectedProjection<DeliveryPage>> {
  const q=new URLSearchParams({scope:scope.kind,limit:'50'});
  if(scope.kind!=='personal')q.set('scopeId',scope.id);
  if(cursor)q.set('cursor',cursor);if(chatId)q.set('chatId',chatId);
  return protectedRead(`${base(workspaceId)}/delivery-commitments?${q}`);
}
export function fetchDeliveryDetail(workspaceId:string,id:string,chatId?:string):Promise<ProtectedProjection<DeliveryDetail>> {
  return protectedRead(`${base(workspaceId)}/delivery-commitments/${encodeURIComponent(id)}${chatId?`?${new URLSearchParams({chatId})}`:''}`);
}
export function executeDeliveryCommand(workspaceId:string,command:DeliveryUiCommand):Promise<{record:{id:string;version:number};duplicate:boolean}> {
  return crmOperationsRequest(`${base(workspaceId)}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)});
}
