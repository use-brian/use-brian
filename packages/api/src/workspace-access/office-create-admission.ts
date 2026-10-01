import type { PoolClient } from 'pg'
import { readAdmissionPolicy } from './admission-policy-read.js'
import { admitWorkspaceResource } from './resource-admission.js'
import { WorkspaceAccessError } from './policy.js'

/** Internal adapter argument, never part of Office request/model JSON. The
 * authenticated adapter must prove this is a human-authored, unbound shell:
 * no imported/copied/generated content, source handles, or template binding.
 * No production adapter supplies this proof yet; those callers fail closed in
 * ready mode. Creator/owner identity is not provenance.
 */
export type OfficeCreateOptions = {
  provenance?: { kind: 'human_authored_root'; actorUserId: string; workspaceId: string }
  expectedPolicyRevision?: string
}
export type OfficeShellAdmissionInput = {
  userId: string
  workspaceId: string
  templateVersionId: string | null
  mode?: 'artifact' | 'template'
  sensitivity: 'public' | 'internal' | 'confidential'
  visibilityUserIds?: string[]
  requiredCompartments?: string[]
  projectIds?: string[]
}

/** Workspace is always the first resource lock, also for legacy writes. */
export async function officeCreationPolicy(client: PoolClient, workspaceId: string) {
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
  return readAdmissionPolicy(client, workspaceId)
}

export function officeProvenanceRequired(): never {
  throw new WorkspaceAccessError('office_admission_provenance_required', 409)
}

export async function admitOfficeShell<T extends OfficeShellAdmissionInput>(
  client: PoolClient, input: T, options?: OfficeCreateOptions,
): Promise<T> {
  const policy = await officeCreationPolicy(client, input.workspaceId)
  if (options?.expectedPolicyRevision !== undefined && options.expectedPolicyRevision !== policy?.revision) {
    throw new WorkspaceAccessError('access_policy_conflict', 409)
  }
  if (!policy || policy.setupState === 'legacy') return input
  const proof = options?.provenance
  if (!proof || proof.kind !== 'human_authored_root' || proof.actorUserId !== input.userId
    || proof.workspaceId !== input.workspaceId || input.templateVersionId !== null
    || (input.mode !== undefined && input.mode !== 'artifact')) officeProvenanceRequired()
  if (input.requiredCompartments === null || input.projectIds === null || input.visibilityUserIds === null) {
    throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
  }
  const admitted = await admitWorkspaceResource(client, input.workspaceId, input.userId, {
    expectedPolicyRevision: options?.expectedPolicyRevision,
    visibility: input.visibilityUserIds?.length ? 'private' : 'workspace',
    sensitivity: input.sensitivity,
    requestedLabels: { compartments: input.requiredCompartments, projectIds: input.projectIds },
  })
  const envelope = admitted.envelope
  // Preserve the Office-specific principal and mutation boundary, not just the
  // generic admission authority. INSERT RLS independently checks these values.
  const allowed = await client.query<{ allowed: boolean }>(`SELECT office_labels_scope_allows(
    $1,$2,$3::text[],$4::uuid[],$5::uuid[],'{}'::uuid[],true) AS allowed`,
  [input.workspaceId,envelope.sensitivity,envelope.compartments,envelope.projectIds,input.visibilityUserIds ?? []])
  if (!allowed.rows[0]?.allowed) throw new WorkspaceAccessError('context_not_available', 404)
  return { ...input, sensitivity: envelope.sensitivity,
    requiredCompartments: envelope.compartments, projectIds: envelope.projectIds }
}
