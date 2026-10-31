/** Attended legacy source adoption. [COMP:api/legacy-knowledge-binding] */
import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {z} from 'zod'
import {withCommandReviewTransaction,hashCommandReviewIntent} from './command-review.js'
import {admitKnowledgeSourceConfiguration,type KnowledgeSourceBindingInput} from './knowledge-create-admission.js'
import {loadDepartmentSnapshot,resolveDepartmentReadGrant} from '../context-scope/department-resolver.js'
import {read} from '../context-scope/reference-predicate.js'
import {WorkspaceAccessError} from './policy.js'
import type {CutoverPrincipal} from './organization-cutover.js'

const prepareInput=z.object({sourceId:z.string().uuid(),targetDepartmentId:z.string().uuid(),idempotencyKey:z.string().uuid()}).strict()
const applyInput=z.object({reviewId:z.string().uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
function fail(code:string,status=409):never{throw new WorkspaceAccessError(code,status)}
type Evidence={sourceId:string;sourceType:string;targetDepartmentId:string;policyRevision:string;sourceFingerprint:string;
 outputFingerprint:string;entryCount:string;binding:KnowledgeSourceBindingInput}
type Review={id:string;workspace_id:string;actor_user_id:string;auth_session_id:string;source_id:string;
 policy_revision:string;payload_hash:string;evidence:Evidence;status:string;expires_at:Date;result:unknown}

async function principal(c:PoolClient,w:string,p:CutoverPrincipal) {
 if(![w,p.userId,p.authSessionId].every(value=>z.string().uuid().safeParse(value).success))fail('invalid_command',400)
 await c.query("SET LOCAL lock_timeout='2s'")
 await c.query("SET LOCAL statement_timeout='5s'")
 await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[w])
 const row=(await c.query<{revision:string}>(`SELECT policy.revision::text FROM workspaces workspace
  JOIN workspace_access_policies policy ON policy.workspace_id=workspace.id
  JOIN workspace_members member ON member.workspace_id=workspace.id AND member.user_id=$2 AND member.role IN('owner','admin')
  JOIN auth_sessions session ON session.id=$3 AND session.user_id=member.user_id
  JOIN users actor ON actor.id=member.user_id AND actor.auth_version=session.auth_version
  WHERE workspace.id=$1 AND workspace.department_read_v2 AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
  FOR SHARE OF policy,member,session,actor`,[w,p.userId,p.authSessionId])).rows[0]
 if(!row)fail('authenticated_workspace_admin_required',403)
 await c.query("SELECT set_config('app.current_user_id',$1,true)",[p.userId])
 return row
}

async function evidence(c:PoolClient,w:string,p:CutoverPrincipal,sourceId:string,targetDepartmentId:string):Promise<Evidence> {
 const policy=await principal(c,w,p)
 const source=(await c.query<{id:string;sourceType:string;sensitivity:KnowledgeSourceBindingInput['sensitivity'];bound:boolean;held:boolean;busy:boolean;fingerprint:string}>(`SELECT id,source_type AS "sourceType",default_sensitivity AS sensitivity,
  configured_by_user_id IS NOT NULL AS bound,binding_held AS held,sync_run_id IS NOT NULL AND sync_lease_until>clock_timestamp() AS busy,
  encode(sha256(convert_to(to_jsonb(source)::text,'UTF8')),'hex') AS fingerprint
  FROM workspace_knowledge_sources source WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[w,sourceId])).rows[0]
 if(!source)fail('knowledge_binding_source_unavailable',404)
 if(source.bound||source.held||source.busy)fail('knowledge_binding_source_busy')
 const group=(await c.query<{compartment:string}>(`SELECT compartment_key AS compartment FROM workspace_groups
  WHERE workspace_id=$1 AND id=$2 AND kind='team' AND status='active' AND compartment_key='team:'||id::text`,[w,targetDepartmentId])).rows[0]
 if(!group)fail('knowledge_binding_department_unavailable',404)
 const binding={sensitivity:source.sensitivity,compartments:[group.compartment],projectIds:[]}
 // Configuring a continuing reader/writer requires current department READ as
 // well as ordinary configuration admission. Role ownership is not data access.
 const {snapshot,principal:human}=await loadDepartmentSnapshot(<R>(sql:string,values:unknown[])=>c.query<R & Record<string,unknown>>(sql,values),{workspaceId:w,userId:p.userId,assistantId:null})
 if(!read(snapshot,{principal:human,assistant:null},{id:sourceId,workspaceId:w,tier:binding.sensitivity,
  departmentIds:[targetDepartmentId],userId:null},{workspaceId:w,department:targetDepartmentId,now:new Date()}))fail('knowledge_binding_department_access_required',403)
 await admitKnowledgeSourceConfiguration(c,w,{actorUserId:p.userId},binding)
 const grant=resolveDepartmentReadGrant(snapshot,human,{workspaceId:w,userId:p.userId,assistantId:null},new Date())
 const outputs=(await c.query<{count:string;fingerprint:string;outside:boolean}>(`SELECT count(*)::text AS count,
  encode(sha256(convert_to(coalesce(string_agg(to_jsonb(entry)::text,E'\n' ORDER BY id),''),'UTF8')),'hex') AS fingerprint,
  coalesce(bool_or(scope_held OR compartments IS DISTINCT FROM $3::text[] OR project_ids IS DISTINCT FROM '{}'::uuid[]
    OR sensitivity_rank(sensitivity)>sensitivity_rank($4)),false) AS outside
  FROM knowledge_entries entry WHERE workspace_id=$1 AND source_id=$2`,[w,sourceId,binding.compartments,grant.departments[targetDepartmentId]])).rows[0]
 if(outputs.outside)fail('knowledge_binding_output_review_required')
 return {sourceId,sourceType:source.sourceType,targetDepartmentId,policyRevision:policy.revision,
  sourceFingerprint:source.fingerprint,outputFingerprint:outputs.fingerprint,entryCount:outputs.count,binding}
}
function project(r:Review){return {status:r.status,reviewId:r.id,payloadHash:r.payload_hash,expiresAt:r.expires_at.toISOString(),
 ...r.evidence,configuredByUserId:r.actor_user_id,...(r.status==='applied'?{receipt:r.result}:{})}}

export async function listLegacyKnowledgeBindings(w:string,p:CutoverPrincipal) {
 return withCommandReviewTransaction(async c=>{
  const policy=await principal(c,w,p)
  const rows=(await c.query<{id:string;sourceType:string;entryCount:string}>(`SELECT source.id,source_type AS "sourceType",
   (SELECT count(*)::text FROM knowledge_entries WHERE source_id=source.id AND workspace_id=$1) AS "entryCount"
   FROM workspace_knowledge_sources source WHERE workspace_id=$1 AND configured_by_user_id IS NULL ORDER BY id`,[w])).rows
  return {policyRevision:policy.revision,validForMs:30_000,sources:rows}
 })
}
export async function prepareLegacyKnowledgeBinding(w:string,p:CutoverPrincipal,input:unknown) {
 const parsed=prepareInput.safeParse(input);if(!parsed.success)fail('invalid_command',400)
 const data=parsed.data
 return withCommandReviewTransaction(async c=>{
  await principal(c,w,p)
  const old=(await c.query<Review>('SELECT *,policy_revision::text FROM workspace_knowledge_binding_reviews WHERE workspace_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',[w,p.userId,data.idempotencyKey])).rows[0]
  if(old){if(old.auth_session_id!==p.authSessionId||old.source_id!==data.sourceId||old.evidence.targetDepartmentId!==data.targetDepartmentId)fail('access_idempotency_conflict');return project(old)}
  const e=await evidence(c,w,p,data.sourceId,data.targetDepartmentId),id=randomUUID(),expiresAt=new Date(Date.now()+10*60_000).toISOString()
  const hash=hashCommandReviewIntent({id,w,actor:p.userId,session:p.authSessionId,expiresAt,evidence:e})
  const row=(await c.query<Review>(`INSERT INTO workspace_knowledge_binding_reviews(id,workspace_id,source_id,actor_user_id,auth_session_id,
   target_department_id,policy_revision,idempotency_key,payload_hash,evidence,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *,policy_revision::text`,
   [id,w,data.sourceId,p.userId,p.authSessionId,data.targetDepartmentId,e.policyRevision,data.idempotencyKey,hash,JSON.stringify(e),expiresAt])).rows[0]
  return project(row)
 })
}
export async function applyLegacyKnowledgeBinding(w:string,p:CutoverPrincipal,input:unknown) {
 const parsed=applyInput.safeParse(input);if(!parsed.success)fail('invalid_command',400)
 return withCommandReviewTransaction(async c=>{
  const policy=await principal(c,w,p),data=parsed.data
  const row=(await c.query<Review>('SELECT *,policy_revision::text FROM workspace_knowledge_binding_reviews WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[data.reviewId,w])).rows[0]
  if(!row||row.actor_user_id!==p.userId||row.auth_session_id!==p.authSessionId)fail('knowledge_binding_review_unavailable',404)
  if(row.payload_hash!==data.payloadHash)fail('knowledge_binding_review_changed')
  if(row.status==='applied')return row.result
  if(row.status!=='prepared'||row.expires_at.getTime()<=Date.now())fail('knowledge_binding_review_expired')
  if(policy.revision!==row.policy_revision)fail('access_policy_conflict')
  const current=await evidence(c,w,p,row.source_id,row.evidence.targetDepartmentId)
  if(hashCommandReviewIntent(current)!==hashCommandReviewIntent(row.evidence))fail('knowledge_binding_review_changed')
  await c.query("UPDATE workspace_knowledge_binding_reviews SET status='applying' WHERE id=$1",[row.id])
  await c.query("SELECT set_config('app.knowledge_binding_review',$1,true)",[row.id])
  const updated=await c.query(`UPDATE workspace_knowledge_sources SET configured_by_user_id=$3,binding_sensitivity=$4,
   binding_compartments=$5,binding_project_ids='{}',binding_version=binding_version+1 WHERE workspace_id=$1 AND id=$2 AND configured_by_user_id IS NULL RETURNING id`,
   [w,row.source_id,p.userId,current.binding.sensitivity,current.binding.compartments])
  if(updated.rowCount!==1)fail('knowledge_binding_review_changed')
  const retained=(await c.query<{fingerprint:string}>(`SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(entry)::text,E'\n' ORDER BY id),''),'UTF8')),'hex') AS fingerprint
   FROM knowledge_entries entry WHERE workspace_id=$1 AND source_id=$2`,[w,row.source_id])).rows[0]
  if(retained.fingerprint!==current.outputFingerprint)fail('knowledge_binding_outputs_changed')
  await principal(c,w,p)
  const receipt={reviewId:row.id,sourceId:row.source_id,configuredByUserId:p.userId,binding:current.binding,entriesPreserved:current.entryCount,recordsDeleted:0,grantsChanged:false}
  await c.query("UPDATE workspace_knowledge_binding_reviews SET status='applied',result=$2,applied_at=clock_timestamp() WHERE id=$1",[row.id,JSON.stringify(receipt)])
  await c.query(`INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes)
   VALUES($1,$2,'workspace.knowledge_source.binding_completed',$3,$4,$5)`,[w,p.userId,row.source_id,policy.revision,JSON.stringify(receipt)])
  return receipt
 })
}
