/** Canonical external metadata and short transaction receipts, never provider payloads. [COMP:api/external-source-access] */
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { bindScopeSource, ContextScopeAccumulator, intersectAccessCeilings, maxSensitivity, pinAccessCeiling, resourceScopeKey,
  type ExecutionContext, type ScopeSource } from '@use-brian/core'
import { SourceProtocolError, sourceResourceKey, sourceSubjectKey, type SourceAction, type SourceObservation, type SourceSubject } from '@use-brian/brian-app/connector'
import { getPool } from '../db/client.js'
import { findAssistantById } from '../db/users.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { resolveConnectorNativeTurnScopeSystem } from '../context-scope/connector-exposure.js'
import { validateCallerScopeEvidence } from '../context-scope/caller-evidence.js'
import { trustedSourceOperationProof, trustedSourceReadBinding, type SourceOperationProof, type SourceAccessProfile, type TrustedSourceRead } from './source-access.js'

function denied(): never { throw new SourceProtocolError('source_access_denied') }
type Profile = { id: string; revision: string; sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] }
async function profileFor(binding: SourceAccessProfile): Promise<Profile> {
  const { rows } = await getPool().query<Profile>(`SELECT p.id,p.revision::text,ci.sensitivity,
    CASE WHEN ci.scope='workspace' THEN ci.compartments ELSE g.compartments END AS compartments,
    CASE WHEN ci.scope='workspace' THEN ci.project_ids ELSE g.project_ids END AS "projectIds"
    FROM connector_source_profiles p JOIN connector_instance ci ON ci.id=p.connector_instance_id
    LEFT JOIN connector_grant g ON g.connector_instance_id=ci.id AND g.target_type='workspace' AND g.target_id=p.workspace_id
    WHERE p.workspace_id=$1 AND p.connector_instance_id=$2 AND p.tenant=$3 AND p.status='qualified'
      AND p.revision=$4::bigint AND p.issuer=$5 AND p.audience=$6 AND p.source_base_url=$7 AND p.mcp_url=$8
      AND p.http_read_path IS NOT DISTINCT FROM $9 AND ci.url=p.mcp_url AND ci.connected AND ci.health_status<>'auth_failed'
      AND (ci.scope='workspace' AND ci.workspace_id=p.workspace_id OR ci.scope='user' AND g.id IS NOT NULL)`,
  [binding.workspaceId,binding.connectorInstanceId,binding.tenant,binding.bindingRevision,binding.issuer,binding.audience,binding.sourceBaseUrl,binding.mcpUrl,binding.httpReadPath ?? null])
  if (rows.length !== 1 || !Array.isArray(rows[0].compartments) || !Array.isArray(rows[0].projectIds)) denied()
  return rows[0]
}
function normalized(observation: SourceObservation): SourceObservation {
  return { resource: { type: observation.resource.type, id: observation.resource.id, contentVersion: observation.resource.contentVersion, policyVersion: observation.resource.policyVersion },
    fields: [...observation.fields].sort(), labels: { sensitivity: observation.labels.sensitivity,
      compartments: [...observation.labels.compartments].sort(), projectIds: [...observation.labels.projectIds].sort() },
    subjects: [...observation.subjects].sort((a,b) => sourceSubjectKey(a).localeCompare(sourceSubjectKey(b))), actions: [...observation.actions].sort(),
    retention: observation.retention.mode === 'released_snapshot' ? { mode: 'released_snapshot', releaseId: observation.retention.releaseId, expiresAt: observation.retention.expiresAt }
      : { mode: observation.retention.mode }, export: { model: observation.export.model, destinations: [...observation.export.destinations].sort() } }
}
async function nativeRecipientCeiling(subject: SourceSubject, workspaceId: string) {
  if (subject.kind !== 'human' || await getWorkspaceRoleSystem(subject.id, workspaceId, true) === null) denied()
  const assistant = await findAssistantById(subject.executingAssistantId)
  if (!assistant || assistant.workspaceId !== workspaceId) denied()
  const native = await resolveConnectorNativeTurnScopeSystem({ userId: subject.id, workspaceId, assistant, memberMode: 'member' })
  return pinAccessCeiling(native.access)
}

/** Run only after remote revalidation, inside the same app transaction as the protected operation. */
export async function pinExternalSourceOperation(client: PoolClient, execution: ExecutionContext, proof: SourceOperationProof,
  sources: readonly ScopeSource[], action: SourceAction): Promise<void> {
  const binding = trustedSourceOperationProof(proof, execution)
  if (!binding || execution.identity.kind !== 'attended' || sources.length === 0 || sources.length > 100) denied()
  await binding.assertCurrent()
  const profile = await profileFor(binding.profile)
  const fingerprint = (await getPool().query<{ value: string | null }>('SELECT external_source_authority_fingerprint($1,$2) AS value',
    [binding.profile.workspaceId,profile.id])).rows[0]?.value
  if (!fingerprint) denied()
  const transaction = (await client.query<{ xid: string; pid: number; actor: string }>(`SELECT pg_current_xact_id()::text AS xid,pg_backend_pid() AS pid,
    nullif(current_setting('app.current_user_id',true),'') AS actor`)).rows[0]
  if (transaction.actor !== execution.security.access.userId) denied()
  const { request, response, requestDigest } = binding.proof
  for (const source of sources) {
    if (source.workspaceId !== binding.profile.workspaceId || source.resourceKind !== 'external_source') denied()
    const row = (await getPool().query<{ id: string; resourceRevision: string; observation: SourceObservation }>(`SELECT o.id,r.revision::text AS "resourceRevision",o.observation
      FROM external_source_observations o JOIN external_source_resources r ON r.id=o.resource_id AND r.workspace_id=o.workspace_id
      WHERE o.workspace_id=$1 AND o.id=$2 AND o.version=$3 AND r.profile_id=$4 AND r.state='active'`,
    [source.workspaceId,source.resourceId,source.version,profile.id])).rows[0]
    if (!row || !row.observation.actions.includes(action)) denied()
    const item = request.items.find(item => item.action === action && sourceResourceKey(item.resource) === sourceResourceKey(row.observation.resource)
      && row.observation.fields.every(field => item.fields.includes(field)) && item.retentionMode === row.observation.retention.mode)
    if (!item) denied()
    const deriveItem = action === 'retain' ? request.items.find(candidate => candidate.action === 'derive'
      && sourceResourceKey(candidate.resource) === sourceResourceKey(row.observation.resource)
      && row.observation.fields.every(field => candidate.fields.includes(field)) && candidate.retentionMode === row.observation.retention.mode) : undefined
    if (action === 'retain' && (!deriveItem || !row.observation.actions.includes('derive') || row.observation.retention.mode !== 'governed')) denied()
    if (action === 'retain' && row.observation.retention.mode === 'ephemeral') denied()
    if (row.observation.retention.mode === 'released_snapshot' && row.observation.retention.expiresAt <= Date.now()) denied()
    for (const recipient of request.recipients) {
      const decision = response.decisions.find(value => value.itemId === item.itemId && value.recipientId === recipient.recipientId)
      if (!decision?.allowed) denied()
      const deriveDecision = deriveItem ? response.decisions.find(value => value.itemId === deriveItem.itemId && value.recipientId === recipient.recipientId) : undefined
      if (deriveItem && !deriveDecision?.allowed) denied()
      const deriveReceipt = deriveDecision?.allowed ? deriveDecision.receipt : undefined
      const recipientCeiling = await nativeRecipientCeiling(recipient.subject, source.workspaceId)
      await validateCallerScopeEvidence({ sensitivity: source.sensitivity, compartments: source.compartments, projectIds: source.projectIds }, recipientCeiling)
      await getPool().query(`INSERT INTO external_source_authorizations(workspace_id,observation_id,profile_id,profile_revision,resource_revision,
        operation_id,request_digest,transaction_id,backend_pid,actor_kind,actor_id,assistant_id,recipient_kind,recipient_id,recipient_assistant_id,
        action,source_receipt,authority_fingerprint,expires_at,derivation_receipt)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8::xid8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$19,$18,$20
        WHERE external_source_authority_fingerprint($1,$3)=$19`,
      [source.workspaceId,row.id,profile.id,profile.revision,row.resourceRevision,request.operationId,requestDigest,transaction.xid,transaction.pid,
        binding.profile.subject.kind,execution.security.access.userId,execution.assistant.id,recipient.subject.kind,recipient.subject.id,recipient.subject.executingAssistantId,
        action,decision.receipt.id,new Date(Math.min(decision.receipt.expiresAt,deriveReceipt?.expiresAt ?? Infinity)),fingerprint,deriveReceipt?.id ?? null])
    }
  }
  await binding.assertCurrent()
  await client.query(`SELECT set_config('app.external_source_operation_id',$1,true),set_config('app.external_source_actor_id',$2,true),
    set_config('app.external_source_assistant_id',$3,true),set_config('app.external_source_action',$4,true),set_config('app.v2_assistant_id',$3,true)`,
  [request.operationId,execution.security.access.userId,execution.assistant.id,action])
  const current = await client.query<{ snapshot: ScopeSource & { held: boolean } | null }>(`SELECT external_source_snapshot($1,id) AS snapshot FROM unnest($2::uuid[]) AS id`,
    [binding.profile.workspaceId,sources.map(source => source.resourceId)])
  if (current.rows.length !== sources.length || current.rows.some((row,index) => !row.snapshot || row.snapshot.held || row.snapshot.version !== sources[index].version
    || resourceScopeKey(row.snapshot) !== resourceScopeKey(sources[index]))) denied()
}

/** Metadata is persisted/bound before any tool display conversion; every field observation enters the accumulator. */
export async function bindTrustedSourceRead(client: PoolClient, execution: ExecutionContext, read: TrustedSourceRead, accumulator: ContextScopeAccumulator) {
  const binding = trustedSourceReadBinding(read, execution)
  if (!binding || !(accumulator instanceof ContextScopeAccumulator) || binding.envelope.resources.some(resource => resource.retention.mode !== 'governed')) denied()
  const proof = trustedSourceOperationProof(binding.proof, execution)
  if (!proof) denied()
  await proof.assertCurrent()
  const profile = await profileFor(proof.profile)
  // Native lane now; explicit bounded application-source releases must qualify separately before activation.
  const ceiling = intersectAccessCeilings(execution.security.ceiling, await nativeRecipientCeiling(proof.profile.subject, proof.profile.workspaceId)), sources: ScopeSource[] = []
  for (const raw of binding.envelope.resources) {
    const observation = normalized(raw), sensitivity = maxSensitivity(profile.sensitivity, observation.labels.sensitivity)
    const compartments = [...new Set([...profile.compartments,...observation.labels.compartments])].sort(), projectIds = [...new Set([...profile.projectIds,...observation.labels.projectIds])].sort()
    await validateCallerScopeEvidence({ sensitivity, compartments, projectIds }, ceiling)
    const identity = (await getPool().query<{ id: string; state: string }>(`INSERT INTO external_source_resources(workspace_id,profile_id,resource_type,opaque_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(profile_id,resource_type,opaque_id) DO NOTHING RETURNING id,state`,
    [proof.profile.workspaceId,profile.id,observation.resource.type,observation.resource.id])).rows[0]
      ?? (await getPool().query<{ id: string; state: string }>('SELECT id,state FROM external_source_resources WHERE profile_id=$1 AND resource_type=$2 AND opaque_id=$3',
        [profile.id,observation.resource.type,observation.resource.id])).rows[0]
    if (!identity || identity.state !== 'active') denied()
    const version = createHash('sha256').update(JSON.stringify([profile.id,observation,sensitivity,compartments,projectIds])).digest('hex'), id = randomUUID()
    const inserted = (await getPool().query<{ id: string }>(`INSERT INTO external_source_observations(id,workspace_id,resource_id,version,content_version,policy_version,fields,observation,sensitivity,compartments,project_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(resource_id,version) DO NOTHING RETURNING id`,
    [id,proof.profile.workspaceId,identity.id,version,observation.resource.contentVersion,observation.resource.policyVersion,observation.fields,observation,sensitivity,compartments,projectIds])).rows[0]
      ?? (await getPool().query<{ id: string }>('SELECT id FROM external_source_observations WHERE resource_id=$1 AND version=$2', [identity.id,version])).rows[0]
    if (!inserted) denied()
    sources.push({ workspaceId: proof.profile.workspaceId, userId: null, assistantId: null, resourceKind: 'external_source', resourceId: inserted.id,
      version, sensitivity, compartments, projectIds })
  }
  await pinExternalSourceOperation(client, execution, binding.proof, sources, 'context')
  const sourceRows = sources.map(source => bindScopeSource({}, source))
  accumulator.note({ sources })
  return { result: read.result, sourceRows, sources: structuredClone(sources) }
}
