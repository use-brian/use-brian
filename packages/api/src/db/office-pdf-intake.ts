import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {deriveResourceScope,resourceScopeKey,type ScopeSource,type ResourceScope} from '@use-brian/core'
import {applyRLSGucs,getAppPool,rollbackAndRelease,queryWithRLS} from './client.js'
import {buildAccessPredicate,buildCurrentMemberSourcePredicate,assertExecutionResourceScope} from './access-predicate.js'
import {admitWorkspaceResource} from '../workspace-access/resource-admission.js'
import {readAdmissionPolicy} from '../workspace-access/admission-policy-read.js'

export type PdfIntakeSource = ScopeSource & {kind:'workspace_file'|'file_cache';sessionId?:string;mime:string;sizeBytes:number}
export function pdfIntakeError(code='pdf_intake_source_changed'):never {throw Object.assign(new Error(code),{code})}
export async function intakeTransaction<T>(actor:string,work:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await getAppPool().connect()
 try{await client.query('BEGIN');await applyRLSGucs(client,actor);const result=await work(client);await client.query('COMMIT');return result}
 finally{await rollbackAndRelease(client)}
}
export async function readPdfIntakeSource(client:PoolClient,actor:string,w:string,source:{kind:'workspace_file'|'file_cache';id:string;expectedSessionId?:string}):Promise<PdfIntakeSource>{
 const table=source.kind==='workspace_file'?'workspace_files':'file_cache'
 const read=buildAccessPredicate({workspaceId:w,userId:actor,assistantId:'',assistantKind:'primary',visibilityAssistantIds:[]},{alias:'f'})
 const member=buildCurrentMemberSourcePredicate(actor,{alias:'f',startIdx:read.nextIdx,operation:'read'})
 const idIdx=member.nextIdx
 const guard=source.kind==='workspace_file'?`f.created_by_user_id=$${idIdx+1} AND f.source='user' AND f.valid_to IS NULL AND f.retracted_at IS NULL`:`f.user_id=$${idIdx+1} AND f.expires_at>now() AND EXISTS(SELECT 1 FROM sessions s JOIN assistants a ON a.id=s.assistant_id
   WHERE s.id=f.session_id AND s.user_id=$${idIdx+1} AND s.workspace_id=f.workspace_id AND a.workspace_id=f.workspace_id
     AND coalesce(s.context_compartments,'{}') <@ f.compartments
     AND (s.context_project_id IS NULL OR s.context_project_id=ANY(f.project_ids)) FOR SHARE OF s,a)`
 const row=(await client.query(`SELECT to_jsonb(f)-'content'-'original_content' AS row,encode(sha256(convert_to(to_jsonb(f)::text,'UTF8')),'hex') AS version FROM ${table} f
 WHERE ${read.sql} AND ${member.sql} AND f.workspace_id=$1 AND f.id=$${idIdx} AND ${guard} AND NOT f.scope_held
 AND NOT scope_review_state_held($${idIdx+2},f.id) FOR SHARE OF f`,[...read.params,...member.params,source.id,actor,source.kind])).rows[0]
 if(!row)pdfIntakeError('pdf_intake_source_unavailable')
 const r=row.row
 if(source.expectedSessionId && r.session_id!==source.expectedSessionId)pdfIntakeError()
 const scope:ResourceScope={workspaceId:w,userId:r.user_id,assistantId:r.assistant_id,sensitivity:r.sensitivity,compartments:r.compartments,projectIds:r.project_ids}
 assertExecutionResourceScope(scope,'read')
 return {...scope,kind:source.kind,resourceKind:source.kind,resourceId:source.id,version:row.version,
   ...(r.session_id?{sessionId:r.session_id}:{}),mime:r.mime??r.mime_type,sizeBytes:Number(r.size_bytes)}
}
export async function validatePdfIntakeSources(client:PoolClient,actor:string,w:string,sources:PdfIntakeSource[]){
 if(!sources?.length)pdfIntakeError()
 for(const expected of [...sources].sort((a,b)=>(a.kind+a.resourceId).localeCompare(b.kind+b.resourceId))){
  const current=await readPdfIntakeSource(client,actor,w,{kind:expected.kind,id:expected.resourceId,expectedSessionId:expected.sessionId})
  if(current.version!==expected.version || resourceScopeKey(current)!==resourceScopeKey(expected))pdfIntakeError()
 }
}
export async function authorizePendingPdfIntake(client:PoolClient,actor:string,w:string,id:string){
 await client.query("SELECT set_config('app.pdf_intake_artifact',$1,true)",[id])
 const row=(await client.query('SELECT pdf_intake_state,pdf_intake_sources FROM office_artifacts WHERE id=$1 AND workspace_id=$2 AND owner_user_id=$3 FOR SHARE',[id,w,actor])).rows[0]
 if(row?.pdf_intake_state==='pending')await validatePdfIntakeSources(client,actor,w,row.pdf_intake_sources)
 if(row?.pdf_intake_state==='abandoned')pdfIntakeError()
}
export const capturePdfIntakeSource=(actor:string,w:string,source:Parameters<typeof readPdfIntakeSource>[3])=>intakeTransaction(actor,async client=>{
 await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[w]);return readPdfIntakeSource(client,actor,w,source)
})
export async function reservePdfIntake(p:{userId:string;workspaceId:string;artifactId:string;title:string;idempotencyKey:string;requestHash:string;sensitivity:ResourceScope['sensitivity'];sources:PdfIntakeSource[]}){
 return intakeTransaction(p.userId,async client=>{
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[p.workspaceId])
  await client.query("SELECT set_config('app.pdf_intake_artifact',$1,true)",[p.artifactId])
  await validatePdfIntakeSources(client,p.userId,p.workspaceId,p.sources)
  const scope=deriveResourceScope({producer:'pdf-intake',sources:p.sources},{workspaceId:p.workspaceId,userId:p.userId,assistantId:null,sensitivity:p.sensitivity,compartments:[],projectIds:[]})
  if(scope.assistantId)pdfIntakeError('pdf_intake_assistant_binding_required')
  const policy=await readAdmissionPolicy(client,p.workspaceId)
  if(policy?.setupState==='ready')await admitWorkspaceResource(client,p.workspaceId,p.userId,{visibility:'private',sensitivity:scope.sensitivity,
    inherited:{...scope,visibility:'private'},requestedLabels:{}})
  const row=(await client.query(`INSERT INTO office_artifacts(id,workspace_id,family,mode,title,creator_user_id,owner_user_id,capability_version,
    sensitivity,compartments,project_ids,visibility_user_ids,default_workspace_role,expires_at,pdf_session_idempotency_key,pdf_intake_state,pdf_intake_sources,pdf_intake_request_hash)
    VALUES($1,$2,'pdf','session',$3,$4,$4,1,$5,$6,$7,ARRAY[$4::uuid],'deny',now()+interval '24 hours',$8,'pending',$9::jsonb,$10)
    ON CONFLICT (workspace_id,owner_user_id,pdf_session_idempotency_key) WHERE mode='session' DO NOTHING RETURNING id`,
    [p.artifactId,p.workspaceId,p.title,p.userId,scope.sensitivity,scope.compartments,scope.projectIds,p.idempotencyKey,JSON.stringify(p.sources),p.requestHash])).rows[0]
  if(!row)pdfIntakeError('pdf_intake_busy')
  return scope
 })
}
export async function checkPdfIntakeRequest(actor:string,w:string,key:string,hash:string){
 const rows=await queryWithRLS(actor,"SELECT pdf_intake_request_hash FROM office_artifacts WHERE workspace_id=$1 AND owner_user_id=$2 AND pdf_session_idempotency_key=$3",[w,actor,key])
 if(rows.rows[0]?.pdf_intake_request_hash && rows.rows[0].pdf_intake_request_hash!==hash)pdfIntakeError('pdf_intake_idempotency_conflict')
}
export const pdfIntakeHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')

export async function finalizePdfIntake(p:import('./office-pdf-sessions.js').CreatePdfSessionRecord,selectSession:string){
 return intakeTransaction(p.userId,async client=>{
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[p.workspaceId])
  await authorizePendingPdfIntake(client,p.userId,p.workspaceId,p.artifactId)
  const root=(await client.query("SELECT * FROM office_artifacts WHERE id=$1 AND workspace_id=$2 AND owner_user_id=$3 AND pdf_intake_state='pending' AND expires_at>now() FOR UPDATE",[p.artifactId,p.workspaceId,p.userId])).rows[0]
  if(!root)pdfIntakeError()
  const sources:PdfIntakeSource[]=root.pdf_intake_sources
  await validatePdfIntakeSources(client,p.userId,p.workspaceId,sources)
  const floor=deriveResourceScope({producer:'pdf-intake',sources})
  const policy=await readAdmissionPolicy(client,p.workspaceId)
  if(policy?.setupState==='ready')await admitWorkspaceResource(client,p.workspaceId,p.userId,{visibility:'private',sensitivity:root.sensitivity,
    inherited:{...floor,visibility:'private'},requestedLabels:{compartments:root.compartments.length?root.compartments:undefined,projectIds:root.project_ids}})
  const assets=[{id:p.sourceFileId,role:'source',hash:p.sourceSha256},{id:p.snapshotFileId,role:'snapshot',hash:p.snapshotHash},
    ...(p.signatureFileId?[{id:p.signatureFileId,role:'signature',hash:p.signatureSha256}]:[])]
  for(const asset of assets){
   const row=(await client.query(`SELECT f.id FROM workspace_files f JOIN workspace_file_session_bindings b ON b.file_id=f.id
     JOIN office_pdf_session_assets a ON a.file_id=f.id AND a.artifact_id=b.artifact_id
     WHERE f.id=$1 AND b.artifact_id=$2 AND f.workspace_id=$3 AND f.user_id=$4 AND f.assistant_id IS NULL
       AND f.valid_to IS NULL AND f.retracted_at IS NULL AND NOT f.scope_held AND a.role=$5 AND a.content_sha256=$6
       AND f.metadata->>'contentSha256'=$6 AND f.compartments @> $7::text[] AND f.project_ids @> $8::uuid[]
       AND sensitivity_rank(f.sensitivity)>=sensitivity_rank($9) FOR SHARE OF f`,
     [asset.id,p.artifactId,p.workspaceId,p.userId,asset.role,asset.hash,root.compartments,root.project_ids,root.sensitivity])).rows[0]
   if(!row)pdfIntakeError('pdf_intake_asset_changed')
  }
  await client.query(`INSERT INTO office_artifact_versions(id,artifact_id,workspace_id,version,snapshot_file_id,snapshot_hash,operation_clock,schema_version,capability_version,author_type,author_user_id,origin,summary)
    VALUES($1,$2,$3,0,$4,$5,$6,$7,$8,'import',$9,'import','PDF session intake')`,[p.versionId,p.artifactId,p.workspaceId,p.snapshotFileId,p.snapshotHash,Buffer.from(p.stateVector),p.snapshot.schemaVersion,p.snapshot.capabilityVersion,p.userId])
  await client.query(`INSERT INTO office_collab_documents(artifact_id,workspace_id,ydoc,state_vector,canonical_hash,base_version,seq)
    VALUES($1,$2,$3,$4,$5,0,1)`,[p.artifactId,p.workspaceId,Buffer.from(p.snapshotBytes),Buffer.from(p.stateVector),p.snapshotHash])
  await client.query("UPDATE office_artifacts SET head_version_id=$2,pdf_intake_state='ready' WHERE id=$1",[p.artifactId,p.versionId])
  await client.query(`INSERT INTO office_audit_events(workspace_id,artifact_id,actor_user_id,event_type,artifact_version,metadata)
    VALUES($1,$2,$3,'office_pdf_session_created',0,jsonb_build_object('sourceSha256',$4::text))`,[p.workspaceId,p.artifactId,p.userId,p.sourceSha256])
  return (await client.query<import('./office-pdf-sessions.js').PdfSessionRow>(`${selectSession} AND a.id=$1`,[p.artifactId])).rows[0]??null
 })
}
