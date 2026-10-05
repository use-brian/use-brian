/** Bounded authenticated prompt-only request admission; not derived output admission. */
import { APP_LEVEL_ASSISTANT_ID, type ResourceDestination } from '@use-brian/shared'
import type { OfficeToolPort } from '@use-brian/core'
import { getAppPool, applyRLSGucs, rollbackAndRelease } from './client.js'
import { createOfficeArtifactStore, type OfficeDbQuery } from './office-artifacts.js'
import { createOfficeGenerationStore } from './office-generation.js'
import { officeCreationPolicy, admitOfficeShell, type OfficeCreateOptions } from '../workspace-access/office-create-admission.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

export type OfficeHumanGenerationOptions = {
  /** Supplied by requireAuth's route adapter, never request/model JSON. */
  actorUserId: string
  workspaceId: string
  sessionId: string
  destination?: ResourceDestination
}
export type OfficeGenerationRequest = Parameters<OfficeToolPort['create']>[0]

/** Returns null only for legacy mode; its existing generation behavior is unchanged.
 * Ready-mode sources/templates/context require a separate locked evidence adapter.
 * The empty source set here is canonical only for the persisted prompt-only
 * execution contract, which MUST NOT call ambient retrieval or brand/template
 * loaders. The dedicated prompt-only worker publishes through artifact-bound admission.
 */
export async function createHumanOfficeGeneration(input: OfficeGenerationRequest, proof: OfficeHumanGenerationOptions) {
  if (proof.actorUserId !== input.userId || proof.workspaceId !== input.workspaceId || !proof.sessionId) {
    throw new WorkspaceAccessError('office_admission_provenance_required', 409)
  }
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, input.userId)
    const policy = await officeCreationPolicy(client, input.workspaceId)
    if (!policy || policy.setupState === 'legacy') {
      if (proof.destination) throw new WorkspaceAccessError('access_mode_setup_required',409)
      await client.query('COMMIT'); return null
    }
    if (input.family !== 'document' || input.sourceHandles.length || input.templateId || input.additionalContext
      || input.compartments.length || input.projectIds.length) {
      throw new WorkspaceAccessError('office_admission_provenance_required', 409)
    }
    const session = await client.query(`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND s.auth_version=u.auth_version FOR SHARE OF s,u`,[proof.sessionId,input.userId])
    if (!session.rows.length) throw new WorkspaceAccessError('authenticated_session_required',401)
    // No assistant authority is inferred from this identifier. It is attribution
    // only; this job is bound to the session human and contains no assistant context.
    const assistant = await client.query<{id:string}>(`SELECT id FROM assistants WHERE workspace_id=$2
      AND (id=$1 OR ($1=$3 AND kind='primary')) ORDER BY id LIMIT 1 FOR SHARE`,[input.assistantId,input.workspaceId,APP_LEVEL_ASSISTANT_ID])
    if (!assistant.rows.length) throw new WorkspaceAccessError('context_not_available',404)
    const query: OfficeDbQuery = async <T>(actor: string, sql: string, params: unknown[]) => {
      if (actor !== input.userId) throw new Error('office_generation_actor_mismatch')
      return { rows: (await client.query(sql,params)).rows as T[] }
    }
    const assistantId = assistant.rows[0].id
    const options: OfficeCreateOptions = {destination:proof.destination,provenance:{kind:'human_authored_root',actorUserId:proof.actorUserId,workspaceId:proof.workspaceId}}
    const admitted = await admitOfficeShell(client, {
      userId:input.userId,workspaceId:input.workspaceId,family:'document' as const,
      title:input.outcome.trim().slice(0,1000),templateVersionId:null,capabilityVersion:1,
      sensitivity:input.sensitivity,
      // Raw execution labels are not a user selection; admission resolves the
      // typed destination separately and authorizes it inside this transaction.
      requiredCompartments:undefined,projectIds:[],visibilityUserIds:[],
    }, options)
    const artifacts = createOfficeArtifactStore(query)
    const artifact = await artifacts.createShell(admitted)
    const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
    if (artifact.workspaceId !== admitted.workspaceId || artifact.sensitivity !== admitted.sensitivity
      || !same(artifact.compartments,admitted.requiredCompartments ?? []) || !same(artifact.projectIds,admitted.projectIds)) {
      throw new Error('office_admission_persistence_mismatch')
    }
    const brief = {workspaceId:input.workspaceId,actingUserId:input.userId,assistantId,
      family:input.family,outcome:input.outcome,audience:input.audience,sourceHandles:[],
      requestedSensitivityFloor:artifact.sensitivity,idempotencyKey:input.idempotencyKey}
    const binding = {protocol:'office_prompt_only_v1',actorUserId:input.userId,workspaceId:input.workspaceId,
      authSessionId:proof.sessionId,policyRevision:policy.revision,sources:[],
      implicitContext:'disabled',executionAdapter:'prompt_only_document_v1'}
    const job = await createOfficeGenerationStore(query).create({userId:input.userId,workspaceId:input.workspaceId,
      artifactId:artifact.id,assistantId,jobKind:'create',brief,idempotencyKey:input.idempotencyKey,
      authorityProjection:{sensitivity:artifact.sensitivity,visibilityUserIds:[],compartments:artifact.compartments,
        projectIds:artifact.projectIds,compartmentGrant:artifact.compartments,projectGrant:artifact.projectIds,
        sourceHandles:[],creationBinding:binding}})
    if (job.artifactId !== artifact.id) {
      // Idempotency may return a pre-existing job. Never silently accept a
      // different request or pre-admission authority under the same key.
      const old = job.authorityProjection as {creationBinding?: {protocol?: string}}
      const previous = job.brief as Record<string,unknown>
      if (old.creationBinding?.protocol !== binding.protocol || Object.entries(brief).some(([key,value]) => JSON.stringify(previous[key]) !== JSON.stringify(value))) {
        throw new WorkspaceAccessError('office_generation_request_conflict',409)
      }
      await artifacts.deleteEmptyShell(input.userId,artifact.id)
    }
    await client.query('COMMIT')
    return {artifactId:job.artifactId,jobId:job.id}
  } finally { await rollbackAndRelease(client) }
}
