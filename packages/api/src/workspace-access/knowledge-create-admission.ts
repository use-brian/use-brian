import type { PoolClient } from 'pg'
import type { Sensitivity } from '@use-brian/core'
import { currentAgentAccess } from '../db/agent-access-context.js'
import { admitWorkspaceResource } from './resource-admission.js'
import { WorkspaceAccessError } from './policy.js'

export type KnowledgeSourceBindingInput = {
  sensitivity: Sensitivity; compartments: string[]; projectIds: string[]
}
/** Passed separately by authenticated application code, never read from payload. */
export type KnowledgeConfigureAuthority = { actorUserId: string }

export async function admitKnowledgeSourceConfiguration(
  client: PoolClient, workspaceId: string, authority: KnowledgeConfigureAuthority,
  binding: KnowledgeSourceBindingInput,
): Promise<KnowledgeSourceBindingInput> {
  if (!authority?.actorUserId || !binding || !Array.isArray(binding.compartments) || !Array.isArray(binding.projectIds)
    || !['public', 'internal', 'confidential'].includes(binding.sensitivity)
    || binding.compartments.some(key => typeof key !== 'string' || !key.trim())
    || binding.projectIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('knowledge_source_admission_required')
  if (('userId' in binding && binding.userId != null) || ('assistantId' in binding && binding.assistantId != null)) throw new Error('knowledge_partition_not_supported')
  const admitted = await admitWorkspaceResource(client, workspaceId, authority.actorUserId, {
    visibility: 'workspace', sensitivity: binding.sensitivity,
    requestedLabels: { compartments: binding.compartments, projectIds: binding.projectIds },
  })
  return { sensitivity: admitted.envelope.sensitivity, compartments: admitted.envelope.compartments, projectIds: admitted.envelope.projectIds }
}

export type KnowledgeAdmissionInput = {
  workspaceId: string; sensitivity: Sensitivity; compartments?: string[]; projectIds?: string[]
  sourceId?: string | null; sourceSha?: string | null; expectedPolicyRevision?: string
}
export type KnowledgePrior = {
  sensitivity: Sensitivity; compartments: string[]; projectIds: string[]
  sourceId: string | null; sourceSha: string | null
}

/** Knowledge has no personal/assistant partition columns. Never infer private
 * ownership from created_by or turn a source identifier into inheritance. */
export async function admitKnowledgeWrite<T extends KnowledgeAdmissionInput>(
  client: PoolClient, actor: string, input: T, prior?: KnowledgePrior,
): Promise<T> {
  if (('userId' in input && input.userId != null) || ('assistantId' in input && input.assistantId != null)) throw new Error('knowledge_partition_not_supported')
  if (input.compartments === null || input.projectIds === null) throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
  if (input.sourceId || input.sourceSha || prior?.sourceId) throw new Error('knowledge_source_admission_required')
  const ambient = currentAgentAccess()
  if (ambient?.workspaceId && ambient.workspaceId !== input.workspaceId) throw new WorkspaceAccessError('context_not_available', 404)
  const admitted = await admitWorkspaceResource(client, input.workspaceId, actor, {
    writerKind: 'knowledge_entry',
    expectedPolicyRevision: input.expectedPolicyRevision,
    visibility: 'workspace', sensitivity: input.sensitivity,
    inherited: prior ? { ...prior, visibility: 'workspace' } : undefined,
    requestedLabels: { compartments: input.compartments, projectIds: input.projectIds },
  })
  return { ...input, ...admitted.envelope,
    ...(prior ? { sourceId: prior.sourceId, sourceSha: prior.sourceSha } : {}) }
}

/** Read and lock the actual target, not caller metadata. RLS read visibility
 * alone does not authorize mutation. Held targets never become new roots. */
export async function lockKnowledgePrior(client: PoolClient, workspaceId: string, value: string, byId = false): Promise<KnowledgePrior | undefined> {
  const row = (await client.query<KnowledgePrior & { allowed: boolean }>(`SELECT sensitivity, compartments, project_ids AS "projectIds",
    source_id AS "sourceId", source_sha AS "sourceSha",
    NOT scope_held AND member_operation_scope_allows(workspace_id,sensitivity,compartments,true)
      AND agent_mutation_scope_allows(compartments)
      AND context_scope_allows_current_principal(workspace_id,sensitivity,compartments,project_ids) AS allowed
    FROM knowledge_entries WHERE workspace_id=$1 AND ${byId ? 'id' : 'path'}=$2 FOR UPDATE`, [workspaceId, value])).rows[0]
  if (row && !row.allowed) throw new WorkspaceAccessError('context_not_available', 404)
  return row
}
