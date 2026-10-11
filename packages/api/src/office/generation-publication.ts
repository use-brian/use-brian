/** Office-owned staging + atomic app-role publication. Never root-file admission. */
import { createHash, randomUUID } from 'node:crypto'
import {dispatchOfficeJobLocal} from './job-event-bus.js'
import type { PoolClient } from 'pg'
import { assertOfficeArtifactSnapshot, officeStateVector, snapshotToYDoc, type DocumentSnapshot } from '@use-brian/office-model'
import { applyRLSGucs, getAppPool, rollbackAndRelease } from '../db/client.js'
import { createOfficeLiveStore } from '../db/office-live.js'
import { createOfficeArtifactStore, type OfficeDbQuery } from '../db/office-artifacts.js'
import { createOfficeGenerationStore, type OfficeGenerationJobRow } from '../db/office-generation.js'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'
import type { FilesClientResolver } from '../files/files-api.js'
import { buildStorageKey, buildStorageUri } from '../files/gcs-client.js'
import { promptOnlyBrief, constructPromptOnlyDocument } from './prompt-only.js'
import type { LLMProvider } from '@use-brian/core'
import { validateOfficeInternalCandidateRendering, type OfficeRenderValidationPort } from './render-validation.js'

const denied=()=>new Error('office_generation_publication_denied')
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
function queryFor(client:PoolClient,actor:string):OfficeDbQuery {
  return async <T>(userId:string,sql:string,values:unknown[])=>{
    if(userId!==actor) throw denied()
    return {rows:(await client.query(sql,values)).rows as T[]}
  }
}
async function authorize(client:PoolClient, expected:OfficeGenerationJobRow, leaseToken:string) {
  const actor=expected.initiatedByUserId
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[expected.workspaceId])
  await client.query('SELECT id FROM office_generation_jobs WHERE id=$1 FOR UPDATE',[expected.id])
  const job=await createOfficeGenerationStore(queryFor(client,actor)).get(actor,expected.id)
  if(!job || job.status!=='running' || job.leaseToken!==leaseToken || job.cancelRequestedAt || job.jobKind!=='create'
    || job.artifactId!==expected.artifactId || job.workspaceId!==expected.workspaceId || job.initiatedByUserId!==actor
    || !equal(job.brief,expected.brief) || !equal(job.authorityProjection,expected.authorityProjection)) throw denied()
  promptOnlyBrief(job)
  const p=job.authorityProjection as {sensitivity:string;compartments:string[];projectIds:string[];visibilityUserIds:string[];compartmentGrant:string[];projectGrant:string[];sourceHandles:string[];
    creationBinding:{protocol:string;actorUserId:string;workspaceId:string;authSessionId:string;sources:unknown[];implicitContext:string}}
  const b=p.creationBinding
  if(b?.protocol!=='office_prompt_only_v1' || b.actorUserId!==actor || b.workspaceId!==job.workspaceId || b.implicitContext!=='disabled'
    || !equal(b.sources,[]) || !equal(p.sourceHandles,[]) || !Array.isArray(p.compartments) || !Array.isArray(p.projectIds)
    || !equal(p.compartmentGrant,p.compartments) || !equal(p.projectGrant,p.projectIds) || job.templateVersionId || job.baseArtifactVersion!==0) throw denied()
  const session=await client.query(`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version FOR SHARE OF s,u`,[b.authSessionId,actor])
  if(!session.rows.length) throw denied()
  const a=(await client.query(`SELECT * FROM office_artifacts WHERE id=$1 AND workspace_id=$2 AND family='document' AND mode='artifact'
    AND lifecycle_state='active' AND head_version=0 AND head_version_id IS NULL AND template_version_id IS NULL
    AND NOT scope_review_state_held('office_artifact',id) AND office_generation_artifact_allows(id,workspace_id,true) FOR UPDATE`,[job.artifactId,job.workspaceId])).rows[0]
  if(!a || a.sensitivity!==p.sensitivity || !equal(a.compartments,p.compartments) || !equal(a.project_ids,p.projectIds)
    || !equal(a.visibility_user_ids,p.visibilityUserIds)) throw denied()
  if((await client.query('SELECT 1 FROM office_artifact_sources WHERE artifact_id=$1 LIMIT 1',[job.artifactId])).rows.length) throw denied()
  for(const key of p.compartments) if(key.startsWith('team:') && !(await client.query("SELECT 1 FROM workspace_groups WHERE workspace_id=$1 AND compartment_key=$2 AND status='active'",[job.workspaceId,key])).rows.length) throw denied()
  for(const id of p.projectIds) if(!(await client.query("SELECT 1 FROM workspace_projects WHERE workspace_id=$1 AND id=$2 AND status='active'",[job.workspaceId,id])).rows.length) throw denied()
  if(!(await client.query('SELECT 1 FROM office_generation_jobs WHERE id=$1 AND lease_expires_at>clock_timestamp()',[job.id])).rows.length) throw denied()
  return a
}
export async function checkPromptOnlyAuthority(job:OfficeGenerationJobRow,leaseToken:string) {
  const client=await getAppPool().connect()
  try {await client.query('BEGIN');await applyRLSGucs(client,job.initiatedByUserId);await authorize(client,job,leaseToken);await client.query('COMMIT')}
  finally {await rollbackAndRelease(client)}
}
export async function publishPromptOnlyDocument(params:{job:OfficeGenerationJobRow;leaseToken:string;snapshot:DocumentSnapshot;resolver:FilesClientResolver;storageLimitBytes:number}) {
  const {job,leaseToken,snapshot,resolver}=params, actor=job.initiatedByUserId
  assertOfficeArtifactSnapshot(snapshot)
  if(snapshot.artifactId!==job.artifactId || snapshot.workspaceId!==job.workspaceId || snapshot.templateVersionId || snapshot.resources.length) throw denied()
  await checkPromptOnlyAuthority(job,leaseToken)
  const bytes=Buffer.from(JSON.stringify(snapshot)), hash=createHash('sha256').update(bytes).digest('hex'), fileId=randomUUID()
  const storage=await resolver.forWorkspace(job.workspaceId), key=buildStorageKey(job.workspaceId,fileId)
  // Unpublished random object; never mutate an existing version's bytes.
  try { await storage.gcs.writeBlob(key,bytes,{workspaceId:job.workspaceId,createdByUserId:actor,mime:'application/json'}) }
  catch(error) {await storage.gcs.deleteBlob(key).catch(()=>{});throw error}
  let client:PoolClient|undefined
  let committing=false, committed=false
  try {
    // Connection acquisition can fail after upload, before any transaction
    // exists. It belongs inside the same definite-nonpublication cleanup guard.
    client=await getAppPool().connect()
    await client.query('BEGIN');await applyRLSGucs(client,actor)
    const a=await authorize(client,job,leaseToken)
    if(!storage.byo) {
      const usage=(await client.query('SELECT coalesce(sum(size_bytes),0)::text AS bytes FROM workspace_files WHERE workspace_id=$1',[job.workspaceId])).rows[0]
      if(Number(usage.bytes)+bytes.length>params.storageLimitBytes) throw new Error('office_storage_quota_exceeded')
    }
    // Inherited artifact envelope, with current mutation authority. Visibility is
    // additionally constrained by the live parent binding for every generic read.
    const admitted=await admitWorkspaceResource(client,job.workspaceId,actor,{writerKind:'workspace_file',rowVisibility:{userId:null,assistantId:null},visibility:'workspace',sensitivity:a.sensitivity,
      inherited:{visibility:'workspace',sensitivity:a.sensitivity,compartments:a.compartments,projectIds:a.project_ids},
      requestedLabels:{compartments:a.compartments,projectIds:a.project_ids}})
    if(!equal(admitted.envelope.compartments,a.compartments)||!equal(admitted.envelope.projectIds,a.project_ids)||admitted.envelope.sensitivity!==a.sensitivity) throw denied()
    const parent=`/office/artifacts/${job.artifactId}/versions`, name=`1-${hash}.json`
    await client.query(`INSERT INTO workspace_files(id,workspace_id,path,parent_path,name,mime,size_bytes,storage_uri,sensitivity,compartments,project_ids,created_by_user_id,metadata)
      VALUES($1,$2,$3,$4,$5,'application/json',$6,$7,$8,$9,$10,$11,$12::jsonb)`,[fileId,job.workspaceId,`${parent}/${name}`,parent,name,bytes.length,buildStorageUri(storage.bucket,job.workspaceId,fileId,storage.uriScheme),a.sensitivity,a.compartments,a.project_ids,actor,JSON.stringify({noIndex:true,contentSha256:hash,officeGenerationJobId:job.id})])
    await client.query('INSERT INTO office_generation_file_bindings(file_id,artifact_id,workspace_id,job_id,snapshot_hash) VALUES($1,$2,$3,$4,$5)',[fileId,job.artifactId,job.workspaceId,job.id,hash])
    const version=await createOfficeArtifactStore(queryFor(client,actor)).commitVersion({userId:actor,artifactId:job.artifactId,snapshotTitle:snapshot.title,expectedVersion:0,snapshotFileId:fileId,snapshotHash:hash,
      operationClock:officeStateVector(snapshotToYDoc(snapshot)),schemaVersion:snapshot.schemaVersion,capabilityVersion:snapshot.capabilityVersion,origin:'generation',authorType:'system',summary:'Prompt-only generation',checkpointKind:'generation'})
    if(!version) throw denied()
    // Publish an immediately usable editing document, not just a historical
    // snapshot. Never overwrite a concurrent draft; roll back the whole output.
    if(!await createOfficeLiveStore(queryFor(client,actor)).initializeIfMissing({userId:actor,artifactId:job.artifactId,snapshot})) throw denied()
    const done=await client.query(`UPDATE office_generation_jobs SET status='completed',stage='completed',completed_at=now(),updated_at=now(),lease_token=NULL,lease_expires_at=NULL,error_code=NULL,error_detail=NULL
      WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_expires_at>clock_timestamp() AND cancel_requested_at IS NULL
      AND EXISTS(SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id::text=office_generation_jobs.authority_projection->'creationBinding'->>'authSessionId'
        AND s.user_id=office_generation_jobs.initiated_by_user_id AND s.revoked_at IS NULL
        AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version) RETURNING id`,[job.id,leaseToken])
    if(!done.rows.length) throw denied()
    await createOfficeGenerationStore(queryFor(client,actor)).appendEvent({userId:actor,jobId:job.id,workspaceId:job.workspaceId,
      code:'office.job.completed',values:{artifactId:job.artifactId,version:version.version},actorType:'system',safeNarration:'Completed'})
    committing=true;await client.query('COMMIT');committed=true
    dispatchOfficeJobLocal({jobId:job.id,workspaceId:job.workspaceId})
    return version
  } finally {
    if(client) await rollbackAndRelease(client)
    // Unknown COMMIT acknowledgement must retain bytes: they may be canonical.
    if(!committing && !committed) await storage.gcs.deleteBlob(key).catch(()=>{})
  }
}

/** Production orchestration. Tests replace only external model/render/storage ports. */
export async function executePromptOnlyGeneration(params:{job:OfficeGenerationJobRow;leaseToken:string;provider:LLMProvider;model:string;
  resolver:FilesClientResolver;storageLimitBytes:number;renderPort?:OfficeRenderValidationPort}) {
  await checkPromptOnlyAuthority(params.job,params.leaseToken)
  const snapshot=await constructPromptOnlyDocument(params.job,params.provider,params.model)
  const rendered=await validateOfficeInternalCandidateRendering({snapshot,port:params.renderPort})
  if(!rendered.receipt.ok) throw new Error('office_prompt_render_validation_failed')
  await publishPromptOnlyDocument({...params,snapshot})
}
