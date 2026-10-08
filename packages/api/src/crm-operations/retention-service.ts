/** Owner-reviewed or explicitly scheduled retention. [COMP:crm/retention] */
import {createHash,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {CrmOperationsContextSchema,CrmOperationsError,PreviewCrmRetentionCommandSchema,ExecuteCrmRetentionCommandSchema,
  assertCrmOperationsAuthority,canonicalCrmRequest,type CrmOperationsContext,type CrmRetentionServicePort,type ResourceScope} from '@use-brian/core'
import {getPool,query,queryWithRLS} from '../db/client.js'
import {acquireCrmPrivacyAdmission} from './privacy-admission.js'
import {readCrmPrivacyPolicy} from './privacy-policy.js'
import {inspectCrmRetention,applyCrmRetention,type CrmRetentionPlan} from './retention-store.js'
import {assertCrmRetentionScope,renewCrmRetentionScope,emptyCrmRetentionScope} from './retention-authority.js'
import {queryCrmPage} from './pagination.js'
import type {CrmPageQuery} from '@use-brian/core'

const conflict=(reason:string)=>new CrmOperationsError('conflict','Review the current retention policy and affected data before proceeding.',{reason})
const hash=(input:unknown)=>createHash('sha256').update(canonicalCrmRequest(input)).digest('hex')
function summary(plan:CrmRetentionPlan) {
  return {domains:plan.domains,blockers:plan.blockers,hasMore:plan.hasMore,cutoffs:plan.cutoffs,retainedCopies:plan.retainedCopies,scope:'crm_retention' as const}
}
export async function assertCrmRetentionOwner(client:PoolClient,context:CrmOperationsContext):Promise<string> {
  if(context.actor.kind!=='user' || !context.authority.canConfigure || !context.authority.canWrite || !['owner','admin'].includes(context.authority.role)) {
    throw new CrmOperationsError('not_authorized','Retention requires an owner/admin member session.')
  }
  const role=(await client.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[context.workspaceId,context.actor.userId])).rows[0]?.role
  if(!['owner','admin'].includes(role))throw new CrmOperationsError('not_authorized','Current owner/admin membership is required.')
  return context.actor.userId
}
function fail(error:unknown):never {
  if(error instanceof CrmOperationsError)throw error
  throw conflict('retention_failed')
}
type Run={scope_snapshot:ResourceScope|null;id:string;owner_user_id:string;policy_version:number;before_at:Date;captured_at:Date;expires_at:Date;
  snapshot_hash:string;preview_hash:string;status:string;receipt:Record<string,unknown>|null;valid:boolean}
async function insert(client:PoolClient,input:{id:string;workspaceId:string;owner:string;plan:CrmRetentionPlan;before:Date;captured:Date;mode:'manual'|'scheduled';changed?:Record<string,number>}) {
  const {id,workspaceId,plan,before,captured}=input,expires=new Date(captured.getTime()+15*60_000)
  const previewHash=hash({id,workspaceId,owner:input.owner,policyVersion:plan.policyVersion,snapshotHash:plan.snapshotHash,expiresAt:expires.toISOString()})
  const status=plan.blockers.length?'blocked':input.mode==='manual'?'ready':'completed'
  const receipt=status==='completed'?{runId:id,policyVersion:plan.policyVersion,changed:input.changed ?? {},...summary(plan)}:null
  await client.query(`INSERT INTO crm_retention_runs(id,workspace_id,owner_user_id,policy_version,mode,before_at,captured_at,expires_at,
    snapshot_hash,preview_hash,summary,status,receipt,completed_at,scope_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,CASE WHEN $12='completed' THEN clock_timestamp() ELSE NULL END,$14::jsonb)`,
    [id,workspaceId,input.owner,plan.policyVersion,input.mode,before,captured,expires,plan.snapshotHash,previewHash,JSON.stringify(summary(plan)),status,receipt && JSON.stringify(receipt),plan.scope?JSON.stringify(plan.scope):null])
  return {id,workspaceId,policyVersion:plan.policyVersion,before:before.toISOString(),capturedAt:captured.toISOString(),expiresAt:expires.toISOString(),previewHash,status,...summary(plan)}
}
export function createCrmRetentionService():CrmRetentionServicePort {
  return {
    async preview(rawContext,rawCommand) {
      const context=CrmOperationsContextSchema.parse(rawContext),command=PreviewCrmRetentionCommandSchema.parse(rawCommand)
      assertCrmOperationsAuthority(context,command)
      const client=await getPool().connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
        await client.query("SET LOCAL statement_timeout='30s'")
        const ownerId=await assertCrmRetentionOwner(client,context),before=new Date(command.before)
        const captured=(await client.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0]!.now
        const plan=await inspectCrmRetention(client,context.workspaceId,before,captured,context)
        const review=await insert(client,{id:randomUUID(),workspaceId:context.workspaceId,owner:ownerId,plan,before,captured,mode:'manual'})
        await renewCrmRetentionScope(context,plan.scope)
        await client.query('COMMIT')
        return {...review,status:review.status as 'ready'|'blocked'}
      }catch(error){await client.query('ROLLBACK').catch(()=>{});return fail(error)}finally{client.release()}
    },
    async execute(rawContext,rawCommand) {
      const context=CrmOperationsContextSchema.parse(rawContext),command=ExecuteCrmRetentionCommandSchema.parse(rawCommand)
      assertCrmOperationsAuthority(context,command)
      const client=await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query("SET LOCAL statement_timeout='30s'")
        await acquireCrmPrivacyAdmission(client,context.workspaceId)
        const ownerId=await assertCrmRetentionOwner(client,context)
        const run=(await client.query<Run>(`SELECT *,expires_at>clock_timestamp() valid FROM crm_retention_runs
          WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND mode='manual' FOR UPDATE`,[context.workspaceId,command.previewId,ownerId])).rows[0]
        if(!run)throw new CrmOperationsError('not_found','The retention preview is unavailable.')
        await assertCrmRetentionScope(client,context,run.scope_snapshot)
        await renewCrmRetentionScope(context,run.scope_snapshot)
        if(run.preview_hash!==command.previewHash)throw conflict('retention_preview_mismatch')
        if(run.status==='completed') {await client.query('COMMIT');return {receipt:run.receipt!,duplicate:true}}
        if(!run.valid)throw conflict('retention_preview_expired')
        if(run.status!=='ready')throw conflict('retention_preview_blocked')
        const plan=await inspectCrmRetention(client,context.workspaceId,run.before_at,run.captured_at,context)
        if(plan.snapshotHash!==run.snapshot_hash || plan.policyVersion!==run.policy_version)throw conflict('retention_preview_stale')
        if(plan.blockers.length)throw conflict('retention_preview_blocked')
        await renewCrmRetentionScope(context,plan.scope)
        const changed=await applyCrmRetention(client,context.workspaceId,plan)
        const receipt={runId:run.id,policyVersion:plan.policyVersion,changed,...summary(plan)}
        const saved=await client.query(`UPDATE crm_retention_runs SET status='completed',receipt=$3::jsonb,completed_at=clock_timestamp()
          WHERE workspace_id=$1 AND id=$2 AND status='ready' AND expires_at>clock_timestamp()`,[context.workspaceId,run.id,JSON.stringify(receipt)])
        if(!saved.rowCount)throw conflict('retention_preview_expired')
        await client.query('COMMIT');return {receipt,duplicate:false}
      }catch(error){await client.query('ROLLBACK').catch(()=>{});return fail(error)}finally{client.release()}
    },
  }
}

/** Same selector/mutator as manual review, authorized by the latest saved policy. */
export async function runScheduledCrmRetention(workspaceId:string):Promise<'completed'|'blocked'|'skipped'|'failed'> {
  const client=await getPool().connect()
  let policyVersion=0,ownerId:string|null=null,captured=new Date()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout='30s'")
    await acquireCrmPrivacyAdmission(client,workspaceId)
    const policy=await readCrmPrivacyPolicy(workspaceId,client)
    if(!policy.policy.retention?.scheduled || !policy.approvedByUserId) {await client.query('COMMIT');return 'skipped'}
    policyVersion=policy.version;ownerId=policy.approvedByUserId
    captured=(await client.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0]!.now
    const recent=await client.query(`SELECT id FROM crm_retention_runs WHERE workspace_id=$1 AND mode='scheduled' AND policy_version=$2
      AND created_at>$3::timestamptz-$4::integer*interval '1 second' LIMIT 1`,[workspaceId,policyVersion,captured,policy.policy.retention.intervalSeconds])
    if(recent.rowCount){await client.query('COMMIT');return 'skipped'}
    // A saved policy is not a durable membership grant. The shared owner gate
    // locks current membership until commit, including for unattended execution.
    const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId:ownerId},
      authority:{role:'owner',canConfigure:true,canWrite:true,trustedIdentitySources:[]}}
    await assertCrmRetentionOwner(client,context)
    const plan=await inspectCrmRetention(client,workspaceId,captured,captured,context)
    await renewCrmRetentionScope(context,plan.scope)
    const changed=plan.blockers.length?undefined:await applyCrmRetention(client,workspaceId,plan)
    await insert(client,{id:randomUUID(),workspaceId,owner:ownerId,plan,before:captured,captured,mode:'scheduled',changed})
    await client.query('COMMIT')
    return plan.blockers.length?'blocked':'completed'
  }catch(error) {
    await client.query('ROLLBACK').catch(()=>{})
    if(error instanceof CrmOperationsError && error.details?.reason==='privacy_operation_busy')return 'skipped'
    // A rollback is not success. The separate audit contains no source error or
    // request payload, and cannot rescue/commit any partial mutation.
    if(ownerId)await query(`INSERT INTO crm_retention_runs(workspace_id,owner_user_id,policy_version,mode,before_at,captured_at,expires_at,
      snapshot_hash,preview_hash,summary,status,error_code,scope_snapshot) VALUES($1,$2,$3,'scheduled',$4,$4,$4::timestamptz+interval '15 minutes',
      repeat('0',64),repeat('0',64),'{}','failed','retention_failed',$5::jsonb)`,[workspaceId,ownerId,policyVersion,captured,JSON.stringify(emptyCrmRetentionScope(workspaceId))]).catch(()=>{})
    return 'failed'
  }finally{client.release()}
}

export async function listCrmRetentionRuns(context:CrmOperationsContext,page:CrmPageQuery) {
  const client=await getPool().connect()
  try {await client.query('BEGIN');await assertCrmRetentionOwner(client,context);await client.query('COMMIT')}
  catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
  return queryCrmPage((sql,params)=>queryWithRLS(context.actor.kind==='user'?context.actor.userId:'',sql,params),{workspaceId:context.workspaceId,resource:'crm-retention-runs',key:'runs',query:page,
    sql:`SELECT id,policy_version,mode,before_at,captured_at,expires_at,summary,status,receipt,error_code,completed_at,created_at AS "createdAt"
      FROM crm_retention_runs WHERE workspace_id=$1 AND EXISTS(SELECT 1 FROM workspace_members
        WHERE workspace_id=$1 AND user_id=$2 AND role IN('owner','admin'))`,
    params:[context.workspaceId,context.actor.kind==='user'?context.actor.userId:null]})
}
