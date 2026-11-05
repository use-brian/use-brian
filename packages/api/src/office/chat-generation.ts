/** Atomic creation from a native personal web chat. [COMP:api/office-chat-generation] */
import { createHash } from 'node:crypto'
import { AuthoritySourceSchema, pinAuthoringAuthority, type ToolContext, type OfficeToolPort } from '@use-brian/core'
import { getAppPool, applyRLSGucs, rollbackAndRelease } from '../db/client.js'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import { createOfficeArtifactStore, type OfficeDbQuery } from '../db/office-artifacts.js'
import { createOfficeGenerationStore } from '../db/office-generation.js'
import { officeCreationPolicy } from '../workspace-access/office-create-admission.js'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { readOfficeGenerationEvidence } from './generation-evidence.js'

type Request = Parameters<OfficeToolPort['create']>[0]
const denied = () => new WorkspaceAccessError('context_not_available', 404)

/** Null retains the existing adapter for other execution surfaces and pre-v2 workspaces.
 * No model JSON is accepted as caller proof. */
export async function createChatOfficeGeneration(context: ToolContext, input: Request) {
  const execution = context.executionContext
  if (!execution || execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member'
    || execution.identity.principal.authenticationKind !== 'native_session'
    || execution.lifecycle.channelType !== 'web' || execution.security.access.sharedAudience) return null
  if (execution.identity.principal.userId !== input.userId || context.userId !== input.userId || context.workspaceId !== input.workspaceId
    || execution.ownership.kind !== 'workspace' || execution.ownership.workspaceId !== input.workspaceId
    || execution.assistant.id !== input.assistantId || context.assistantId !== input.assistantId
    || execution.security.access.userId !== input.userId || execution.security.access.workspaceId !== input.workspaceId
    || execution.security.access.assistantId !== input.assistantId
    || execution.lifecycle.sessionId !== context.sessionId || execution.lifecycle.sessionPersisted === false
    || execution.surface.readOnly || execution.surface.systemRead || execution.surface.clientSelfMemory
    || execution.security.access.systemRead || execution.lifecycle.abortSignal.aborted) throw denied()
  await execution.security.authority.assertCurrent()
  const credential = execution.security.authority.snapshotNativeSessionCredential?.()
  if (!credential || credential.userId !== input.userId) throw denied()
  const parsed = AuthoritySourceSchema.safeParse(execution.security.authority.snapshotSource?.())
  if (!parsed.success || parsed.data.kind !== 'session' && parsed.data.kind !== 'invocation') throw denied()
  const origin = parsed.data.kind === 'session' ? parsed.data : null
  if (origin && (origin.id !== context.sessionId || origin.workspaceId !== input.workspaceId
    || origin.authorityUserId !== input.userId || origin.executingAssistantId !== input.assistantId
    || origin.visibility !== 'personal' || origin.ignoreSessionBinding || origin.systemRead)) throw denied()
  return runWithAgentAccess(execution.security.access, async () => {
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client, input.userId)
      const policy = await officeCreationPolicy(client, input.workspaceId)
      if (!policy?.departmentReadV2) { await client.query('COMMIT'); return null }
      const session = (await client.query<{ contextGroupId: string | null; contextProjectId: string | null; contextLockedAt: Date; contextRevision: string }>(`
        SELECT context_group_id AS "contextGroupId",context_project_id AS "contextProjectId",context_locked_at AS "contextLockedAt",
          context_locked_at::text AS "contextRevision" FROM sessions
        WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND assistant_id=$4
          AND channel_type='web' AND visibility='personal' AND anchor_kind='none' FOR SHARE`,
      [context.sessionId,input.workspaceId,input.userId,input.assistantId])).rows[0]
      if (!session?.contextLockedAt || origin && (session.contextGroupId !== origin.contextGroupId || session.contextProjectId !== origin.contextProjectId
        || session.contextLockedAt.toISOString() !== origin.contextLockedAt)) throw denied()
      await execution.security.authority.assertCurrent()
      const liveAuth = await client.query(`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND s.auth_version=$3 AND u.auth_version=s.auth_version
          AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF s,u`,
      [credential.sessionId,input.userId,credential.authVersion])
      if (!liveAuth.rows.length) throw denied()
      const source = await readOfficeGenerationEvidence(client,input.workspaceId,input)
      // A canonical General source already supplies placement. Do not reapply a
      // root default that could move the result outside the requesting person's access.
      const inheritedGeneral = source.sources.length > 0 && source.scope.compartments.length === 0
        && input.compartments.length === 0 && !execution.security.access.departmentRead?.contextDepartment
      const admitted = await admitWorkspaceResource(client,input.workspaceId,input.userId,{
        visibility:source.private?'private':'workspace',sensitivity:input.sensitivity,
        inherited:source.sources.length?{...source.scope,visibility:source.private?'private':'workspace'}:undefined,
        inheritedAuthority:source.sources.length?'read':undefined,
        ...(inheritedGeneral ? {destination:{kind:'general' as const},requestedLabels:{projectIds:input.projectIds}}
          :{requestedLabels:{compartments:input.compartments,projectIds:input.projectIds}}),
      })
      const query: OfficeDbQuery = async <T>(actor: string, sql: string, params: unknown[]) => {
        if (actor !== input.userId) throw denied()
        return { rows: (await client.query(sql,params)).rows as T[] }
      }
      const artifacts = createOfficeArtifactStore(query)
      const artifact = await artifacts.createShell({userId:input.userId,workspaceId:input.workspaceId,family:input.family,
        title:input.outcome.trim().slice(0,1000),templateVersionId:input.templateId??null,capabilityVersion:1,
        sensitivity:admitted.envelope.sensitivity,requiredCompartments:admitted.envelope.compartments,
        projectIds:admitted.envelope.projectIds,visibilityUserIds:source.private?[input.userId]:[]})
      const brief = {workspaceId:input.workspaceId,actingUserId:input.userId,assistantId:input.assistantId,
        family:input.family,outcome:input.outcome,audience:input.audience,sourceHandles:input.sourceHandles,
        requestedSensitivityFloor:artifact.sensitivity,...(input.templateId?{templateId:input.templateId}:{}),
        ...(input.additionalContext?{additionalContext:input.additionalContext}:{}),idempotencyKey:input.idempotencyKey}
      const requestHash = createHash('sha256').update(JSON.stringify({brief,sessionId:context.sessionId,...session})).digest('hex')
      const binding = {protocol:'office_department_v2',origin:'native_personal_chat',actorUserId:input.userId,
        workspaceId:input.workspaceId,chatSessionId:context.sessionId,contextGroupId:session.contextGroupId,
        contextProjectId:session.contextProjectId,contextLockedAt:session.contextRevision,requestHash,
        authSessionId:credential.sessionId,
        sourceFingerprint:source.fingerprint,sources:source.sources,authoringAuthority:pinAuthoringAuthority(execution.security.access)}
      const job = await createOfficeGenerationStore(query).create({userId:input.userId,workspaceId:input.workspaceId,
        artifactId:artifact.id,assistantId:input.assistantId,jobKind:'create',brief,idempotencyKey:input.idempotencyKey,
        templateVersionId:input.templateId,authorityProjection:{sensitivity:artifact.sensitivity,
          visibilityUserIds:source.private?[input.userId]:[],compartments:artifact.compartments,projectIds:artifact.projectIds,
          compartmentGrant:context.compartments??null,projectGrant:context.projectIds??null,
          sourceHandles:input.sourceHandles,creationBinding:binding}})
      if (job.artifactId !== artifact.id) {
        const previous=job.authorityProjection as {creationBinding?:{requestHash?:string}}
        if (previous.creationBinding?.requestHash !== requestHash) throw new WorkspaceAccessError('office_generation_request_conflict',409)
        await artifacts.deleteEmptyShell(input.userId,artifact.id)
      }
      await client.query('COMMIT')
      return {artifactId:job.artifactId,jobId:job.id}
    } finally { await rollbackAndRelease(client) }
  })
}
