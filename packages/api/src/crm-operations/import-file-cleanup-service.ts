/** Reviewed, durable cleanup of an attributable staged import file. [COMP:crm/file-cleanup] */
import {createHash,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {CrmOperationsContextSchema,CrmOperationsError,PreviewCrmImportFileCleanupCommandSchema,ExecuteCrmImportFileCleanupCommandSchema,
  assertCrmOperationsAuthority,canonicalCrmRequest,type CrmOperationsContext,type CrmImportFileCleanupPort,type ResourceScope} from '@use-brian/core'
import {readCrmFileCleanupAuthority,renewCrmFileCleanupAuthority} from './import-file-cleanup-authority.js'
import {getPool} from '../db/client.js'
import {acquireCrmPrivacyAdmission} from './privacy-admission.js'
import {inspectCrmImportFileCleanup,deleteCrmStagedFileIndex} from './import-file-cleanup-store.js'

const conflict=(reason:string)=>new CrmOperationsError('conflict','Review the current source file and cleanup policy before proceeding.',{reason})
async function owner(client:PoolClient,context:CrmOperationsContext):Promise<string> {
  if(context.actor.kind!=='user' || !context.authority.canConfigure || !context.authority.canWrite || !['owner','admin'].includes(context.authority.role))
    throw new CrmOperationsError('not_authorized','Source cleanup requires an owner/admin member session.')
  const role=(await client.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[context.workspaceId,context.actor.userId])).rows[0]?.role
  if(!['owner','admin'].includes(role))throw new CrmOperationsError('not_authorized','Current owner/admin membership is required.')
  return context.actor.userId
}
type Cleanup={scope_snapshot:ResourceScope|null;id:string;file_id:string;policy_version:number;before_at:Date;expires_at:Date;snapshot_hash:string;preview_hash:string;
  summary:Record<string,unknown>;status:string;valid:boolean;attempts:number;error_code:string|null;queued_at:Date|null;completed_at:Date|null;replay_expires_at:Date|null}
function receipt(row:Cleanup) {return {id:row.id,fileId:row.file_id,policyVersion:row.policy_version,status:row.status,attempts:row.attempts,
  errorCode:row.error_code,queuedAt:row.queued_at?.toISOString() ?? null,completedAt:row.completed_at?.toISOString() ?? null,
  replayExpiresAt:row.replay_expires_at?.toISOString() ?? null,...row.summary}}
async function transaction<T>(fn:(client:PoolClient)=>Promise<T>,snapshot=false):Promise<T> {
  const client=await getPool().connect()
  try {await client.query(snapshot?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');await client.query("SET LOCAL statement_timeout='30s'")
    const value=await fn(client);await client.query('COMMIT');return value
  }catch(error){await client.query('ROLLBACK').catch(()=>{});if(error instanceof CrmOperationsError)throw error;throw conflict('file_cleanup_failed')}
  finally{client.release()}
}
export function createCrmImportFileCleanupService():CrmImportFileCleanupPort {
  return {
    async preview(rawContext,rawCommand) {
      const context=CrmOperationsContextSchema.parse(rawContext),command=PreviewCrmImportFileCleanupCommandSchema.parse(rawCommand)
      assertCrmOperationsAuthority(context,command)
      return transaction(async client=>{
        const ownerId=await owner(client,context),before=new Date(command.before)
        const now=(await client.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0]!.now
        if(before>now)throw new CrmOperationsError('invalid_input','The cleanup cutoff cannot be in the future.')
        const scope=await readCrmFileCleanupAuthority(client,context,command.fileId)
        const plan=await inspectCrmImportFileCleanup(client,context.workspaceId,command.fileId,before)
        const id=randomUUID(),expiresAt=new Date(now.getTime()+15*60_000).toISOString(),status=plan.blockers.length?'blocked' as const:'ready' as const
        const summary={domains:plan.domains,blockers:plan.blockers,scope:'crm_import_source_file' as const}
        const previewHash=createHash('sha256').update(canonicalCrmRequest({id,workspaceId:context.workspaceId,ownerId,snapshotHash:plan.snapshotHash,expiresAt,scope})).digest('hex')
        await renewCrmFileCleanupAuthority(context,scope)
        await client.query(`INSERT INTO crm_import_file_cleanups(id,workspace_id,owner_user_id,file_id,before_at,policy_version,snapshot_hash,preview_hash,summary,status,expires_at,scope_snapshot)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb)`,[id,context.workspaceId,ownerId,command.fileId,before,plan.policyVersion,plan.snapshotHash,previewHash,JSON.stringify(summary),status,expiresAt,scope?JSON.stringify(scope):null])
        return {id,fileId:command.fileId,previewHash,expiresAt,policyVersion:plan.policyVersion,status,...summary}
      },true)
    },
    async execute(rawContext,rawCommand) {
      const context=CrmOperationsContextSchema.parse(rawContext),command=ExecuteCrmImportFileCleanupCommandSchema.parse(rawCommand)
      assertCrmOperationsAuthority(context,command)
      return transaction(async client=>{
        await acquireCrmPrivacyAdmission(client,context.workspaceId)
        const ownerId=await owner(client,context)
        const row=(await client.query<Cleanup>(`SELECT *,expires_at>clock_timestamp() valid FROM crm_import_file_cleanups
          WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE`,[context.workspaceId,command.previewId,ownerId])).rows[0]
        if(!row)throw new CrmOperationsError('not_found','The file cleanup preview is unavailable.')
        const scope=await readCrmFileCleanupAuthority(client,context,row.file_id,row.scope_snapshot,!!row.queued_at)
        await renewCrmFileCleanupAuthority(context,scope)
        if(row.preview_hash!==command.previewHash)throw conflict('file_cleanup_preview_mismatch')
        if(row.queued_at)return {receipt:receipt(row),duplicate:true}
        if(!row.valid)throw conflict('file_cleanup_preview_expired')
        if(row.status!=='ready')throw conflict('file_cleanup_preview_blocked')
        const plan=await inspectCrmImportFileCleanup(client,context.workspaceId,row.file_id,row.before_at)
        if(plan.snapshotHash!==row.snapshot_hash || plan.policyVersion!==row.policy_version)throw conflict('file_cleanup_preview_stale')
        if(plan.blockers.length || !plan.file || !plan.retentionSeconds)throw conflict('file_cleanup_preview_blocked')
        await renewCrmFileCleanupAuthority(context,scope)
        await deleteCrmStagedFileIndex(client,context.workspaceId,plan)
        const queued=(await client.query<Cleanup>(`UPDATE crm_import_file_cleanups SET status='queued',storage_uri=$3,
          queued_at=statement_timestamp(),replay_expires_at=statement_timestamp()+$4::integer*interval '1 second'
          WHERE workspace_id=$1 AND id=$2 AND expires_at>clock_timestamp() RETURNING *`,[context.workspaceId,row.id,plan.file.storage_uri,plan.retentionSeconds])).rows[0]
        if(!queued)throw conflict('file_cleanup_preview_expired')
        return {receipt:receipt(queued),duplicate:false}
      })
    },
    async read(rawContext,id) {
      const context=CrmOperationsContextSchema.parse(rawContext)
      return transaction(async client=>{
        await owner(client,context)
        const row=(await client.query<Cleanup>('SELECT * FROM crm_import_file_cleanups WHERE workspace_id=$1 AND id=$2',[context.workspaceId,id])).rows[0]
        if(!row)throw new CrmOperationsError('not_found','The file cleanup receipt is unavailable.')
        const scope=await readCrmFileCleanupAuthority(client,context,row.file_id,row.scope_snapshot,!!row.queued_at)
        await renewCrmFileCleanupAuthority(context,scope)
        return receipt(row)
      })
    },
  }
}
