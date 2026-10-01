/** AUTHORING only. Execution/resume must never call this default selector.
 * Caller owns the transaction through insertion. Human provenance is supplied
 * by a trusted server surface, not inferred from creator/owner or a snapshot.
 */
import type { PoolClient } from 'pg'
import { accessCeilingContains, pinAccessCeiling, parseAuthoringAuthority, type WorkflowTrigger, type AuthoringAuthority } from '@use-brian/core'
import { captureAuthoringAuthoritySystem, resolveWorkflowAuthoringScope } from '../context-scope/workflow-authority.js'
import { readAdmissionPolicy } from './admission-policy-read.js'
import { admitWorkspaceResource } from './resource-admission.js'
import { WorkspaceAccessError } from './policy.js'

export type OperationalHumanAuthor = {
  userId: string
  assistantId: string
  expectedPolicyRevision?: string
}

export async function lockOperationalPolicy(client: PoolClient, workspaceId: string) {
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
  return readAdmissionPolicy(client, workspaceId)
}

export async function admitOperationalAuthoring(client: PoolClient, input: {
  workspaceId: string
  userId: string
  contextGroupId?: string | null
  contextProjectId?: string | null
  authoringAuthority?: AuthoringAuthority | null
}, human?: OperationalHumanAuthor) {
  const policy = await lockOperationalPolicy(client, input.workspaceId)
  if (!policy || policy.setupState === 'legacy') return input
  if (policy.setupState !== 'ready') throw new WorkspaceAccessError('access_mode_setup_required', 409)
  if (!human || human.userId !== input.userId) throw new WorkspaceAccessError('operational_authoring_proof_required', 409)
  if (human.expectedPolicyRevision !== undefined && human.expectedPolicyRevision !== policy.revision) {
    throw new WorkspaceAccessError('access_policy_conflict', 409)
  }
  const assistant = (await client.query(`SELECT default_workspace_group_id AS "groupId",default_project_id AS "projectId"
    FROM assistants WHERE id=$1 AND workspace_id=$2`, [human.assistantId, input.workspaceId])).rows[0]
  const member = (await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [input.workspaceId, human.userId])).rows[0]
  if (!assistant || !member) throw new WorkspaceAccessError('context_not_available', 404)
  const contextGroupId = input.contextGroupId !== undefined ? input.contextGroupId
    : policy.mode === 'simple' ? policy.defaultDepartmentId : assistant.groupId
  const contextProjectId = input.contextProjectId !== undefined ? input.contextProjectId : assistant.projectId
  if (input.contextGroupId === undefined && !contextGroupId) {
    throw new WorkspaceAccessError(policy.mode === 'simple' ? 'access_mode_default_invalid' : 'context_selection_required', 409)
  }
  const params = { userId: human.userId, workspaceId: input.workspaceId, assistantId: human.assistantId,
    contextGroupId: contextGroupId ?? null, contextProjectId: contextProjectId ?? null }
  // Supplied consent is never replaced with fresh, broader consent.
  const authoringAuthority = input.authoringAuthority ?? await captureAuthoringAuthoritySystem(params, client)
  const scope = await resolveWorkflowAuthoringScope({ ...params, authoringAuthority }, client)
  // The preview intersects ambient execution (including private visibility).
  // Do not persist supplied consent broader than that validated projection.
  if (!accessCeilingContains(pinAccessCeiling(scope.access), authoringAuthority.ceiling)) {
    throw new WorkspaceAccessError('operational_authoring_proof_required', 409)
  }
  await admitWorkspaceResource(client, input.workspaceId, human.userId, {
    expectedPolicyRevision: human.expectedPolicyRevision, visibility: 'workspace', sensitivity: scope.access.clearance!,
    destination: contextGroupId ? { kind: 'department', departmentId: contextGroupId, ...(contextProjectId ? { projectId: contextProjectId } : {}) }
      : { kind: 'general', ...(contextProjectId ? { projectId: contextProjectId } : {}) },
  })
  return { ...input, contextGroupId: params.contextGroupId, contextProjectId: params.contextProjectId, authoringAuthority }
}

/** Schedules have no canonical authoring snapshot contract yet. Do not turn
 * an owner id, model binding, or legacy queue row into renewed consent. */
export async function assertLegacyJobCreation(client: PoolClient, assistantId: string) {
  const read = async (lock = false) => (await client.query(`SELECT workspace_id FROM assistants WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [assistantId])).rows[0]?.workspace_id
  const workspaceId = await read()
  const policy = workspaceId ? await lockOperationalPolicy(client, workspaceId) : undefined
  // Freeze even a non-workspace assistant against transfer into ready mode.
  if (await read(true) !== workspaceId) throw new WorkspaceAccessError('access_policy_conflict', 409)
  if (policy && policy.setupState !== 'legacy') throw new WorkspaceAccessError('operational_authoring_proof_required', 409)
}

/** Inheritance, never AUTHORING: revalidate the exact saved workflow principal
 * against live authority, with its persisted explicit binding and no defaults. */
export async function readWorkflowScheduleAuthority(client: PoolClient, workspaceId: string, workflowId: string) {
  await lockOperationalPolicy(client, workspaceId)
  const row = (await client.query<{
    id: string; userId: string; enabled: boolean; trigger: WorkflowTrigger;
    authority: unknown; contextGroupId: string | null; contextProjectId: string | null;
    compartments: string[]; snapshot: Record<string, unknown>;
  }>(`SELECT w.id,COALESCE(w.schedule_authoring_user_id,w.created_by) AS "userId",w.enabled,w.trigger,w.authoring_authority AS authority,
    w.context_group_id AS "contextGroupId",w.context_project_id AS "contextProjectId",
    CASE WHEN g.compartment_key IS NULL THEN ARRAY[]::text[] ELSE ARRAY[g.compartment_key] END AS compartments,
    jsonb_build_object('authority',w.authoring_authority,'definition',w.definition,'trigger',w.trigger,
      'groupId',w.context_group_id,'projectId',w.context_project_id,'userId',COALESCE(w.schedule_authoring_user_id,w.created_by),'workspaceId',w.workspace_id) AS snapshot
    FROM workflows w LEFT JOIN workspace_groups g ON g.id=w.context_group_id
    WHERE w.id=$1 AND w.workspace_id=$2 FOR SHARE OF w`, [workflowId, workspaceId])).rows[0]
  const authority = parseAuthoringAuthority(row?.authority)
  if (!row || !row.enabled || row.trigger.kind !== 'schedule' || !authority || authority.ceiling.userId !== row.userId) {
    throw new WorkspaceAccessError('workflow_schedule_authority_unavailable', 409)
  }
  const scope = await resolveWorkflowAuthoringScope({ userId: row.userId, workspaceId,
    assistantId: authority.assistantId, authoringAuthority: authority,
    contextGroupId: row.contextGroupId, contextProjectId: row.contextProjectId }, client)
  if (!accessCeilingContains(pinAccessCeiling(scope.access), authority.ceiling)) {
    throw new WorkspaceAccessError('workflow_schedule_authority_unavailable', 409)
  }
  return { ...row, trigger: row.trigger, authority, assistantId: authority.assistantId,
    projectIds: row.contextProjectId ? [row.contextProjectId] : [] }
}
