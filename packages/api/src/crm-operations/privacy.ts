/**
 * Privacy lifecycle and operator visibility for CRM operations.
 *
 * Append-only evidence is immutable during normal product use. The explicit
 * erasure primitive below is the legal override: it removes personal linkage
 * and payload while retaining minimized execution receipts required by policy.
 *
 * [COMP:crm/operations-privacy]
 */

import type pg from 'pg'
import { CrmOperationsContextSchema, CrmOperationsError, type CrmPageQuery, type CrmOperationsContext } from '@use-brian/core'
import { assertCrmPrivacyWorkspaceAuthority } from './privacy-subject-authority.js'
import { assertAssociationSourceAuthority } from '../association/source-scope.js'
import {assertCrmRetentionOwner} from './retention-service.js'
import {createCrmRetentionAuthority,renewCrmRetentionScope} from './retention-authority.js'
import { queryCrmPage } from './pagination.js'
import { getPool, query, queryWithRLS } from '../db/client.js'
import { currentAgentAccess } from '../db/agent-access-context.js'
import { retireCrmIntakeReceipts, readCrmPrivacyPolicy } from './privacy-policy.js'
import { acquireCrmPrivacyAdmission } from './privacy-admission.js'
import { retainCrmAddressSuppression } from './suppression-tombstones.js'
import { retireCrmImportCopies } from './import-copy-resolver.js'
import { retireWorkflowCopies } from './workflow-copy-resolver.js'
import { CRM_PRIVACY_COVERAGE } from './privacy-coverage.js'
import { prepareCrmPrivacyCopies, assertCrmPrivacyCopiesResolvable, deleteCrmPrivacyCopies, retireCrmNotificationCopies } from './privacy-copy-resolver.js'

export const CRM_OPERATIONS_PRIVACY_TABLES = [
  'campaigns',
  'campaign_placements',
  'campaign_links',
  'campaign_sites',
  'campaign_site_credentials',
  'campaign_events',
  'campaign_subject_links',
  'campaign_conversions',
  'campaign_conversion_outbox',
  'campaign_email_dispatches',
  'campaign_email_recipients',
  'campaign_email_jobs',
  'campaign_unsubscribe_tokens',
  'campaign_email_link_tokens',
  'campaign_daily_metrics',
  'campaign_command_receipts',
  'crm_intake_definitions',
  'crm_intake_definition_versions',
  'crm_intake_credentials',
  'crm_intake_credential_definitions',
  'crm_intake_idempotency',
  'crm_privacy_policies',
  'crm_erasure_journal',
  'crm_privacy_previews',
  'crm_retention_runs',
  'crm_import_file_cleanups',
  'crm_address_suppression_tombstones',
  'crm_managed_mailbox_policies',
  'crm_mailbox_integration_grants',
  'crm_delivery_receipts',
  'crm_delivery_receipt_contacts',
  'association_external_identities',
  'association_enquiries',
  'association_enquiry_notes',
  'crm_consent_purposes',
  'crm_consent_purpose_versions',
  'association_consent_events',
  'crm_suppression_events',
  'crm_segments',
  'association_membership_plans',
  'association_memberships',
  'association_membership_source_imports',
  'association_membership_checkouts',
  'association_membership_offline_rescues',
  'association_events',
  'association_registrations',
  'association_inventory_boundaries',
  'association_promotions',
  'association_promotion_source_contact_uses',
  'association_promotion_uses',
  'association_waitlist_offers',
  'association_integration_events',
  'association_audit_log',
  'workspace_audit_log',
  'workspace_modules',
  'crm_integration_credentials',
  'crm_integration_credential_grants',
  'crm_domain_event_outbox',
  'crm_import_jobs',
  'crm_import_sources',
  'crm_import_chunks',
  'crm_import_rows',
  'crm_import_errors',
] as const

type PrivacyTable = (typeof CRM_OPERATIONS_PRIVACY_TABLES)[number]

const EXPORT_PROJECTIONS: Record<PrivacyTable, string> = Object.fromEntries(
  CRM_OPERATIONS_PRIVACY_TABLES.map((table) => [table, '*']),
) as Record<PrivacyTable, string>

for (const table of ['association_enquiries','association_consent_events','crm_suppression_events'] as const) {
  const projection = CRM_PRIVACY_COVERAGE.find(entry => entry.domain === table)!
  EXPORT_PROJECTIONS[table] = projection.columns.filter(column => !projection.excludedColumns.includes(column)).join(',')
}

// A credential secret hash is authentication material, not exportable
// workspace content. Its non-secret lifecycle metadata remains visible.
EXPORT_PROJECTIONS.crm_intake_credentials = [
  'id', 'workspace_id', 'label', 'secret_prefix', 'created_by_user_id',
  'revoked_at', 'last_used_at', 'created_at', 'replay_scope_id', 'rotated_from_credential_id',
].join(',')
EXPORT_PROJECTIONS.crm_integration_credentials = [
  'id', 'workspace_id', 'label', 'secret_prefix', 'created_by_user_id',
  'expires_at', 'revoked_at', 'last_used_at', 'created_at',
].join(',')
EXPORT_PROJECTIONS.campaign_site_credentials = 'id,workspace_id,site_id,key_prefix,grants,created_by,created_at,revoked_at'
EXPORT_PROJECTIONS.campaign_events = 'id,workspace_id,site_id,event_type,evidence_level,link_id,occurred_at,received_at,page_path,referrer_origin,utm_snapshot,metadata,is_test,bot_class,classification_version,expires_at'
EXPORT_PROJECTIONS.campaign_conversion_outbox = 'id,workspace_id,site_id,outcome_kind,external_outcome_id,state,attempts,available_at,last_error,created_at,updated_at'
EXPORT_PROJECTIONS.campaign_unsubscribe_tokens = 'id,workspace_id,recipient_id,purpose_key,all_marketing,expires_at,used_at,revoked_at,created_at'
EXPORT_PROJECTIONS.campaign_email_link_tokens = 'id,workspace_id,recipient_id,link_id,expires_at,revoked_at,created_at'
EXPORT_PROJECTIONS.campaign_command_receipts = 'workspace_id,actor_kind,actor_reference,result,created_at'
// Original CSV bytes are a separate multi-subject processing artifact. The
// legacy operations export includes its inventory, never an implicit blob dump.
EXPORT_PROJECTIONS.crm_import_sources = [
  'id', 'workspace_id', 'source_key', 'source_hash', 'credential_id',
  'integration_grants', 'created_at', 'octet_length(content_bytes) AS byte_count',
].join(',')
EXPORT_PROJECTIONS.crm_address_suppression_tombstones = 'id,workspace_id,key_version,channel,purpose_key,reason_code,occurred_at,policy_version,created_at,expires_at,released_at,release_evidence_kind,release_evidence_id'
EXPORT_PROJECTIONS.association_integration_events = 'id,workspace_id,provider,provider_event_id,provider_reference,occurred_at,target_kind,order_id,entitlement_id,contact_id,plan_id,state,attempts,cycle_attempts,next_attempt_at,last_error_code,created_at,updated_at,applied_at'
EXPORT_PROJECTIONS.association_promotions = 'id,workspace_id,promotion_key,name,discount_type,percentage_basis_points,amount_minor,currency,buy_quantity,get_quantity,target_kind,target_ids,recurrence_mode,recurrence_cycles,apply_mode,valid_from,valid_to,max_uses,max_uses_per_contact,source_system,source_site,source_promotion_id,source_redeemed_uses,combines_with_member_price,release_on_full_refund,status,created_at,updated_at'
EXPORT_PROJECTIONS.association_membership_source_imports = 'id,workspace_id,membership_id,source_system,source_site,source_membership_id,source_plan_id,source_member_id,source_order_id,source_subscription_id,source_payment_provider,source_payment_reference,source_status,source_renewal_status,source_payment_status,source_refund_status,purchased_at,cancelled_at,relationships,metadata,created_at'
EXPORT_PROJECTIONS.association_membership_checkouts = 'id,workspace_id,contact_id,plan_id,status,currency,subtotal_minor,discount_minor,total_minor,promotion_id,promotion_snapshot,reservation_expires_at,provider,provider_reference,provider_coupon_reference,created_at,updated_at'

EXPORT_PROJECTIONS.crm_import_file_cleanups='id,workspace_id,owner_user_id,file_id,before_at,policy_version,summary,status,attempts,next_attempt_at,leased_until,error_code,created_at,expires_at,queued_at,completed_at,replay_expires_at'
EXPORT_PROJECTIONS.crm_erasure_journal='id,workspace_id,table_name,operation,captured_at'
EXPORT_PROJECTIONS.crm_retention_runs='id,workspace_id,owner_user_id,policy_version,mode,before_at,captured_at,expires_at,summary,status,receipt,error_code,completed_at,created_at'

EXPORT_PROJECTIONS.crm_domain_event_outbox = CRM_PRIVACY_COVERAGE.find(entry=>entry.domain==='crm_domain_event_outbox')!.columns.filter(column=>!['lease_owner','leased_until','last_error','scope_source','scope_origin','scope_held','scope_version','privacy_scope'].includes(column)).join(',')

EXPORT_PROJECTIONS.crm_privacy_previews='id,workspace_id,owner_user_id,subject_id,policy_version,domain_summary,blockers,status,created_at,expires_at,consumed_at,receipt'

// Claim tokens and raw request fingerprints are private replay machinery.
EXPORT_PROJECTIONS.crm_delivery_receipts = 'workspace_id,delivery_id,connector_instance_id,provider_key,purpose_key,actor_kind,actor_credential_id,acting_user_id,envelope,status,provider_receipt,error_code,accepted_at,confirmed_at,redacted_at,created_at,updated_at'

/** Retire content without reopening a stable delivery identity. Caller holds person locks. */
export async function redactCrmDeliveryReceipts(client:pg.PoolClient,workspaceId:string,contactId?:string):Promise<void> {
  await client.query(`UPDATE crm_delivery_receipts r SET envelope=NULL,provider_receipt=NULL,redacted_at=COALESCE(redacted_at,clock_timestamp()),
    status=CASE WHEN status='dispatching' THEN 'needs_reconciliation' ELSE status END,
    error_code=CASE WHEN status='dispatching' THEN 'delivery_erased_during_dispatch' ELSE error_code END,updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM crm_delivery_receipt_contacts c
      WHERE c.workspace_id=r.workspace_id AND c.delivery_id=r.delivery_id AND c.contact_id=$2))`,[workspaceId,contactId ?? null])
}

export type CrmOperationsPrivacyExport = {
  schema: 'crm-operations-privacy-v1'
  workspaceId: string
  exportedAt: string
  tables: Record<string, unknown[]>
}

export async function exportCrmOperationsPrivacy(
  rawContext: CrmOperationsContext,
): Promise<CrmOperationsPrivacyExport> {
  const context = CrmOperationsContextSchema.parse(rawContext)
  const { workspaceId } = context
  if (context.actor.kind !== 'user' || !context.authority.canConfigure ||
      !['owner', 'admin'].includes(context.authority.role)) {
    throw new CrmOperationsError('not_authorized', 'A current workspace owner or admin is required for CRM privacy export.')
  }
  const actor = { credentialKind: 'user' as const, credentialId: context.actor.userId, actingUserId: context.actor.userId }
  const client = await getPool().connect()
  let open = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    open = true
    await client.query("SET LOCAL statement_timeout='30s'")
    const membership = await client.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId, context.actor.userId])
    if (!['owner', 'admin'].includes(membership.rows[0]?.role)) {
      throw new CrmOperationsError('not_authorized', 'A current workspace owner or admin is required for CRM privacy export.')
    }
    const floor = await assertCrmPrivacyWorkspaceAuthority(client, context)
    const tables: Record<string, unknown[]> = {}
    for (const table of CRM_OPERATIONS_PRIVACY_TABLES) {
      const result = await client.query(`SELECT ${EXPORT_PROJECTIONS[table]} FROM ${table} WHERE workspace_id=$1`, [workspaceId])
      tables[table] = result.rows
    }
    if (floor) await assertAssociationSourceAuthority(getPool(), workspaceId, actor, { scope: floor, sources: [] })
    await client.query('COMMIT')
    open = false
    return { schema: 'crm-operations-privacy-v1', workspaceId, exportedAt: new Date().toISOString(), tables }
  } finally {
    if (open) await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

/**
 * Erase operation-owned personal linkage before an entity hard delete.
 * The caller supplies the hard-purge transaction client so this cannot commit
 * independently of the entity DELETE and correction audit shell.
 */
export async function redactCrmOperationsForContact(
  client: pg.PoolClient,
  workspaceId: string,
  contactId: string,
): Promise<void> {
  const person = await client.query<{ isPerson: boolean }>(
    `SELECT kind='person' AS "isPerson" FROM entities WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [workspaceId, contactId],
  )
  if (!person.rows[0]?.isPerson) return
  await prepareCrmPrivacyCopies(client,workspaceId,contactId)
  await assertCrmPrivacyCopiesResolvable(client,workspaceId,contactId)
  await client.query('DELETE FROM crm_privacy_previews WHERE workspace_id=$1 AND subject_id=$2',[workspaceId,contactId])
  await retainCrmAddressSuppression(client,workspaceId,contactId)
  // Resolve audit references before clearing the attendee/enquiry/membership
  // links on which attribution depends. Reuse the preview/export predicates.
  for (const [domain, assignments] of [
    ['association_audit_log', "subject_id='00000000-0000-0000-0000-000000000000'::uuid,metadata=jsonb_build_object('erased',true)"],
    ['workspace_audit_log', "subject_id=NULL,details=jsonb_build_object('erased',true)"],
    ['brain_row_versions', "before_image=NULL,erased_at=COALESCE(erased_at,clock_timestamp()),mutation_reason='Personal data erased',workspace_id=$1"],
    ['correction_audit', "reason='Personal data erased',ticket_reference=NULL,row_snapshot=jsonb_build_object('erased',true),detail=jsonb_build_object('erased',true)"],
  ] as const) {
    const entry = CRM_PRIVACY_COVERAGE.find((candidate) => candidate.domain === domain)!
    await client.query(`WITH privacy_args AS (SELECT $1::uuid workspace_id,$2::uuid contact_id)
      UPDATE ${domain} t SET ${assignments}
      WHERE (${entry.workspacePredicate ?? 't.workspace_id=$1'}) AND (${entry.subjectWhere})`, [workspaceId, contactId])
  }
  await retireWorkflowCopies(client,workspaceId)
  await retireCrmNotificationCopies(client,workspaceId,contactId)
  await redactCrmDeliveryReceipts(client,workspaceId,contactId)
  // Match retention's enquiry -> receipt ordering. Holding a receipt before
  // its enquiry would deadlock against a concurrent retention transaction.
  await client.query(`SELECT id FROM association_enquiries WHERE workspace_id=$1 AND contact_id=$2 ORDER BY id FOR UPDATE`,
    [workspaceId, contactId])
  await retireCrmIntakeReceipts(client, workspaceId, { contactId })

  // Campaign projections are downstream copies of CRM identity. Cancel queued
  // copies before deleting linked snapshots so no later worker can recreate
  // the association from stale payload.
  await client.query(
    `UPDATE campaign_conversion_outbox
        SET state='cancelled',payload='{"erased":true}'::jsonb,payload_hash=repeat('0',64),
            lease_token=NULL,lease_expires_at=NULL,last_error='subject_erased',updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND payload->>'contactId'=$2 AND state<>'completed'`,
    [workspaceId, contactId],
  )
  await client.query(
    `DELETE FROM campaign_events e WHERE e.workspace_id=$1 AND e.session_key IN(
       SELECT l.session_key FROM campaign_subject_links l
        WHERE l.workspace_id=$1 AND l.contact_id=$2 AND l.session_key IS NOT NULL
     )`, [workspaceId, contactId],
  )
  await client.query('DELETE FROM campaign_conversions WHERE workspace_id=$1 AND contact_id=$2', [workspaceId, contactId])
  await client.query('DELETE FROM campaign_subject_links WHERE workspace_id=$1 AND contact_id=$2', [workspaceId, contactId])
  await client.query('DELETE FROM campaign_email_recipients WHERE workspace_id=$1 AND contact_id=$2', [workspaceId, contactId])

  await retireCrmImportCopies(client,workspaceId)

  await client.query(
    'UPDATE association_promotion_uses SET contact_id=NULL WHERE workspace_id=$1 AND contact_id=$2',
    [workspaceId, contactId],
  )
  await client.query(
    'UPDATE association_promotion_source_contact_uses SET contact_id=NULL WHERE workspace_id=$1 AND contact_id=$2',
    [workspaceId, contactId],
  )
  await client.query(
    'DELETE FROM association_membership_checkouts WHERE workspace_id=$1 AND contact_id=$2',
    [workspaceId, contactId],
  )

  // Commerce participation can be retention-bound and therefore uses a
  // pseudonymous shell. Non-commerce rows use the same shell because their
  // attendee columns are equally identifying and the event chronology may be
  // required independently of the erased subject.
  await client.query(
    `UPDATE association_registrations r SET eligible_membership_id=NULL
      WHERE r.workspace_id=$1 AND EXISTS(
        SELECT 1 FROM association_memberships m
         WHERE m.workspace_id=r.workspace_id AND m.id=r.eligible_membership_id AND m.contact_id=$2
      )`,
    [workspaceId, contactId],
  )
  await client.query(
    `UPDATE association_registrations
        SET attendee_contact_id=NULL, attendee_name='Erased participant',
            attendee_email=NULL, attendee_metadata='{}'::jsonb
      WHERE workspace_id=$1 AND attendee_contact_id=$2`,
    [workspaceId, contactId],
  )
  await client.query(
    `UPDATE crm_import_errors e SET row_snapshot='{}'::jsonb,
            message='Row data erased by privacy request'
       FROM crm_import_rows r
      WHERE e.workspace_id=$1 AND r.workspace_id=e.workspace_id
        AND r.job_id=e.job_id AND r.row_number=e.row_number
        AND r.entity_id=$2`,
    [workspaceId, contactId],
  )
  await client.query(
    `UPDATE crm_import_rows SET entity_id=NULL,result_refs='[]'::jsonb
      WHERE workspace_id=$1 AND entity_id=$2`,
    [workspaceId, contactId],
  )
  // The remaining direct contact FKs are CASCADE-bound to entities. The
  // explicit deletes document the legal behavior and keep it stable if a
  // future migration changes an FK action.
  await deleteCrmPrivacyCopies(client,workspaceId,contactId)
  for (const table of [
    'crm_suppression_events',
    'association_consent_events',
    'association_membership_offline_rescues',
    'association_memberships',
    'association_enquiries',
    'association_external_identities',
  ]) {
    await client.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND contact_id=$2`, [workspaceId, contactId])
  }
}

export type CrmOperationsRetentionResult = {
  before: string
  deleted: Record<string, number>
  total: number
}

/**
 * Explicit policy hook. There is intentionally no implicit default cutoff:
 * operators must configure real retention/legal policy before scheduling it.
 */
export async function pruneCrmOperationsRetention(
  rawContext: CrmOperationsContext,
  before: Date,
): Promise<CrmOperationsRetentionResult> {
  const context=CrmOperationsContextSchema.parse(rawContext),{workspaceId}=context
  if (!Number.isFinite(before.getTime())) throw new Error('Retention cutoff must be a valid instant.')
  const client = await getPool().connect()
  const deleted: Record<string, number> = {}
  try {
    await client.query('BEGIN')
    await acquireCrmPrivacyAdmission(client,workspaceId)
    await assertCrmRetentionOwner(client,context)
    const authority=await createCrmRetentionAuthority(client,context)
    const retentionPolicy = (await readCrmPrivacyPolicy(workspaceId, client)).policy
    const heldContacts = retentionPolicy.retention?.holds.filter(h => h.domain==='contact').map(h => h.id) ?? []
    const heldSubmissions = retentionPolicy.retention?.holds.filter(h => h.domain==='submission').map(h => h.id) ?? []
    const heldFiles = retentionPolicy.retention?.holds.filter(h => h.domain==='file').map(h => h.id) ?? []
    const enquiries = await client.query<{ id: string }>(
      `SELECT id FROM association_enquiries WHERE workspace_id=$1
        AND status IN ('resolved','spam') AND updated_at<$2
        AND NOT(id=ANY($3::uuid[])) AND NOT(contact_id=ANY($4::uuid[]))
        ORDER BY id FOR UPDATE`, [workspaceId, before, heldSubmissions, heldContacts])
    const submissionIds = enquiries.rows.map((row) => row.id)
    for(const {id} of enquiries.rows)await authority.capture('association_enquiries',id)
    const events=await client.query<{id:string}>(
      `SELECT e.id FROM crm_domain_event_outbox e WHERE workspace_id=$1
        AND status='delivered' AND created_at < $2
        AND NOT(e.subject_id=ANY($3::uuid[])) AND NOT(e.subject_id=ANY($4::uuid[]))
        AND NOT(COALESCE(e.payload->>'contactId','')=ANY($3::text[]))
        AND NOT EXISTS(SELECT 1 FROM association_enquiries q WHERE q.workspace_id=e.workspace_id AND q.id=e.subject_id AND q.contact_id=ANY($3::uuid[]))
        AND NOT EXISTS(SELECT 1 FROM workflow_runs r
          WHERE r.workspace_id=e.workspace_id AND r.crm_event_id=e.id)
        AND NOT EXISTS(SELECT 1 FROM goal_crm_event_sources g WHERE g.workspace_id=e.workspace_id AND g.event_id=e.id) ORDER BY e.id FOR UPDATE`,
      [workspaceId, before, heldContacts, heldSubmissions])
    for(const {id} of events.rows)await authority.capture('crm_domain_event_outbox',id)
    await renewCrmRetentionScope(context,authority.scope())
    const retiredReceiptsDeleted = await retireCrmIntakeReceipts(client, workspaceId, { submissionIds })
    const remove = async (name: string, sql: string, values: unknown[]) => {
      const result = await client.query(sql, values)
      deleted[name] = result.rowCount ?? 0
    }
    const heldSources = retentionPolicy.importSourceErasure?.heldSourceIds ?? []
    await remove('crm_import_jobs',
      `DELETE FROM crm_import_jobs WHERE workspace_id=$1
        AND status IN ('completed','cancelled','failed') AND updated_at < $2
        AND (staged_file_id IS NULL OR NOT(staged_file_id=ANY($4::uuid[])))
        AND NOT EXISTS(SELECT 1 FROM crm_import_rows r WHERE r.workspace_id=crm_import_jobs.workspace_id
          AND r.job_id=crm_import_jobs.id AND r.entity_id=ANY($5::uuid[]))
        AND (source_id IS NULL OR (NOT(source_id=ANY($3::uuid[]))
          AND EXISTS(SELECT 1 FROM crm_import_sources s WHERE s.workspace_id=crm_import_jobs.workspace_id
            AND s.id=crm_import_jobs.source_id AND s.privacy_erased)))`,
      [workspaceId, before, heldSources, heldFiles, heldContacts])
    await remove('crm_import_sources',
      `DELETE FROM crm_import_sources s WHERE workspace_id=$1 AND privacy_erased
        AND replay_expires_at<=clock_timestamp() AND NOT(id=ANY($2::uuid[]))
        AND NOT EXISTS(SELECT 1 FROM crm_import_jobs j WHERE j.workspace_id=s.workspace_id AND j.source_id=s.id)`,
      [workspaceId, heldSources])
    await remove('crm_domain_event_outbox','DELETE FROM crm_domain_event_outbox WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[workspaceId,events.rows.map(row=>row.id)])
    await remove('crm_intake_idempotency',
      `DELETE FROM crm_intake_idempotency WHERE workspace_id=$1 AND status='retired'
        AND replay_expires_at<=clock_timestamp()`, [workspaceId])
    deleted.crm_intake_idempotency! += retiredReceiptsDeleted
    await remove('association_submission_attachments',
      `DELETE FROM association_submission_attachments WHERE workspace_id=$1
        AND submission_id=ANY($2::uuid[])`, [workspaceId, submissionIds])
    await remove('association_enquiries',
      `DELETE FROM association_enquiries WHERE workspace_id=$1
        AND id=ANY($2::uuid[])`, [workspaceId, submissionIds])
    await renewCrmRetentionScope(context,authority.scope())
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return {
    before: before.toISOString(),
    deleted,
    total: Object.values(deleted).reduce((sum, count) => sum + count, 0),
  }
}

export async function listCrmOperationsAudit(context: CrmOperationsContext, filters: CrmPageQuery = {}) {
  const {workspaceId}=context,userId=operationsHistoryActor(context)
  return queryCrmPage((sql,values)=>queryWithRLS(userId,sql,values), { workspaceId, resource: 'crm.audit', key: 'entries', query: filters,
    sql: `SELECT id,action,subject_kind AS "subjectKind",subject_id AS "subjectId",
            actor_kind AS "actorKind",created_at AS "occurredAt",created_at AS "createdAt",metadata AS details
       FROM association_audit_log WHERE workspace_id=$1 AND action LIKE 'crm.%'
         AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2)`,
    params: [workspaceId,userId],
  })
}

function operationsHistoryActor(context: CrmOperationsContext): string {
  const {workspaceId,actor}=context
  if(!('userId' in actor) || !actor.userId || !['user','import','assistant','workflow'].includes(actor.kind))
    throw new CrmOperationsError('not_authorized','Operation history requires current member scope. Review Department access.')
  const userId=actor.userId
  if(actor.kind==='assistant'||actor.kind==='workflow') {
    const bound=currentAgentAccess()
    if(!bound||bound.workspaceId!==workspaceId||bound.userId!==userId
      ||bound.compartments===undefined||bound.projectIds===undefined||bound.visibilityAssistantIds===undefined)
      throw new CrmOperationsError('not_authorized','Operation history requires bound execution scope. Review Department access.')
  }
  return userId
}

export async function listCrmEventDelivery(context: CrmOperationsContext, filters: CrmPageQuery = {}) {
  const {workspaceId}=context,userId=operationsHistoryActor(context)
  return queryCrmPage((sql,values)=>queryWithRLS(userId,sql,values), { workspaceId, resource: 'crm.event-delivery', key: 'events', query: filters,
    sql: `SELECT id,event_type AS "eventType",subject_kind AS "subjectKind",
            subject_id AS "subjectId",status,attempts,created_at AS "createdAt",
            occurred_at AS "occurredAt",delivered_at AS "deliveredAt",
            retired_at AS "retiredAt",retired_from_status AS "retiredFromStatus"
       FROM crm_domain_event_outbox WHERE workspace_id=$1
         AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2)`,
    params: [workspaceId,userId],
  })
}
