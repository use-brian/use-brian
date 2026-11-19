/** Workflow copy eligibility and canonical retirement. [COMP:crm/privacy-copies] */
import type {PoolClient} from 'pg'
import type {CrmPrivacyBlocker} from '@use-brian/core/crm/operations-types.js'

export async function inspectWorkflowCopyConflicts(client:PoolClient,workspaceId:string):Promise<CrmPrivacyBlocker[]> {
  const result=await client.query<{reason:string;count:number}>(`WITH selected AS(
    SELECT r.* FROM workflow_runs r JOIN pg_temp.crm_privacy_copy_workflows c ON c.id=r.id
      WHERE r.workspace_id=$1 AND NOT r.privacy_erased
  ), checks AS(
    SELECT 'workflow_legacy_lineage_dependency' reason,count(*)::int count FROM selected WHERE privacy_lineage_version=0
    UNION ALL
    SELECT 'workflow_execution_dependency',count(*)::int FROM selected r WHERE NOT (
      (status='pending' AND claimed_at IS NULL AND claim_attempts=0
        AND NOT EXISTS(SELECT 1 FROM workflow_step_runs s WHERE s.run_id=r.id))
      OR status='completed')
    UNION ALL
    SELECT 'workflow_artifact_dependency',count(*)::int FROM selected r WHERE
      EXISTS(SELECT 1 FROM workflow_step_runs s WHERE s.run_id=r.id AND (s.step_type<>'branch' OR s.status<>'completed'))
      OR EXISTS(SELECT 1 FROM pending_approvals a WHERE a.workflow_run_id=r.id OR a.workflow_step_run_id IN(SELECT id FROM workflow_step_runs WHERE run_id=r.id))
      OR EXISTS(SELECT 1 FROM scheduled_jobs j WHERE j.workflow_step_run_id IN(SELECT id FROM workflow_step_runs WHERE run_id=r.id))
      OR EXISTS(SELECT 1 FROM blueprint_records b WHERE b.source_kind IN('workflow','research') AND b.source_id=r.id::text)
    UNION ALL
    SELECT 'workflow_replay_dependency',count(*)::int FROM selected r WHERE
      r.webhook_idempotency_key IS NOT NULL AND (r.crm_event_id IS NULL
        OR r.webhook_idempotency_key<>'crm:'||r.crm_event_id::text)
    UNION ALL
    SELECT 'shared_workflow_copy_dependency',count(*)::int FROM selected r WHERE
      (r.crm_event_id IS NOT NULL AND r.crm_event_id NOT IN(SELECT id FROM pg_temp.crm_privacy_copy_events))
      OR (r.crm_event_id IS NULL AND r.privacy_lineage_version=1 AND r.input<>'{}'::jsonb)
      OR EXISTS(SELECT 1 FROM workflow_run_copy_sources s WHERE s.workspace_id=$1 AND s.run_id=r.id
        AND s.source_run_id NOT IN(SELECT id FROM pg_temp.crm_privacy_copy_workflows))
  ) SELECT * FROM checks WHERE count>0`,[workspaceId])
  return result.rows.map(row=>({domain:'workflow_runs',reason:row.reason,count:row.count}))
}

/** Caller already validated the captured set under exclusive privacy admission. */
export async function retireWorkflowCopies(client:PoolClient,workspaceId:string):Promise<void> {
  await client.query(`DELETE FROM workflow_step_runs s USING workflow_runs r
    WHERE s.run_id=r.id AND r.workspace_id=$1 AND NOT r.privacy_erased
      AND r.id IN(SELECT id FROM pg_temp.crm_privacy_copy_workflows)`,[workspaceId])
  await client.query(`UPDATE workflow_runs r SET privacy_erased=true,privacy_erased_at=clock_timestamp(),
    status=CASE WHEN status='pending' THEN 'failed' ELSE status END,
    finished_at=COALESCE(finished_at,clock_timestamp()),input='{}',vars='{}',outcome=NULL,error=NULL,
    triggered_by=NULL,trigger_page_id=NULL,current_step_id=NULL,claimed_at=NULL,
    webhook_body_sha256=CASE WHEN webhook_idempotency_key IS NULL THEN NULL ELSE repeat('0',64) END
    WHERE r.workspace_id=$1 AND NOT r.privacy_erased
      AND r.id IN(SELECT id FROM pg_temp.crm_privacy_copy_workflows)`,[workspaceId])
}
