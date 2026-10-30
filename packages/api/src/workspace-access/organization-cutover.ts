/** Authenticated, owner-reviewed organization cutover. [COMP:api/organization-cutover] */
import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {z} from 'zod'
import {getPool} from '../db/client.js'
import {getContextReadinessSystem} from '../context-scope/context-readiness.js'
import {hashCommandReviewIntent} from './command-review.js'
import {lockOrganizationCutoverInventory,organizationCutoverInventory} from './migration-inventory.js'
import {readWorkflowScheduleAuthority} from './operational-admission.js'
import {parseAuthoringAuthority} from '@use-brian/core'
import {resolveWorkflowAuthoringScope} from '../context-scope/workflow-authority.js'
import {WorkspaceAccessError} from './policy.js'

export const cutoverPrepareSchema=z.object({targetDepartmentId:z.string().uuid(),idempotencyKey:z.string().uuid(),
  requireNoGeneral:z.boolean().default(true)}).strict()
export const cutoverApplySchema=z.object({reviewId:z.string().uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
export type CutoverPrincipal={userId:string;authSessionId:string}
type Schedule={id:string;workflowId:string;oldFingerprint:string;sourceFingerprint:string;retainedFingerprint:string;alreadyPinned:boolean;enabled:boolean}
type Blocker={code:string;kind?:string;id?:string}
type Review={id:string;workspace_id:string;actor_user_id:string;auth_session_id:string;target_department_id:string;
  policy_revision:string;payload_hash:string;evidence:Evidence;status:string;expires_at:Date;result:unknown}
type Evidence={request:z.infer<typeof cutoverPrepareSchema>;policyRevision:string;inventory:Awaited<ReturnType<typeof organizationCutoverInventory>>;
  schedules:Schedule[];blockers:Blocker[];readinessVersion:number;retained:Record<string,string>}
const fail=(code:string,status=409):never=>{throw new WorkspaceAccessError(code,status)}

const deadlines=new WeakMap<PoolClient,number>()
function checkDeadline(c:PoolClient){if(performance.now()>(deadlines.get(c)??0))fail('cutover_busy')}

async function transaction<T>(run:(c:PoolClient)=>Promise<T>) {
 const c=await getPool().connect()
 try {
  await c.query('BEGIN')
  deadlines.set(c,performance.now()+15_000)
  // PostgreSQL 17+ also enforces a server-side absolute transaction deadline.
  if(Number((await c.query('SHOW server_version_num')).rows[0].server_version_num)>=170000)await c.query("SET LOCAL transaction_timeout='20s'")
  await c.query("SET LOCAL lock_timeout='2s'")
  await c.query("SET LOCAL statement_timeout='15s'")
  const result=await run(c);checkDeadline(c);await c.query('COMMIT');return result
 }catch(error){await c.query('ROLLBACK').catch(()=>{});if(['55P03','40P01','57014'].includes((error as {code:string}).code))fail('cutover_busy');throw error}finally{deadlines.delete(c);c.release()}
}
async function owner(c:PoolClient,w:string,principal:CutoverPrincipal,lock=true) {
 checkDeadline(c)
 if(![w,principal.userId,principal.authSessionId].every(id=>z.string().uuid().safeParse(id).success))fail('invalid_command',400)
 if(lock)await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[w])
 const row=(await c.query<{revision:string;setupState:string;departmentReadV2:boolean;receiptId:string|null}>(`
  SELECT p.revision::text,p.setup_state AS "setupState",w.department_read_v2 AS "departmentReadV2",p.completed_cutover_id AS "receiptId"
  FROM workspaces w JOIN workspace_access_policies p ON p.workspace_id=w.id
  JOIN workspace_members member ON member.workspace_id=w.id AND member.user_id=$2 AND member.role='owner'
  JOIN auth_sessions session ON session.id=$3 AND session.user_id=member.user_id
  JOIN users actor ON actor.id=member.user_id AND actor.auth_version=session.auth_version
  WHERE w.id=$1 AND w.owner_user_id=$2 AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
  ${lock?'FOR SHARE OF session,actor,member':''}`,[w,principal.userId,principal.authSessionId])).rows[0]
 if(!row)fail('authenticated_workspace_owner_required',403)
 if(!row.departmentReadV2)fail('organization_cutover_requires_department_model')
 await c.query("SELECT set_config('app.current_user_id',$1,true)",[principal.userId])
 return row
}

async function inspect(c:PoolClient,w:string,request:z.infer<typeof cutoverPrepareSchema>):Promise<Evidence> {
 const policy=(await c.query<{revision:string}>('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[w])).rows[0]
 const target=(await c.query(`SELECT id FROM workspace_groups WHERE id=$2 AND workspace_id=$1 AND kind='team' AND status='active'
   AND compartment_key='team:'||id::text`,[w,request.targetDepartmentId])).rows[0]
 if(!target)fail('cutover_department_unavailable',404)
 const inventory=await organizationCutoverInventory(c,w)
 const readiness=await getContextReadinessSystem(w,(sql,values)=>c.query(sql,values),{legacyInventory:false})
 const blockers:Blocker[]=readiness.checks.filter(check=>check.blocking&&!check.ready).map(check=>({code:`readiness_${check.id}`}))
 const retained:Record<string,string>={}
 for(const [kind,table] of Object.entries({memory:'memories',task:'tasks',entity:'entities',entity_link:'entity_links',
  workspace_file:'workspace_files',episode:'episodes',knowledge_entry:'knowledge_entries',kb_chunk:'kb_chunks',office_artifact:'office_artifacts'})) {
  checkDeadline(c)
  const rows=(await c.query<{id:string}>(`SELECT id FROM ${table} r WHERE workspace_id=$1
   AND (to_jsonb(r)->>'valid_to') IS NULL AND (to_jsonb(r)->>'retracted_at') IS NULL
   AND coalesce(to_jsonb(r)->>'lifecycle_state','active') NOT IN ('purged','trash')
   AND ($2::boolean AND NOT EXISTS(SELECT 1 FROM unnest(r.compartments) key WHERE key LIKE 'team:%')
     OR coalesce((to_jsonb(r)->>'scope_held')::boolean,false)) ORDER BY id`,[w,request.requireNoGeneral])).rows
  blockers.push(...rows.map(row=>({code:'cutover_unresolved_content',kind,id:row.id})))
  const family=inventory.families.find(row=>row.family===kind)
  if(family)retained[kind]=family.fingerprint
 }
 const assistants=(await c.query<{id:string}>(`SELECT id FROM assistants WHERE workspace_id=$1 AND
   (home_department_id IS DISTINCT FROM $2 OR default_workspace_group_id IS DISTINCT FROM $2 OR context_binding_origin='legacy') ORDER BY id`,[w,request.targetDepartmentId])).rows
 blockers.push(...assistants.map(row=>({code:'cutover_assistant_binding_required',kind:'assistant',id:row.id})))
 const sources=(await c.query<{id:string}>(`SELECT id FROM workspace_knowledge_sources WHERE workspace_id=$1 AND
   (configured_by_user_id IS NULL OR binding_held OR binding_compartments IS NULL OR binding_project_ids IS NULL
    OR (sync_run_id IS NOT NULL AND sync_lease_until>clock_timestamp())) ORDER BY id`,[w])).rows
 blockers.push(...sources.map(row=>({code:'cutover_knowledge_source_binding_required',kind:'knowledge_source',id:row.id})))
 const profiles=(await c.query<{id:string}>(`SELECT id FROM programmatic_capture_profiles WHERE workspace_id=$1 AND enabled
   AND (intake_binding IS NULL OR NOT EXISTS(SELECT 1 FROM auth_sessions session JOIN users actor ON actor.id=session.user_id
     WHERE session.id::text=intake_binding->>'session' AND session.user_id::text=intake_binding->>'actor'
       AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp() AND session.auth_version=actor.auth_version)) ORDER BY id`,[w])).rows
 blockers.push(...profiles.map(row=>({code:'cutover_intake_configuration_required',kind:'programmatic_capture_profile',id:row.id})))
 const workflows=(await c.query<{id:string;groupId:string|null;projectId:string|null;userId:string;authority:unknown}>(`SELECT id,context_group_id AS "groupId",context_project_id AS "projectId",coalesce(schedule_authoring_user_id,created_by) AS "userId",authoring_authority AS authority FROM workflows
   WHERE workspace_id=$1 AND enabled ORDER BY id`,[w])).rows
 const schedules:Schedule[]=[]
 for(const workflow of workflows) {
  checkDeadline(c)
  if(request.requireNoGeneral&&!workflow.groupId)blockers.push({code:'cutover_workflow_binding_required',kind:'workflow',id:workflow.id})
  try {
   const authority=parseAuthoringAuthority(workflow.authority)
   if(!authority)throw new Error('missing authority')
   await resolveWorkflowAuthoringScope({userId:workflow.userId,workspaceId:w,assistantId:authority.assistantId,
    authoringAuthority:authority,contextGroupId:workflow.groupId,contextProjectId:workflow.projectId},c)
  }catch(error){if(typeof(error as {code?:unknown}).code==='string'&&/^[0-9A-Z]{5}$/.test((error as {code:string}).code))throw error;blockers.push({code:'cutover_workflow_authority_unavailable',kind:'workflow',id:workflow.id})}
 }
 const active=(await c.query<{id:string}>(`SELECT r.id FROM workflow_runs r JOIN workflows workflow ON workflow.id=r.workflow_id
   WHERE r.workspace_id=$1 AND workflow.trigger->>'kind'='schedule' AND NOT workflow.schedule_authoring_pinned
   AND r.status NOT IN ('completed','failed','cancelled') ORDER BY r.id`,[w])).rows
 blockers.push(...active.map(row=>({code:'cutover_schedule_not_quiet',kind:'workflow_run',id:row.id})))
 const jobs=(await c.query<Schedule & {workspaceId:string;workflowWorkspaceId:string|null;userId:string;assistantId:string;groupId:string|null;projectId:string|null;compartments:string[];projectIds:string[];claimed:boolean;dispatching:boolean}>(`
  SELECT j.id,j.workflow_id AS "workflowId",a.workspace_id AS "workspaceId",workflow.workspace_id AS "workflowWorkspaceId",
    j.user_id AS "userId",j.assistant_id AS "assistantId",j.context_group_id AS "groupId",j.context_project_id AS "projectId",
    j.context_compartments AS compartments,j.context_project_ids AS "projectIds",j.enabled,
    j.workflow_authoring_snapshot IS NOT NULL AS "alreadyPinned",
    j.dispatch_lease_id IS NOT NULL AS dispatching,
    encode(sha256(convert_to((to_jsonb(j)-ARRAY['workflow_authoring_snapshot','updated_at'])::text,'UTF8')),'hex') AS "retainedFingerprint",
    j.schedule_claim_id IS NOT NULL AND j.schedule_claim_expires_at>clock_timestamp() AS claimed,
    encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex') AS "oldFingerprint",
    encode(sha256(convert_to(jsonb_build_object('authority',workflow.authoring_authority,'definition',workflow.definition,
      'trigger',workflow.trigger,'groupId',workflow.context_group_id,'projectId',workflow.context_project_id,
      'userId',coalesce(workflow.schedule_authoring_user_id,workflow.created_by),'workspaceId',workflow.workspace_id)::text,'UTF8')),'hex') AS "sourceFingerprint"
  FROM scheduled_jobs j JOIN assistants a ON a.id=j.assistant_id LEFT JOIN workflows workflow ON workflow.id=j.workflow_id
  WHERE j.workflow_step_run_id IS NULL AND (a.workspace_id=$1 OR workflow.workspace_id=$1) ORDER BY j.id FOR UPDATE OF j`,[w])).rows
 for(const job of jobs) {
  checkDeadline(c)
  if(!job.enabled) {
   if(!job.alreadyPinned)blockers.push({code:'cutover_inactive_schedule_review_required',kind:'scheduled_job',id:job.id})
   continue
  }
  if(job.workspaceId!==w||job.workflowWorkspaceId!==w||!job.workflowId||job.claimed||job.dispatching) {
   blockers.push({code:'cutover_schedule_not_quiet',kind:'scheduled_job',id:job.id});continue
  }
  try {
   const source=await readWorkflowScheduleAuthority(c,w,job.workflowId)
   if(source.userId!==job.userId||source.assistantId!==job.assistantId||source.contextGroupId!==job.groupId
    ||source.contextProjectId!==job.projectId||hashCommandReviewIntent([...source.compartments].sort())!==hashCommandReviewIntent([...job.compartments].sort())
    ||hashCommandReviewIntent([...source.projectIds].sort())!==hashCommandReviewIntent([...job.projectIds].sort()))throw new Error('binding')
   if(job.alreadyPinned) {
    const same=(await c.query(`SELECT 1 FROM scheduled_jobs WHERE id=$1 AND workflow_authoring_snapshot=$2::jsonb`,[job.id,JSON.stringify(source.snapshot)])).rowCount
    if(!same)throw new Error('snapshot')
   }
   schedules.push({id:job.id,workflowId:job.workflowId,oldFingerprint:job.oldFingerprint,sourceFingerprint:job.sourceFingerprint,retainedFingerprint:job.retainedFingerprint,alreadyPinned:job.alreadyPinned,enabled:job.enabled})
  }catch(error) {if(typeof(error as {code?:unknown}).code==='string'&&/^[0-9A-Z]{5}$/.test((error as {code:string}).code))throw error;blockers.push({code:'cutover_schedule_authority_unavailable',kind:'scheduled_job',id:job.id})}
 }
 return {request,policyRevision:policy.revision,inventory,schedules,blockers,readinessVersion:readiness.enforcementVersion,retained}
}

export async function prepareOrganizationCutover(w:string,principal:CutoverPrincipal,input:unknown) {
 const parsed=cutoverPrepareSchema.safeParse(input);if(!parsed.success)return fail('invalid_command',400)
 const data=parsed.data
 return transaction(async c=>{
  await owner(c,w,principal,false)
  await lockOrganizationCutoverInventory(c)
  const policy=await owner(c,w,principal)
  const existing=(await c.query<Review>('SELECT *,policy_revision::text FROM workspace_organization_cutover_reviews WHERE workspace_id=$1 AND actor_user_id=$2 AND idempotency_key=$3 FOR UPDATE',[w,principal.userId,data.idempotencyKey])).rows[0]
  if(existing) {
   if(hashCommandReviewIntent(existing.evidence.request)!==hashCommandReviewIntent(data)||existing.auth_session_id!==principal.authSessionId)fail('access_idempotency_conflict')
   return publicReview(existing)
  }
  if(policy.setupState==='ready'&&policy.receiptId)return {status:'already_ready',receiptId:policy.receiptId}
  const evidence=await inspect(c,w,data)
  if(evidence.blockers.length)return {status:'blocked',blockers:evidence.blockers,inventory:evidence.inventory,policyRevision:evidence.policyRevision}
  const id=randomUUID(),expiresAt=new Date(Date.now()+10*60_000).toISOString()
  const payloadHash=hashCommandReviewIntent({id,w,actor:principal.userId,session:principal.authSessionId,expiresAt,evidence})
  const review=(await c.query<Review>(`INSERT INTO workspace_organization_cutover_reviews(id,workspace_id,actor_user_id,auth_session_id,
   target_department_id,policy_revision,idempotency_key,payload_hash,evidence,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *,policy_revision::text`,
   [id,w,principal.userId,principal.authSessionId,data.targetDepartmentId,evidence.policyRevision,data.idempotencyKey,payloadHash,JSON.stringify(evidence),expiresAt])).rows[0]
  return publicReview(review)
 })
}
function publicReview(review:Review) {
 return {status:review.status,reviewId:review.id,payloadHash:review.payload_hash,expiresAt:review.expires_at.toISOString(),
  policyRevision:review.policy_revision,targetDepartmentId:review.target_department_id,inventory:review.evidence.inventory,
  schedules:review.evidence.schedules,retained:review.evidence.retained,blockers:review.evidence.blockers,
  changes:{setupState:'ready',mode:'departments',defaultDepartmentId:review.target_department_id,
   scheduleConversions:review.evidence.schedules.filter(row=>!row.alreadyPinned).map(row=>row.id),recordsDeleted:0,grantsChanged:false},
  ...(review.status==='applied'?{receipt:review.result}:{})}
}

export async function applyOrganizationCutover(w:string,principal:CutoverPrincipal,input:unknown) {
 const parsed=cutoverApplySchema.safeParse(input);if(!parsed.success)return fail('invalid_command',400)
 const data=parsed.data
 return transaction(async c=>{
  await owner(c,w,principal,false)
  await lockOrganizationCutoverInventory(c)
  const policy=await owner(c,w,principal)
  const review=(await c.query<Review>('SELECT *,policy_revision::text FROM workspace_organization_cutover_reviews WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[data.reviewId,w])).rows[0]
  if(!review||review.actor_user_id!==principal.userId||review.auth_session_id!==principal.authSessionId)fail('cutover_review_unavailable',404)
  if(review.payload_hash!==data.payloadHash)fail('cutover_review_changed')
  if(review.status==='applied')return review.result
  if(review.status!=='prepared'||review.expires_at.getTime()<=Date.now())fail('cutover_review_expired')
  if(review.policy_revision!==policy.revision)fail('access_policy_conflict')
  const current=await inspect(c,w,review.evidence.request)
  if(current.blockers.length||hashCommandReviewIntent(current)!==hashCommandReviewIntent(review.evidence))fail('cutover_review_changed')
  await c.query("UPDATE workspace_organization_cutover_reviews SET status='applying' WHERE id=$1",[review.id])
  await c.query("SELECT set_config('app.organization_cutover_review',$1,true)",[review.id])
  for(const job of current.schedules.filter(row=>!row.alreadyPinned)) {
   checkDeadline(c)
   const source=await readWorkflowScheduleAuthority(c,w,job.workflowId)
   const updated=await c.query(`UPDATE scheduled_jobs SET workflow_authoring_snapshot=$3::jsonb
     WHERE id=$1 AND workflow_id=$2 AND workflow_authoring_snapshot IS NULL RETURNING id`,[job.id,job.workflowId,JSON.stringify(source.snapshot)])
   if(updated.rowCount!==1)fail('cutover_review_changed')
   await c.query('UPDATE workflows SET schedule_authoring_pinned=true WHERE id=$1 AND workspace_id=$2',[job.workflowId,w])
   const post=(await c.query<{retained:string;source:string}>(`SELECT
     encode(sha256(convert_to((to_jsonb(j)-ARRAY['workflow_authoring_snapshot','updated_at'])::text,'UTF8')),'hex') AS retained,
     encode(sha256(convert_to(jsonb_build_object('authority',workflow.authoring_authority,'definition',workflow.definition,
       'trigger',workflow.trigger,'groupId',workflow.context_group_id,'projectId',workflow.context_project_id,
       'userId',coalesce(workflow.schedule_authoring_user_id,workflow.created_by),'workspaceId',workflow.workspace_id)::text,'UTF8')),'hex') AS source
     FROM scheduled_jobs j JOIN workflows workflow ON workflow.id=j.workflow_id WHERE j.id=$1 AND workflow.workspace_id=$2`,[job.id,w])).rows[0]
   if(!post||post.retained!==job.retainedFingerprint||post.source!==job.sourceFingerprint)fail('cutover_schedule_fields_changed')

  }
  // The policy trigger advances the real revision, records its before/after
  // audit, and emits invalidation. Never manufacture completion by removing it.
  const updated=(await c.query<{revision:string}>(`UPDATE workspace_access_policies SET setup_state='ready',access_mode='departments',
    default_department_id=$2,completed_cutover_id=$3 WHERE workspace_id=$1 RETURNING revision::text`,[w,review.target_department_id,review.id])).rows[0]
  await owner(c,w,principal)
  const retained=await organizationCutoverInventory(c,w)
  for(const [kind,fingerprint]of Object.entries(current.retained)) {
   if(retained.families.find(row=>row.family===kind)?.fingerprint!==fingerprint)fail('cutover_retained_content_changed')
  }
  const receipt={reviewId:review.id,workspaceId:w,setupState:'ready',mode:'departments',defaultDepartmentId:review.target_department_id,
   policyRevision:updated.revision,scheduleConversions:current.schedules.filter(row=>!row.alreadyPinned).map(row=>row.id),
   retained:current.retained,inventoryManifest:retained.manifestVersion,recordsDeleted:0,grantsChanged:false}
  await c.query("UPDATE workspace_organization_cutover_reviews SET status='applied',result=$2,applied_at=clock_timestamp() WHERE id=$1",[review.id,JSON.stringify(receipt)])
  await c.query(`UPDATE workspace_access_migration_plans p SET status='completed',
    summary_counts=jsonb_build_object('applied',(SELECT count(*) FROM workspace_access_migration_items i WHERE i.plan_id=p.id),
      'total',(SELECT count(*) FROM workspace_access_migration_items i WHERE i.plan_id=p.id),'blockers','[]'::jsonb)
    WHERE p.workspace_id=$1 AND p.target_mode='departments' AND p.status NOT IN ('paused','cancelled')
      AND EXISTS(SELECT 1 FROM workspace_access_migration_items i WHERE i.plan_id=p.id)
      AND NOT EXISTS(SELECT 1 FROM workspace_access_migration_items i WHERE i.plan_id=p.id AND i.status<>'applied')`,[w])
  await c.query(`INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes)
   VALUES($1,$2,'workspace.organization_cutover.completed',$3,$4,$5)`,[w,principal.userId,review.id,updated.revision,JSON.stringify(receipt)])
  return receipt
 })
}
