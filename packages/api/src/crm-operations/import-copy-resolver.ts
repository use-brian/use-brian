/** Complete CRM CSV consumer proof and canonical retirement. [COMP:crm/privacy-copies] */
import type { PoolClient } from 'pg'
import type { CrmPrivacyBlocker } from '@use-brian/core/crm/operations-types.js'
import { readCrmPrivacyPolicy } from './privacy-policy.js'

export async function prepareCrmImportCopies(client: PoolClient, workspaceId: string, contactId: string | null): Promise<void> {
  await client.query(`CREATE TEMP TABLE IF NOT EXISTS crm_privacy_copy_import_sources(id uuid PRIMARY KEY) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS crm_privacy_copy_import_jobs(id uuid PRIMARY KEY) ON COMMIT DROP;
    TRUNCATE pg_temp.crm_privacy_copy_import_sources,pg_temp.crm_privacy_copy_import_jobs`)
  await client.query(`WITH source_hashes AS(
      SELECT s.source_hash FROM crm_import_sources s JOIN crm_import_jobs j ON j.workspace_id=s.workspace_id AND j.source_id=s.id
        JOIN crm_import_rows r ON r.workspace_id=j.workspace_id AND r.job_id=j.id
      WHERE s.workspace_id=$1 AND r.entity_id=$2 AND NOT s.privacy_erased)
    INSERT INTO pg_temp.crm_privacy_copy_import_sources
    SELECT s.id FROM crm_import_sources s WHERE s.workspace_id=$1
      AND ($2::uuid IS NULL OR s.source_hash IN(SELECT source_hash FROM source_hashes))`, [workspaceId, contactId])
  await client.query(`INSERT INTO pg_temp.crm_privacy_copy_import_jobs
    SELECT j.id FROM crm_import_jobs j JOIN pg_temp.crm_privacy_copy_import_sources s ON s.id=j.source_id
    WHERE j.workspace_id=$1`, [workspaceId])
}

export async function inspectCrmImportCopyConflicts(client: PoolClient, workspaceId: string, contactId: string): Promise<CrmPrivacyBlocker[]> {
  const sources = await client.query<{ id: string; privacy_lineage_version: number; unprocessed: boolean }>(`SELECT t.id,t.privacy_lineage_version,
      NOT EXISTS(SELECT 1 FROM crm_import_jobs j WHERE j.workspace_id=t.workspace_id AND j.source_id=t.id) AS unprocessed
    FROM crm_import_sources t JOIN pg_temp.crm_privacy_copy_import_sources s ON s.id=t.id
    WHERE t.workspace_id=$1 AND NOT t.privacy_erased ORDER BY t.id`, [workspaceId])
  const unknown = await client.query<{ count: number }>(`SELECT count(*)::int count FROM crm_import_sources
    WHERE workspace_id=$1 AND NOT privacy_erased AND privacy_lineage_version=0`, [workspaceId])
  const blockers: CrmPrivacyBlocker[] = []
  if (unknown.rows[0]?.count) blockers.push({ domain: 'crm_import_sources', reason: 'import_source_legacy_lineage_dependency', count: unknown.rows[0].count })
  if (!sources.rowCount) return blockers
  const policy = (await readCrmPrivacyPolicy(workspaceId, client)).policy.importSourceErasure
  const add = (reason: string, count: number) => { if (count) blockers.push({ domain: 'crm_import_sources', reason, count }) }
  if (!policy) add('import_source_erasure_policy_unconfigured', sources.rows.length)
  add('import_source_retention_hold', sources.rows.filter(s => policy?.heldSourceIds.includes(s.id)).length)
  add('import_source_unprocessed_copy_dependency', sources.rows.filter(s => s.unprocessed).length)
  const jobs = await client.query<{ execution: number; attribution: number; receipts: number }>(`SELECT
    count(*) FILTER(WHERE j.privacy_erased OR j.status<>'completed' OR j.total_rows<=0
      OR j.failed_rows<>0 OR j.processed_rows<>j.total_rows OR j.succeeded_rows<>j.total_rows)::int AS execution,
    count(*) FILTER(WHERE EXISTS(SELECT 1 FROM crm_import_rows r WHERE r.workspace_id=$1 AND r.job_id=j.id
      AND (r.entity_id IS DISTINCT FROM $2::uuid OR r.status<>'completed')))::int AS attribution,
    count(*) FILTER(WHERE
      (SELECT count(*) FROM crm_import_rows r WHERE r.workspace_id=$1 AND r.job_id=j.id)<>j.total_rows
      OR EXISTS(SELECT 1 FROM crm_import_rows r WHERE r.workspace_id=$1 AND r.job_id=j.id
        AND (r.row_number<2 OR r.row_number>j.total_rows+1))
      OR EXISTS(SELECT 1 FROM crm_import_errors e WHERE e.workspace_id=$1 AND e.job_id=j.id)
      OR j.next_chunk_index<>(j.total_rows+49)/50
      OR (SELECT count(*) FROM crm_import_chunks c WHERE c.workspace_id=$1 AND c.job_id=j.id)<>j.next_chunk_index
      OR EXISTS(SELECT 1 FROM crm_import_chunks c WHERE c.workspace_id=$1 AND c.job_id=j.id
        AND (c.status<>'completed' OR c.failed_rows<>0 OR c.chunk_index>=j.next_chunk_index
          OR c.processed_rows<>least(50,j.total_rows-c.chunk_index*50) OR c.succeeded_rows<>c.processed_rows))
    )::int AS receipts
    FROM crm_import_jobs j JOIN pg_temp.crm_privacy_copy_import_jobs s ON s.id=j.id WHERE j.workspace_id=$1`, [workspaceId, contactId])
  add('import_source_execution_dependency', jobs.rows[0]?.execution ?? 0)
  add('shared_or_unattributed_import_source', jobs.rows[0]?.attribution ?? 0)
  add('import_source_receipt_dependency', jobs.rows[0]?.receipts ?? 0)
  return blockers
}

/** Caller holds exclusive privacy admission and has resolved the entire copy set. */
export async function retireCrmImportCopies(client: PoolClient, workspaceId: string): Promise<void> {
  const policy = await readCrmPrivacyPolicy(workspaceId, client)
  if (!policy.policy.importSourceErasure) return // No eligible source can pass the caller's assertion without a policy.
  await client.query(`UPDATE crm_import_jobs SET privacy_erased=true,privacy_erased_at=clock_timestamp(),
    mapping='{"columns":{}}'::jsonb,mapping_hash=repeat('0',64),source_hash=repeat('0',64),trusted_identity=false,
    integration_grants='[]'::jsonb,created_by_user_id=NULL,confirmed_by_user_id=NULL
    WHERE workspace_id=$1 AND NOT privacy_erased AND id IN(SELECT id FROM pg_temp.crm_privacy_copy_import_jobs)`, [workspaceId])
  for (const table of ['crm_import_errors', 'crm_import_chunks', 'crm_import_rows']) {
    await client.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND job_id IN(SELECT id FROM pg_temp.crm_privacy_copy_import_jobs)`, [workspaceId])
  }
  await client.query(`UPDATE crm_import_sources SET privacy_erased=true,content_bytes=''::bytea,
    source_hash=repeat('0',64),integration_grants='[]'::jsonb,retired_at=statement_timestamp(),
    replay_policy_version=$2,replay_expires_at=statement_timestamp()+$3::integer*interval '1 second'
    WHERE workspace_id=$1 AND NOT privacy_erased AND id IN(SELECT id FROM pg_temp.crm_privacy_copy_import_sources)`,
    [workspaceId, policy.version, policy.policy.importSourceErasure.receiptRetentionSeconds])
}
