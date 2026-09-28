/** Captured copy sets shared by export, review and purge. [COMP:crm/privacy-copies] */
import type { PoolClient } from 'pg'
import { CrmOperationsError, type CrmPrivacyBlocker } from '@use-brian/core'
import { CRM_PRIVACY_COVERAGE } from './privacy-coverage.js'
import { readCrmPrivacyPolicy } from './privacy-policy.js'
import { prepareCrmImportCopies, inspectCrmImportCopyConflicts } from './import-copy-resolver.js'
import { inspectWorkflowCopyConflicts } from './workflow-copy-resolver.js'
import { CRM_WORKFLOW_COPY_ROOT, CRM_WORKSPACE_TASK_ROOT, CRM_OTHER_CONTACT_EMAILS, CRM_SUBJECT_EMAILS, CRM_TASK_COPY_ROOT, CRM_SHARED_TASK_ROOT, crmDraftHasSubjectRecipient } from './privacy-copy-attribution.js'

/** Caller owns a transaction. Only row ids are materialized, never content. */
export async function prepareCrmPrivacyCopies(client: PoolClient, workspaceId: string, contactId: string | null): Promise<void> {
  await prepareCrmImportCopies(client,workspaceId,contactId)
  await client.query(`CREATE TEMP TABLE IF NOT EXISTS crm_privacy_copy_tasks(id uuid PRIMARY KEY,shared boolean NOT NULL DEFAULT false) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS crm_privacy_copy_drafts(id uuid PRIMARY KEY) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS crm_privacy_copy_events(id uuid PRIMARY KEY) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS crm_privacy_copy_workflows(id uuid PRIMARY KEY) ON COMMIT DROP;
    TRUNCATE pg_temp.crm_privacy_copy_tasks,pg_temp.crm_privacy_copy_drafts,pg_temp.crm_privacy_copy_events,pg_temp.crm_privacy_copy_workflows`)
  await client.query(`WITH RECURSIVE args AS(SELECT $1::uuid workspace_id,$2::uuid contact_id), selected(id) AS(
      SELECT t.id FROM tasks t WHERE t.workspace_id=$1 AND (($2::uuid IS NULL AND (${CRM_WORKSPACE_TASK_ROOT})) OR ($2::uuid IS NOT NULL AND (${CRM_TASK_COPY_ROOT})))
      UNION
      SELECT t.id FROM selected s JOIN tasks linked_task ON linked_task.workspace_id=$1 AND linked_task.id=s.id
        JOIN tasks t ON t.workspace_id=$1 AND (t.parent_id=s.id OR t.superseded_by=s.id OR t.id=linked_task.superseded_by)
    ) INSERT INTO pg_temp.crm_privacy_copy_tasks(id) SELECT id FROM selected`, [workspaceId,contactId])
  await client.query(`WITH args AS(SELECT $1::uuid workspace_id,$2::uuid contact_id)
    INSERT INTO pg_temp.crm_privacy_copy_drafts
    SELECT d.id FROM crm_email_drafts d WHERE d.workspace_id=$1 AND ($2::uuid IS NULL OR ${crmDraftHasSubjectRecipient('d')}
      OR EXISTS(SELECT 1 FROM crm_email_draft_versions v WHERE v.workspace_id=$1 AND v.draft_id=d.id AND ${crmDraftHasSubjectRecipient('v')}))`, [workspaceId,contactId])
  if(contactId!==null)await client.query(`WITH RECURSIVE args AS(SELECT $1::uuid workspace_id,$2::uuid contact_id), shared(id) AS(
      SELECT t.id FROM tasks t JOIN pg_temp.crm_privacy_copy_tasks s ON s.id=t.id
        WHERE t.workspace_id=$1 AND (${CRM_SHARED_TASK_ROOT})
      UNION
      SELECT t.id FROM shared s JOIN tasks linked_task ON linked_task.workspace_id=$1 AND linked_task.id=s.id
        JOIN tasks t ON t.workspace_id=$1 AND (t.parent_id=s.id OR t.id=linked_task.parent_id
          OR t.superseded_by=s.id OR t.id=linked_task.superseded_by)
        JOIN pg_temp.crm_privacy_copy_tasks included ON included.id=t.id
    ) UPDATE pg_temp.crm_privacy_copy_tasks SET shared=true WHERE id IN(SELECT id FROM shared)`, [workspaceId,contactId])
  const eventDomain=CRM_PRIVACY_COVERAGE.find(e=>e.domain==='crm_domain_event_outbox')!
  await client.query(`WITH args AS(SELECT $1::uuid workspace_id,$2::uuid contact_id)
    INSERT INTO pg_temp.crm_privacy_copy_events SELECT t.id FROM crm_domain_event_outbox t
    WHERE t.workspace_id=$1 AND ($2::uuid IS NULL OR (${eventDomain.subjectWhere}))`,[workspaceId,contactId])
  await client.query(`WITH args AS(SELECT $1::uuid workspace_id,$2::uuid contact_id)
    INSERT INTO pg_temp.crm_privacy_copy_workflows SELECT t.id FROM workflow_runs t WHERE t.workspace_id=$1 AND (
      ($2::uuid IS NULL AND (t.crm_event_id IS NOT NULL OR (t.trigger_kind='event' AND t.input#>>'{trigger,sourceType}'='crm')))
      OR ($2::uuid IS NOT NULL AND (${CRM_WORKFLOW_COPY_ROOT}))
      OR EXISTS(SELECT 1 FROM goal_crm_event_sources g JOIN pg_temp.crm_privacy_copy_events e ON e.id=g.event_id
        WHERE g.workspace_id=$1 AND g.goal_id=t.source_goal_id))`,[workspaceId,contactId])

  await client.query(`WITH RECURSIVE copies(id) AS(
    SELECT id FROM pg_temp.crm_privacy_copy_workflows
    UNION
    SELECT candidate.id FROM copies c JOIN workflow_runs parent ON parent.id=c.id AND parent.workspace_id=$1
      JOIN workflow_runs candidate ON candidate.workspace_id=$1 AND (
        (candidate.workflow_id=parent.workflow_id AND candidate.privacy_lineage_version=0)
        OR EXISTS(SELECT 1 FROM workflow_run_copy_sources link WHERE link.workspace_id=$1
          AND link.source_run_id=c.id AND link.run_id=candidate.id))
  ) INSERT INTO pg_temp.crm_privacy_copy_workflows SELECT id FROM copies ON CONFLICT DO NOTHING`,[workspaceId])
}

/** Preview and canonical purge both refuse shared or ambiguous copy ownership. */
export async function inspectCrmPrivacyCopyConflicts(client: PoolClient, workspaceId: string, contactId: string): Promise<CrmPrivacyBlocker[]> {
  const blockers: CrmPrivacyBlocker[] = []
  const pendingFiles=await client.query<{count:number}>("SELECT count(*)::int count FROM crm_import_file_cleanups WHERE workspace_id=$1 AND status IN('queued','leased','failed')",[workspaceId])
  if(pendingFiles.rows[0]?.count)blockers.push({domain:'crm_import_file_cleanups',reason:'source_file_cleanup_pending',count:pendingFiles.rows[0].count})
  const holds=(await readCrmPrivacyPolicy(workspaceId,client)).policy.retention?.holds ?? []
  if(holds.some(h=>h.domain==='contact' && h.id===contactId.toLowerCase()))blockers.push({domain:'entities',reason:'retention_hold',count:1})
  for(const [kind,domain] of [['submission','association_enquiries'],['order','association_orders'],['file','workspace_files']] as const) {
    const ids=holds.filter(h=>h.domain===kind).map(h=>h.id)
    if(!ids.length)continue
    const entry=CRM_PRIVACY_COVERAGE.find(e=>e.domain===domain)!
    const held=await client.query<{count:number}>(`WITH args AS(SELECT $1::uuid workspace_id,$2::uuid contact_id)
      SELECT count(*)::int count FROM ${domain} t WHERE t.workspace_id=$1 AND t.id=ANY($3::uuid[]) AND (${entry.subjectWhere})`,[workspaceId,contactId,ids])
    if(held.rows[0]?.count)blockers.push({domain,reason:'retention_hold',count:held.rows[0].count})
  }
  const drafts = await client.query<{ count: number }>(`WITH args AS(SELECT $1::uuid workspace_id,$2::uuid contact_id), recipients AS(
      SELECT d.id,unnest(d.to_addresses||d.cc_addresses||d.bcc_addresses) address
        FROM crm_email_drafts d JOIN pg_temp.crm_privacy_copy_drafts s ON s.id=d.id WHERE d.workspace_id=$1
      UNION ALL
      SELECT v.draft_id,unnest(v.to_addresses||v.cc_addresses||v.bcc_addresses)
        FROM crm_email_draft_versions v JOIN pg_temp.crm_privacy_copy_drafts s ON s.id=v.draft_id WHERE v.workspace_id=$1
    ) SELECT count(DISTINCT id)::int count FROM recipients
      WHERE address IS NULL OR lower(btrim(address)) NOT IN(${CRM_SUBJECT_EMAILS})
        OR lower(btrim(address)) IN(${CRM_OTHER_CONTACT_EMAILS})`, [workspaceId,contactId])
  if(drafts.rows[0]?.count)blockers.push({domain:'crm_email_drafts',reason:'shared_or_ambiguous_draft',count:drafts.rows[0].count})
  const tasks = await client.query<{ count: number }>(`SELECT count(*)::int count
    FROM tasks t JOIN pg_temp.crm_privacy_copy_tasks s ON s.id=t.id WHERE t.workspace_id=$1 AND s.shared`, [workspaceId])
  if(tasks.rows[0]?.count)blockers.push({domain:'tasks',reason:'shared_or_unresolved_task',count:tasks.rows[0].count})
  const foreign = await client.query<{ count: number }>(`SELECT count(DISTINCT t.id)::int count
    FROM tasks t JOIN pg_temp.crm_privacy_copy_tasks s ON s.id=t.id
    WHERE EXISTS(SELECT 1 FROM tasks other WHERE other.workspace_id<>$1 AND
      (other.parent_id=t.id OR other.superseded_by=t.id OR other.id=t.superseded_by))`, [workspaceId])
  if(foreign.rows[0]?.count)blockers.push({domain:'tasks',reason:'cross_workspace_task_dependency',count:foreign.rows[0].count})
  const notificationDomain=CRM_PRIVACY_COVERAGE.find(e=>e.domain==='association_notification_outbox')!
  const notifications=await client.query<{count:number}>(`WITH args AS(SELECT $1::uuid workspace_id,$2::uuid contact_id)
    SELECT count(*)::int count FROM association_notification_outbox t WHERE t.workspace_id=$1
      AND (${notificationDomain.subjectWhere}) AND t.status<>'retired'
      AND t.recipient_kind='contact' AND t.recipient_ref<>$2::text`,[workspaceId,contactId])
  if(notifications.rows[0]?.count)blockers.push({domain:'association_notification_outbox',reason:'shared_notification_dependency',count:notifications.rows[0].count})
  blockers.push(...await inspectCrmImportCopyConflicts(client,workspaceId,contactId))
  blockers.push(...await inspectWorkflowCopyConflicts(client,workspaceId))
  return blockers
}

/** Preserve attribution until unsupported dependent artifacts are resolved. */
export async function assertCrmPrivacyCopiesResolvable(client: PoolClient, workspaceId: string, contactId: string): Promise<void> {
  const blockers = await inspectCrmPrivacyCopyConflicts(client,workspaceId,contactId)
  for(const domain of ['crm_segments','workspace_files','decision_events','decision_applications','decision_derivations']) {
    const entry = CRM_PRIVACY_COVERAGE.find(candidate => candidate.domain===domain)!
    const result=await client.query<{count:number}>(`WITH args AS(SELECT $1::uuid workspace_id,$2::uuid contact_id)
      SELECT count(*)::int count FROM ${domain} t WHERE (${entry.workspacePredicate ?? 't.workspace_id=$1'}) AND (${entry.subjectWhere})`, [workspaceId,contactId])
    if(result.rows[0]?.count)blockers.push({domain,reason:'crm_copy_resolution_required',count:result.rows[0].count})
  }
  if(blockers.length)throw new CrmOperationsError('conflict','Resolve CRM copy dependencies before erasure.',{reason:'crm_copy_resolution_required',blockers})
}

/** Runs after audit/history/receipt redaction, before the canonical parent delete. */
export async function deleteCrmPrivacyCopies(client: PoolClient, workspaceId: string, contactId: string): Promise<void> {
  for(const domain of ['entity_links','crm_email_drafts','tasks']) {
    const entry = CRM_PRIVACY_COVERAGE.find(candidate => candidate.domain===domain)!
    await client.query(`WITH args AS(SELECT $1::uuid workspace_id,$2::uuid contact_id)
      DELETE FROM ${domain} t WHERE t.workspace_id=$1 AND (${entry.subjectWhere})`, [workspaceId,contactId])
  }
}

/** Retire dispatchable copies before their source attribution disappears. */
export async function retireCrmNotificationCopies(client:PoolClient,workspaceId:string,contactId:string):Promise<void> {
  for(const [domain,assignments] of [
    ['crm_domain_event_outbox',"subject_id='00000000-0000-0000-0000-000000000000'::uuid,payload=jsonb_build_object('erased',true,'eventType',event_type),lease_owner=NULL,leased_until=NULL,last_error=NULL"],
    ['association_notification_outbox',"source_id='00000000-0000-0000-0000-000000000000'::uuid,recipient_ref='erased:'||t.id::text,payload=jsonb_build_object('erased',true),provider_message_id=NULL,last_error=NULL,next_attempt_at=NULL"],
  ] as const) {
    const entry=CRM_PRIVACY_COVERAGE.find(e=>e.domain===domain)!
    await client.query(`WITH args AS(SELECT $1::uuid workspace_id,$2::uuid contact_id)
      UPDATE ${domain} t SET retired_from_status=status,status='retired',retired_at=clock_timestamp(),${assignments}
      WHERE t.workspace_id=$1 AND t.status<>'retired' AND (${entry.subjectWhere})`,[workspaceId,contactId])
  }
  await client.query(`UPDATE goal_crm_event_sources s SET event_binding='{"erased":true}'
    WHERE s.workspace_id=$1 AND s.event_binding<>'{"erased":true}'::jsonb
      AND s.event_id IN(SELECT id FROM pg_temp.crm_privacy_copy_events)
      AND EXISTS(SELECT 1 FROM crm_domain_event_outbox e WHERE e.id=s.event_id AND e.status='retired' AND e.scope_source IS NULL)`,[workspaceId])

}
