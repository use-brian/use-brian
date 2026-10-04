import { admitProgrammaticCandidate } from '../ingest/programmatic-candidate-authority.js'
import { readAdmissionPolicy } from './admission-policy-read.js'
import type { PoolClient } from 'pg'
import { maxSensitivity, unionScopeRequirements, type AccessContext, type Sensitivity } from '@use-brian/core'
import { buildAccessPredicate, buildCurrentMemberSourcePredicate } from '../db/access-predicate.js'
import { admitWorkspaceResource } from './resource-admission.js'
import { WorkspaceAccessError } from './policy.js'

type TaskEnvelope = {
  workspaceId: string
  parentId?: string | null
  expectedPolicyRevision?: string
  sensitivity?: Sensitivity
  compartments?: string[]
  projectIds?: string[]
  visibility?: { userId: string | null; assistantId: string | null }
}

type TaskAdmissionParent = { sensitivity: Sensitivity; compartments: string[]; projectIds: string[]; userId: string | null; assistantId: string | null }
/** Must be the first resource lock in the writer transaction. Legacy policy is
 * intentionally a passthrough; it is not an implicit activation/migration.
 * prior is only a canonically locked, mutation-authorized predecessor supplied
 * by updateTask, never a transport-provided envelope. */
export async function admitTaskCreate<T extends TaskEnvelope>(client: PoolClient, userId: string, params: T, access: AccessContext, prior?: TaskAdmissionParent): Promise<T> {
  const configured=await admitProgrammaticCandidate(client,params.workspaceId,userId,'task',{userId:params.visibility?.userId??null,assistantId:params.visibility?.assistantId??null,sensitivity:params.sensitivity??'internal',compartments:params.compartments??[],projectIds:params.projectIds??[]})
  if(configured){if(params.parentId||prior)throw new Error('capture_candidate_scope_mismatch');return {...params,sensitivity:configured.sensitivity,compartments:configured.compartments,projectIds:configured.projectIds}}
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [params.workspaceId])
  const policy = await readAdmissionPolicy(client, params.workspaceId)
  if (params.expectedPolicyRevision !== undefined && params.expectedPolicyRevision !== policy?.revision) {
    throw new WorkspaceAccessError('access_policy_conflict', 409)
  }
  if (!policy || policy.setupState === 'legacy') return params
  // Explicit null is invalid, not omitted selection (including JS/HTTP callers).
  if (params.compartments === null || params.projectIds === null || params.visibility === null) {
    throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
  }
  // Lock membership before the parent resource, matching admission lock order.
  await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [params.workspaceId, userId])
  let parent: { sensitivity: Sensitivity; compartments: string[]; projectIds: string[]; userId: string | null; assistantId: string | null } | undefined
  if (params.parentId) {
    const read = buildAccessPredicate(access, { alias: 't', startIdx: 2, operation: 'read' })
    const mutation = buildAccessPredicate(access, { alias: 't', startIdx: read.nextIdx, operation: 'mutation' })
    const member = buildCurrentMemberSourcePredicate(userId, { alias: 't', startIdx: mutation.nextIdx, operation: 'mutation' })
    parent = (await client.query(`SELECT t.sensitivity,t.compartments,t.project_ids AS "projectIds",t.user_id AS "userId",t.assistant_id AS "assistantId"
      FROM tasks t WHERE t.id=$1 AND t.workspace_id=$2 AND t.valid_to IS NULL AND t.retracted_at IS NULL AND NOT t.scope_held
      AND ${read.sql} AND ${mutation.sql} AND ${member.sql}
      AND context_scope_allows_current_principal(t.workspace_id,t.sensitivity,t.compartments,t.project_ids)
      FOR SHARE OF t`, [params.parentId, ...read.params, ...mutation.params, ...member.params])).rows[0]
    if (!parent) throw new WorkspaceAccessError('context_not_available', 404)
  }
  const mergeOwner = (requested: string | null | undefined, inherited: string | null | undefined) => {
    if (requested && inherited && requested !== inherited) throw new WorkspaceAccessError('context_not_available', 404)
    return inherited ?? requested ?? null
  }
  if (prior) parent = parent ? {
    sensitivity: maxSensitivity(prior.sensitivity, parent.sensitivity),
    compartments: unionScopeRequirements(prior.compartments, parent.compartments),
    projectIds: unionScopeRequirements(prior.projectIds, parent.projectIds),
    userId: mergeOwner(prior.userId, parent.userId), assistantId: mergeOwner(prior.assistantId, parent.assistantId),
  } : prior
  const visibility = { userId: mergeOwner(params.visibility?.userId, parent?.userId), assistantId: mergeOwner(params.visibility?.assistantId, parent?.assistantId) }
  const admitted = await admitWorkspaceResource(client, params.workspaceId, userId, {
    writerKind: 'task',
    rowVisibility: visibility,
    expectedPolicyRevision: params.expectedPolicyRevision,
    sensitivity: params.sensitivity ?? 'internal',
    // The assistant partition is not a personal visibility boundary: primary
    // viewers can read assistant-only rows. Keep it without skipping admission.
    visibility: visibility.userId ? 'private' : 'workspace',
    inherited: parent ? { ...parent, visibility: parent.userId ? 'private' : 'workspace' } : undefined,
    requestedLabels: { compartments: prior && params.compartments?.length === 0 ? undefined : params.compartments, projectIds: params.projectIds },
  })
  return { ...params, sensitivity: admitted.envelope.sensitivity, compartments: admitted.envelope.compartments, projectIds: admitted.envelope.projectIds, visibility }
}
