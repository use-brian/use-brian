import type { PoolClient } from 'pg'
import { deriveResourceScope, type EntityCreateParams, type ResourceScope } from '@use-brian/core'
import { validateDerivedEntityInputs } from '../db/derived-scope-store.js'
import { assertExecutionResourceScope } from '../db/access-predicate.js'
import { WorkspaceAccessError } from './policy.js'
import { beginBrainAdmission, admitBrainCreate } from './brain-create-admission.js'

export { beginBrainAdmission as beginEntityAdmission }

/** Source-derived entities retain the exact locked source envelope. Provenance
 * identifiers alone are never evidence, and additions require mutation rights. */
export async function admitEntityCreate(client: PoolClient, params: EntityCreateParams): Promise<EntityCreateParams> {
  if (!params.workspaceId) throw new Error('scope_workspace_mismatch')
  const ready = await beginBrainAdmission(client, params.workspaceId)
  if (params.derivation) {
    const floor = await validateDerivedEntityInputs(client, params.derivation)
    if (floor.workspaceId !== params.workspaceId) throw new Error('scope_workspace_mismatch')
    if ((params.sourceEpisodeId && !params.derivation.sources.some(s => s.resourceKind === 'episode' && s.resourceId === params.sourceEpisodeId))
      || params.sourceSessionId) throw new Error('scope_evidence_missing')
    const scope = deriveResourceScope(params.derivation, {
      workspaceId: params.workspaceId, userId: params.userId ?? floor.userId,
      assistantId: params.assistantId ?? floor.assistantId, sensitivity: params.sensitivity ?? floor.sensitivity,
      compartments: params.compartments ?? [], projectIds: params.projectIds ?? [],
    })
    for (const source of params.derivation.sources) {
      if (source.userId && source.userId !== params.createdByUserId) throw new WorkspaceAccessError('context_not_available', 404)
      assertExecutionResourceScope(source, 'read')
    }
    await validateEntityAssistant(client, params.workspaceId, scope.assistantId)
    const admitted = ready ? await admitBrainCreate(client, params.workspaceId, params.createdByUserId, {
      ...scope, compartments: params.compartments, projectIds: params.projectIds,
    }, floor, true, 'entity') : scope
    return { ...params, ...scope, ...admitted }
  }
  if (!ready && !params.explicitGeneral) return params
  if (params.sourceEpisodeId || params.sourceSessionId || params.source !== 'user') throw new Error('scope_evidence_missing')
  const admitted = await admitBrainCreate(client, params.workspaceId, params.createdByUserId, {
    explicitGeneral: params.explicitGeneral,
    userId: params.userId ?? null, assistantId: params.assistantId ?? null, sensitivity: params.sensitivity ?? 'internal',
    compartments: params.compartments, projectIds: params.projectIds,
  }, undefined, false, 'entity')
  await validateEntityAssistant(client, params.workspaceId, params.assistantId)
  return { ...params, ...admitted }
}

/** Supersession inherits a canonically locked mutation-authorized entity.
 * No read-authority exemption: this is a mutation, not validated derivation. */
export async function admitEntitySuccessor(client: PoolClient, actor: string, old: ResourceScope, patch: { sensitivity?: ResourceScope['sensitivity']; compartments?: string[]; projectIds?: string[] }) {
  return admitBrainCreate(client, old.workspaceId, actor, { userId: old.userId, assistantId: old.assistantId, sensitivity: patch.sensitivity ?? old.sensitivity,
    compartments: patch.compartments, projectIds: patch.projectIds }, old, false, 'entity')
}

/** An assistant partition never establishes a different destination workspace. */
export async function validateEntityAssistant(client: PoolClient, workspaceId: string, assistantId?: string | null) {
  if (!assistantId) return
  const assistant = (await client.query('SELECT id FROM assistants WHERE id=$1 AND workspace_id=$2 FOR SHARE', [assistantId, workspaceId])).rows[0]
  if (!assistant) throw new WorkspaceAccessError('context_not_available', 404)
}
