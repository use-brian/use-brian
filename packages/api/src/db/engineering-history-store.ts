import {preflightArchiveScope} from '../workspace-access/file-programmatic-admission.js'
/** Identity and lexical projection; File bytes remain authoritative. [COMP:api/engineering-history] */
import { createHash,randomUUID } from 'node:crypto'
import { applyRLSGucs,getAppPool,query,rollbackAndRelease } from './client.js'
import type { BrainAuth } from '../brain-mcp/auth.js'
import type { ArchiveSnapshot,ArchiveReceipt,ArchiveCapture } from '../engineering-history/contracts.js'
import { ARCHIVE_TEXT_LIMIT,EngineeringHistoryError } from '../engineering-history/contracts.js'
export function archiveDigest(input: {content:string;occurredAt?:Date;sessionId?:string;subjectId?:string;role?:string;sourceLabel?:string;metadata?:Record<string,unknown>}) {
 return createHash('sha256').update(JSON.stringify({content:input.content,occurredAt:input.occurredAt?.toISOString()??null,
  sessionId:input.sessionId??null,subjectId:input.subjectId??null,role:input.role??null,sourceLabel:input.sourceLabel??null,
  metadata:Object.fromEntries(Object.entries(input.metadata??{}).sort(([a],[b])=>a.localeCompare(b)))})).digest('hex')
}
export async function archiveReceipt(auth: Pick<BrainAuth,'workspaceId'|'authKind'|'keyId'|'actingUserId'>,eventId:string,digest?:string):Promise<ArchiveReceipt|null> {
 if(!auth.actingUserId)throw new EngineeringHistoryError('capture_target_unavailable')
 const client=await getAppPool().connect()
 try {
  await client.query('BEGIN');await applyRLSGucs(client,auth.actingUserId)
  const r=(await client.query(`SELECT r.*,e.delivery_status,e.file_id,b.fires_at FROM programmatic_capture_receipts r
   LEFT JOIN programmatic_archive_events e ON e.id=r.archive_id LEFT JOIN pending_ingest_batches b ON b.id=r.batch_id WHERE r.workspace_id=$1 AND r.principal_kind=$2 AND r.principal_id=$3 AND r.event_id=$4`,
   [auth.workspaceId,auth.authKind,auth.keyId,eventId])).rows[0]
  if(!r)return null
  if(r.processing_purpose!=='archive_only'||digest&&r.payload_digest!==digest)throw new EngineeringHistoryError('capture_event_conflict')
  const status=r.archive_delivery_status??r.delivery_status??(r.status==='completed'?'deleted':r.status==='dropped'?'dropped':'pending')
  return {contractVersion:1,processingPurpose:'archive_only',outcome:'duplicate',receiptStatus:r.status,archiveId:r.archive_id??undefined,
   fileId:r.file_id??undefined,...(r.fires_at?{firesAt:r.fires_at}:{}),deliveryStatus:status,indexStatus:status==='archived'?'ready':status==='pending'?'pending':'withheld'}
 }finally {await rollbackAndRelease(client)}
}
export async function enqueueArchive(auth:BrainAuth,input:Parameters<ArchiveCapture>[1],target:Parameters<ArchiveCapture>[2],rule:Parameters<ArchiveCapture>[3],scope:Parameters<ArchiveCapture>[4]) {
 if(auth.scope!=='read_write'||!auth.actingUserId||auth.authKind!=='api_key')throw new EngineeringHistoryError('capture_target_unavailable',403)
 if(!input.content.trim() || Buffer.byteLength(input.content)>ARCHIVE_TEXT_LIMIT || !['user','assistant'].includes(input.role??''))throw new EngineeringHistoryError('capture_event_unsupported',400)
 const digest=archiveDigest(input),client=await getAppPool().connect()
 try{
  await client.query('BEGIN');await applyRLSGucs(client,auth.actingUserId)
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[auth.workspaceId])
  const prior=(await client.query('SELECT payload_digest,processing_purpose FROM programmatic_capture_receipts WHERE principal_kind=$1 AND principal_id=$2 AND event_id=$3 FOR UPDATE',[auth.authKind,auth.keyId,input.eventId])).rows[0]
  if(prior){if(prior.processing_purpose!=='archive_only'||prior.payload_digest!==digest)throw new EngineeringHistoryError('capture_event_conflict');await client.query('COMMIT');return null}
  const key=(await client.query('SELECT capture_intake_revision::text AS revision FROM brain_keys WHERE id=$1 AND workspace_id=$2',[auth.keyId,auth.workspaceId])).rows[0]
  const rawRule=(await client.query('SELECT to_jsonb(r) AS snapshot FROM ingest_rules r WHERE id=$1',[rule.id])).rows[0]
  if(!key||!rawRule)throw new EngineeringHistoryError('capture_target_unavailable')
  const sequence=(await client.query("SELECT nextval(pg_get_serial_sequence('programmatic_archive_events','sequence'))::text AS sequence")).rows[0].sequence as string
  const now=new Date().toISOString()
  const snapshot:ArchiveSnapshot={processingPurpose:'archive_only',archiveId:randomUUID(),serverSequence:sequence,workspaceId:auth.workspaceId,assistantId:target.assistantId,
   profileId:target.profileId,profileRevision:target.revision??'1',ruleId:rule.id,ruleSnapshot:rawRule.snapshot,keyRevision:key.revision,
   principalKind:auth.authKind,principalId:auth.keyId,actingUserId:auth.actingUserId,...scope,eventId:input.eventId,content:input.content,payloadDigest:digest,contentDigest:createHash('sha256').update(input.content).digest('hex'),
   occurredAt:input.occurredAt?.toISOString()??now,receivedAt:now,role:input.role as 'user'|'assistant',provider:input.metadata?.provider?.toString()??'unknown',
   sessionId:input.sessionId,subjectId:input.subjectId,turnId:input.metadata?.turnId?.toString(),attributionQuality:'reported_unverified'}
  if(!(await client.query('SELECT engineering_capture_current($1,$2,$3,$4::jsonb) AS allowed',[auth.workspaceId,target.assistantId,rule.id,JSON.stringify(snapshot)])).rows[0]?.allowed)throw new EngineeringHistoryError('capture_target_unavailable')
  await preflightArchiveScope(client,snapshot)
  await client.query(`INSERT INTO programmatic_capture_receipts(workspace_id,principal_kind,principal_id,event_id,rule_id,status,processing_purpose,payload_digest,archive_id,archive_actor_id,archive_sequence)
   VALUES($1,$2,$3,$4,$5,'queued','archive_only',$6,$7,$8,$9)`,[auth.workspaceId,auth.authKind,auth.keyId,input.eventId,rule.id,digest,snapshot.archiveId,auth.actingUserId,sequence])
  const batch=(await client.query(`INSERT INTO pending_ingest_batches(workspace_id,assistant_id,rule_id,partition_key,source,fires_at,events,episode_sensitivity,compartments,project_ids,scope_binding_origin,scope_held,processing_purpose)
   VALUES($1,$2,$3,$4,'programmatic',$5,$6::jsonb,$7,$8,$9,'explicit',true,'archive_only') RETURNING id`,
   [auth.workspaceId,target.assistantId,rule.id,`archive:${snapshot.archiveId}`,scope.firesAt,JSON.stringify([snapshot]),scope.sensitivity,scope.compartments,scope.projectIds])).rows[0]
  await client.query('UPDATE programmatic_capture_receipts SET batch_id=$2 WHERE archive_id=$1',[snapshot.archiveId,batch.id])
  await client.query('COMMIT');return {snapshot,batchId:batch.id as string}
 }catch(error){throw error}finally{await rollbackAndRelease(client)}
}
/** Claim bytes only through a supported-purpose lease, with the legacy scope hold retained. */
export async function claimArchiveBatch(batchId?:string):Promise<{id:string;token:string;snapshot:ArchiveSnapshot}|null>{
 const token=randomUUID()
 const rows=(await query(`UPDATE pending_ingest_batches SET archive_claim_until=now()+interval '2 minutes',archive_claim_token=$2
  WHERE id=(SELECT id FROM pending_ingest_batches b WHERE source='programmatic' AND processing_purpose='archive_only'
    AND processed_at IS NULL AND NOT purpose_held AND engineering_capture_current(workspace_id,assistant_id,rule_id,events->0) AND (archive_claim_until IS NULL OR archive_claim_until<now())
    AND ($1::uuid IS NULL AND fires_at<=now() OR id=$1) ORDER BY fires_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING id,events`,[batchId??null,token])).rows[0]
 return rows?{id:rows.id,token,snapshot:rows.events[0]}:null
}
export async function finishArchiveBatch(id:string,token:string){
 await query(`UPDATE pending_ingest_batches SET processed_at=now(),archive_claim_until=NULL,archive_claim_token=NULL
  WHERE id=$1 AND archive_claim_token=$2 AND NOT EXISTS(SELECT 1 FROM programmatic_capture_receipts WHERE batch_id=$1 AND status<>'completed')`,[id,token])
}
export async function releaseArchiveBatch(id:string,token:string,hold:boolean){
 await query('UPDATE pending_ingest_batches SET archive_claim_until=NULL,archive_claim_token=NULL,purpose_held=purpose_held OR $3 WHERE id=$1 AND archive_claim_token=$2',[id,token,hold])
}

export async function recordArchiveDrop(auth:BrainAuth,eventId:string,input:Parameters<ArchiveCapture>[1],profileId:string):Promise<ArchiveReceipt>{
 if(auth.scope!=='read_write'||!auth.actingUserId||auth.authKind!=='api_key')throw new EngineeringHistoryError('capture_target_unavailable',403)
 const payloadDigest=archiveDigest(input),prior=await archiveReceipt(auth,eventId,payloadDigest)
 if(prior)return prior
 const client=await getAppPool().connect()
 try{await client.query('BEGIN');await applyRLSGucs(client,auth.actingUserId)
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[auth.workspaceId])
  const key=(await client.query(`SELECT id FROM brain_keys WHERE id=$1 AND workspace_id=$2 AND status='active' AND scope='read_write'
   AND coalesce(issuer_user_id,(SELECT owner_user_id FROM workspaces WHERE id=$2))=$3`,[auth.keyId,auth.workspaceId,auth.actingUserId])).rows[0]
  if(!key)throw new EngineeringHistoryError('capture_target_unavailable')
  await client.query(`INSERT INTO programmatic_capture_receipts(workspace_id,principal_kind,principal_id,event_id,status,processing_purpose,payload_digest,archive_actor_id,archive_delivery_status)
   VALUES($1,$2,$3,$4,'dropped','archive_only',$5,$6,'dropped') ON CONFLICT(principal_kind,principal_id,event_id) DO NOTHING`,[auth.workspaceId,auth.authKind,auth.keyId,eventId,payloadDigest,auth.actingUserId])
  await client.query('COMMIT')
 }finally{await rollbackAndRelease(client)}
 const receipt=await archiveReceipt(auth,eventId,payloadDigest)
 if(!receipt)throw new EngineeringHistoryError('archive_receipt_conflict')
 return {...receipt,outcome:'dropped',profileId}
}
