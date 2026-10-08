/** Exact affected-set selection and mutation. [COMP:crm/retention] */
import {captureCrmErasure} from './erasure-journal.js'
import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {canonicalCrmRequest,type CrmPrivacyDomainReview,type CrmPrivacyBlocker,type CrmRetentionPolicy,type CrmOperationsContext,type ResourceScope} from '@use-brian/core'
import {readCrmPrivacyPolicy,retireCrmIntakeReceipts} from './privacy-policy.js'

import {createCrmRetentionAuthority} from './retention-authority.js'

const LIMIT=500
const REDACTED='Removed by retention policy'
export type CrmRetentionPlan={
  scope:ResourceScope|null;evaluatedAt:Date;policyVersion:number;domains:CrmPrivacyDomainReview[];blockers:CrmPrivacyBlocker[];hasMore:boolean;
  cutoffs:Record<string,string|null>;snapshotHash:string;retainedCopies:string[];
  targets:Record<string,string[]>;policy:CrmRetentionPolicy|null
}
export async function inspectCrmRetention(client:PoolClient,workspaceId:string,before:Date,capturedAt:Date,context:CrmOperationsContext):Promise<CrmRetentionPlan> {
  const authority=await createCrmRetentionAuthority(client,context)
  const approved=await readCrmPrivacyPolicy(workspaceId,client),policy=approved.policy.retention ?? null
  const plan:CrmRetentionPlan={scope:null,evaluatedAt:capturedAt,policyVersion:approved.version,domains:[],blockers:[],hasMore:false,cutoffs:{},snapshotHash:'',targets:{},policy,
    retainedCopies:['canonical_contacts','unattributed_free_text','independent_task_import_delivery_copies','external_storage_and_backups']}
  const digest=createHash('sha256')
  function cutoff(name:string,seconds:number|null|undefined) {
    const value=seconds==null?null:new Date(Math.min(before.getTime(),capturedAt.getTime()-seconds*1000)).toISOString()
    plan.cutoffs[name]=value;return value
  }
  if(!policy)plan.blockers.push({domain:'crm_privacy_policies',reason:'retention_policy_unconfigured',count:1})
  const holds=(domain:string)=>policy?.holds.filter(h=>h.domain===domain).map(h=>h.id) ?? []
  const contactHolds=holds('contact'),submissionHolds=holds('submission')
  const sourceHolds=approved.policy.importSourceErasure?.heldSourceIds ?? []
  // Each selection includes held/dependent records in its signature and report,
  // but only eligible identities enter the mutation set. All SQL is internal.
  async function select(key:string,domain:string,action:CrmPrivacyDomainReview['action'],sql:string,params:unknown[]) {
    const unbounded=sql.replace(/ORDER BY [\s\S]*$/, '')
    // One cursor snapshot supplies authority, counts and selected identities.
    // A second query could count or select a newly inserted, unchecked row.
    type Candidate={id:string;version:string;retained:boolean}
    const rows:Candidate[]=[],counts={retained:0,eligible:0}
    await client.query('DECLARE retention_authority NO SCROLL CURSOR FOR SELECT * FROM ('+unbounded+') candidates ORDER BY retained,id',params)
    for(;;) {
      const page=(await client.query<Candidate>('FETCH FORWARD 256 FROM retention_authority')).rows
      if(!page.length)break
      for(const row of page) {
        await authority.capture(domain,row.id)
        counts[row.retained?'retained':'eligible']++
        if(rows.length<LIMIT)rows.push(row)
      }
    }
    await client.query('CLOSE retention_authority')
    if(counts.eligible>LIMIT)plan.hasMore=true
    digest.update(canonicalCrmRequest({key,counts}))
    digest.update(canonicalCrmRequest({key,rows}))
    plan.targets[key]=rows.filter(r=>!r.retained).map(r=>r.id)
    const retained=counts.retained
    plan.domains.push({domain,action,count:plan.targets[key]!.length})
    if(retained)plan.domains.push({domain,action:'retain',count:retained})
  }
  const resolved=cutoff('resolvedSubmissions',policy?.resolvedSubmissionsSeconds)
  if(resolved)await select('submissions','association_enquiries','delete',`SELECT q.id,q.xmin::text version,
    (q.id=ANY($3::uuid[]) OR q.contact_id=ANY($4::uuid[]) OR q.follow_up_task_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM crm_import_rows r WHERE r.workspace_id=q.workspace_id AND r.entity_id=q.contact_id)
      OR EXISTS(SELECT 1 FROM crm_domain_event_outbox e WHERE e.workspace_id=q.workspace_id
        AND (e.subject_id=q.id OR e.payload->>'submissionId'=q.id::text OR e.payload->>'enquiryId'=q.id::text))
      OR EXISTS(SELECT 1 FROM association_notification_outbox e WHERE e.workspace_id=q.workspace_id AND e.source_id=q.id)
      OR EXISTS(SELECT 1 FROM decision_events e WHERE e.workspace_id=q.workspace_id AND e.source_id=q.id::text)
    ) retained FROM association_enquiries q WHERE q.workspace_id=$1 AND q.status IN('resolved','spam') AND q.updated_at<$2
    ORDER BY q.id LIMIT 501`,[workspaceId,resolved,submissionHolds,contactHolds])
  const open=cutoff('openSubmissions',policy?.openSubmissions?.afterSeconds)
  const openRedactionFields=policy?.openSubmissions?.fields ?? []
  if(open && policy?.openSubmissions) {
    const nonempty=openRedactionFields.map(field=>field==='notes'
      ? 'EXISTS(SELECT 1 FROM association_enquiry_notes n WHERE n.workspace_id=q.workspace_id AND n.enquiry_id=q.id)'
      : field==='metadata'?"q.submitted_data<>'{}'::jsonb":`q.${field}<>$5`).join(' OR ')
    await select('open','association_enquiries','redact',`SELECT q.id,q.xmin::text version,
      (q.id=ANY($3::uuid[]) OR q.contact_id=ANY($4::uuid[])) retained
      FROM association_enquiries q WHERE q.workspace_id=$1 AND q.status IN('new','in_progress')
        AND q.updated_at<$2 AND $5::text IS NOT NULL AND (${nonempty}) ORDER BY q.id LIMIT 501`,[workspaceId,open,submissionHolds,contactHolds,REDACTED])
  }
  const imports=cutoff('importReceipts',policy?.importReceiptsSeconds)
  if(imports) {
    await select('imports','crm_import_jobs','delete',`SELECT j.id,j.xmin::text version,
      (j.staged_file_id IS NOT NULL OR j.source_id=ANY($3::uuid[]) OR EXISTS(SELECT 1 FROM crm_import_sources s
        WHERE s.workspace_id=j.workspace_id AND s.id=j.source_id AND NOT s.privacy_erased)
        OR EXISTS(SELECT 1 FROM crm_import_rows r WHERE r.workspace_id=j.workspace_id AND r.job_id=j.id AND r.entity_id=ANY($4::uuid[]))) retained
      FROM crm_import_jobs j WHERE j.workspace_id=$1 AND j.status IN('completed','failed','cancelled') AND j.updated_at<$2
      ORDER BY j.id LIMIT 501`,[workspaceId,imports,sourceHolds,contactHolds])
    await select('sources','crm_import_sources','delete',`SELECT s.id,s.xmin::text version,
      (s.id=ANY($3::uuid[]) OR EXISTS(SELECT 1 FROM crm_import_jobs j WHERE j.workspace_id=s.workspace_id AND j.source_id=s.id
        AND NOT(j.id=ANY($4::uuid[])))) retained
      FROM crm_import_sources s WHERE s.workspace_id=$1 AND s.privacy_erased AND s.replay_expires_at<=$2
      ORDER BY s.id LIMIT 501`,[workspaceId,capturedAt,sourceHolds,plan.targets.imports ?? []])
  }
  await select('fileCleanups','crm_import_file_cleanups','delete',`SELECT id,xmin::text version,false retained
    FROM crm_import_file_cleanups WHERE workspace_id=$1 AND ((status='completed' AND replay_expires_at<=$2)
      OR (status IN('ready','blocked') AND expires_at<=$2)) ORDER BY id LIMIT 501`,[workspaceId,capturedAt])
  const delivery=cutoff('deliveryReceipts',policy?.deliveryReceiptsSeconds)
  if(delivery) {
    await select('deliveries','crm_delivery_receipts','redact',`SELECT r.delivery_id id,r.xmin::text version,
      (r.status NOT IN('sent','blocked','failed') OR r.scope_snapshot IS NULL OR EXISTS(SELECT 1 FROM crm_delivery_receipt_contacts c
        WHERE c.workspace_id=r.workspace_id AND c.delivery_id=r.delivery_id AND c.contact_id=ANY($3::uuid[]))) retained
      FROM crm_delivery_receipts r WHERE r.workspace_id=$1 AND r.updated_at<$2 AND r.redacted_at IS NULL
      ORDER BY r.delivery_id LIMIT 501`,[workspaceId,delivery,contactHolds])
    await select('events','crm_domain_event_outbox','delete',`SELECT e.id,e.xmin::text version,
      (e.status<>'delivered' OR e.subject_id=ANY($3::uuid[]) OR e.payload->>'contactId'=ANY($3::text[])
        OR EXISTS(SELECT 1 FROM workflow_runs r WHERE r.workspace_id=e.workspace_id AND r.crm_event_id=e.id)
        OR EXISTS(SELECT 1 FROM goal_crm_event_sources g WHERE g.workspace_id=e.workspace_id AND g.event_id=e.id)
        OR EXISTS(SELECT 1 FROM association_enquiries q WHERE q.workspace_id=e.workspace_id AND q.id=e.subject_id AND q.contact_id=ANY($3::uuid[]))) retained
      FROM crm_domain_event_outbox e WHERE e.workspace_id=$1 AND e.created_at<$2 ORDER BY e.id LIMIT 501`,[workspaceId,delivery,contactHolds])
  }
  if(policy) {
    await select('intake','crm_intake_idempotency','delete',`SELECT id,xmin::text version,false retained FROM crm_intake_idempotency
      WHERE workspace_id=$1 AND status='retired' AND replay_expires_at<=$2 ORDER BY id LIMIT 501`,[workspaceId,capturedAt])
    await select('tombstones','crm_address_suppression_tombstones','delete',`SELECT id,xmin::text version,false retained
      FROM crm_address_suppression_tombstones WHERE workspace_id=$1 AND expires_at<=$2 ORDER BY id LIMIT 501`,[workspaceId,capturedAt])
  }
  // Financial/audit evidence is not an automatically disposable receipt. Report
  // the configured horizon and retained set until a domain-specific resolution.
  for(const [name,domain,seconds] of [
    ['audit','association_audit_log',policy?.auditSeconds],['financialRecords','association_orders',policy?.financialRecordsSeconds],
    ['membershipRescueFinancialRecords','association_membership_offline_rescues',policy?.financialRecordsSeconds],
  ] as const) {
    const date=cutoff(name,seconds)
    if(date)await select(name,domain,'retain',`SELECT id,xmin::text version,true retained FROM ${domain}
      WHERE workspace_id=$1 AND created_at<$2 ORDER BY id LIMIT 501`,[workspaceId,date])
  }
  // Hash child records too: counts alone cannot authorize changed note content,
  // replay state or newly added consumer attribution. Cursor bounds memory.
  const children:[string,string,string[]][]=[
    ['association_audit_log','subject_id',plan.targets.submissions ?? []],
    ['workspace_audit_log','subject_id',plan.targets.submissions ?? []],
    ['association_enquiry_notes','enquiry_id',[...(plan.targets.submissions ?? []),...(plan.targets.open ?? [])]],
    ['association_submission_attachments','submission_id',[...(plan.targets.submissions ?? []),
      ...(openRedactionFields.includes('metadata') ? (plan.targets.open ?? []) : [])]],
    ['crm_intake_idempotency','submission_id',plan.targets.submissions ?? []],
    ['crm_import_rows','job_id',plan.targets.imports ?? []],
    ['crm_import_chunks','job_id',plan.targets.imports ?? []],
    ['crm_import_errors','job_id',plan.targets.imports ?? []],
  ]
  for(const [table,column,ids] of children) {
    if(!ids.length)continue
    const isAudit=table.endsWith('audit_log')
    let audited=0
    await client.query(`DECLARE retention_versions NO SCROLL CURSOR FOR SELECT id,xmin::text version FROM ${table}
      WHERE workspace_id=$1 AND ${column}=ANY($2::uuid[]) ORDER BY id`,[workspaceId,ids])
    for(;;) {
      const rows=(await client.query('FETCH FORWARD 256 FROM retention_versions')).rows
      if(!rows.length)break
      audited+=rows.length
      for(const row of rows)digest.update(canonicalCrmRequest({table,row}))
    }
    await client.query('CLOSE retention_versions')
    if(isAudit)plan.domains.push({domain:table,action:'redact',count:audited})
    if(table==='association_submission_attachments'&&audited)plan.domains.push({domain:table,action:'delete',count:audited})
  }
  if(plan.targets.submissions?.length && !approved.policy.intakeReplay) {
    const missing=await client.query<{count:number}>(`SELECT count(*)::int count FROM crm_intake_idempotency
      WHERE workspace_id=$1 AND status='committed' AND submission_id=ANY($2::uuid[]) AND replay_policy_version IS NULL`,[workspaceId,plan.targets.submissions])
    if(missing.rows[0]?.count)plan.blockers.push({domain:'crm_intake_idempotency',reason:'intake_replay_policy_unconfigured',count:missing.rows[0].count})
  }
  plan.scope=authority.scope()
  digest.update(canonicalCrmRequest({scope:plan.scope,policy:approved.policy,version:approved.version,domains:plan.domains,blockers:plan.blockers,
    before:before.toISOString(),capturedAt:capturedAt.toISOString(),cutoffs:plan.cutoffs,hasMore:plan.hasMore}))
  plan.snapshotHash=digest.digest('hex')
  return plan
}

/** Called only after current review/policy validation under exclusive admission. */
export async function applyCrmRetention(client:PoolClient,workspaceId:string,plan:CrmRetentionPlan):Promise<Record<string,number>> {
  await captureCrmErasure(client)
  const changed:Record<string,number>={}
  async function apply(key:string,sql:string,values:unknown[]=[]) {
    const ids=plan.targets[key] ?? [];if(!ids.length)return
    changed[key]=(await client.query(sql,[workspaceId,ids,...values])).rowCount ?? 0
  }
  if(plan.targets.submissions?.length) {
    await client.query('SELECT id FROM association_enquiries WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[workspaceId,plan.targets.submissions])
    await retireCrmIntakeReceipts(client,workspaceId,{submissionIds:plan.targets.submissions},plan.evaluatedAt)
    changed.associationAudit=(await client.query("UPDATE association_audit_log SET metadata=jsonb_build_object('retentionRedacted',true) WHERE workspace_id=$1 AND subject_id=ANY($2::uuid[])",[workspaceId,plan.targets.submissions])).rowCount ?? 0
    changed.workspaceAudit=(await client.query("UPDATE workspace_audit_log SET details=jsonb_build_object('retentionRedacted',true) WHERE workspace_id=$1 AND subject_id=ANY($2::uuid[])",[workspaceId,plan.targets.submissions])).rowCount ?? 0
    changed.submissionAttachments=(await client.query('DELETE FROM association_submission_attachments WHERE workspace_id=$1 AND submission_id=ANY($2::uuid[])',[workspaceId,plan.targets.submissions])).rowCount ?? 0
    await apply('submissions','DELETE FROM association_enquiries WHERE workspace_id=$1 AND id=ANY($2::uuid[])')
  }
  const fields=plan.policy?.openSubmissions?.fields ?? []
  if(fields.length && plan.targets.open?.length) {
    if(fields.includes('notes'))changed.notes=(await client.query('DELETE FROM association_enquiry_notes WHERE workspace_id=$1 AND enquiry_id=ANY($2::uuid[])',[workspaceId,plan.targets.open])).rowCount ?? 0
    if(fields.includes('metadata'))changed.submissionAttachments=(changed.submissionAttachments ?? 0)+((await client.query('DELETE FROM association_submission_attachments WHERE workspace_id=$1 AND submission_id=ANY($2::uuid[])',[workspaceId,plan.targets.open])).rowCount ?? 0)
    const assignments=fields.filter(f=>f!=='notes').map(f=>f==='metadata'?"submitted_data='{}'::jsonb":`${f}=$3`)
    if(assignments.length)await apply('open',`UPDATE association_enquiries SET ${assignments.join(',')}
      WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,assignments.some(a=>a.includes('$3'))?[REDACTED]:[])
  }
  await apply('fileCleanups','DELETE FROM crm_import_file_cleanups WHERE workspace_id=$1 AND id=ANY($2::uuid[])')
  await apply('imports','DELETE FROM crm_import_jobs WHERE workspace_id=$1 AND id=ANY($2::uuid[])')
  await apply('sources','DELETE FROM crm_import_sources WHERE workspace_id=$1 AND id=ANY($2::uuid[])')
  await apply('deliveries',`UPDATE crm_delivery_receipts SET envelope=NULL,provider_receipt=NULL,
    redacted_at=clock_timestamp(),acting_user_id=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND delivery_id=ANY($2::uuid[])`)
  await apply('events','DELETE FROM crm_domain_event_outbox WHERE workspace_id=$1 AND id=ANY($2::uuid[])')
  await apply('intake','DELETE FROM crm_intake_idempotency WHERE workspace_id=$1 AND id=ANY($2::uuid[])')
  await apply('tombstones','DELETE FROM crm_address_suppression_tombstones WHERE workspace_id=$1 AND id=ANY($2::uuid[])')
  return changed
}
