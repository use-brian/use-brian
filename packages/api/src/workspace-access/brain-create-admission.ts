import { admitProgrammaticCandidate } from '../ingest/programmatic-candidate-authority.js'
import type { PoolClient } from 'pg'
import type { Sensitivity, ResourceScope } from '@use-brian/core'
import { readAdmissionPolicy } from './admission-policy-read.js'
import { admitWorkspaceResource, type AdmissionWriterKind } from './resource-admission.js'
import { WorkspaceAccessError } from './policy.js'

/** Call before locking any source/resource. Metadata elevation is restored by
 * readAdmissionPolicy before returning to the canonical writer. */
export async function beginBrainAdmission(client: PoolClient, workspaceId: string) {
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
  const policy = await readAdmissionPolicy(client, workspaceId)
  return !!policy && policy.setupState !== 'legacy'
}

/** user_id is the personal boundary; assistant-only rows are shared assistant
 * work, not personal data. Never manufacture inherited evidence from labels. */
export async function admitBrainCreate(
  client: PoolClient, workspaceId: string, actor: string,
  input: { userId: string | null; assistantId?: string | null; sensitivity: Sensitivity; compartments?: string[]; projectIds?: string[] },
  inherited?: ResourceScope,
  /** Only after canonical exact-version derivation validation, never for an
   * authored root or an unvalidated parent/source identifier. */
  readOnlyInherited = false,
  writerKind?: AdmissionWriterKind,
) {
  if (input.compartments === null || input.projectIds === null) {
    throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
  }
  const configured=await admitProgrammaticCandidate(client,workspaceId,actor,writerKind,{...input,compartments:input.compartments??[],projectIds:input.projectIds??[]})
  if(configured)return configured
  if (input.userId && input.userId !== actor) throw new WorkspaceAccessError('context_not_available', 404)
  return (await admitWorkspaceResource(client, workspaceId, actor, {
    writerKind,
    rowVisibility: { userId: input.userId, assistantId: input.assistantId ?? null },
    visibility: input.userId ? 'private' : 'workspace', sensitivity: input.sensitivity,
    // In the canonical derivation contract these are additional requirements,
    // not a request to erase the source floor or select General. An empty set
    // must retain the verified inherited floor without applying a new default.
    requestedLabels: { compartments: readOnlyInherited && input.compartments?.length === 0 ? undefined : input.compartments, projectIds: input.projectIds },
    inherited: inherited ? { ...inherited, visibility: inherited.userId ? 'private' : 'workspace' } : undefined,
    inheritedAuthority: readOnlyInherited ? 'read' : 'mutation',
  })).envelope
}
