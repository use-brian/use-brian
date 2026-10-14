/** Durable archive terminal. No Episode or model port. [COMP:api/engineering-history] */
import type { FilesApi,FilesContext } from '@use-brian/core'
import type { ArchiveCapture,ArchiveSnapshot } from './contracts.js'
import { EngineeringHistoryError } from './contracts.js'
import { archiveDigest,archiveReceipt,enqueueArchive,claimArchiveBatch,finishArchiveBatch,releaseArchiveBatch } from '../db/engineering-history-store.js'
import { withArchivePublication,previewArchiveScope } from '../workspace-access/file-programmatic-admission.js'
export function createEngineeringArchivePublisher(files:FilesApi){
 const authFor=(s:ArchiveSnapshot)=>({workspaceId:s.workspaceId,keyId:s.principalId,authKind:s.principalKind,actingUserId:s.actingUserId})
 async function publish(s:ArchiveSnapshot){
  await previewArchiveScope(s)
  const prior=await archiveReceipt(authFor(s),s.eventId,s.payloadDigest)
  if(prior?.deliveryStatus==='archived'||prior?.deliveryStatus==='deleted'||prior?.deliveryStatus==='excluded')return prior
  const ctx:FilesContext={workspaceId:s.workspaceId,userId:s.actingUserId,assistantId:s.assistantId,assistantKind:'standard',clearance:s.sensitivity,
   writeSensitivity:s.sensitivity,writeCompartments:s.compartments,writeProjectIds:s.projectIds}
  const stored=await withArchivePublication(s,()=>files.writeBytes(ctx,{path:`/engineering-history/${s.archiveId}.json`,
   bytes:Buffer.from(JSON.stringify({version:1,content:s.content,provenance:{provider:s.provider,role:s.role,sessionId:s.sessionId,turnId:s.turnId,
    claimedSubject:s.subjectId,attributionQuality:s.attributionQuality,occurredAt:s.occurredAt,receivedAt:s.receivedAt}}),'utf8'),
   mime:'application/json',sensitivity:s.sensitivity}))
  if(!stored.ok){
   const reconciled=await archiveReceipt(authFor(s),s.eventId,s.payloadDigest)
   if(reconciled?.deliveryStatus==='archived')return reconciled
   throw new EngineeringHistoryError(stored.error.kind==='quota_exceeded'?'archive_quota_exceeded':'archive_storage_unavailable',503)
  }
  const receipt=await archiveReceipt(authFor(s),s.eventId,s.payloadDigest)
  if(receipt?.deliveryStatus!=='archived')throw new EngineeringHistoryError('archive_publication_uncertain',503)
  return {...receipt,outcome:'archived' as const,profileId:s.profileId,profileRevision:s.profileRevision,ruleId:s.ruleId}
 }
 async function drain(batchId?:string){
  const claim=await claimArchiveBatch(batchId)
  if(!claim)return null
  try{const receipt=await publish(claim.snapshot);await finishArchiveBatch(claim.id,claim.token);return receipt}
  catch(error){await releaseArchiveBatch(claim.id,claim.token,typeof error==='object'&&error!==null&&typeof(error as {status?:unknown}).status==='number'&&(error as {status:number}).status<500);throw error}
 }
 const capture:ArchiveCapture=async(auth,input,target,rule,scope)=>{
  const prior=await archiveReceipt(auth,input.eventId,archiveDigest(input))
  if(prior&&prior.deliveryStatus!=='pending')return prior
  const enqueued=await enqueueArchive(auth,input,target,rule,scope)
  if(!enqueued){const current=await archiveReceipt(auth,input.eventId,archiveDigest(input));if(current)return current}
  const receipt=scope.realtime&&enqueued?await drain(enqueued.batchId):null
  return receipt??{contractVersion:1,processingPurpose:'archive_only',outcome:enqueued?'queued':'duplicate',receiptStatus:'queued',
   archiveId:enqueued?.snapshot.archiveId??prior?.archiveId,deliveryStatus:'pending',indexStatus:'pending',profileId:target.profileId,profileRevision:target.revision,ruleId:rule.id,firesAt:scope.firesAt}
 }
 return {capture,drain,publish}
}
