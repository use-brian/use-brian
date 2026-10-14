import {loadDepartmentSnapshot,resolveDepartmentReadGrant} from '../context-scope/department-resolver.js'
import {write as referenceWrite} from '../context-scope/reference-predicate.js'
import {runWithAgentAccess} from '../db/agent-access-context.js'
import {assertExecutionResourceScope} from '../db/access-predicate.js'
import {applyRLSGucs,getAppPool,rollbackAndRelease} from '../db/client.js'
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
 await preflightArchiveScope(client,s)
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
  occurred_at,received_at,content_digest,file_id,file_version,delivery_status,index_text,sequence)
  OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$1,$19,'archived',$20,$21)`,
  [s.archiveId,s.workspaceId,s.principalKind,s.principalId,s.eventId,s.actingUserId,s.profileId,s.profileRevision,s.ruleId,s.provider,
   s.sessionId??null,s.turnId??null,s.role,s.subjectId??null,s.attributionQuality,s.occurredAt,s.receivedAt,s.contentDigest,version,s.content.slice(0,65536),s.serverSequence])
 const done=await client.query(`UPDATE programmatic_capture_receipts SET status='completed',updated_at=now(),error=NULL
  WHERE archive_id=$1 AND status='queued' RETURNING id`,[s.archiveId])
 if(done.rowCount!==1)throw new EngineeringHistoryError('archive_receipt_conflict')
}

export async function preflightArchiveScope(client:PoolClient,s:Pick<ArchiveSnapshot,'workspaceId'|'actingUserId'|'assistantId'|'sensitivity'|'compartments'|'projectIds'>){
 const scope={workspaceId:s.workspaceId,userId:null,assistantId:null,sensitivity:s.sensitivity,compartments:s.compartments,projectIds:s.projectIds}
 const v2=(await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[s.workspaceId])).rows[0]?.department_read_v2
 let access:AccessContext={workspaceId:s.workspaceId,userId:s.actingUserId,assistantId:s.assistantId,assistantKind:'standard',clearance:s.sensitivity}
 if(v2){const input={workspaceId:s.workspaceId,userId:s.actingUserId,assistantId:s.assistantId,credential:{cap:s.sensitivity}}
  const query=<R>(sql:string,values:unknown[])=>client.query(sql,values) as unknown as Promise<{rows:R[]}>
  const loaded=await loadDepartmentSnapshot(query,input)
  access={...access,departmentRead:resolveDepartmentReadGrant(loaded.snapshot,loaded.principal,input,new Date())}
  const admitted=referenceWrite(loaded.snapshot,{principal:loaded.principal,assistant:{kind:'assistant',id:s.assistantId},credential:{issuerUserId:s.actingUserId,cap:s.sensitivity,binding:null,scope:'read_write'}},{requestedTier:s.sensitivity,explicitGeneral:true,sources:[{id:'archive-source',workspaceId:s.workspaceId,tier:s.sensitivity,departmentIds:s.compartments.filter(k=>k.startsWith('team:')).map(k=>k.slice(5)),projectScopeIds:s.compartments.filter(k=>k.startsWith('project:')).map(k=>k.slice(8)),userId:null}]},{workspaceId:s.workspaceId,department:null,now:new Date()})
  if(!admitted.allowed)throw new EngineeringHistoryError('capture_target_unavailable')
 }
 assertExecutionResourceScope(scope,'mutation',access)
 const id='00000000-0000-0000-0000-000000000001'
 await runWithAgentAccess({...access,clearance:s.sensitivity,compartments:null,projectIds:null},()=>admitBoundFile(client,s.actingUserId,{...scope,id,path:`/engineering-history/${id}.json`,parentPath:'/engineering-history',name:`${id}.json`,mime:'application/json',sizeBytes:0,storageUri:'preview://unpublished',createdByUserId:s.actingUserId,createdByAssistantId:s.assistantId},scope,access))
}
export async function previewArchiveScope(s:Pick<ArchiveSnapshot,'workspaceId'|'actingUserId'|'assistantId'|'sensitivity'|'compartments'|'projectIds'>){
 const client=await getAppPool().connect()
 try{await client.query('BEGIN');await applyRLSGucs(client,s.actingUserId);await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[s.workspaceId]);await preflightArchiveScope(client,s)}finally{await rollbackAndRelease(client)}
}
