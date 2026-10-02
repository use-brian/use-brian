import { admitSessionFile, admitUploadedFile, readFileSessionBinding, type FileSessionBinding } from '../workspace-access/file-publication-admission.js'
import { randomUUID } from 'node:crypto'
import type {
  AccessContext,
  DerivedWriteEvidence,
  EntityLinksStore,
  FileSensitivity,
  WorkspaceFile,
  WorkspaceFileCreateInput,
  WorkspaceFileIndexRow,
  WorkspaceFileMetaPatch,
  WorkspaceFileSupersedePatch,
} from '@use-brian/core'
import type pg from 'pg'
import { bindScopeSource, maxSensitivity, unionScopeRequirements } from '@use-brian/core'
import { assertExecutionResourceScope, buildAccessPredicate, buildCurrentMemberSourcePredicate } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { currentAgentAccess } from './agent-access-context.js'
import { applyRLSGucs, getAppPool, query, queryWithRLS, rollbackAndRelease } from './client.js'
import { emitDocumentedByEdges } from './edge-hooks.js'
import { admitDerivedFile } from '../workspace-access/file-derived-admission.js'
import { admitFileCreate } from '../workspace-access/file-create-admission.js'
import { readAdmissionPolicy } from '../workspace-access/admission-policy-read.js'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'

const FULL_SELECT = `
  id, workspace_id as "workspaceId", path, parent_path as "parentPath",
  name, title, summary, mime, size_bytes as "sizeBytes",
  tags, related_ids as "relatedIds", storage_uri as "storageUri",
  sensitivity, compartments, project_ids as "projectIds", metadata, scope_version::text as "scopeVersion",
  user_id as "userId", assistant_id as "assistantId",
  source, source_episode_id as "sourceEpisodeId",
  verified_by_user_id as "verifiedByUserId", verified_at as "verifiedAt",
  valid_from as "validFrom", valid_to as "validTo",
  superseded_by as "supersededBy",
  retracted_at as "retractedAt", retracted_reason as "retractedReason",
  retracted_by as "retractedBy",
  created_by_user_id as "createdByUserId",
  created_by_assistant_id as "createdByAssistantId",
  created_at as "createdAt", updated_at as "updatedAt"
`

const INDEX_SELECT = `
  id, workspace_id as "workspaceId", path, parent_path as "parentPath",
  name, title, summary, mime, size_bytes as "sizeBytes",
  tags, sensitivity, compartments, project_ids as "projectIds", updated_at as "updatedAt",
  user_id AS "userId", assistant_id AS "assistantId", scope_version::text AS "scopeVersion"
`

type FileRow = {
  scopeVersion: string
  id: string
  workspaceId: string
  path: string
  parentPath: string
  name: string
  title: string | null
  summary: string | null
  mime: string
  sizeBytes: number | string
  tags: string[]
  relatedIds: string[]
  storageUri: string
  sensitivity: FileSensitivity
  compartments: string[]
  projectIds: string[]
  metadata: Record<string, unknown> | null
  userId: string | null
  assistantId: string | null
  source: string
  sourceEpisodeId: string | null
  verifiedByUserId: string | null
  verifiedAt: Date | null
  validFrom: Date
  validTo: Date | null
  supersededBy: string | null
  retractedAt: Date | null
  retractedReason: string | null
  retractedBy: string | null
  createdByUserId: string | null
  createdByAssistantId: string | null
  createdAt: Date
  updatedAt: Date
}

type IndexRow = {
  userId: string | null
  assistantId: string | null
  scopeVersion: string
  id: string
  workspaceId: string
  path: string
  parentPath: string
  name: string
  title: string | null
  summary: string | null
  mime: string
  sizeBytes: number | string
  tags: string[]
  sensitivity: FileSensitivity
  compartments: string[]
  projectIds: string[]
  updatedAt: Date
}

/** Postgres BIGINT comes back as string in pg's default settings; coerce. */
function asNumber(v: number | string): number {
  return typeof v === 'string' ? Number(v) : v
}

function toRecord(row: FileRow): WorkspaceFile {
  return bindFileSource({
    scopeVersion: row.scopeVersion,
    id: row.id,
    workspaceId: row.workspaceId,
    path: row.path,
    parentPath: row.parentPath,
    name: row.name,
    title: row.title,
    summary: row.summary,
    mime: row.mime,
    sizeBytes: asNumber(row.sizeBytes),
    tags: row.tags,
    relatedIds: row.relatedIds,
    storageUri: row.storageUri,
    sensitivity: row.sensitivity,
    compartments: row.compartments ?? [],
    projectIds: row.projectIds ?? [],
    metadata: row.metadata ?? {},
    userId: row.userId,
    assistantId: row.assistantId,
    source: row.source,
    sourceEpisodeId: row.sourceEpisodeId,
    verifiedByUserId: row.verifiedByUserId,
    verifiedAt: row.verifiedAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    supersededBy: row.supersededBy,
    retractedAt: row.retractedAt,
    retractedReason: row.retractedReason,
    retractedBy: row.retractedBy,
    createdByUserId: row.createdByUserId,
    createdByAssistantId: row.createdByAssistantId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }, row)
}

function toIndexRow(row: IndexRow): WorkspaceFileIndexRow {
  return bindFileSource({
    id: row.id,
    workspaceId: row.workspaceId,
    path: row.path,
    parentPath: row.parentPath,
    name: row.name,
    title: row.title,
    summary: row.summary,
    mime: row.mime,
    sizeBytes: asNumber(row.sizeBytes),
    tags: row.tags,
    sensitivity: row.sensitivity,
    compartments: row.compartments ?? [],
    projectIds: row.projectIds ?? [],
    updatedAt: row.updatedAt,
  }, row)
}

function bindFileSource<T extends object>(value: T, row: IndexRow): T {
  return bindScopeSource(value, { resourceKind: 'workspace_file', resourceId: row.id,
    version: row.scopeVersion, workspaceId: row.workspaceId, userId: row.userId,
    assistantId: row.assistantId, sensitivity: row.sensitivity,
    compartments: row.compartments, projectIds: row.projectIds })
}

function fileMutationAccess(userId: string, workspaceId: string, access?: AccessContext): AccessContext | undefined {
  const agent = currentAgentAccess()
  if (agent && (!agent.workspaceId || !agent.userId || agent.workspaceId !== workspaceId || agent.userId !== userId)
      || access && (access.workspaceId !== workspaceId || access.userId !== userId)) {
    throw Object.assign(new Error('The operation requires the executing author.'), { code: 'scope_operation_denied' })
  }
  return access ?? (agent ? { workspaceId, userId, assistantId: '', assistantKind: 'primary' } : undefined)
}

function fileSourceGuard(userId: string, access: AccessContext | undefined, startIdx: number) {
  const execution = access ? buildAccessPredicate(access, { startIdx, operation: 'mutation' }) : { sql: 'TRUE', params: [], nextIdx: startIdx }
  const member = buildCurrentMemberSourcePredicate(userId, { alias: 'workspace_files', startIdx: execution.nextIdx })
  return { sql: `(${execution.sql}) AND (${member.sql})`, params: [...execution.params, ...member.params], nextIdx: member.nextIdx }
}

/**
 * Create a workspace file.
 *
 * WU-1.7 edge hook: when `opts.documentsEntityIds` is non-empty AND an
 * `opts.entityLinks` store is passed, an `entity → file` `documented_by`
 * edge is emitted per entity id, fire-and-forget, after the file row is
 * written. Edge failures never affect the file save (see
 * `edge-hooks.ts`). `opts` is optional so existing call sites keep
 * compiling unchanged. The `documents...` data rides a separate `opts`
 * arg rather than `WorkspaceFileCreateInput` because that input type is
 * a `@use-brian/core` contract — widening it is a follow-up.
 */
export async function createWorkspaceFile(
  userId: string,
  input: WorkspaceFileCreateInput,
  opts: {
    access?: AccessContext
    /** Optional admission preview fence; checked under the workspace lock. */
    expectedPolicyRevision?: string
    /** Trusted canonical snapshots from this call, never HTTP/model input. */
    derivation?: DerivedWriteEvidence
    sessionBinding?: FileSessionBinding
    uploadId?: string
    entityLinks?: EntityLinksStore
    /** Entity ids this file documents — each gets a `documented_by`
     *  edge (WU-1.7). Optional; empty/absent means no edge emission. */
    documentsEntityIds?: readonly string[]
    /** Commit SHA provenance, stored in the edge's `attributes` JSONB. */
    commitSha?: string
  } = {},
): Promise<WorkspaceFile> {
  // An owner/author on the input is not a substitute for the executing actor.
  if (!userId) throw Object.assign(new Error('File creation requires an executing actor.'), { code: 'file_admission_provenance_required' })
  const access = fileMutationAccess(userId, input.workspaceId, opts.access)
  if (!opts.derivation) assertExecutionResourceScope({ workspaceId: input.workspaceId,
    userId: input.userId ?? null, assistantId: input.assistantId ?? null,
    sensitivity: input.sensitivity ?? 'internal', compartments: input.compartments ?? [],
    projectIds: input.projectIds ?? [] }, 'mutation', access)
  // WU-4.5 — `input.createdByUserId` is the row author (separate from
  // the `userId` arg which is the RLS actor; they are usually equal
  // but the row-author identity is what gets stamped). Reject the
  // insert if it would land NULL — mig 128 leaves the column nullable
  // for legacy rows, so the guard, not the schema, enforces.
  assertAuthorshipPresent('createWorkspaceFile', input.createdByUserId)
  const client = await getAppPool().connect()
  let file: WorkspaceFile
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[input.workspaceId])
    input = opts.sessionBinding ? await admitSessionFile(client,userId,input,opts.sessionBinding,access)
      : opts.uploadId ? await admitUploadedFile(client,userId,input,opts.uploadId,access)
      : opts.derivation
      ? await admitDerivedFile(client, userId, input, opts.derivation, access, opts.expectedPolicyRevision)
      : await admitFileCreate(client, userId, input, opts.expectedPolicyRevision)
    // Recheck the resolved destination, not only the caller's pre-default labels.
    if (!opts.derivation) assertExecutionResourceScope({ workspaceId: input.workspaceId,
      userId: input.userId ?? null, assistantId: input.assistantId ?? null,
      sensitivity: input.sensitivity ?? 'internal', compartments: input.compartments ?? [],
      projectIds: input.projectIds ?? [] }, 'mutation', access)
    // When the caller supplies an id (the files-api does, so the GCS key
    // and DB row share the same uuid), use it; otherwise let the DB
    // default `gen_random_uuid()` fire.
    const cols: string[] = [
      'workspace_id', 'path', 'parent_path', 'name', 'title', 'summary',
      'mime', 'size_bytes', 'tags', 'related_ids', 'storage_uri',
      'sensitivity', 'metadata',
      'user_id', 'assistant_id', 'source', 'source_episode_id',
      'created_by_user_id', 'created_by_assistant_id', 'compartments', 'project_ids',
    ]
    const values: unknown[] = [
      input.workspaceId,
      input.path,
      input.parentPath,
      input.name,
      input.title ?? null,
      input.summary ?? null,
      input.mime,
      input.sizeBytes,
      input.tags ?? [],
      input.relatedIds ?? [],
      input.storageUri,
      input.sensitivity ?? 'internal',
      JSON.stringify(input.metadata ?? {}),
      input.userId ?? null,
      input.assistantId ?? null,
      input.source ?? 'user',
      input.sourceEpisodeId ?? null,
      input.createdByUserId,
      input.createdByAssistantId ?? null,
      input.compartments ?? [],
      input.projectIds ?? [],
    ]
    if (input.id) {
      cols.unshift('id')
      values.unshift(input.id)
    }
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
    const workspaceParam = cols.indexOf('workspace_id') + 1
    const teamParam = cols.indexOf('compartments') + 1
    values.push(userId)
    const actorParam = values.length
    const result = opts.derivation
      ? await client.query<FileRow>(`SELECT ${FULL_SELECT} FROM create_source_derived_file($1::jsonb,$2::jsonb)`,
        [JSON.stringify(input), JSON.stringify(opts.derivation)])
      : await client.query<FileRow>(
      `INSERT INTO workspace_files (${cols.join(', ')})
       SELECT ${placeholders}
       WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=$${workspaceParam} AND user_id=$${actorParam})
         AND (effective_member_team_compartments($${actorParam},$${workspaceParam}) IS NULL
           OR $${teamParam}::text[] <@ effective_member_team_compartments($${actorParam},$${workspaceParam}))
       RETURNING ${FULL_SELECT}`,
      values,
    )
    if (!result.rows[0]) throw Object.assign(new Error('The operation exceeds current department access.'), { code: 'scope_operation_denied' })
    file = toRecord(result.rows[0])
    if (opts.sessionBinding) await client.query(`INSERT INTO workspace_file_session_bindings(file_id,artifact_id,workspace_id,owner_user_id,snapshot,bound_scope)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[file.id,opts.sessionBinding.artifactId,input.workspaceId,userId,opts.sessionBinding.snapshot,
        JSON.stringify({sensitivity:file.sensitivity,compartments:file.compartments,projectIds:file.projectIds})])
    if (opts.sessionBinding?.pending) {
      const role=input.path.split('/')[4]
      if (!['source','snapshot','signature','preview','release'].includes(role??'') || typeof input.metadata?.contentSha256!=='string') throw new Error('pdf_intake_asset_changed')
      await client.query(`INSERT INTO office_pdf_session_assets(artifact_id,workspace_id,owner_user_id,file_id,role,content_sha256)
        VALUES($1,$2,$3,$4,$5,$6)`,[opts.sessionBinding.artifactId,input.workspaceId,userId,file.id,role,input.metadata.contentSha256])
    }
    if (opts.uploadId) await client.query("UPDATE workspace_file_uploads SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1",[opts.uploadId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await rollbackAndRelease(client)
  }

  // Fire-and-forget `documented_by` edges (entity → file) — `void`,
  // never awaited on the caller's path, never able to throw into the
  // file save.
  if (opts.entityLinks && opts.documentsEntityIds && opts.documentsEntityIds.length > 0) {
    // Edge trust source mirrors the file's: pipeline-extracted files
    // yield an `'extracted'` edge, everything else `'user'` (file
    // `source` is a free `string`, normalized here to `EntitySource`).
    const edgeSource = file.source === 'extracted' ? 'extracted' : 'user'
    void emitDocumentedByEdges(opts.entityLinks, userId, {
      fileId: file.id,
      entityIds: opts.documentsEntityIds,
      workspaceId: file.workspaceId,
      source: edgeSource,
      userId: file.userId,
      assistantId: file.assistantId,
      sourceEpisodeId: file.sourceEpisodeId,
      commitSha: opts.commitSha,
      compartments: file.compartments,
      projectIds: file.projectIds,
    })
  }
  return file
}

export async function getWorkspaceFileById(
  ctx: AccessContext,
  id: string,
): Promise<WorkspaceFile | null> {
  // Universal access projection (WU-4.2b) + `valid_to IS NULL` to hide
  // superseded versions; history reachable via `getWorkspaceFileHistory`.
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<FileRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM workspace_files
     WHERE ${ap.sql}
       AND id = $${ap.nextIdx} AND valid_to IS NULL`,
    [...ap.params, id],
  )
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

export async function getWorkspaceFileByPath(
  ctx: AccessContext,
  path: string,
): Promise<WorkspaceFile | null> {
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<FileRow>(
    ctx.userId,
    `SELECT ${FULL_SELECT} FROM workspace_files
     WHERE ${ap.sql}
       AND path = $${ap.nextIdx} AND valid_to IS NULL`,
    [...ap.params, path],
  )
  return result.rows.length === 0 ? null : toRecord(result.rows[0])
}

/** Current source and browser display lifetime from the same RLS snapshot. */
export async function getWorkspaceFileReadProjection(ctx: AccessContext, id: string): Promise<{file:WorkspaceFile;validForMs:number}|null> {
  const ap=buildAccessPredicate(ctx,{startIdx:1})
  const result=await queryWithRLS<FileRow & {validForMs:number}>(ctx.userId,
    `SELECT ${FULL_SELECT}, department_media_valid_for_ms(workspace_files.workspace_id) AS "validForMs"
     FROM workspace_files WHERE ${ap.sql} AND id=$${ap.nextIdx} AND valid_to IS NULL`,
    [...ap.params,id])
  const row=result.rows[0]
  return row?{file:toRecord(row),validForMs:row.validForMs}:null
}

export async function updateWorkspaceFileMeta(
  userId: string,
  workspaceId: string,
  id: string,
  patch: WorkspaceFileMetaPatch,
  transactionClient?: pg.PoolClient,
  access?: AccessContext,
): Promise<WorkspaceFile | null> {
  access = fileMutationAccess(userId, workspaceId, access)
  if (access) assertExecutionResourceScope({ workspaceId, userId: null, assistantId: null, sensitivity: 'public',
    compartments: patch.inheritCompartments ?? [], projectIds: patch.inheritProjectIds ?? [] }, 'mutation', access)
  if (!transactionClient) {
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await applyRLSGucs(client, userId)
      const result = await updateWorkspaceFileMeta(userId, workspaceId, id, patch, client, access)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { await rollbackAndRelease(client) }
  }
  // Metadata-only edits stay in-place per corrections.md §D.7 — only
  // content (substantive) edits route through `supersedeWorkspaceFile`.
  // The lock-in side of the draft lifecycle (remove `'draft'`, add
  // `'final'`) is a tags patch, which lands here.
  {
    const guard = fileSourceGuard(userId, access, 3)
    const current = await transactionClient.query<FileRow>(`SELECT ${FULL_SELECT} FROM workspace_files
      WHERE id=$1 AND workspace_id=$2 AND valid_to IS NULL AND retracted_at IS NULL
        AND NOT scope_held AND ${guard.sql} FOR UPDATE`, [id, workspaceId, ...guard.params])
    if (!current.rows[0]) return null
    const source = current.rows[0]
    if (patch.sensitivity !== undefined && maxSensitivity(source.sensitivity, patch.sensitivity) !== patch.sensitivity) {
      throw Object.assign(new Error('Lowering sensitivity requires an audited release.'), { code: 'scope_declassification_required' })
    }
    assertExecutionResourceScope({ ...source, sensitivity: patch.sensitivity ?? source.sensitivity,
      compartments: unionScopeRequirements(source.compartments, patch.inheritCompartments),
      projectIds: unionScopeRequirements(source.projectIds, patch.inheritProjectIds) }, 'mutation', access)
  }
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1
  let destinationCompartments = 'workspace_files.compartments'

  if (patch.title !== undefined)       { sets.push(`title = $${idx}`);       values.push(patch.title);       idx++ }
  if (patch.summary !== undefined)     { sets.push(`summary = $${idx}`);     values.push(patch.summary);     idx++ }
  if (patch.tags !== undefined)        { sets.push(`tags = $${idx}`);        values.push(patch.tags);        idx++ }
  if (patch.relatedIds !== undefined)  { sets.push(`related_ids = $${idx}`); values.push(patch.relatedIds);  idx++ }
  if (patch.sensitivity !== undefined) { sets.push(`sensitivity = $${idx}`); values.push(patch.sensitivity); idx++ }
  if (patch.metadata !== undefined)    { sets.push(`metadata = $${idx}`);    values.push(JSON.stringify(patch.metadata)); idx++ }
  if (patch.inheritCompartments !== undefined) {
    destinationCompartments = `(workspace_files.compartments || $${idx}::text[])`
    sets.push(`compartments = ARRAY(SELECT DISTINCT unnest(compartments || $${idx}::text[]) ORDER BY 1)`)
    values.push(patch.inheritCompartments)
    idx++
  }
  if (patch.inheritProjectIds !== undefined) {
    sets.push(`project_ids = ARRAY(SELECT DISTINCT unnest(project_ids || $${idx}::uuid[]) ORDER BY 1)`)
    values.push(patch.inheritProjectIds)
    idx++
  }

  if (sets.length === 0) {
    // No-op reads retain the current-member and execution source floor.
    const guard = fileSourceGuard(userId, access, 3)
    const sql = `SELECT ${FULL_SELECT} FROM workspace_files
       WHERE id = $1 AND workspace_id = $2 AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held AND ${guard.sql}`
    const values = [id, workspaceId, ...guard.params]
    const cur = transactionClient
      ? await transactionClient.query<FileRow>(sql, values)
      : await queryWithRLS<FileRow>(userId, sql, values)
    return cur.rows.length === 0 ? null : toRecord(cur.rows[0])
  }

  values.push(id, workspaceId)
  const guard = fileSourceGuard(userId, access, values.length + 1)
  values.push(...guard.params)
  const sql = `UPDATE workspace_files SET ${sets.join(', ')}
     WHERE id = $${idx} AND workspace_id = $${idx + 1} AND valid_to IS NULL
       AND retracted_at IS NULL AND NOT scope_held AND ${guard.sql}
       AND (effective_member_team_compartments($${guard.nextIdx - 1},workspace_files.workspace_id) IS NULL
         OR ${destinationCompartments} <@ effective_member_team_compartments($${guard.nextIdx - 1},workspace_files.workspace_id))
     RETURNING ${FULL_SELECT}`
  const result = transactionClient
    ? await transactionClient.query<FileRow>(sql, values)
    : await queryWithRLS<FileRow>(userId, sql, values)
  if (result.rows.length === 0) return null

  // Lifecycle propagation (large-content-artifacts §Phase 2.1): file_segments
  // are derived rows that inherit sensitivity/compartments/tags verbatim at
  // chunk time — a ceiling raise on the parent must reach them or segments
  // keep surfacing at the OLD ceiling. Runs immediately after the RLS-gated
  // parent update (segments are rebuildable derived data; a failure here is
  // loud, not silent).
  if (patch.sensitivity !== undefined || patch.tags !== undefined
      || patch.inheritCompartments !== undefined || patch.inheritProjectIds !== undefined) {
    const segSets: string[] = []
    const segValues: unknown[] = [id]
    if (patch.sensitivity !== undefined) {
      segValues.push(patch.sensitivity)
      segSets.push(`sensitivity = CASE WHEN sensitivity_rank($${segValues.length}) > sensitivity_rank(sensitivity) THEN $${segValues.length} ELSE sensitivity END`)
    }
    if (patch.tags !== undefined) {
      segValues.push(patch.tags)
      segSets.push(`tags = $${segValues.length}`)
    }
    if (patch.inheritCompartments !== undefined) {
      segValues.push(patch.inheritCompartments)
      segSets.push(`compartments = ARRAY(SELECT DISTINCT unnest(compartments || $${segValues.length}::text[]) ORDER BY 1)`)
    }
    if (patch.inheritProjectIds !== undefined) {
      segValues.push(patch.inheritProjectIds)
      segSets.push(`project_ids = ARRAY(SELECT DISTINCT unnest(project_ids || $${segValues.length}::uuid[]) ORDER BY 1)`)
    }
    if (transactionClient) {
      await transactionClient.query(
        `UPDATE file_segments SET ${segSets.join(', ')} WHERE file_id = $1`,
        segValues,
      )
    } else {
      await query(`UPDATE file_segments SET ${segSets.join(', ')} WHERE file_id = $1`, segValues)
    }
  }
  return toRecord(result.rows[0])
}

export async function updateWorkspaceFileSize(
  userId: string,
  workspaceId: string,
  id: string,
  sizeBytes: number,
  scope: { compartments?: string[]; projectIds?: string[] } = {},
  access?: AccessContext,
): Promise<WorkspaceFile | null> {
  // Legacy metadata-only adapter. Content append publishes a successor blob.
  access = fileMutationAccess(userId, workspaceId, access)
  assertExecutionResourceScope({ workspaceId, userId: null, assistantId: null, sensitivity: 'public',
    compartments: scope.compartments ?? [], projectIds: scope.projectIds ?? [] }, 'mutation', access)
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    // This UPDATE holds the source lock and propagates inherited requirements
    // to segments in the same transaction as the metadata-only size change.
    const current = await updateWorkspaceFileMeta(userId, workspaceId, id, {
      inheritCompartments: scope.compartments ?? [], inheritProjectIds: scope.projectIds ?? [],
    }, client, access)
    if (!current) { await client.query('ROLLBACK'); return null }
    const result = await client.query<FileRow>(`UPDATE workspace_files SET size_bytes=$1
      WHERE id=$2 AND workspace_id=$3 RETURNING ${FULL_SELECT}`, [sizeBytes, id, workspaceId])
    await client.query('COMMIT')
    return toRecord(result.rows[0])
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { await rollbackAndRelease(client) }
}

export async function deleteWorkspaceFile(
  userId: string,
  workspaceId: string,
  id: string,
  access?: AccessContext,
): Promise<boolean> {
  access = fileMutationAccess(userId, workspaceId, access)
  const guard = fileSourceGuard(userId, access, 3)
  // Hard-deletes the current row. WU-6 (D.3 retraction) introduces the
  // soft-delete path; for now `delete` clears both the DB row and (via
  // files-api) the GCS blob, matching pre-WS-2 semantics.
  const result = await queryWithRLS<{ id: string }>(
    userId,
    `DELETE FROM workspace_files
     WHERE id = $1 AND workspace_id = $2 AND valid_to IS NULL
       AND retracted_at IS NULL AND NOT scope_held AND ${guard.sql}
     RETURNING id`,
    [id, workspaceId, ...guard.params],
  )
  return result.rows.length > 0
}

/**
 * Close the derived `file_segments` of a file that just left the current
 * bi-temporal window (soft delete).
 *
 * Every retrieval predicate reads the SEGMENT's own window — `visibilityPredicate`
 * in `retrieval-store.ts` filters `fs.valid_to` / `fs.retracted_at` and never
 * joins the parent `workspace_files` row. Closing only the file therefore drops
 * it off the Brain list while leaving its extracted text fully searchable and
 * readable: `searchFileContent`, `readFileSegmentRange` and the brain
 * `file_segment` arm all keep answering from a file the user deleted. The
 * hard-delete path never had this problem (mig 297's FK is
 * `ON DELETE CASCADE`); only the soft path needs the explicit close.
 *
 * System-level (no RLS) — the caller has already proven workspace ownership.
 * Mirrors the same cascade `supersedeWorkspaceFile` runs in-transaction and
 * `retractWorkspaceFilesByStorageBucket` runs for the staleness sweep.
 */
export async function closeWorkspaceFileSegmentsSystem(fileId: string): Promise<number> {
  const result = await query(
    `UPDATE file_segments
        SET valid_to = now()
      WHERE file_id = $1 AND valid_to IS NULL`,
    [fileId],
  )
  return result.rowCount ?? 0
}

export async function retractWorkspaceFilesByStorageBucket(
  workspaceId: string,
  bucket: string,
  scheme: 'gs' | 's3',
  reason: string,
): Promise<number> {
  // System-level (no RLS) — invoked by the BYO storage staleness sweep when a
  // disconnected binding's bucket goes stale and its key is wiped. Soft-retracts
  // every current row whose bytes live in `bucket` (now unreadable), closing the
  // bi-temporal window so all current-version queries (search, L1, getById /
  // getByPath, sumSize) stop surfacing them. Audit history is preserved.
  // `^@` is the prefix operator (no LIKE wildcard interpretation of the bucket).
  const result = await query(
    `UPDATE workspace_files
        SET valid_to = now(), retracted_at = now(), retracted_reason = $3
      WHERE workspace_id = $1
        AND storage_uri ^@ $2
        AND valid_to IS NULL
        AND retracted_at IS NULL`,
    [workspaceId, `${scheme}://${bucket}/`, reason],
  )
  // Propagate the retraction to derived file_segments so the retrieval
  // predicates (retracted_at IS NULL + bi-temporal window) stop surfacing
  // segments of now-unreadable files (large-content-artifacts §Phase 2.1).
  if ((result.rowCount ?? 0) > 0) {
    await query(
      `UPDATE file_segments fs
          SET valid_to = now(), retracted_at = now(), retracted_reason = $3
         FROM workspace_files wf
        WHERE fs.file_id = wf.id
          AND wf.workspace_id = $1
          AND wf.storage_uri ^@ $2
          AND wf.retracted_reason = $3
          AND fs.retracted_at IS NULL`,
      [workspaceId, `${scheme}://${bucket}/`, reason],
    )
  }
  return result.rowCount ?? 0
}

export async function listWorkspaceFilesByPath(
  ctx: AccessContext,
  opts: { prefix?: string; limit?: number; offset?: number },
): Promise<WorkspaceFileIndexRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  const prefix = opts.prefix ?? ''
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<IndexRow>(
    ctx.userId,
    `SELECT ${INDEX_SELECT} FROM workspace_files
     WHERE ${ap.sql}
       AND parent_path = $${ap.nextIdx} AND valid_to IS NULL
       AND path NOT LIKE '/office/sessions/%'
       AND NOT COALESCE((metadata->>'noIndex')::boolean, false)
     ORDER BY updated_at DESC
     LIMIT $${ap.nextIdx + 1} OFFSET $${ap.nextIdx + 2}`,
    [...ap.params, prefix, limit, offset],
  )
  return result.rows.map(toIndexRow)
}

/**
 * List files under a RESERVED path prefix (`/apps/`, `/doc/`).
 *
 * `searchWorkspaceFiles` deliberately excludes those prefixes so third-party
 * bundle source never reaches brain retrieval — which means it can never be
 * used to *manage* them either. Bundle replacement was written on top of that
 * search and therefore always found nothing: the delete silently no-opped and
 * the following write failed with `conflict`, so re-importing or re-syncing a
 * custom Home app had never worked.
 *
 * System-scoped on purpose: this is storage housekeeping for a known prefix,
 * not a user-facing read, and it must see exactly what the exclusion hides.
 * Never expose it on a retrieval path.
 */
export async function listWorkspaceFilesUnderReservedPrefix(
  workspaceId: string,
  prefix: string,
): Promise<Array<{ path: string }>> {
  if (!prefix.startsWith('/doc/') && !prefix.startsWith('/apps/')) {
    throw new Error(`Not a reserved prefix: ${prefix}`)
  }
  const result = await query<{ path: string }>(
    `SELECT path FROM workspace_files
      WHERE workspace_id = $1 AND valid_to IS NULL AND path LIKE $2
      ORDER BY path`,
    [workspaceId, `${prefix}%`],
  )
  return result.rows
}

export async function searchWorkspaceFiles(
  ctx: AccessContext,
  opts: { query?: string; tag?: string; parentPath?: string; limit?: number },
): Promise<WorkspaceFileIndexRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100)
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  // Two reserved path prefixes are durable storage but deliberately EXCLUDED
  // from `fileSearch`, so neither pollutes brain retrieval:
  //   `/doc/`  — doc-block media (packages/api/src/routes/doc-files.ts);
  //              high-volume decorative paste/drop content.
  //   `/apps/` — custom Home app bundles (routes/home-apps.ts); an app's HTML
  //              and JS are program text, not workspace knowledge, and a
  //              `fileSearch` that returned them would put third-party source
  //              into the assistant's context.
  const wheres: string[] = [
    ap.sql,
    'valid_to IS NULL',
    "path NOT LIKE '/doc/%'",
    "path NOT LIKE '/apps/%'",
    "path NOT LIKE '/office/sessions/%'",
    "NOT COALESCE((metadata->>'noIndex')::boolean, false)",
  ]
  const values: unknown[] = [...ap.params]
  let idx = ap.nextIdx
  let orderBy = 'updated_at DESC'

  if (opts.query && opts.query.trim().length > 0) {
    wheres.push(`search_vector @@ plainto_tsquery('english', $${idx})`)
    values.push(opts.query)
    orderBy = `ts_rank_cd(search_vector, plainto_tsquery('english', $${idx})) DESC`
    idx++
  }
  if (opts.tag) {
    wheres.push(`$${idx} = ANY(tags)`)
    values.push(opts.tag)
    idx++
  }
  if (opts.parentPath !== undefined) {
    wheres.push(`parent_path = $${idx}`)
    values.push(opts.parentPath)
    idx++
  }

  values.push(limit)
  const result = await queryWithRLS<IndexRow>(
    ctx.userId,
    `SELECT ${INDEX_SELECT} FROM workspace_files
     WHERE ${wheres.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT $${idx}`,
    values,
  )
  return result.rows.map(toIndexRow)
}

export async function listWorkspaceFilesIndexRanked(
  ctx: AccessContext,
  limit: number,
): Promise<WorkspaceFileIndexRow[]> {
  const cap = Math.min(Math.max(limit, 1), 200)
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  // Doc-block media (reserved `/doc/` path prefix — see
  // packages/api/src/routes/doc-files.ts) is excluded from the ranked
  // index that backs the L1 `# Workspace Files` prompt block, so embedded
  // page decoration never surfaces in the assistant's working context. Custom
  // Home app bundles (`/apps/`) are excluded for the same reason: an app's
  // source is program text, not workspace knowledge.
  const result = await queryWithRLS<IndexRow>(
    ctx.userId,
    `SELECT ${INDEX_SELECT} FROM workspace_files
     WHERE ${ap.sql} AND valid_to IS NULL
       AND path NOT LIKE '/doc/%' AND path NOT LIKE '/apps/%'
       AND path NOT LIKE '/office/sessions/%'
       AND NOT COALESCE((metadata->>'noIndex')::boolean, false)
     ORDER BY updated_at DESC
     LIMIT $${ap.nextIdx}`,
    [...ap.params, cap],
  )
  return result.rows.map(toIndexRow)
}

/**
 * Marks a row whose bytes are NOT charged to the workspace quota.
 *
 * The only user today is recording media. A recording's audio gets a
 * workspace_files row so it is visible to ERASURE (erasure.md: workspace_files
 * is hard-delete + GCS object delete; without a row the bytes are structurally
 * invisible and survive forever) and to the UI — but it is not a file the
 * workspace "uploaded" in the quota sense. A 2-hour recording is 50-500 MB
 * against a 1 GiB cap, so charging it would make the quota a
 * 2-to-20-recordings limit and mean nothing else.
 *
 * Erasure visibility and quota accounting are separate concerns; this flag is
 * what keeps them separate.
 *
 * It is deliberately NOT the `source` column: `source` is a TRUST signal with a
 * controlled vocabulary (SOURCE_WEIGHTS, 0.85 default), so a novel value there
 * would silently down-weight the row in search and conflate "how trustworthy is
 * this provenance" with "what kind of artifact is this".
 */
export const QUOTA_EXEMPT_META_KEY = 'quota_exempt'

export async function sumWorkspaceFilesSizeBytes(
  ctx: AccessContext,
): Promise<number> {
  // Historical (superseded) rows are excluded from the quota — their
  // GCS blobs may linger until retraction sweeps, but the current
  // active rows are what the quota gates against.
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<{ total: number | string | null }>(
    ctx.userId,
    `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
     FROM workspace_files
     WHERE ${ap.sql} AND valid_to IS NULL
       AND NOT COALESCE((metadata->>'${QUOTA_EXEMPT_META_KEY}')::boolean, false)`,
    [...ap.params],
  )
  const total = result.rows[0]?.total ?? 0
  return typeof total === 'string' ? Number(total) : total
}

/**
 * Atomic supersession (SV(2)). Closes the current row's bi-temporal
 * window and inserts a successor in a single transaction so neither
 * write lands without the other. RLS is engaged for the duration of
 * the transaction.
 *
 * Path-stable supersession works because the `(workspace_id, path)`
 * uniqueness is scoped to the current version — mig 445 replaced mig
 * 119's unscoped `workspace_files_workspace_id_path_key` with the
 * partial `uq_workspace_files_current_path ... WHERE valid_to IS NULL`.
 * The close and the insert run in one transaction, so the old row has
 * already left the current window when the successor claims the path.
 */
export async function supersedeWorkspaceFile(
  userId: string,
  workspaceId: string,
  id: string,
  patch: WorkspaceFileSupersedePatch,
  access?: AccessContext,
): Promise<WorkspaceFile | null> {
  access = fileMutationAccess(userId, workspaceId, access)
  const agent = currentAgentAccess()
  if (!userId || patch.editorUserId !== userId || (agent?.userId !== undefined && agent.userId !== userId)) {
    throw Object.assign(new Error('The operation requires the executing author.'), { code: 'scope_operation_denied' })
  }
  const client = await getAppPool().connect()
  try {
    // Runs on the app pool (app_user, subject to RLS). `BEGIN` first, then
    // `SET LOCAL app.current_user_id` so it reverts at COMMIT/ROLLBACK to the
    // seeded sentinel and never leaks onto the pooled connection.
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    // Serialize mode/authority before locking the predecessor. A successor is
    // admitted from this mutation-authorized canonical row, not root metadata.
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    const policy = await readAdmissionPolicy(client, workspaceId)
    if (policy && policy.setupState !== 'legacy') {
      await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId, userId])
    }

    const sourceGuard = fileSourceGuard(userId, access, 3)
    const current = await client.query<FileRow>(
      `SELECT ${FULL_SELECT} FROM workspace_files
       WHERE id = $1 AND workspace_id = $2 AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
       AND ${sourceGuard.sql} FOR UPDATE`,
      [id, workspaceId, ...sourceGuard.params],
    )

    if (current.rows.length === 0) {
      await client.query('ROLLBACK')
      return null
    }

    const old = current.rows[0]
    if (patch.expectedScopeVersion !== undefined && old.scopeVersion !== patch.expectedScopeVersion) {
      await client.query('ROLLBACK')
      return null
    }
    const sessionRecord=(await client.query('SELECT artifact_id FROM workspace_file_session_bindings WHERE file_id=$1',[old.id])).rows[0]
    const sessionBinding=sessionRecord ? await readFileSessionBinding(client,userId,workspaceId,patch.path??old.path,access) : undefined
    if (sessionRecord && sessionBinding?.artifactId!==sessionRecord.artifact_id) throw Object.assign(new Error('Session binding changed'),{code:'scope_operation_denied'})
    const sourceScope = { ...old, compartments: old.compartments ?? [], projectIds: old.projectIds ?? [] }
    assertExecutionResourceScope(sourceScope, 'read', access)
    assertExecutionResourceScope(sourceScope, 'mutation', access)
    const nextSensitivity = maxSensitivity(old.sensitivity, patch.sensitivity ?? old.sensitivity)
    if (patch.sensitivity !== undefined && nextSensitivity !== patch.sensitivity) {
      throw Object.assign(new Error('Lowering sensitivity requires an audited release.'), { code: 'scope_declassification_required' })
    }
    let after = { sensitivity: nextSensitivity,
      compartments: unionScopeRequirements(old.compartments, patch.compartments),
      projectIds: unionScopeRequirements(old.projectIds, patch.projectIds) }
    assertExecutionResourceScope({ ...sourceScope, ...after }, 'mutation', access)
    const newId = randomUUID()

    // Close segments while the locked, mutation-authorized predecessor is
    // still current. Retiring it first holds its descendants and makes their
    // live-parent SELECT policy hide them from this app-role UPDATE. Keep RLS
    // engaged; destination denial or insert failure rolls back both closes.
    // The successor is re-indexed separately from its new bytes.
    await client.query(
      `UPDATE file_segments
          SET valid_to = now()
        WHERE file_id = $1 AND workspace_id = $2 AND valid_to IS NULL`,
      [id, workspaceId],
    )

    await client.query(
      `UPDATE workspace_files
          SET valid_to = now(),
              superseded_by = $1
        WHERE id = $2 AND workspace_id = $3`,
      [newId, id, workspaceId],
    )

    // Retiring the predecessor advances the policy revision via canonical
    // scope triggers. Resolve immediately before INSERT so the one-use receipt
    // fences that current revision. Any denial rolls back both closes above;
    // the verified predecessor and workspace remain locked throughout.
    if (policy && policy.setupState !== 'legacy') {
      const visibility = old.userId ? 'private' : 'workspace'
      const admitted = await admitWorkspaceResource(client, workspaceId, userId, {
        writerKind: 'workspace_file',
        rowVisibility: { userId: old.userId, assistantId: old.assistantId },
        visibility, sensitivity: nextSensitivity,
        inherited: { visibility, sensitivity: old.sensitivity,
          compartments: sourceScope.compartments, projectIds: sourceScope.projectIds },
        inheritedAuthority: 'mutation',
        // Supersede patches add requirements; [] means no additions, not a
        // new root's explicit General destination. Never erase the prior floor.
        requestedLabels: { compartments: patch.compartments?.length ? patch.compartments : undefined,
          projectIds: patch.projectIds?.length ? patch.projectIds : undefined },
      })
      after = admitted.envelope
      assertExecutionResourceScope({ ...sourceScope, ...after }, 'mutation', access)
    }

    const inserted = await client.query<FileRow>(
      `INSERT INTO workspace_files (
         id, workspace_id, path, parent_path, name, title, summary,
         mime, size_bytes, tags, related_ids, storage_uri,
         sensitivity, metadata,
         user_id, assistant_id, source, source_episode_id,
         valid_from, created_by_user_id, created_by_assistant_id,
         compartments, project_ids
       )
       SELECT
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14,
         $15, $16, $17, $18,
         now(), $19, $20,
         $21::text[], $22::uuid[]
       WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=$2 AND user_id=$19)
         AND (effective_member_team_compartments($19,$2) IS NULL
           OR $21::text[] <@ effective_member_team_compartments($19,$2))
       RETURNING ${FULL_SELECT}`,
      [
        newId,
        workspaceId,
        patch.path ?? old.path,
        patch.parentPath ?? old.parentPath,
        patch.name ?? old.name,
        patch.title !== undefined ? patch.title : old.title,
        patch.summary !== undefined ? patch.summary : old.summary,
        patch.mime ?? old.mime,
        patch.sizeBytes,
        patch.tags ?? old.tags,
        patch.relatedIds ?? old.relatedIds,
        patch.storageUri,
        after.sensitivity,
        JSON.stringify(patch.metadata ?? old.metadata ?? {}),
        old.userId,
        old.assistantId,
        old.source,
        old.sourceEpisodeId,
        patch.editorUserId,
        patch.editorAssistantId ?? null,
        after.compartments,
        after.projectIds,
      ],
    )

    if (!inserted.rows[0]) throw Object.assign(new Error('The operation exceeds current department access.'), { code: 'scope_operation_denied' })
    if (sessionBinding) await client.query(`INSERT INTO workspace_file_session_bindings(file_id,artifact_id,workspace_id,owner_user_id,snapshot,bound_scope)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[newId,sessionBinding.artifactId,workspaceId,userId,sessionBinding.snapshot,JSON.stringify(after)])
    await client.query('COMMIT')
    return toRecord(inserted.rows[0])
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await rollbackAndRelease(client)
  }
}

/**
 * D.7 audit walk — every version of this row's supersession chain,
 * ordered oldest → newest by `valid_from`. The recursive CTE accepts
 * any id within the chain; results converge to the same set whether
 * the caller passed the head, tail, or a middle version (the anchor
 * starts at the passed id, then walks both backward via `superseded_by`
 * and forward via the inverse).
 */
export async function getWorkspaceFileHistory(
  ctx: AccessContext,
  id: string,
): Promise<WorkspaceFile[]> {
  // Recursive CTE walks both directions of the supersession chain from
  // any starting id — `superseded_by` (forward) and the inverse
  // (backward). Postgres' WITH RECURSIVE allows exactly one recursive
  // term, so the bidirectional walk is fused into a single OR clause.
  // The CTE projects only `id` because `workspace_files` carries a
  // TSVECTOR column (`search_vector`) which has no equality operator
  // and so cannot participate in `UNION` deduplication — the full row
  // is read in the outer SELECT.
  //
  // D.7 invariant: chain rows share the universal-column tuple, so the
  // access predicate gates the anchor only (WU-4.2b).
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const idIdx = ap.nextIdx
  const result = await queryWithRLS<FileRow>(
    ctx.userId,
    `WITH RECURSIVE chain AS (
       SELECT id, superseded_by FROM workspace_files
         WHERE ${ap.sql} AND id = $${idIdx}
       UNION
       SELECT wf.id, wf.superseded_by
         FROM workspace_files wf, chain c
         WHERE wf.workspace_id = $1
           AND (wf.id = c.superseded_by OR wf.superseded_by = c.id)
     )
     SELECT ${FULL_SELECT} FROM workspace_files
       WHERE workspace_id = $1 AND id IN (SELECT id FROM chain)
       ORDER BY valid_from ASC, created_at ASC`,
    [...ap.params, id],
  )
  return result.rows.map(toRecord)
}
