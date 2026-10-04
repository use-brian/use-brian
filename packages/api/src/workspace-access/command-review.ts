/** Saved, immutable reviews over the canonical transaction. [COMP:api/workspace-access] */
import {createHash,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import type {DepartmentAccessCommand,DepartmentCommandReview,WorkspaceAccessOverview} from '@use-brian/shared'
import {getPool} from '../db/client.js'
import {notifyWorkspaceChange} from '../brain-stream/notify.js'
import {departmentAccessCommandSchema,departmentCommandApplySchema,departmentCommandIntentSchema} from './commands.js'
import {executeDepartmentAccessInTransaction,getWorkspaceAccessDirectoryInTransaction,getWorkspaceAccessInTransaction} from './service.js'
import {WorkspaceAccessError} from './policy.js'

type ReviewRow={id:string;payloadHash:string;intentHash:string;policyRevision:string;command:DepartmentAccessCommand;changes:DepartmentCommandReview['changes'];expiresAt:Date;status:'preview'|'applied';receipt:{appliedCommand?:WorkspaceAccessOverview['appliedCommand']}|null}
const columns=`id,payload_hash AS "payloadHash",intent_hash AS "intentHash",policy_revision::text AS "policyRevision",command,changes,expires_at AS "expiresAt",status,receipt`
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`
  if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>`${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)??'null'
}
export function hashCommandReviewIntent(value:unknown){return createHash('sha256').update(canonical(value)).digest('hex')}
/** A reserved session stays checked out; each call still commits its own phase. */
export async function withCommandReviewTransaction<T>(run:(client:PoolClient)=>Promise<T>,reservedClient?:PoolClient):Promise<T>{
  const client=reservedClient??await getPool().connect()
  try{await client.query('BEGIN');const result=await run(client);await client.query('COMMIT');return result}
  catch(error){
    await client.query('ROLLBACK');if(error instanceof WorkspaceAccessError)throw error
    const code=(error as {code?:string}).code
    if(code&&['23503','23505','23514','P0001','40001','40P01'].includes(code))throw new WorkspaceAccessError('access_conflict',409)
    // A statement timeout or a NOWAIT lock refusal is transient, not a crash:
    // answer with a retryable code the UI can name instead of a bare 500.
    console.error(`[workspace-access] command review transaction failed (${code??'no_code'}):`,(error as Error)?.message)
    if(code==='57014'||code==='55P03')throw new WorkspaceAccessError('access_busy',503)
    throw error
  }
  finally{if(!reservedClient)client.release()}
}
function project(row:ReviewRow,validForMs:number):DepartmentCommandReview {
  return{id:row.id,payloadHash:row.payloadHash,policyRevision:row.policyRevision,command:row.command,changes:row.changes,expiresAt:row.expiresAt.toISOString(),validForMs}
}

/** Only recognized, human-readable permission fields leave the server. */
async function changes(client:PoolClient,workspaceId:string,auditEventId:string|undefined):Promise<DepartmentCommandReview['changes']>{
  if(!auditEventId)return []
  const audit=(await client.query<{changes:{before:Record<string,unknown>|null;after:Record<string,unknown>|null}}>('SELECT changes FROM workspace_access_events WHERE workspace_id=$1 AND id=$2',[workspaceId,auditEventId])).rows[0]?.changes
  if(!audit)return []
  const names=(await client.query<{id:string;name:string}>(`SELECT id::text,coalesce(name,'') AS name FROM users WHERE id IN(SELECT user_id FROM workspace_members WHERE workspace_id=$1)
    UNION ALL SELECT id::text,name FROM workspace_groups WHERE workspace_id=$1
    UNION ALL SELECT compartment_key,name FROM workspace_groups WHERE workspace_id=$1 AND compartment_key IS NOT NULL
    UNION ALL SELECT id::text,name FROM assistants WHERE workspace_id=$1
    UNION ALL SELECT id::text,name FROM workspace_projects WHERE workspace_id=$1`,[workspaceId])).rows
  const labels=new Map(names.map(row=>[row.id,row.name]))
  const plain=['name','description','color','reason','starts_at','expires_at']
  const codes=['status','access_mode','classification_mode','reviewed_inventory_revision','directory_visibility','requestable','read_all','clearance','team_scope_mode','project_scope_mode','member','capabilities','revoked_at']
  const references=['default_department_id','bundle','assistant_ids','team_ids','project_ids','default_workspace_group_id','default_project_id','reviewer_id']
  const before=audit.before??{},after=audit.after??{}
  return [...plain,...codes,...references].filter(field=>canonical(before[field]??null)!==canonical(after[field]??null)).map(field=>{
    const values=(value:unknown):DepartmentCommandReview['changes'][number]['before']=>{
      if(field==='revoked_at')return [{kind:'code',value:value?'enabled':'disabled'}]
      if(value===null||value===undefined||Array.isArray(value)&&!value.length)return[{kind:'code',value:'none'}]
      return (Array.isArray(value)?value:[value]).map(item=>references.includes(field)?labels.get(String(item))?{kind:'text' as const,value:labels.get(String(item))!}:{kind:'code' as const,value:'unnamed'}:codes.includes(field)?{kind:'code' as const,value:typeof item==='boolean'?(item?'enabled':'disabled'):String(item)}:{kind:'text' as const,value:String(item)})
    }
    return{field,before:values(before[field]),after:values(after[field])}
  })
}

export async function prepareDepartmentCommand(workspaceId:string,userId:string,input:unknown,reservedClient?:PoolClient):Promise<DepartmentCommandReview>{
  const parsed=departmentCommandIntentSchema.safeParse(input);if(!parsed.success)throw new WorkspaceAccessError('invalid_command',400)
  const intent=parsed.data,intentHash=hashCommandReviewIntent(intent)
  return withCommandReviewTransaction(async client=>{
    // A review reads only the policy revision, lifetime and the simulated audit
    // event. The departmental readiness audit locks and reads every scoped row
    // in the workspace; running it here (twice, with the simulation) made a
    // department create take 15-30s and outlive its own confirmation window.
    const current=await getWorkspaceAccessDirectoryInTransaction(client,workspaceId,userId,true)
    const existing=(await client.query<ReviewRow>(`SELECT ${columns} FROM workspace_access_command_reviews WHERE workspace_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,[workspaceId,userId,intent.idempotencyKey])).rows[0]
    if(existing&&existing.intentHash!==intentHash)throw new WorkspaceAccessError('access_idempotency_conflict',409)
    if(existing?.status==='applied')return {...project(existing,current.validForMs),command:intent.command,changes:[],policyRevision:current.policyRevision,alreadyApplied:true}
    if(current.policyRevision!==intent.expectedPolicyRevision)throw new WorkspaceAccessError('access_policy_conflict',409)
    const now=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now
    if(existing){
      if(existing.expiresAt<=now)throw new WorkspaceAccessError('access_review_expired',409)
      return project(existing,Math.min(current.validForMs,existing.expiresAt.getTime()-now.getTime()))
    }
    const command=intent.command.type==='access.request.create'?{...intent.command,startsAt:intent.command.startsAt??now.toISOString()}:intent.command
    await client.query('SAVEPOINT access_preview')
    const simulated=await executeDepartmentAccessInTransaction(client,workspaceId,userId,command,'directory')
    const effects=await changes(client,workspaceId,simulated.appliedCommand?.auditEventId)
    await client.query('ROLLBACK TO SAVEPOINT access_preview');await client.query('RELEASE SAVEPOINT access_preview')
    const id=randomUUID(),expiresAt=new Date(now.getTime()+15*60_000),payloadHash=hashCommandReviewIntent({workspaceId,userId,id,command,policyRevision:current.policyRevision,changes:effects,expiresAt:expiresAt.toISOString()})
    const row=(await client.query<ReviewRow>(`INSERT INTO workspace_access_command_reviews(id,workspace_id,actor_user_id,idempotency_key,intent_hash,command,policy_revision,changes,payload_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10) RETURNING ${columns}`,[id,workspaceId,userId,intent.idempotencyKey,intentHash,JSON.stringify(command),current.policyRevision,JSON.stringify(effects),payloadHash,expiresAt])).rows[0]
    return project(row,Math.min(current.validForMs,15*60_000))
  },reservedClient)
}

export async function applyDepartmentCommand(workspaceId:string,userId:string,input:unknown,expectedCommand?:unknown,reservedClient?:PoolClient):Promise<WorkspaceAccessOverview>{
  const parsed=departmentCommandApplySchema.safeParse(input);if(!parsed.success)throw new WorkspaceAccessError('access_review_required',409)
  const expected=expectedCommand===undefined?undefined:departmentAccessCommandSchema.safeParse(expectedCommand)
  if(expected&&!expected.success)throw new WorkspaceAccessError('invalid_command',400)
  const normalized=(command:DepartmentAccessCommand)=>command.type==='department.member.set'?{...command,activateAssigned:command.activateAssigned??false}:command
  const result=await withCommandReviewTransaction(async client=>{
    // Revision checks need only the directory view; the full overview (with its
    // readiness audit) is composed once, by the command itself or the replay.
    const current=await getWorkspaceAccessDirectoryInTransaction(client,workspaceId,userId,true)
    const row=(await client.query<ReviewRow>(`SELECT ${columns} FROM workspace_access_command_reviews WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND organization_revision IS NULL FOR UPDATE`,[workspaceId,userId,parsed.data.reviewId])).rows[0]
    if(!row)throw new WorkspaceAccessError('not_found',404)
    if(row.payloadHash!==parsed.data.payloadHash)throw new WorkspaceAccessError('access_review_changed',409)
    if(expected?.success&&hashCommandReviewIntent(normalized(expected.data))!==hashCommandReviewIntent(normalized(row.command)))throw new WorkspaceAccessError('access_review_changed',409)
    if(row.status==='applied')return{...await getWorkspaceAccessInTransaction(client,workspaceId,userId),...(current.canAdminister&&row.receipt?.appliedCommand?{appliedCommand:row.receipt.appliedCommand}:{}),commandReceipt:{reviewId:row.id,replayed:true}}
    const now=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now
    if(row.expiresAt<=now)throw new WorkspaceAccessError('access_review_expired',409)
    if(row.policyRevision!==current.policyRevision)throw new WorkspaceAccessError('access_policy_conflict',409)
    const applied=await executeDepartmentAccessInTransaction(client,workspaceId,userId,row.command)
    await client.query("UPDATE workspace_access_command_reviews SET status='applied',applied_at=clock_timestamp(),receipt=$4::jsonb WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3",[workspaceId,userId,row.id,JSON.stringify({appliedCommand:applied.appliedCommand??null})])
    return{...applied,commandReceipt:{reviewId:row.id,replayed:false}}
  },reservedClient)
  if(!result.commandReceipt?.replayed){notifyWorkspaceChange(workspaceId,'workspace_config','update');notifyWorkspaceChange(workspaceId,'approval','update')}
  return result
}

/** Native execution may consume its exact confirmed intent, never create a review. */
export async function applyDepartmentCommandIntent(workspaceId:string,userId:string,input:unknown):Promise<WorkspaceAccessOverview>{
  const parsed=departmentCommandIntentSchema.safeParse(input);if(!parsed.success)throw new WorkspaceAccessError('invalid_command',400)
  const receipt=await withCommandReviewTransaction(async client=>{
    await getWorkspaceAccessInTransaction(client,workspaceId,userId)
    const row=(await client.query<ReviewRow>(`SELECT ${columns} FROM workspace_access_command_reviews WHERE workspace_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,[workspaceId,userId,parsed.data.idempotencyKey])).rows[0]
    if(!row)throw new WorkspaceAccessError('access_review_required',409)
    if(row.intentHash!==hashCommandReviewIntent(parsed.data))throw new WorkspaceAccessError('access_idempotency_conflict',409)
    return{type:'access.command.apply' as const,reviewId:row.id,payloadHash:row.payloadHash}
  })
  return applyDepartmentCommand(workspaceId,userId,receipt)
}
