/**
 * Privacy lifecycle and operator visibility for CRM operations.
 *
 * Append-only evidence is immutable during normal product use. The explicit
 * erasure primitive below is the legal override: it removes personal linkage
 * and payload while retaining only non-identifying execution tombstones.
 *
 * [COMP:crm/operations-privacy]
 */

import type pg from 'pg'
import { getPool, query } from '../db/client.js'

export const CRM_OPERATIONS_PRIVACY_TABLES = [
  'crm_intake_definitions',
  'crm_intake_definition_versions',
  'crm_intake_credentials',
  'crm_intake_credential_definitions',
  'crm_intake_idempotency',
  'association_external_identities',
  'association_enquiries',
  'association_enquiry_notes',
  'crm_consent_purposes',
  'association_consent_events',
  'crm_suppression_events',
  'crm_segments',
  'association_membership_plans',
  'association_memberships',
  'association_events',
  'association_registrations',
  'association_audit_log',
  'workspace_audit_log',
  'crm_domain_event_outbox',
  'crm_import_jobs',
  'crm_import_chunks',
  'crm_import_rows',
  'crm_import_errors',
] as const

type PrivacyTable = (typeof CRM_OPERATIONS_PRIVACY_TABLES)[number]

const EXPORT_PROJECTIONS: Record<PrivacyTable, string> = Object.fromEntries(
  CRM_OPERATIONS_PRIVACY_TABLES.map((table) => [table, '*']),
) as Record<PrivacyTable, string>

// A credential secret hash is authentication material, not exportable
// workspace content. Its non-secret lifecycle metadata remains visible.
EXPORT_PROJECTIONS.crm_intake_credentials = [
  'id', 'workspace_id', 'label', 'secret_prefix', 'created_by_user_id',
  'revoked_at', 'last_used_at', 'created_at',
].join(',')

export type CrmOperationsPrivacyExport = {
  schema: 'crm-operations-privacy-v1'
  workspaceId: string
  exportedAt: string
  tables: Record<string, unknown[]>
}

export async function exportCrmOperationsPrivacy(
  workspaceId: string,
): Promise<CrmOperationsPrivacyExport> {
  const tables: Record<string, unknown[]> = {}
  for (const table of CRM_OPERATIONS_PRIVACY_TABLES) {
    const result = await query(`SELECT ${EXPORT_PROJECTIONS[table]} FROM ${table} WHERE workspace_id=$1`, [workspaceId])
    tables[table] = result.rows
  }
  return {
    schema: 'crm-operations-privacy-v1',
    workspaceId,
    exportedAt: new Date().toISOString(),
    tables,
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
    `SELECT kind='person' AS "isPerson" FROM entities WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, contactId],
  )
  if (!person.rows[0]?.isPerson) return

  // Commerce participation can be retention-bound and therefore uses a
  // pseudonymous shell. Non-commerce rows use the same shell because their
  // attendee columns are equally identifying and the event chronology may be
  // required independently of the erased subject.
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
    `UPDATE crm_import_rows SET entity_id=NULL
      WHERE workspace_id=$1 AND entity_id=$2`,
    [workspaceId, contactId],
  )
  await client.query(
    `UPDATE crm_domain_event_outbox
        SET subject_id='00000000-0000-0000-0000-000000000000'::uuid,
            payload=jsonb_build_object('erased',true,'eventType',event_type)
      WHERE workspace_id=$1 AND (
        subject_id=$2 OR payload->>'contactId'=$2::text
        OR payload->>'dealId'=$2::text OR payload->>'submissionId'=$2::text
      )`,
    [workspaceId, contactId],
  )
  await client.query(
    `UPDATE association_audit_log
        SET metadata=jsonb_build_object('erased',true)
      WHERE workspace_id=$1 AND (
        subject_id=$2 OR metadata->>'contactId'=$2::text
      )`,
    [workspaceId, contactId],
  )
  await client.query(
    `UPDATE workspace_audit_log
        SET subject_id=NULL,details=jsonb_build_object('erased',true)
      WHERE workspace_id=$1 AND (
        subject_id=$2 OR details->>'contactId'=$2::text
      )`,
    [workspaceId, contactId],
  )
  await client.query(
    `DELETE FROM crm_segments
      WHERE workspace_id=$1 AND predicate::text LIKE '%' || $2::text || '%'`,
    [workspaceId, contactId],
  )
  // The remaining direct contact FKs are CASCADE-bound to entities. The
  // explicit deletes document the legal behavior and keep it stable if a
  // future migration changes an FK action.
  for (const table of [
    'crm_suppression_events',
    'association_consent_events',
    'association_memberships',
    'association_enquiries',
    'association_external_identities',
  ]) {
    await client.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND contact_id=$2`, [workspaceId, contactId])
  }
  await client.query(
    `DELETE FROM crm_intake_idempotency WHERE workspace_id=$1 AND contact_id=$2`,
    [workspaceId, contactId],
  )
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
  workspaceId: string,
  before: Date,
): Promise<CrmOperationsRetentionResult> {
  if (!Number.isFinite(before.getTime())) throw new Error('Retention cutoff must be a valid instant.')
  const client = await getPool().connect()
  const deleted: Record<string, number> = {}
  try {
    await client.query('BEGIN')
    const remove = async (name: string, sql: string, values: unknown[]) => {
      const result = await client.query(sql, values)
      deleted[name] = result.rowCount ?? 0
    }
    await remove('crm_import_jobs',
      `DELETE FROM crm_import_jobs WHERE workspace_id=$1
        AND status IN ('completed','cancelled','failed') AND updated_at < $2`,
      [workspaceId, before])
    await remove('crm_domain_event_outbox',
      `DELETE FROM crm_domain_event_outbox WHERE workspace_id=$1
        AND status IN ('delivered','failed') AND created_at < $2`,
      [workspaceId, before])
    await remove('crm_intake_idempotency',
      `DELETE FROM crm_intake_idempotency WHERE workspace_id=$1 AND created_at < $2
        AND (status='committed' OR created_at < $2 - interval '24 hours')`,
      [workspaceId, before])
    await remove('association_enquiries',
      `DELETE FROM association_enquiries WHERE workspace_id=$1
        AND status IN ('resolved','spam') AND updated_at < $2`,
      [workspaceId, before])
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

export async function listCrmOperationsAudit(workspaceId: string, limit = 50) {
  const result = await query<{
    id: string; action: string; subjectKind: string; subjectId: string
    actorKind: string; occurredAt: Date; details: Record<string, unknown>
  }>(
    `SELECT id,action,subject_kind AS "subjectKind",subject_id AS "subjectId",
            actor_kind AS "actorKind",created_at AS "occurredAt",metadata AS details
       FROM association_audit_log
      WHERE workspace_id=$1 AND action LIKE 'crm.%'
      ORDER BY created_at DESC,id DESC LIMIT $2`,
    [workspaceId, Math.min(Math.max(limit, 1), 100)],
  )
  return result.rows
}

export async function listCrmEventDelivery(workspaceId: string, limit = 50) {
  const result = await query<{
    id: string; eventType: string; subjectKind: string; subjectId: string
    status: string; attempts: number; occurredAt: Date; deliveredAt: Date | null
  }>(
    `SELECT id,event_type AS "eventType",subject_kind AS "subjectKind",
            subject_id AS "subjectId",status,attempts,
            occurred_at AS "occurredAt",delivered_at AS "deliveredAt"
       FROM crm_domain_event_outbox
      WHERE workspace_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT $2`,
    [workspaceId, Math.min(Math.max(limit, 1), 100)],
  )
  return result.rows
}
