/** Explicit policy and receipt retirement in the caller's transaction. [COMP:crm/operations-privacy] */
import type { PoolClient } from 'pg'
import { CrmOperationsError, canonicalCrmRequest, type CrmOperationsCommand, type CrmOperationsContext, type CrmRetentionPolicy } from '@use-brian/core'
import { query } from '../db/client.js'

type Policy = { retention?: CrmRetentionPolicy | null; intakeReplay: { retentionSeconds: number } | null; addressSuppression?: { retentionSeconds: number } | null
  importSourceErasure?: { receiptRetentionSeconds: number; heldSourceIds: string[] } | null }
type PolicyRecord = {
  id: string | null
  version: number
  policy: Policy
  approvedByUserId: string | null
  createdAt: Date | null
}
const projection = `id,version,policy,approved_by_user_id AS "approvedByUserId",created_at AS "createdAt"`
export async function readCrmPrivacyPolicy(workspaceId: string, client?: PoolClient): Promise<PolicyRecord> {
  const result = await (client ? client.query.bind(client) : query)<PolicyRecord>(
    `SELECT ${projection} FROM crm_privacy_policies WHERE workspace_id=$1 ORDER BY version DESC LIMIT 1`, [workspaceId])
  return result.rows[0] ?? { id: null, version: 0, policy: { intakeReplay: null }, approvedByUserId: null, createdAt: null }
}

export async function saveCrmPrivacyPolicy(
  client: PoolClient, context: CrmOperationsContext,
  command: Extract<CrmOperationsCommand, { kind: 'save_privacy_policy' }>,
): Promise<{ record: PolicyRecord; created: boolean }> {
  if (context.actor.kind !== 'user') throw new CrmOperationsError('not_authorized', 'A member must approve privacy policy.')
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`crm-privacy-policy:${context.workspaceId}`])
  const role = await client.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`,
    [context.workspaceId, context.actor.userId])
  if (!['owner', 'admin'].includes(role.rows[0]?.role ?? '')) {
    throw new CrmOperationsError('not_authorized', 'Current workspace owner or admin membership is required.')
  }
  const current = await readCrmPrivacyPolicy(context.workspaceId, client)
  if (current.version !== command.expectedVersion) {
    throw new CrmOperationsError('conflict', 'Privacy policy changed. Reload it before approving.', { reason: 'stale_privacy_policy_version' })
  }
  const addressSuppression = command.addressSuppression === undefined ? current.policy.addressSuppression ?? null : command.addressSuppression
  const requestedSourcePolicy = command.importSourceErasure === undefined ? current.policy.importSourceErasure ?? null : command.importSourceErasure
  const importSourceErasure = requestedSourcePolicy && { ...requestedSourcePolicy,
    heldSourceIds: requestedSourcePolicy.heldSourceIds.map(id => id.toLowerCase()).sort() }
  if (command.importSourceErasure && importSourceErasure!.heldSourceIds.length) {
    const held = await client.query('SELECT id FROM crm_import_sources WHERE workspace_id=$1 AND id=ANY($2::uuid[]) FOR KEY SHARE',
      [context.workspaceId, importSourceErasure!.heldSourceIds])
    if (held.rowCount !== importSourceErasure!.heldSourceIds.length) {
      throw new CrmOperationsError('invalid_input', 'Source holds must reference sources in this workspace.')
    }
  }
  const requestedRetention = command.retention === undefined ? current.policy.retention ?? null : command.retention
  const retention = requestedRetention && { ...requestedRetention,
    openSubmissions: requestedRetention.openSubmissions && { ...requestedRetention.openSubmissions, fields: [...requestedRetention.openSubmissions.fields].sort() },
    holds: requestedRetention.holds.map(h => ({...h,id:h.id.toLowerCase()})).sort((a,b) => `${a.domain}:${a.id}`.localeCompare(`${b.domain}:${b.id}`)) }
  if (command.retention && retention) {
    const tables = { contact: 'entities', submission: 'association_enquiries', order: 'association_orders', file: 'workspace_files' } as const
    for (const domain of Object.keys(tables) as (keyof typeof tables)[]) {
      const ids = retention.holds.filter(h => h.domain === domain).map(h => h.id)
      if (!ids.length) continue
      const held = await client.query(`SELECT id FROM ${tables[domain]} WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ${domain==='contact' ? "AND kind='person'" : ''} FOR KEY SHARE`, [context.workspaceId,ids])
      if (held.rowCount !== ids.length) throw new CrmOperationsError('invalid_input', 'Retention holds must reference records in this workspace.')
    }
  }
  const policy: Policy = { intakeReplay: command.intakeReplay,
    ...(command.retention !== undefined || Object.hasOwn(current.policy,'retention') ? { retention } : {}),
    ...(command.addressSuppression !== undefined || Object.hasOwn(current.policy,'addressSuppression') ? { addressSuppression } : {}),
    ...(command.importSourceErasure !== undefined || Object.hasOwn(current.policy,'importSourceErasure') ? { importSourceErasure } : {}) }
  if (current.version > 0 && current.policy.intakeReplay?.retentionSeconds === command.intakeReplay?.retentionSeconds
    && current.policy.addressSuppression?.retentionSeconds === addressSuppression?.retentionSeconds
    && canonicalCrmRequest(current.policy.retention ?? null) === canonicalCrmRequest(retention)
    && canonicalCrmRequest(current.policy.importSourceErasure ?? null) === canonicalCrmRequest(importSourceErasure)) {
    // Explicitly reapprove a scheduled policy whose original approver lost
    // authority. Unrelated edits and still-authorized approvals remain no-ops.
    const reapprove = command.retention?.scheduled === true && !(await client.query(
      "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role IN('owner','admin') FOR SHARE",
      [context.workspaceId,current.approvedByUserId])).rowCount
    if (!reapprove) return { record: current, created: false }
  }
  const saved = await client.query<PolicyRecord>(
    `INSERT INTO crm_privacy_policies(workspace_id,version,policy,approved_by_user_id)
     VALUES($1,$2,$3::jsonb,$4) RETURNING ${projection}`,
    [context.workspaceId, current.version + 1, JSON.stringify(policy), context.actor.userId])
  return { record: saved.rows[0]!, created: true }
}

/** Parents must be locked by the purge/retention caller before invoking this hook. */
export async function retireCrmIntakeReceipts(
  client: PoolClient, workspaceId: string,
  subject: { contactId: string } | { submissionIds: string[] },
  expiryAt?: Date,
): Promise<number> {
  const predicate = 'contactId' in subject ? 'contact_id=$2::uuid' : 'submission_id=ANY($2::uuid[])'
  const value = 'contactId' in subject ? subject.contactId : subject.submissionIds
  const candidates = await client.query<{ id: string; replay_policy_version: number | null }>(
    `SELECT id,replay_policy_version FROM crm_intake_idempotency
      WHERE workspace_id=$1 AND status='committed' AND ${predicate} ORDER BY id FOR UPDATE`, [workspaceId, value])
  if (!candidates.rows.length) return 0
  const policy = candidates.rows.some((row) => row.replay_policy_version === null)
    ? await readCrmPrivacyPolicy(workspaceId, client) : null
  if (policy && !policy.policy.intakeReplay) {
    throw new CrmOperationsError('conflict', 'Approve an intake replay period before retiring these submissions.',
      { reason: 'intake_replay_policy_unconfigured' })
  }
  const ids = candidates.rows.map((row) => row.id)
  await client.query(
    `UPDATE crm_intake_idempotency SET status='retired',retired_at=clock_timestamp(),
      submission_id=NULL,contact_id=NULL,follow_up_task_id=NULL,
      replay_policy_version=COALESCE(replay_policy_version,$3::integer),
      replay_expires_at=COALESCE(replay_expires_at,created_at+$4::integer*interval '1 second')
      WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,
    [workspaceId, ids, policy?.version ?? null, policy?.policy.intakeReplay?.retentionSeconds ?? null])
  const expired = await client.query(
    `DELETE FROM crm_intake_idempotency WHERE workspace_id=$1 AND id=ANY($2::uuid[])
      AND status='retired' AND replay_expires_at<=${expiryAt ? '$3::timestamptz' : 'clock_timestamp()'}`, expiryAt ? [workspaceId, ids, expiryAt] : [workspaceId, ids])
  return expired.rowCount ?? 0
}
