/** CRM staged-file eligibility and the affected-set proof. [COMP:crm/file-cleanup] */
import {captureCrmErasure} from './erasure-journal.js'
import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {canonicalCrmRequest, type CrmPrivacyBlocker, type CrmPrivacyDomainReview} from '@use-brian/core/crm/operations-types.js'
import {readCrmPrivacyPolicy} from './privacy-policy.js'
import {parseStorageKey} from '../files/gcs-client.js'
import {localDirectoryMetadata} from '../files/local-directory-import.js'

type SourceFile={id:string;workspace_id:string;path:string;storage_uri:string;metadata:Record<string,unknown>;source_episode_id:string|null;created_at:Date;updated_at:Date;version:string}
export type CrmImportFilePlan={file:SourceFile|null;policyVersion:number;retentionSeconds:number|null;domains:CrmPrivacyDomainReview[];blockers:CrmPrivacyBlocker[];snapshotHash:string}
const identifier=(value:string)=>'"'+value.replaceAll('"','""')+'"'
export async function inspectCrmImportFileCleanup(client:PoolClient,workspaceId:string,fileId:string,before:Date):Promise<CrmImportFilePlan> {
  const policy=await readCrmPrivacyPolicy(workspaceId,client)
  const file=(await client.query<SourceFile>(`SELECT id,workspace_id,path,storage_uri,metadata,source_episode_id,created_at,updated_at,xmin::text version
    FROM workspace_files WHERE workspace_id=$1 AND id=$2`,[workspaceId,fileId])).rows[0] ?? null
  const plan:CrmImportFilePlan={file,policyVersion:policy.version,retentionSeconds:policy.policy.importSourceErasure?.receiptRetentionSeconds ?? null,
    domains:[],blockers:[],snapshotHash:''}
  const digest=createHash('sha256'),block=(reason:string,count=1,domain='workspace_files')=>{if(count)plan.blockers.push({domain,reason,count})}
  if(!file)block('source_file_unavailable')
  if(!plan.retentionSeconds)block('import_source_erasure_policy_unconfigured',1,'crm_privacy_policies')
  const holds=policy.policy.retention?.holds ?? []
  if(holds.some(h=>h.domain==='file' && h.id===fileId.toLowerCase()))block('retention_hold')
  await client.query('CREATE TEMP TABLE IF NOT EXISTS crm_file_cleanup_jobs(id uuid PRIMARY KEY) ON COMMIT DROP; TRUNCATE pg_temp.crm_file_cleanup_jobs')
  if(file) {
    if(file.updated_at>=before)block('source_file_cutoff_not_met')
    if(localDirectoryMetadata({metadata:file.metadata}))block('read_only_source_file')
    try {if(parseStorageKey(file.storage_uri)!==`${file.workspace_id}/${file.id}`)block('noncanonical_source_object')}
    catch {block('noncanonical_source_object')}
    if(file.source_episode_id)block('source_file_ingest_dependency')
    await client.query(`INSERT INTO pg_temp.crm_file_cleanup_jobs SELECT id FROM crm_import_jobs WHERE workspace_id=$1 AND staged_file_id=$2`,[workspaceId,fileId])
    const jobs=(await client.query<{total:number;active:number;held:number}>(`SELECT count(*)::int total,
      count(*) FILTER(WHERE status NOT IN('completed','cancelled','failed') OR updated_at>=$3)::int active,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM crm_import_rows r WHERE r.workspace_id=j.workspace_id AND r.job_id=j.id AND r.entity_id=ANY($4::uuid[])))::int held
      FROM crm_import_jobs j WHERE workspace_id=$1 AND staged_file_id=$2`,[workspaceId,fileId,before,holds.filter(h=>h.domain==='contact').map(h=>h.id)])).rows[0]!
    if(!jobs.total)block('source_file_lineage_unavailable')
    block('source_file_active_or_recent_consumer',jobs.active,'crm_import_jobs')
    block('retention_hold',jobs.held,'crm_import_jobs')
    plan.domains.push({domain:'workspace_files',action:'delete',count:1},{domain:'crm_import_jobs',action:'delete',count:jobs.total})
    // Discover actual FK references, including future schema additions. A new
    // consumer is a review dependency instead of an accidental cascade delete.
    const references=await client.query<{schema:string;table:string;columns:string[];target:string[]}>(`SELECT n.nspname schema,c.relname "table",
      ARRAY(SELECT a.attname::text FROM unnest(f.conkey) WITH ORDINALITY k(id,ord) JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=k.id ORDER BY k.ord) columns,
      ARRAY(SELECT a.attname::text FROM unnest(f.confkey) WITH ORDINALITY k(id,ord) JOIN pg_attribute a ON a.attrelid=f.confrelid AND a.attnum=k.id ORDER BY k.ord) target
      FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE f.contype='f' AND f.confrelid='workspace_files'::regclass ORDER BY n.nspname,c.relname,f.conname`)
    for(const ref of references.rows) {
      const foreignJobs=ref.schema==='public' && ref.table==='crm_import_jobs'
      const predicate=ref.columns.map((column,i)=>`c.${identifier(column)}=f.${identifier(ref.target[i]!)}`).join(' AND ')
      const count=Number((await client.query(`SELECT count(*)::int count FROM ${identifier(ref.schema)}.${identifier(ref.table)} c
        JOIN workspace_files f ON ${predicate} WHERE f.workspace_id=$1 AND f.id=$2 ${foreignJobs?'AND c.workspace_id<>$1':''}`,[workspaceId,fileId])).rows[0].count)
      block('shared_source_file_reference',count,ref.table)
    }
    for(const [domain,sql,args] of [
      ['entity_links',"SELECT count(*)::int count FROM entity_links WHERE (source_kind='file' AND source_id=$2 OR target_kind='file' AND target_id=$2)",[workspaceId,fileId]],
      ['crm_email_drafts','SELECT count(*)::int count FROM crm_email_drafts WHERE workspace_id=$1 AND ($2=ANY(attachment_refs) OR $3=ANY(attachment_refs))',[workspaceId,fileId,file.path]],
      ['crm_email_draft_versions','SELECT count(*)::int count FROM crm_email_draft_versions WHERE workspace_id=$1 AND ($2=ANY(attachment_refs) OR $3=ANY(attachment_refs))',[workspaceId,fileId,file.path]],
      ['workspace_files','SELECT count(*)::int count FROM workspace_files WHERE id<>$2 AND storage_uri=$3 AND $1::uuid IS NOT NULL',[workspaceId,fileId,file.storage_uri]],
    ] as const) {
      // The links query intentionally includes foreign-workspace references.
      const statement=domain==='entity_links'?sql+' AND $1::uuid IS NOT NULL':sql
      block('shared_source_file_reference',Number((await client.query(statement,[...args])).rows[0].count),domain)
    }
    const parts:[string,string,string,unknown[],CrmPrivacyDomainReview['action']][]=[
      ['crm_import_jobs','t.workspace_id=$1 AND t.id IN(SELECT id FROM pg_temp.crm_file_cleanup_jobs)','id',[workspaceId],'delete'],
      ['crm_import_csv_indexes','t.workspace_id=$1 AND t.staged_file_id=$2','id',[workspaceId,fileId],'delete'],
      ...['crm_import_rows','crm_import_chunks','crm_import_errors'].map(table=>[table,'t.workspace_id=$1 AND t.job_id IN(SELECT id FROM pg_temp.crm_file_cleanup_jobs)','id',[workspaceId],'delete'] as [string,string,string,unknown[],'delete']),
      ['workspace_audit_log','t.workspace_id=$1 AND t.subject_id=$2','id',[workspaceId,fileId],'redact'],
      ['correction_audit',"t.workspace_id=$1 AND t.primitive='workspace_file' AND t.row_id=$2",'id',[workspaceId,fileId],'redact'],
      ['brain_row_versions',"(t.workspace_id=$1 OR t.workspace_id IS NULL) AND t.primitive='workspace_file' AND t.row_id=$2",'id',[workspaceId,fileId],'redact'],
    ]
    for(const [table,predicate,order,args,action] of parts) {
      let count=0
      await client.query(`DECLARE file_cleanup_versions NO SCROLL CURSOR FOR SELECT t.${order},t.xmin::text version FROM ${table} t WHERE ${predicate} ORDER BY t.${order}`,args)
      for(;;) {
        const rows=(await client.query('FETCH FORWARD 256 FROM file_cleanup_versions')).rows;if(!rows.length)break
        count+=rows.length;for(const row of rows)digest.update(canonicalCrmRequest({table,row}))
      }
      await client.query('CLOSE file_cleanup_versions')
      if(table!=='crm_import_jobs')plan.domains.push({domain:table,action,count})
    }
  }
  digest.update(canonicalCrmRequest({fileId:fileId.toLowerCase(),fileVersion:file?.version ?? null,policy:policy.policy,version:policy.version,
    before:before.toISOString(),domains:plan.domains,blockers:plan.blockers}))
  plan.snapshotHash=digest.digest('hex');return plan
}

/** Caller holds exclusive privacy admission and revalidated the complete plan. */
export async function deleteCrmStagedFileIndex(client:PoolClient,workspaceId:string,plan:CrmImportFilePlan):Promise<void> {
  await captureCrmErasure(client)
  const file=plan.file!
  await client.query(`UPDATE workspace_audit_log SET details=jsonb_build_object('erased',true)
    WHERE workspace_id=$1 AND subject_id=$2`,[workspaceId,file.id])
  await client.query(`UPDATE correction_audit SET reason='Source data erased',ticket_reference=NULL,
    row_snapshot=jsonb_build_object('erased',true),detail=jsonb_build_object('erased',true)
    WHERE workspace_id=$1 AND primitive='workspace_file' AND row_id=$2`,[workspaceId,file.id])
  await client.query(`UPDATE brain_row_versions SET before_image=NULL,erased_at=COALESCE(erased_at,clock_timestamp()),
    mutation_reason='Source data erased',workspace_id=$1 WHERE (workspace_id=$1 OR workspace_id IS NULL) AND primitive='workspace_file' AND row_id=$2`,[workspaceId,file.id])
  await client.query('DELETE FROM crm_import_jobs WHERE workspace_id=$1 AND id IN(SELECT id FROM pg_temp.crm_file_cleanup_jobs)',[workspaceId])
  const deleted=await client.query('DELETE FROM workspace_files WHERE workspace_id=$1 AND id=$2 RETURNING id',[workspaceId,file.id])
  if(deleted.rowCount!==1)throw new Error('Source file changed during cleanup')
}
