/** Trusted archive evidence on the canonical Files transaction. Never transport metadata. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { PoolClient } from 'pg'
import type { AccessContext, WorkspaceFileCreateInput } from '@use-brian/core'
import type { ArchiveSnapshot } from '../engineering-history/contracts.js'
import { EngineeringHistoryError } from '../engineering-history/contracts.js'
import { admitBoundFile } from './file-publication-admission.js'
const publication = new AsyncLocalStorage<ArchiveSnapshot>()
export const currentArchivePublication = () => publication.getStore()
export function withArchivePublication<T>(snapshot: ArchiveSnapshot,run:()=>T): T {return publication.run(structuredClone(snapshot),run)}
export async function admitProgrammaticFile(client: PoolClient,actor: string,input: WorkspaceFileCreateInput,access?: AccessContext) {
 const s=publication.getStore()
 if(!s || actor!==s.actingUserId || input.id!==s.archiveId || input.workspaceId!==s.workspaceId
  || input.path!==`/engineering-history/${s.archiveId}.json`) throw new EngineeringHistoryError('archive_publication_required')
 const valid=(await client.query('SELECT engineering_capture_current($1,$2,$3,$4::jsonb) AS allowed',
  [s.workspaceId,s.assistantId,s.ruleId,JSON.stringify(s)])).rows[0]?.allowed
 if(!valid)throw new EngineeringHistoryError('capture_target_unavailable')
 const receipt=(await client.query(`SELECT payload_digest,archive_id,status FROM programmatic_capture_receipts
  WHERE workspace_id=$1 AND principal_kind=$2 AND principal_id=$3 AND event_id=$4 FOR UPDATE`,
  [s.workspaceId,s.principalKind,s.principalId,s.eventId])).rows[0]
 if(!receipt || receipt.archive_id!==s.archiveId || receipt.payload_digest!==s.payloadDigest || receipt.status!=='queued')throw new EngineeringHistoryError('archive_receipt_conflict')
 const scope={workspaceId:s.workspaceId,userId:null,assistantId:null,sensitivity:s.sensitivity,compartments:s.compartments,projectIds:s.projectIds}
 const admitted={...input,...scope,createdByUserId:actor,createdByAssistantId:s.assistantId,source:'programmatic',metadata:{noIndex:true}}
 await admitBoundFile(client,actor,admitted,scope,access)
 await client.query("SELECT set_config('app.engineering_archive_publication',$1,true)",[s.archiveId])
 return {...admitted,purpose:'engineering_archive' as const}
}
export async function completeProgrammaticFile(client: PoolClient,fileId: string,version: string) {
 const s=publication.getStore()
 if(!s)return
 if(fileId!==s.archiveId)throw new EngineeringHistoryError('archive_receipt_conflict')
 await client.query(`INSERT INTO programmatic_archive_events(id,workspace_id,principal_kind,principal_id,event_id,actor_id,
  profile_id,profile_revision,rule_id,source_provider,source_session,source_turn,event_kind,claimed_subject,attribution_quality,
  occurred_at,received_at,content_digest,file_id,file_version,delivery_status,index_text)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$1,$19,'archived',$20)`,
  [s.archiveId,s.workspaceId,s.principalKind,s.principalId,s.eventId,s.actingUserId,s.profileId,s.profileRevision,s.ruleId,s.provider,
   s.sessionId??null,s.turnId??null,s.role,s.subjectId??null,s.attributionQuality,s.occurredAt,s.receivedAt,s.payloadDigest,version,s.content.slice(0,65536)])
 const done=await client.query(`UPDATE programmatic_capture_receipts SET status='completed',updated_at=now(),error=NULL
  WHERE archive_id=$1 AND status='queued' RETURNING id`,[s.archiveId])
 if(done.rowCount!==1)throw new EngineeringHistoryError('archive_receipt_conflict')
}
