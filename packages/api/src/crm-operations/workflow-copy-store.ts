/** Durable outcome reads before returning copied content. [COMP:crm/privacy-copies] */
import type { WorkflowRunOutcome } from '@use-brian/core'
import { getPool, applyRLSGucs } from '../db/client.js'
import { acquireCrmPrivacyWriterAdmission } from './privacy-admission.js'

export async function readWorkflowOutcomeWithLineage(workflowId:string,runId:string):Promise<WorkflowRunOutcome|null> {
  const client=await getPool().connect()
  try {
    await client.query('BEGIN')
    const target=(await client.query<{workspace_id:string;actor:string|null}>(`SELECT r.workspace_id,coalesce(r.triggered_by,w.created_by) AS actor
      FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id
      WHERE r.id=$1 AND r.workflow_id=$2`,[runId,workflowId])).rows[0]
    if(!target){await client.query('COMMIT');return null}
    if(!target.actor)throw new Error('Workflow actor unavailable')
    await applyRLSGucs(client,target.actor)
    await acquireCrmPrivacyWriterAdmission(client,target.workspace_id)
    const live=await client.query(`SELECT id FROM workflow_runs WHERE id=$1 AND workspace_id=$2
      AND workflow_id=$3 AND NOT privacy_erased FOR KEY SHARE`,[runId,target.workspace_id,workflowId])
    if(!live.rowCount){await client.query('COMMIT');return null}
    // Keep the newest terminal receipt in the ordering. An erased latest run
    // supplies no outcome; falling back to an older run would revive old state.
    const source=(await client.query<{id:string;outcome:WorkflowRunOutcome|null;privacy_erased:boolean}>(`
      SELECT id,outcome,privacy_erased FROM workflow_runs WHERE workflow_id=$1 AND workspace_id=$2
        AND id<>$3 AND status IN ('completed','failed','timeout')
      ORDER BY finished_at DESC NULLS LAST,started_at DESC,id DESC LIMIT 1 FOR KEY SHARE`,
    [workflowId,target.workspace_id,runId])).rows[0]
    if(!source?.outcome || source.privacy_erased){await client.query('COMMIT');return null}
    await client.query(`INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[target.workspace_id,runId,source.id])
    const record=(await client.query<{fields:Record<string,unknown>;status:string}>(`
      SELECT fields,status FROM blueprint_records WHERE workspace_id=$1
        AND source_kind IN ('workflow','research') AND source_id=$2
      ORDER BY updated_at DESC,id DESC LIMIT 1`,[target.workspace_id,source.id])).rows[0]
    const outcome=record?{...source.outcome,output:record.fields??{},outputStatus:record.status}:source.outcome
    await client.query('COMMIT')
    return outcome as WorkflowRunOutcome
  } catch {
    await client.query('ROLLBACK').catch(()=>{})
    // The executor can omit auxiliary lastRun context. It must never receive
    // the copied body if attribution, admission, enrichment or commit failed.
    throw new Error('Workflow outcome copy could not be recorded')
  } finally {client.release()}
}
