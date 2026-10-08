/** Owner-reviewed CRM erasure through the canonical purge. [COMP:crm/privacy-previews] */
import {createHash,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {
  CrmOperationsContextSchema,CrmOperationsUuidSchema,CrmOperationsError,PreviewCrmContactErasureCommandSchema,
  EraseCrmContactWithPreviewCommandSchema,assertCrmOperationsAuthority,canonicalCrmRequest,
  type ResourceScope,type CrmOperationsContext,type CrmErasurePreview,type CrmPrivacyServicePort,type CrmPrivacyDomainReview,type CrmPrivacyBlocker,
} from '@use-brian/core'
import {assertCrmPrivacySubjectAuthority} from './privacy-subject-authority.js'
import {getPool} from '../db/client.js'
import {createSoftDeleteStore} from '../db/soft-delete-store.js'
import {CRM_PRIVACY_COVERAGE} from './privacy-coverage.js'
import {readCrmPrivacyPolicy} from './privacy-policy.js'
import {prepareCrmPrivacyCopies,inspectCrmPrivacyCopyConflicts} from './privacy-copy-resolver.js'
import {prepareCrmSuppressionPrivacy,assertCrmSuppressionKeyringAvailable} from './suppression-tombstones.js'

const scopeLimits=['unattributed_free_text','other_brain_and_chat','external_storage_and_backups']
const hash=(value:unknown)=>createHash('sha256').update(canonicalCrmRequest(value)).digest('hex')
const conflict=(reason:string)=>new CrmOperationsError('conflict','Review a current CRM erasure preview before proceeding.',{reason})
type PreviewRow={
  scope_snapshot:ResourceScope|null;id:string;owner_user_id:string;subject_id:string|null;request_hash:string;snapshot_hash:string;preview_hash:string;
  policy_version:number;domain_summary:CrmPrivacyDomainReview[];blockers:CrmPrivacyBlocker[];
  status:'ready'|'blocked'|'consumed';expires_at:Date;valid:boolean;receipt:Record<string,unknown>|null
}
async function authorize(client:PoolClient,context:CrmOperationsContext):Promise<string> {
  if(context.actor.kind!=='user' || !context.authority.canConfigure || !context.authority.canWrite
    || !['owner','admin'].includes(context.authority.role))throw new CrmOperationsError('not_authorized','CRM erasure requires an owner/admin member session.')
  const role=await client.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[context.workspaceId,context.actor.userId])
  if(!['owner','admin'].includes(role.rows[0]?.role))throw new CrmOperationsError('not_authorized','Current owner/admin membership is required.')
  return context.actor.userId
}
const actions:Record<string,CrmPrivacyDomainReview['action']>={
  entities:'delete',crm_activities:'delete',entity_external_identities:'delete',entity_merges:'delete',
  crm_identity_bindings:'delete',crm_entity_separations:'delete',crm_deal_contacts:'delete',
  association_external_identities:'delete',association_enquiries:'delete',association_enquiry_notes:'delete',
  association_consent_events:'delete',crm_suppression_events:'delete',association_memberships:'delete',
  association_membership_offline_rescues:'delete',
  association_registrations:'redact',correction_audit:'redact',crm_delivery_receipts:'redact',
  crm_delivery_receipt_contacts:'delete',crm_intake_idempotency:'retire',crm_import_errors:'redact',crm_import_rows:'redact',
  association_audit_log:'redact',workspace_audit_log:'redact',
  brain_row_versions:'redact',
  // These are explicit implementation gaps, not successful partial erasure.
  tasks:'delete',entity_links:'delete',crm_segments:'blocked',workspace_files:'blocked',crm_import_sources:'retire',crm_import_jobs:'retire',crm_import_chunks:'delete',
  crm_email_drafts:'delete',crm_email_draft_versions:'delete',crm_email_draft_session_anchors:'delete',
  decision_events:'blocked',decision_applications:'blocked',decision_derivations:'blocked',
  association_notification_outbox:'retire',crm_domain_event_outbox:'retire',
  workflow_runs:'retire',workflow_step_runs:'delete',workflow_run_copy_sources:'retain',
}
async function inspect(client:PoolClient,workspaceId:string,contactId:string) {
  const person=await client.query("SELECT id FROM entities WHERE workspace_id=$1 AND id=$2 AND kind='person'",[workspaceId,contactId])
  if(!person.rowCount)throw new CrmOperationsError('not_found','The CRM contact is unavailable.')
  const policy=await readCrmPrivacyPolicy(workspaceId,client),domains:CrmPrivacyDomainReview[]=[],blockers:CrmPrivacyBlocker[]=[]
  await prepareCrmPrivacyCopies(client,workspaceId,contactId)
  blockers.push(...await inspectCrmPrivacyCopyConflicts(client,workspaceId,contactId))
  const digest=createHash('sha256')
  await client.query('SAVEPOINT suppression_preview')
  try {
    await prepareCrmSuppressionPrivacy(client,workspaceId,contactId)
    await client.query('RELEASE SAVEPOINT suppression_preview')
  }catch(error) {
    await client.query('ROLLBACK TO SAVEPOINT suppression_preview')
    if(!(error instanceof CrmOperationsError))throw error
    blockers.push({domain:'crm_address_suppression_tombstones',reason:String(error.details?.reason ?? 'suppression_unavailable'),count:1})
    await client.query('CREATE TEMP TABLE crm_privacy_suppression_matches(channel text,key_version text,address_hmac text) ON COMMIT DROP')
  }
  for(const entry of CRM_PRIVACY_COVERAGE) {
    if(!entry.subjectWhere || entry.domain==='crm_privacy_previews')continue
    const action=actions[entry.domain] ?? 'retain'
    let count=0
    // A redacted export deliberately omits data that must still invalidate an
    // approval. Hash physical row identity/version, without copying its payload.
    const importCopyPredicate = entry.domain==='crm_import_jobs' ? 't.id IN(SELECT id FROM pg_temp.crm_privacy_copy_import_jobs)'
      : ['crm_import_chunks','crm_import_rows','crm_import_errors'].includes(entry.domain) ? 't.job_id IN(SELECT id FROM pg_temp.crm_privacy_copy_import_jobs)' : null
    const reviewPredicate = importCopyPredicate ? `(${entry.subjectWhere}) OR (${importCopyPredicate})` : entry.subjectWhere
    const sql="WITH preview_args AS (SELECT $1::uuid workspace_id,$2::uuid contact_id) SELECT jsonb_build_array("+entry.orderBy+",t.xmin::text)::text AS version FROM "+entry.domain+" t WHERE "+(entry.workspacePredicate ?? 't.workspace_id=$1')+" AND ("+reviewPredicate+") ORDER BY "+entry.orderBy
    await client.query('DECLARE privacy_preview_rows NO SCROLL CURSOR FOR '+sql,[workspaceId,contactId])
    for(;;) {
      const rows=(await client.query<{version:string}>('FETCH FORWARD 256 FROM privacy_preview_rows')).rows
      if(!rows.length)break
      for(const row of rows){digest.update(entry.domain+'\0'+row.version+'\n');count++}
    }
    await client.query('CLOSE privacy_preview_rows')
    domains.push({domain:entry.domain,action,count})
    if(action==='blocked'&&count)blockers.push({domain:entry.domain,reason:'crm_copy_resolution_required',count})
  }
  const financial=(await client.query<{orders:number;lines:number;rescues:number}>(`SELECT
    (SELECT count(*)::int FROM association_orders WHERE workspace_id=$1 AND contact_id=$2) orders,
    (SELECT count(*)::int FROM association_order_lines l JOIN association_memberships m ON m.workspace_id=l.workspace_id AND m.id=l.eligible_membership_id WHERE l.workspace_id=$1 AND m.contact_id=$2) lines,
    (SELECT count(*)::int FROM association_membership_offline_rescues WHERE workspace_id=$1 AND contact_id=$2 AND status IN('settled','reversed')) rescues`,[workspaceId,contactId])).rows[0]!
  if(financial.orders)blockers.push({domain:'association_orders',reason:'financial_retention_dependency',count:financial.orders})
  if(financial.lines)blockers.push({domain:'association_order_lines',reason:'financial_retention_dependency',count:financial.lines})
  if(financial.rescues)blockers.push({domain:'association_membership_offline_rescues',reason:'financial_retention_dependency',count:financial.rescues})
  const unbound=(await client.query(`SELECT count(*)::int count FROM crm_intake_idempotency
    WHERE workspace_id=$1 AND contact_id=$2 AND status='committed' AND replay_policy_version IS NULL`,[workspaceId,contactId])).rows[0].count
  if(unbound&&!policy.policy.intakeReplay)blockers.push({domain:'crm_intake_idempotency',reason:'intake_replay_policy_unconfigured',count:unbound})
  const suppression=(await client.query(`SELECT
    (SELECT count(*) FROM (SELECT DISTINCT ON(purpose) action FROM association_consent_events WHERE workspace_id=$1 AND contact_id=$2 ORDER BY purpose,occurred_at DESC,created_at DESC,id DESC) c WHERE action='withdrawn')
    +(SELECT count(*) FROM (SELECT DISTINCT ON(channel) action FROM crm_suppression_events WHERE workspace_id=$1 AND contact_id=$2 ORDER BY channel,occurred_at DESC,created_at DESC,id DESC) s WHERE action='suppressed') AS count`,[workspaceId,contactId])).rows[0].count
  if(Number(suppression)>0) {
    if(!policy.policy.addressSuppression)blockers.push({domain:'crm_address_suppression_tombstones',reason:'suppression_policy_unconfigured',count:Number(suppression)})
    try{assertCrmSuppressionKeyringAvailable()}catch(error) {
      if(!(error instanceof CrmOperationsError))throw error
      blockers.push({domain:'crm_address_suppression_tombstones',reason:String(error.details?.reason),count:1})
    }
  }
  digest.update(canonicalCrmRequest({schema:'crm-erasure-review-v1',scopeLimits,policyVersion:policy.version,policy:policy.policy,domains,blockers}))
  return {policyVersion:policy.version,domains,blockers,snapshotHash:digest.digest('hex')}
}
function sanitizeFailure(error:unknown):never {
  if(error instanceof CrmOperationsError)throw error
  if(error && typeof error==='object' && 'code' in error && error.code==='row_not_found')throw conflict('privacy_preview_stale')
  if(error && typeof error==='object' && 'code' in error && error.code==='55P03')throw conflict('privacy_operation_busy')
  throw conflict('privacy_review_failed')
}
/** Renew disclosure authority without creating a review or repeating its mutation. */
export async function readCrmErasureReview(rawContext:CrmOperationsContext,rawPreviewId:string):Promise<{preview:CrmErasurePreview|null;receipt:Record<string,unknown>|null}> {
  const context=CrmOperationsContextSchema.parse(rawContext),previewId=CrmOperationsUuidSchema.parse(rawPreviewId)
  const client=await getPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await client.query("SET LOCAL statement_timeout='30s'")
    const owner=await authorize(client,context)
    const row=(await client.query<PreviewRow>(`SELECT scope_snapshot,id,owner_user_id,subject_id,request_hash,snapshot_hash,preview_hash,policy_version,domain_summary,blockers,status,expires_at,expires_at>clock_timestamp() AS valid,receipt
      FROM crm_privacy_previews WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3`,[context.workspaceId,previewId,owner])).rows[0]
    if(!row)throw new CrmOperationsError('not_found','The erasure preview is unavailable.')
    if(row.status!=='consumed'&&!row.subject_id)throw conflict('privacy_preview_stale')
    await assertCrmPrivacySubjectAuthority(client,context,row.subject_id ?? '',row.scope_snapshot,row.status==='consumed')
    const preview:CrmErasurePreview|null=row.status==='consumed'?null:{
      id:row.id,workspaceId:context.workspaceId,contactId:row.subject_id!,previewHash:row.preview_hash,
      expiresAt:row.expires_at.toISOString(),policyVersion:row.policy_version,domains:row.domain_summary,
      blockers:row.blockers,scopeLimits:[...scopeLimits],status:row.status,
    }
    await client.query('COMMIT')
    return {preview,receipt:row.status==='consumed'?row.receipt:null}
  }catch(error){await client.query('ROLLBACK').catch(()=>{});return sanitizeFailure(error)}
  finally{client.release()}
}
export function createCrmPrivacyService():CrmPrivacyServicePort {
  return {
    async preview(rawContext,rawCommand) {
      const context=CrmOperationsContextSchema.parse(rawContext),command=PreviewCrmContactErasureCommandSchema.parse(rawCommand)
      assertCrmOperationsAuthority(context,command)
      const client=await getPool().connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
        await client.query("SET LOCAL statement_timeout='30s'")
        const owner=await authorize(client,context)
        const scope=await assertCrmPrivacySubjectAuthority(client,context,command.contactId)
        const review=await inspect(client,context.workspaceId,command.contactId)
        const stamp=(await client.query<{createdAt:Date;expiresAt:Date}>("SELECT t AS \"createdAt\",t+interval '15 minutes' AS \"expiresAt\" FROM (SELECT clock_timestamp() t) s")).rows[0]!
        const id=randomUUID(),requestHash=hash({contactId:command.contactId}),status=review.blockers.length?'blocked':'ready'
        const previewHash=hash({id,workspaceId:context.workspaceId,owner,requestHash,snapshotHash:review.snapshotHash,expiresAt:stamp.expiresAt.toISOString()})
        await client.query(`INSERT INTO crm_privacy_previews(id,workspace_id,owner_user_id,subject_id,request_hash,snapshot_hash,preview_hash,policy_version,domain_summary,blockers,status,created_at,expires_at,scope_snapshot)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14::jsonb)`,
          [id,context.workspaceId,owner,command.contactId,requestHash,review.snapshotHash,previewHash,review.policyVersion,JSON.stringify(review.domains),JSON.stringify(review.blockers),status,stamp.createdAt,stamp.expiresAt,JSON.stringify(scope)])
        await assertCrmPrivacySubjectAuthority(client,context,command.contactId,scope)
        await client.query('COMMIT')
        return {id,workspaceId:context.workspaceId,contactId:command.contactId,previewHash,expiresAt:stamp.expiresAt.toISOString(),policyVersion:review.policyVersion,domains:review.domains,blockers:review.blockers,scopeLimits:[...scopeLimits],status}
      }catch(error){await client.query('ROLLBACK').catch(()=>{});return sanitizeFailure(error)}
      finally{client.release()}
    },
    async erase(rawContext,rawCommand) {
      const context=CrmOperationsContextSchema.parse(rawContext),command=EraseCrmContactWithPreviewCommandSchema.parse(rawCommand)
      assertCrmOperationsAuthority(context,command)
      let preview:PreviewRow|undefined,receipt:Record<string,unknown>|undefined,duplicate=false
      const store=createSoftDeleteStore({
        async prepareHardPurge(client) {
          await client.query("SET LOCAL statement_timeout='30s'")
          const owner=await authorize(client,context)
          preview=(await client.query<PreviewRow>(`SELECT scope_snapshot,id,owner_user_id,subject_id,request_hash,snapshot_hash,preview_hash,policy_version,domain_summary,blockers,status,expires_at,expires_at>clock_timestamp() AS valid,receipt
            FROM crm_privacy_previews WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE`,[context.workspaceId,command.previewId,owner])).rows[0]
          if(!preview)throw new CrmOperationsError('not_found','The erasure preview is unavailable.')
          if(preview.preview_hash!==command.previewHash || preview.request_hash!==hash({contactId:command.contactId}))throw conflict('privacy_preview_mismatch')
          await assertCrmPrivacySubjectAuthority(client,context,command.contactId,preview.scope_snapshot,preview.status==='consumed')
          if(preview.status==='consumed'){receipt=preview.receipt!;duplicate=true;return 'skip'}
          if(!preview.valid)throw conflict('privacy_preview_expired')
          if(preview.status==='blocked')throw conflict('privacy_preview_blocked')
        },
        async validateHardPurge(client) {
          await assertCrmPrivacySubjectAuthority(client,context,command.contactId,preview!.scope_snapshot)
          const review=await inspect(client,context.workspaceId,command.contactId)
          if(review.snapshotHash!==preview!.snapshot_hash || review.policyVersion!==preview!.policy_version)throw conflict('privacy_preview_stale')
          if(review.blockers.length)throw conflict('privacy_preview_blocked')
          await assertCrmPrivacySubjectAuthority(client,context,command.contactId,preview!.scope_snapshot)
          const result=await client.query<{receipt:Record<string,unknown>}>(`UPDATE crm_privacy_previews
            SET status='consumed',subject_id=NULL,consumed_at=clock_timestamp(),
              receipt=jsonb_build_object('previewId',id,'status','crm_contact_purged','scope','crm_contact','scopeLimits',$3::jsonb,'completedAt',clock_timestamp())
            WHERE workspace_id=$1 AND id=$2 AND status='ready' AND expires_at>clock_timestamp() RETURNING receipt`,[context.workspaceId,command.previewId,JSON.stringify(scopeLimits)])
          if(!result.rowCount)throw conflict('privacy_preview_expired')
          receipt=result.rows[0]!.receipt
        },
      })
      try {
        // The canonical person purge ignores caller-supplied snapshot content
        // and writes only an erased marker. Its locked target read is authoritative.
        await store.applyHardPurge({primitive:'contact',workspaceId:context.workspaceId,rowId:command.contactId,
          actorUserId:context.actor.kind==='user'?context.actor.userId:'',reason:'Reviewed CRM erasure',ticketReference:null,
          snapshot:{primitive:'contact',workspaceId:context.workspaceId,rowId:command.contactId,validTo:null,retractedAt:null,createdByUserId:null},now:new Date()})
        if(!receipt)throw conflict('privacy_receipt_unavailable')
        return {receipt,duplicate}
      }catch(error){return sanitizeFailure(error)}
    },
  }
}
