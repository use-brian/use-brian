/** Durable outcome reads before returning copied content. [COMP:crm/privacy-copies] */
import { intersectAccessCeilings, type AccessCeiling, type ScopeEvidence, type WorkflowRunOutcome } from '@use-brian/core'
import type { PoolClient } from 'pg'
import { getPool, applyRLSGucs } from '../db/client.js'
import { acquireCrmPrivacyWriterAdmission } from './privacy-admission.js'
import { parseWorkflowCopyEvidence } from '../context-scope/workflow-input-evidence.js'
import { validateAudienceScopeEvidence } from '../context-scope/caller-evidence.js'
import { currentAgentAccess } from '../db/agent-access-context.js'
import { resolveOperationCeilingsSystem } from '../db/workspace-store.js'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from '../context-scope/department-resolver.js'

async function outcomeEvidenceAllowed(client: PoolClient, workspaceId: string, userId: string, evidence: ScopeEvidence): Promise<boolean> {
  try {
    const ambient = currentAgentAccess()
    if (ambient?.workspaceId !== undefined && ambient.workspaceId !== workspaceId
      || ambient?.userId !== undefined && ambient.userId !== userId
      || ambient?.sharedAudience && evidence.sources?.some(source => source.userId !== null)) return false
    const assistantId = ambient?.departmentRead?.assistantId ?? null
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [workspaceId])
    await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId,userId])
    await client.query('SELECT id FROM assistants WHERE workspace_id=$1 AND id=$2 FOR SHARE', [workspaceId,assistantId])
    await client.query('SELECT id FROM department_edges WHERE workspace_id=$1 AND (user_id=$2 OR assistant_id=$3) ORDER BY id FOR SHARE', [workspaceId,userId,assistantId])
    const execute: typeof import('../db/client.js').query = (sql, values) => client.query(sql, values)
    const member = await resolveOperationCeilingsSystem(userId,workspaceId,'confidential',null,true,execute)
    let ceiling: AccessCeiling = { workspaceId,userId,clearance:member.clearance,compartments:member.compartments,
      mutationCompartments:member.mutationCompartments,projectIds:null,visibilityAssistantIds:null }
    if (member.departmentReadV2) {
      const input = { workspaceId,userId,assistantId }
      const { snapshot,principal } = await loadDepartmentSnapshot(
        <R>(sql: string, values: unknown[]) => client.query(sql,values) as unknown as Promise<{rows:R[]}>,input)
      if (principal.kind !== 'user') return false
      ceiling.departmentRead = resolveDepartmentReadGrant(snapshot,principal,input,new Date())
    }
    if (ambient) ceiling = intersectAccessCeilings(ceiling,{workspaceId,userId,clearance:ambient.clearance,
      compartments:ambient.compartments === undefined ? [] : ambient.compartments,
      mutationCompartments:ambient.mutationCompartments === undefined ? ambient.compartments === undefined ? [] : ambient.compartments : ambient.mutationCompartments,
      projectIds:ambient.projectIds ?? null,visibilityAssistantIds:ambient.visibilityAssistantIds ?? null,
      ...(ambient.departmentRead ? {departmentRead:ambient.departmentRead} : {})})
    await validateAudienceScopeEvidence(evidence,ceiling,client)
    return true
  } catch { return false }
}

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
    const source=(await client.query<{id:string;outcome:WorkflowRunOutcome|null;privacy_erased:boolean;scopeEvidence:unknown}>(`
      SELECT id,outcome,privacy_erased,vars->'__contextScopeEvidence' AS "scopeEvidence" FROM workflow_runs WHERE workflow_id=$1 AND workspace_id=$2
        AND id<>$3 AND status IN ('completed','failed','timeout')
      ORDER BY finished_at DESC NULLS LAST,started_at DESC,id DESC LIMIT 1 FOR SHARE`,
    [workflowId,target.workspace_id,runId])).rows[0]
    const evidence = parseWorkflowCopyEvidence(source?.scopeEvidence)
    if(!source?.outcome || source.privacy_erased || !evidence){await client.query('COMMIT');return null}
    const admitted=async()=>(await client.query<{allowed:boolean}>(
      'SELECT workflow_run_department_visible($1) AND workflow_run_department_visible($2) AS allowed',
      [runId,source.id])).rows[0]?.allowed===true
    if(!await admitted() || !await outcomeEvidenceAllowed(client,target.workspace_id,target.actor,evidence)){await client.query('COMMIT');return null}
    const record=(await client.query<{id:string;fields:Record<string,unknown>;status:string;allowed:boolean}>(`
      SELECT id,fields,status,crm_scope_snapshot_allows(read_scope_review_source(workspace_id,'blueprint_record',id),workspace_id,$3,NULL,NULL) AS allowed FROM blueprint_records WHERE workspace_id=$1
        AND source_kind IN ('workflow','research') AND source_id=$2
      ORDER BY updated_at DESC,id DESC LIMIT 1 FOR SHARE`,[target.workspace_id,source.id,target.actor])).rows[0]
    if(record&&record.allowed!==true){await client.query('ROLLBACK');return null}
    await client.query(`INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[target.workspace_id,runId,source.id])
    const receipt=(await client.query<{matches:boolean}>(`SELECT s.blueprint_source IS NOT NULL
      AND s.run_scope_evidence IS NOT NULL AND s.run_source_version=r.derivation_source_version
      AND s.run_scope_evidence IS NOT DISTINCT FROM r.vars->'__contextScopeEvidence'
      AND s.blueprint_source IS NOT DISTINCT FROM CASE WHEN $4::uuid IS NULL THEN 'null'::jsonb
        ELSE read_scope_source($1,'blueprint_record',$4) END AS matches
      FROM workflow_run_copy_sources s JOIN workflow_runs r ON r.id=s.source_run_id AND r.workspace_id=s.workspace_id
      WHERE s.workspace_id=$1 AND s.run_id=$2 AND s.source_run_id=$3`,
      [target.workspace_id,runId,source.id,record?.id??null])).rows[0]
    if(receipt?.matches!==true){await client.query('ROLLBACK');return null}
    const outcome=record?{...source.outcome,output:record.fields??{},outputStatus:record.status}:source.outcome
    const currentSources=(await client.query<{allowed:boolean}>(`SELECT
      workflow_crm_scope_visible($1) AND workflow_crm_scope_visible($2)
      AND ($3::uuid IS NULL OR crm_scope_snapshot_allows(read_scope_review_source($4,'blueprint_record',$3),$4,$5,NULL,NULL)) AS allowed`,
      [runId,source.id,record?.id??null,target.workspace_id,target.actor])).rows[0]?.allowed
    if(!await admitted()||currentSources!==true || !await outcomeEvidenceAllowed(client,target.workspace_id,target.actor,evidence)){await client.query('ROLLBACK');return null}
    await client.query('COMMIT')
    return outcome as WorkflowRunOutcome
  } catch {
    await client.query('ROLLBACK').catch(()=>{})
    // The executor can omit auxiliary lastRun context. It must never receive
    // the copied body if attribution, admission, enrichment or commit failed.
    throw new Error('Workflow outcome copy could not be recorded')
  } finally {client.release()}
}
