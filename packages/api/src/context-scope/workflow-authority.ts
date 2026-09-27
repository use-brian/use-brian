import { accessCeilingContains, ContextScopeAccumulator, intersectAccessCeilings, pinAccessCeiling, scopeGrantContains, unionScopeRequirements, WORKFLOW_SCOPE_EVIDENCE_VAR, type AccessCeiling, type WorkflowRunRecord } from '@use-brian/core'
import { query, queryWithRLS, runWithAgentAccess } from '../db/client.js'
import { findAssistantById } from '../db/users.js'
import { resolveOperationCeilingsSystem } from '../db/workspace-store.js'
import { resolveLiveAccessCeilingSystem, resolveTurnScopeSystem, type ResolvedTurnScope } from './resolve-turn-scope.js'
import { createAuthorityLease, executeWithCurrentAuthority, runWithAuthorityLease } from './authority-lease.js'
import { readWorkflowInputEvidence } from './workflow-input-evidence.js'
import { validateCallerScopeEvidence } from './caller-evidence.js'

type GoalBinding = { id: string; contextGroupId: string | null; contextProjectId: string | null }
type StoredAuthority = { version: 1; assistantId: string; ceiling: AccessCeiling; sourceGoal?: GoalBinding | null }
function unavailable(): Error {
  return Object.assign(new Error('Workflow execution permissions are missing or changed. Review permissions and start a new run.'), { reason: 'workflow_authority_unavailable' })
}

/** The durable run binding survives edits to input and cannot change actors. */
async function readGoalBinding(runId: string, workspaceId: string, userId: string): Promise<GoalBinding | null> {
  const row = (await query<{
    source: string | null; id: string | null; actor: string | null;
    contextGroupId: string | null; contextProjectId: string | null;
  }>(`SELECT r.source_goal_id AS source,g.id,g.created_by_user_id AS actor,
      g.context_group_id AS "contextGroupId",g.context_project_id AS "contextProjectId"
    FROM workflow_runs r LEFT JOIN goals g ON g.id=r.source_goal_id AND g.workspace_id=r.workspace_id
    WHERE r.id=$1 AND r.workspace_id=$2`, [runId,workspaceId])).rows[0]
  if (!row || (row.source && (!row.id || row.actor !== userId))) throw unavailable()
  return row.source ? { id:row.id!, contextGroupId:row.contextGroupId, contextProjectId:row.contextProjectId } : null
}

function sameGoalBinding(a: GoalBinding | null | undefined, b: GoalBinding | null): boolean {
  return (a?.id ?? null) === (b?.id ?? null) && (a?.contextGroupId ?? null) === (b?.contextGroupId ?? null)
    && (a?.contextProjectId ?? null) === (b?.contextProjectId ?? null)
}

/** Server-owned run snapshot; never accepted from workflow input or run vars. */
async function resolveWorkflowRunSnapshot(params: {
  userId: string; assistantId: string; workspaceId: string; run: WorkflowRunRecord
}): Promise<{ turnScope: ResolvedTurnScope; assistantClearance: import('@use-brian/core').Sensitivity; sourceGoal: GoalBinding | null }> {
  const { userId, assistantId, workspaceId, run } = params
  const readStored = async () => (await query<{ status: string; authority: StoredAuthority | null; actor: string | null }>(
    `SELECT r.status, r.execution_authority AS authority, COALESCE(r.triggered_by,w.created_by) AS actor
       FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id
      WHERE r.id=$1 AND r.workspace_id=$2`, [run.id, workspaceId],
  )).rows[0]
  let row = await readStored()
  if (!row || row.actor !== userId) throw unavailable()
  if (!row.authority && row.status !== 'pending') throw unavailable()
  const assistant = await findAssistantById(assistantId)
  if (!assistant || assistant.workspaceId !== workspaceId) throw unavailable()
  const sourceGoal = await readGoalBinding(run.id, workspaceId, userId)
  let scope: ResolvedTurnScope
  try { scope = await resolveTurnScopeSystem({
    userId, assistant, workspaceId,
    key: { contextGroupId:run.contextGroupId ?? null, contextProjectId:run.contextProjectId ?? null, contextLockedAt:run.startedAt },
  }, { resolveReadCeilings:(actor, workspace, clearance, compartments) =>
    resolveOperationCeilingsSystem(actor,workspace,clearance,compartments,true) })
  } catch { throw unavailable() }
  if (sourceGoal) {
    try {
      const goalScope = await resolveTurnScopeSystem({ userId,assistant,workspaceId,key:sourceGoal }, {
        resolveReadCeilings:(actor,workspace,clearance,compartments) =>
          resolveOperationCeilingsSystem(actor,workspace,clearance,compartments,true),
      })
      const bounded = intersectAccessCeilings(pinAccessCeiling(scope.access),pinAccessCeiling(goalScope.access))
      const writeCompartments = unionScopeRequirements(scope.writeCompartments,goalScope.writeCompartments)
      const writeProjectIds = unionScopeRequirements(scope.writeProjectIds,goalScope.writeProjectIds)
      if (!scopeGrantContains(bounded.mutationCompartments,writeCompartments)
        || !scopeGrantContains(bounded.projectIds,writeProjectIds)) throw unavailable()
      scope = { ...scope, access:{ ...scope.access,...bounded },
        effectiveCompartments:bounded.compartments,effectiveProjectIds:bounded.projectIds,
        activeGroupId:scope.activeGroupId ?? goalScope.activeGroupId,
        activeProjectId:scope.activeProjectId ?? goalScope.activeProjectId,
        activeTeam:scope.activeTeam ?? goalScope.activeTeam,activeProject:scope.activeProject ?? goalScope.activeProject,
        writeCompartments,writeProjectIds }
    } catch { throw unavailable() }
  }
  const current = pinAccessCeiling(scope.access)
  if (!row.authority) {
    const authority: StoredAuthority = { version:1, assistantId, ceiling:current, sourceGoal }
    // Compare-and-set under the row lock: never overwrite a concurrent winner,
    // and never capture new authority after execution has started.
    await query(`UPDATE workflow_runs r SET execution_authority=$3::jsonb
      WHERE r.id=$1 AND r.workspace_id=$2 AND r.status='pending' AND r.execution_authority IS NULL
        AND r.current_step_id IS NULL AND r.vars='{}'::jsonb
        AND NOT EXISTS(SELECT 1 FROM workflow_step_runs s WHERE s.run_id=r.id)
        AND COALESCE(r.triggered_by,(SELECT w.created_by FROM workflows w WHERE w.id=r.workflow_id))=$4`,
    [run.id,workspaceId,JSON.stringify(authority),userId])
    row = await readStored()
  }
  const frozen = row?.authority
  if (row?.actor !== userId || !frozen || frozen.version !== 1 || frozen.assistantId !== assistantId
    || !sameGoalBinding(frozen.sourceGoal,sourceGoal)
    || frozen.ceiling?.workspaceId !== workspaceId || frozen.ceiling?.userId !== userId) throw unavailable()
  let bounded: AccessCeiling
  try {
    if (!accessCeilingContains(current,frozen.ceiling)) throw unavailable()
    bounded = intersectAccessCeilings(current,frozen.ceiling)
    if (!scopeGrantContains(bounded.mutationCompartments,scope.writeCompartments)
      || !scopeGrantContains(bounded.projectIds,scope.writeProjectIds)) throw unavailable()
  } catch { throw unavailable() }
  return { assistantClearance:assistant.clearance, sourceGoal, turnScope:{ ...scope,
    access:{ ...scope.access,...bounded }, effectiveCompartments:bounded.compartments,
    effectiveProjectIds:bounded.projectIds } }
}

/** Each advance owns a sticky lease, shared by its parallel steps and nested tools. */
export async function resolveWorkflowRunScope(params: Parameters<typeof resolveWorkflowRunSnapshot>[0]) {
  const resolved = await resolveWorkflowRunSnapshot(params)
  const sourceAvailable = async () => (await queryWithRLS<{allowed:boolean}>(params.userId,
    'SELECT workflow_crm_scope_visible($1) AS allowed', [params.run.id])).rows[0]?.allowed === true
  if (!await runWithAgentAccess(pinAccessCeiling(resolved.turnScope.access), sourceAvailable)) throw unavailable()
  let inputScopeEvidence: import('@use-brian/core').ScopeEvidence
  let persistedScopeEvidence: import('@use-brian/core').ScopeEvidence
  try {
    inputScopeEvidence = await validateCallerScopeEvidence(
      await readWorkflowInputEvidence(params.run.id,params.workspaceId),pinAccessCeiling(resolved.turnScope.access))
    const stored = (await query<{ evidence: import('@use-brian/core').ScopeEvidence | null }>(
      'SELECT vars->$3 AS evidence FROM workflow_runs WHERE id=$1 AND workspace_id=$2',
      [params.run.id,params.workspaceId,WORKFLOW_SCOPE_EVIDENCE_VAR])).rows[0]?.evidence
    persistedScopeEvidence = await validateCallerScopeEvidence(stored ?? {},pinAccessCeiling(resolved.turnScope.access))
    const combined = new ContextScopeAccumulator(inputScopeEvidence)
    combined.note(persistedScopeEvidence)
  } catch { throw unavailable() }
  const lease = createAuthorityLease(pinAccessCeiling(resolved.turnScope.access), async () => {
    const actor = (await query<{ actor: string | null }>(
      `SELECT COALESCE(r.triggered_by,w.created_by) AS actor FROM workflow_runs r
       JOIN workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id
       WHERE r.id=$1 AND r.workspace_id=$2`, [params.run.id, params.workspaceId],
    )).rows[0]?.actor
    const assistant = await findAssistantById(params.assistantId)
    if (actor !== params.userId || !assistant || assistant.workspaceId !== params.workspaceId || !await sourceAvailable()) return null
    try {
      await validateCallerScopeEvidence(inputScopeEvidence,pinAccessCeiling(resolved.turnScope.access))
      await validateCallerScopeEvidence(persistedScopeEvidence,pinAccessCeiling(resolved.turnScope.access))
      const fresh = await readWorkflowInputEvidence(params.run.id,params.workspaceId)
      // New causal inputs require a new advance, never silently widen this one.
      if (JSON.stringify(fresh.sources ?? []) !== JSON.stringify(inputScopeEvidence.sources ?? [])) return null
    } catch { return null }
    // A nested callee can narrow ambient execution access. Renewal checks the
    // actor's live metadata, never that narrower projection, and reads no content.
    const current = await resolveLiveAccessCeilingSystem({
      userId: params.userId, assistant, workspaceId: params.workspaceId,
      key: { contextGroupId: params.run.contextGroupId ?? null,
        contextProjectId: params.run.contextProjectId ?? null, contextLockedAt: params.run.startedAt },
    })
    const sourceGoal = await readGoalBinding(params.run.id,params.workspaceId,params.userId)
    if (!sameGoalBinding(resolved.sourceGoal,sourceGoal)) return null
    if (!sourceGoal) return current
    const goalCeiling = await resolveLiveAccessCeilingSystem({
      userId:params.userId,assistant,workspaceId:params.workspaceId,key:sourceGoal,
    })
    return intersectAccessCeilings(current,goalCeiling)
  })
  return {
    ...resolved,
    inputScopeEvidence,
    executeWithAuthority: <T>(operation: () => Promise<T>): Promise<T> =>
      runWithAgentAccess(pinAccessCeiling(resolved.turnScope.access), () =>
        runWithAuthorityLease(lease, () => executeWithCurrentAuthority(operation))),
  }
}
