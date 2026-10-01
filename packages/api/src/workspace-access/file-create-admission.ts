import type { PoolClient } from 'pg'
import type { WorkspaceFileCreateInput } from '@use-brian/core'
import { readAdmissionPolicy } from './admission-policy-read.js'
import { admitWorkspaceResource } from './resource-admission.js'
import { WorkspaceAccessError } from './policy.js'

/** Root-file admission only, inside the canonical writer transaction.
 *
 * parentPath is a storage path, NOT canonical parent evidence. Neither raw
 * labels nor metadata/source IDs prove an inherited envelope. Session/page,
 * generated and system writers still need a caller integration carrying and
 * revalidating canonical provenance in this same transaction; until then they
 * are explicitly blocked in ready mode rather than assigned a shared default.
 * Do not replace the executing userId with createdByUserId or a workspace owner.
 * Upload staging/finalization and byte publication happen above this store and
 * are NOT covered by this adapter.
 */
export async function admitFileCreate(
  client: PoolClient,
  userId: string,
  input: WorkspaceFileCreateInput,
  expectedPolicyRevision?: string,
): Promise<WorkspaceFileCreateInput> {
  // First resource lock, shared with policy/default/authority mutations.
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId])
  const policy = await readAdmissionPolicy(client, input.workspaceId)
  if (expectedPolicyRevision !== undefined && expectedPolicyRevision !== policy?.revision) {
    throw new WorkspaceAccessError('access_policy_conflict', 409)
  }
  if (!policy || policy.setupState === 'legacy') return input
  if (input.compartments === null || input.projectIds === null) {
    throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
  }
  if (!userId || input.createdByUserId !== userId || input.createdByAssistantId
    || input.sourceEpisodeId || (input.source !== undefined && input.source !== 'user')
    || /^\/(?:office|doc)\//.test(input.path)
    || input.metadata?.officeSession || input.metadata?.sessionId || input.metadata?.session_id
    || input.metadata?.parentId || input.metadata?.sourceId) {
    // Content-free, explicit blocker: no guessed source floor or service grants.
    throw Object.assign(new Error('File creation requires verified actor and canonical provenance.'), {
      code: 'file_admission_provenance_required',
    })
  }
  const admitted = await admitWorkspaceResource(client, input.workspaceId, userId, {
    writerKind: 'workspace_file',
    rowVisibility: { userId: input.userId ?? null, assistantId: input.assistantId ?? null },
    expectedPolicyRevision,
    // An assistant partition is not personal ownership; primary readers can
    // read assistant-only work, so it still requires a shared destination.
    visibility: input.userId ? 'private' : 'workspace',
    sensitivity: input.sensitivity ?? 'internal',
    requestedLabels: { compartments: input.compartments, projectIds: input.projectIds },
  })
  return { ...input, sensitivity: admitted.envelope.sensitivity,
    compartments: admitted.envelope.compartments, projectIds: admitted.envelope.projectIds }
}
