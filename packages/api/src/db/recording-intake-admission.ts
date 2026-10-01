import type { PoolClient } from 'pg'
import { deriveResourceScope, resourceScopeKey, type AccessContext, type DerivedWriteEvidence, type ResourceScope, type ScopeSource } from '@use-brian/core'
import { applyRLSGucs, getAppPool, rollbackAndRelease } from './client.js'
import { assertExecutionResourceScope, buildAccessPredicate, mutationActorAccess } from './access-predicate.js'
import { assertCurrentFileAssistant } from '../workspace-access/file-publication-admission.js'
import { readAdmissionPolicy } from '../workspace-access/admission-policy-read.js'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'

/** Internal, per-call provenance. Never recover this from source_ref or a creator. */
export type RecordingIntakeAuthority = { actorUserId: string; access?: AccessContext }
export type RecordingIntakeParent = ScopeSource & {
  resourceKind: 'workspace_file'
  storageUri: string
  mime: string
  name: string
  sizeBytes: number
}
const unavailable = (): never => { throw new Error('recording_intake_source_unavailable') }

/** No owner-pool fallback, including for worker calls. */
export async function recordingIntakeTransaction<T>(authority: RecordingIntakeAuthority, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!authority?.actorUserId) unavailable()
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, authority.actorUserId)
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } finally {
    await rollbackAndRelease(client)
  }
}

/** Workspace first, then the canonical file. Both RLS delivery gates (including
 * 636/637 session bindings) and the current-member source reader must agree.
 * The source reader takes the canonical SHARE lock. Do not add FOR SHARE to
 * the app-role delivery SELECT: PostgreSQL would also require UPDATE RLS and
 * incorrectly deny read-authorized derivation floors. */
export async function readRecordingIntakeParent(
  client: PoolClient, authority: RecordingIntakeAuthority, workspaceId: string, fileId: string,
): Promise<RecordingIntakeParent> {
  const access = mutationActorAccess(authority.actorUserId, workspaceId, authority.access)
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
  const ap = buildAccessPredicate(access, { alias: 'f' })
  const row = (await client.query(`SELECT f.storage_uri,f.mime,f.name,f.size_bytes,
      read_entity_derivation_source(f.workspace_id,'workspace_file',f.id) AS scope
    FROM workspace_files f WHERE ${ap.sql} AND f.workspace_id=$${ap.nextIdx} AND f.id=$${ap.nextIdx + 1}
      AND f.valid_to IS NULL AND f.retracted_at IS NULL AND NOT f.scope_held
      AND NOT scope_review_state_held('workspace_file',f.id)`,
  [...ap.params, workspaceId, fileId])).rows[0]
  const scope = row?.scope
  if (!scope || scope.held || scope.validTo || scope.retractedAt || !scope.version) unavailable()
  assertExecutionResourceScope(scope, 'read', access)
  await assertCurrentFileAssistant(client, scope, authority.access)
  return {
    workspaceId, resourceKind: 'workspace_file', resourceId: fileId, version: scope.version,
    userId: scope.userId, assistantId: scope.assistantId, sensitivity: scope.sensitivity,
    compartments: scope.compartments, projectIds: scope.projectIds,
    storageUri: row.storage_uri, mime: row.mime, name: row.name, sizeBytes: Number(row.size_bytes),
  }
}

export function captureRecordingIntakeParent(authority: RecordingIntakeAuthority, workspaceId: string, fileId: string) {
  return recordingIntakeTransaction(authority, client => readRecordingIntakeParent(client, authority, workspaceId, fileId))
}

/** Call again in the output transaction AFTER asynchronous byte/model work.
 * Source floors need read authority; only added destination labels need write
 * authority. Supplying an inherited empty floor never chooses a new default. */
export async function admitRecordingIntakeParent(
  client: PoolClient, authority: RecordingIntakeAuthority, workspaceId: string,
  expected: RecordingIntakeParent, requested?: ResourceScope,
): Promise<ResourceScope> {
  if (expected.resourceKind !== 'workspace_file' || expected.workspaceId !== workspaceId
    || (requested && requested.workspaceId !== workspaceId)) unavailable()
  const current = await readRecordingIntakeParent(client, authority, workspaceId, expected.resourceId)
  if (current.version !== expected.version || resourceScopeKey(current) !== resourceScopeKey(expected)
    || current.storageUri !== expected.storageUri || current.mime !== expected.mime || current.sizeBytes !== expected.sizeBytes) {
    throw new Error('recording_intake_source_changed')
  }
  const scope = deriveResourceScope({ producer: 'recording-intake', sources: [current] }, requested)
  const access = mutationActorAccess(authority.actorUserId, workspaceId, authority.access)
  assertExecutionResourceScope(scope, 'read', access)
  assertExecutionResourceScope({ ...scope, compartments: scope.compartments.filter(key => !current.compartments.includes(key)) }, 'mutation', access)
  await assertCurrentFileAssistant(client, scope, authority.access)
  const policy = await readAdmissionPolicy(client, workspaceId)
  if (policy?.setupState === 'ready') await admitWorkspaceResource(client, workspaceId, authority.actorUserId, {
    visibility: scope.userId ? 'private' : 'workspace', sensitivity: scope.sensitivity,
    inherited: { ...current, visibility: current.userId ? 'private' : 'workspace' }, inheritedAuthority: 'read',
    requestedLabels: requested ? { compartments: requested.compartments, projectIds: requested.projectIds } : undefined,
  })
  return scope
}

export type RecordingSegmentProvenance = RecordingIntakeAuthority & {
  parent: RecordingIntakeParent
  recordingId?: string
  recordingVersion?: string
  episodeVersion?: string
  recordingStorageKey?: string
}

/** Capture before transcription, not from the Episode's JSON after processing. */
export async function captureRecordingSegmentProvenance(authority: RecordingIntakeAuthority, workspaceId: string, recordingId: string): Promise<RecordingSegmentProvenance> {
  return recordingIntakeTransaction(authority, async client => {
    mutationActorAccess(authority.actorUserId, workspaceId, authority.access)
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    const binding = (await client.query('SELECT file_id,file_version FROM recording_intake_bindings WHERE recording_id=$1 AND workspace_id=$2', [recordingId, workspaceId])).rows[0]
    if (!binding) unavailable()
    const parent = await readRecordingIntakeParent(client, authority, workspaceId, binding.file_id)
    if (parent.version !== binding.file_version) unavailable()
    const r = (await client.query(`SELECT r.gcs_key,r.storage_uri,r.media_file_id,r.scope_version::text AS version,read_entity_derivation_source(r.workspace_id,'recording',r.id) AS recording,read_entity_derivation_source(r.workspace_id,'episode',r.id) AS episode
      FROM recordings r WHERE r.workspace_id=$1 AND r.id=$2 AND NOT r.scope_held AND r.valid_to IS NULL AND r.retracted_at IS NULL`, [workspaceId, recordingId])).rows[0]
    if (!r?.episode || r.recording?.version !== r.version || r.media_file_id !== parent.resourceId || r.storage_uri !== parent.storageUri || r.episode.held || r.episode.validTo || r.episode.retractedAt) unavailable()
    return { ...authority, parent, recordingId, recordingVersion: r.version, episodeVersion: r.episode.version, recordingStorageKey: r.gcs_key }
  })
}

export async function publishRecordingIntakeSegments(workspaceId: string, createdByUserId: string, segments: unknown[], provenance: RecordingSegmentProvenance, replace = false): Promise<number> {
  if (createdByUserId !== provenance.actorUserId) unavailable()
  return recordingIntakeTransaction(provenance, async client => {
    await admitRecordingIntakeParent(client, provenance, workspaceId, provenance.parent)
    const result = await client.query('SELECT publish_media_segments($1::jsonb,$2::uuid,$3::text,$4::text,$5::jsonb,$6::boolean) AS count', [
      JSON.stringify(provenance.parent), provenance.recordingId ?? null, provenance.recordingVersion ?? null,
      provenance.episodeVersion ?? null, JSON.stringify(segments), replace,
    ])
    return result.rows[0].count
  })
}

/** A transcript is derived from the bytes AND the exact recording/anchor read
 * before model work. No creator/JSON inference and no post-model recapture. */
export function recordingTranscriptEvidence(provenance: RecordingSegmentProvenance): DerivedWriteEvidence {
  if (!provenance?.recordingId || !provenance.recordingVersion || !provenance.episodeVersion) return unavailable()
  const parent = provenance.parent
  return { producer: 'recording-transcript', sources: [
    parent,
    { ...parent, resourceKind: 'recording', resourceId: provenance.recordingId, version: provenance.recordingVersion },
    { ...parent, resourceKind: 'episode', resourceId: provenance.recordingId, version: provenance.episodeVersion },
  ] }
}
